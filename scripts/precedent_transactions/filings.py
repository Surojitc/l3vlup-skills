"""
EDGAR: the documents and the tagged numbers behind one deal.

Everything here is a public SEC endpoint that needs no key and no account. The
SEC asks for a descriptive User-Agent with a contact address and for a polite
request rate, and both are honoured:
https://www.sec.gov/os/accessing-edgar-data

Three things are read:

  the filing index   which documents a filing contains, their type and size,
                     so the transaction statement can be told from its exhibits
  the documents      the HTML itself, reduced to running text for parse.py
  company facts      the target's own XBRL tags, from which the share count,
                     the last twelve months and net debt at announcement follow

The XBRL client is the subset of the site's own Filings class that a precedent
row uses. It keeps that class's rules, because a precedent must be built the
way the site builds every other filed figure: balance-sheet items come from the
latest periodic filing on or before the date, flows come as last fiscal year
plus current year-to-date less prior year-to-date, and across candidate tags
the one reaching the most recent period wins, because filers abandon concepts.
"""

from __future__ import annotations

import html
import json
import os
import re
import time
import urllib.request
from dataclasses import asdict, dataclass
from datetime import date, timedelta

from . import parse

UA = os.environ.get("SEC_USER_AGENT", "L3VLUP open skills contact@l3vlup.com")
ARCHIVES = "https://www.sec.gov/Archives/edgar"
SUBMISSIONS = "https://data.sec.gov/submissions"
COMPANY_FACTS = "https://data.sec.gov/api/xbrl/companyfacts"

ANNUAL = {"10-K", "10-K/A", "20-F", "40-F"}
PERIODIC = ANNUAL | {"10-Q", "10-Q/A", "6-K"}

#: forms whose primary document is the proxy behind a 13E-3 wrapper
PROXY_FORMS = {"PREM14A", "DEFM14A", "PREM14C", "DEFM14C", "PRER14A", "DEFR14A"}

#: key -> (label, unit, candidate tags in order). Coverage decides between them.
#: Only the concepts a precedent row needs; the site's full table is far longer.
CONCEPTS: dict[str, tuple[str, str, list[str]]] = {
    "revenue": ("Revenue", "USD", ["RevenueFromContractWithCustomerExcludingAssessedTax", "Revenues", "RevenueFromContractWithCustomerIncludingAssessedTax", "SalesRevenueNet"]),
    "ebit": ("Operating income", "USD", ["OperatingIncomeLoss"]),
    "dAndA": ("Depreciation and amortisation", "USD", ["DepreciationDepletionAndAmortization", "DepreciationAndAmortization", "DepreciationAmortizationAndAccretionNet", "Depreciation"]),
    "cash": ("Cash and equivalents", "USD", ["CashAndCashEquivalentsAtCarryingValue", "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents"]),
    "shortTermInvestments": ("Short-term investments", "USD", ["ShortTermInvestments", "MarketableSecuritiesCurrent", "AvailableForSaleSecuritiesDebtSecuritiesCurrent"]),
    "shortTermDebt": ("Short-term debt", "USD", ["LongTermDebtCurrent", "DebtCurrent", "ShortTermBorrowings", "LongTermDebtAndCapitalLeaseObligationsCurrent"]),
    "longTermDebt": ("Long-term debt", "USD", ["LongTermDebtNoncurrent", "LongTermDebtAndCapitalLeaseObligations", "LongTermDebtAndFinanceLeaseLiabilitiesNoncurrent", "LongTermDebt"]),
    "sharesOutstanding": ("Shares outstanding", "shares", ["EntityCommonStockSharesOutstanding", "CommonStockSharesOutstanding", "CommonStockSharesIssued"]),
}


# ── HTTP ─────────────────────────────────────────────────────────────────────

_last = 0.0


def _get(url: str, accept: str = "application/json", cap: int = 15_000_000) -> bytes:
    """One polite request: a contact in the user agent and a short gap."""
    global _last
    wait = _last + 0.15 - time.time()
    if wait > 0:
        time.sleep(wait)
    _last = time.time()
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": accept})
    with urllib.request.urlopen(req, timeout=60) as res:
        return res.read(cap)


def fetch(url: str, accept: str = "text/html", tries: int = 3, cap: int | None = None) -> bytes:
    """_get with a short retry: EDGAR answers 429 or 503 now and then under a steady rate."""
    last: Exception | None = None
    for i in range(tries):
        try:
            return _get(url, accept=accept, **({"cap": cap} if cap else {}))
        except Exception as e:  # noqa: BLE001
            last = e
            if "404" in str(e):
                raise
            time.sleep(1.5 * (i + 1))
    raise last  # type: ignore[misc]


def fetch_json(url: str):
    return json.loads(fetch(url, accept="application/json").decode("utf-8", "ignore"))


def submissions(cik: str) -> dict:
    """A filer's submissions record: its industry code, its state and its recent filings."""
    return fetch_json(f"{SUBMISSIONS}/CIK{cik}.json")


# ── documents ────────────────────────────────────────────────────────────────


def to_text(raw: bytes) -> str:
    """A filing's HTML as running text: tags gone, entities decoded, one space between words, a newline per block."""
    s = raw.decode("utf-8", "ignore")
    s = re.sub(r"(?is)<(script|style)[^>]*>.*?</\1>", "", s)
    s = re.sub(r"(?i)<br\s*/?>|</p>|</div>|</tr>|</li>|</h\d>", "\n", s)
    s = re.sub(r"<[^>]+>", " ", s)
    s = html.unescape(s).replace("\xa0", " ").replace("\u200b", "")
    s = re.sub(r"[ \t\r\f]+", " ", s)
    s = re.sub(r"\n\s*\n+", "\n", s)
    return s


def index_page(url: str) -> list[dict]:
    """The documents on a filing's index page: description, file name, type, size and URL."""
    raw = fetch(url).decode("utf-8", "ignore")
    out = []
    for row in re.findall(r"<tr[^>]*>(.*?)</tr>", raw, re.S):
        cells = [html.unescape(re.sub(r"<[^>]+>", "", c)).strip() for c in re.findall(r"<td[^>]*>(.*?)</td>", row, re.S)]
        href = re.search(r'href="([^"]+)"', row)
        if len(cells) < 5 or not href:
            continue
        name = cells[2].split()[0] if cells[2] else ""
        try:
            size = int(cells[4])
        except ValueError:
            size = 0
        link = href.group(1)
        # An inline-XBRL viewer link wraps the real path; take the path.
        link = link.split("/ix?doc=", 1)[1] if "/ix?doc=" in link else link
        out.append({"description": cells[1], "name": name, "type": cells[3], "size": size, "url": "https://www.sec.gov" + link if link.startswith("/") else link})
    return out


def docs_for(tx: dict, sub: dict) -> list[dict]:
    """The documents worth reading for a take-private, in order: the 13E-3 itself, its (a) exhibits largest first, then the target's own proxy."""
    accn = tx["id"]
    index_url = tx["filings"][0]["filingUrl"]
    docs = index_page(index_url)
    r = sub.get("filings", {}).get("recent", {})
    primary_name = None
    for a, d in zip(r.get("accessionNumber", []), r.get("primaryDocument", [])):
        if a == accn:
            primary_name = d
            break
    out = []
    primary = next((d for d in docs if d["name"] == primary_name), None) or next((d for d in docs if d["type"].startswith("SC 13E3")), None)
    if primary:
        out.append({**primary, "role": "primary"})
    exhibits = [d for d in docs if re.match(r"EX-99\.?\(?A\)?", d["type"], re.I) or re.search(r"\(A\)", d["description"], re.I)]
    exhibits = [d for d in exhibits if d["name"].lower().endswith((".htm", ".html", ".txt")) and d["size"] > 100_000]
    for d in sorted(exhibits, key=lambda d: -d["size"])[:2]:
        out.append({**d, "role": "exhibit"})
    filed = date.fromisoformat(tx["filings"][0]["filed"])
    proxies = []
    for a, d, form, fd in zip(r.get("accessionNumber", []), r.get("primaryDocument", []), r.get("form", []), r.get("filingDate", [])):
        if form in PROXY_FORMS and abs((date.fromisoformat(fd) - filed).days) <= 150:
            proxies.append((abs((date.fromisoformat(fd) - filed).days), a, d, form, fd))
    for _, a, d, form, fd in sorted(proxies)[:1]:
        out.append({"name": d, "type": form, "size": 0, "url": f"{ARCHIVES}/data/{int(tx['target']['cik'])}/{a.replace('-', '')}/{d}", "role": "proxy", "filed": fd})
    return out


def read_documents(row: dict, docs: list[dict], *, cap: int | None = None, on_text=None) -> dict:
    """
    The reading every precedent row gets, whatever filing it came from: the
    agreement date, the offer, the premiums and the stated share count out of
    each document, then the company facts at announcement. `cap` raises the
    fetch ceiling for a document that is the whole proxy rather than a
    wrapper, and `on_text(row, text)` is where a builder reads the fields only
    its own filing carries.
    """
    cik = row["target"]["cik"]
    premiums: dict[str, tuple[float, str]] = {}
    for d in docs:
        if row["offerPrice"] is not None and "1day" in premiums and row["announcedBasis"] == "merger agreement":
            break
        try:
            text = to_text(fetch(d["url"], cap=cap))
        except Exception as e:  # noqa: BLE001
            row["readErrors"].append(f"{d['name']}: {str(e)[:60]}")
            continue
        row["documentsRead"].append(d["url"])
        if row["announcedBasis"] != "merger agreement":
            agreed = parse.parse_agreement_date(text)
            if agreed:
                row["announced"], row["announcedBasis"] = agreed, "merger agreement"
        if row["offerPrice"] is None:
            offer, basis = parse.parse_offer(text)
            if offer is not None:
                row["offerPrice"], row["offerBasis"] = offer, basis
        if parse.mixed_consideration(text):
            row["consideration"] = "cash and stock"
        if on_text:
            on_text(row, text)
        if "statedShares" not in row:
            n, phrase = parse.parse_shares(text)
            if n:
                row["statedShares"], row["statedSharesBasis"] = round(n, 3), phrase
        # The agreement date, not the filing date, is what a premium is measured
        # to; a proxy is filed weeks later.
        agreed = row["announced"] if row["announcedBasis"] == "merger agreement" else None
        for k, v in parse.parse_premiums(text, row.get("offerPrice"), agreed).items():
            premiums.setdefault(k, v)
    if "1day" in premiums:
        row["premium1Day"] = premiums["1day"][0]
    if "vwap30" in premiums:
        row["premium30DayVwap"] = premiums["vwap30"][0]
    if "high52" in premiums:
        row["premium52WeekHigh"] = premiums["high52"][0]
    row["premiumBasis"] = [s for _, s in premiums.values()]
    if row["offerPrice"] is None:
        row["status"] = "no-offer"
        return row
    try:
        fin = financials_at(cik, row["announced"])
    except Exception as e:  # noqa: BLE001
        fin = {}
        row["readErrors"].append(f"company facts: {str(e)[:60]}")
    for k in ("sharesOut", "ltmRevenue", "ltmEbitda", "ltmEbit", "netDebt", "ltmPeriodEnd", "balanceSheetDate", "ebitdaBasis", "netDebtBasis", "sharesBasis"):
        if k in fin:
            row[k] = fin[k]
    row["formsUsed"] = fin.get("forms", [])
    # A filer that stopped tagging its share count still states it in the
    # transaction statement; that is the count at announcement, near enough.
    if not row.get("sharesOut") and row.get("statedShares"):
        row["sharesOut"] = row["statedShares"]
        row["sharesBasis"] = {"tag": "stated in the transaction statement", "phrase": row.get("statedSharesBasis")}
    return row


# ── XBRL company facts ───────────────────────────────────────────────────────


@dataclass
class Fact:
    """One tagged figure with the filing it came from, or the rule it was built by."""

    key: str
    label: str
    value: float
    unit: str
    tag: str
    start: str | None
    end: str
    form: str
    filed: str
    accession: str
    period: str
    url: str
    #: how the number was built when it is not a single filed figure
    basis: str | None = None
    #: the other filing a built figure draws on (the 10-K behind an LTM sum)
    also: str | None = None


class Filings:
    """
    A filer's XBRL company facts, read as they stood on a given day.

    `asof` drops every observation ending after it, so the balance sheet, the
    LTM and the share count read as they stood at announcement rather than at
    the latest filing. A precedent is priced on the day it was agreed.
    """

    def __init__(self, cik: str, asof: str | None = None):
        self.cik = str(cik).zfill(10)
        self.asof = asof
        self.facts = fetch_json(f"{COMPANY_FACTS}/CIK{self.cik}.json")
        self.name = (self.facts.get("entityName") or "").strip()
        self._cache: dict[str, Fact | None] = {}

    def observations(self, tag: str, unit: str) -> list[dict]:
        """Every observation of one tag, in the first taxonomy that carries it, on or before `asof`."""
        for tax in ("us-gaap", "ifrs-full", "dei", "srt"):
            node = self.facts.get("facts", {}).get(tax, {}).get(tag)
            if not node:
                continue
            rows = node.get("units", {}).get(unit)
            if not rows:
                continue
            out = []
            for r in rows:
                if not isinstance(r.get("val"), (int, float)):
                    continue
                if self.asof and r.get("end", "") > self.asof:
                    continue
                out.append({**r, "tag": f"{tax}:{tag}"})
            return out
        return []

    @staticmethod
    def _days(r: dict) -> float | None:
        if not r.get("start"):
            return None
        return (date.fromisoformat(r["end"]) - date.fromisoformat(r["start"])).days

    def _url(self, accn: str) -> str:
        return f"{ARCHIVES}/data/{int(self.cik)}/{accn.replace('-', '')}/{accn}-index.htm"

    @staticmethod
    def _period(r: dict) -> str:
        fy, fp = r.get("fy"), r.get("fp")
        if fy and fp:
            return f"FY{fy}" if fp == "FY" else f"{fp} {fy}"
        y, m = r["end"][:4], int(r["end"][5:7])
        return f"FY{y}" if r.get("form") in ANNUAL else f"Q{(m + 2) // 3} {y}"

    def _fact(self, key: str, r: dict, basis: str | None = None, value: float | None = None) -> Fact:
        label, unit, _ = CONCEPTS[key]
        return Fact(
            key=key, label=label, value=float(value if value is not None else r["val"]), unit=unit, tag=r["tag"],
            start=r.get("start"), end=r["end"], form=r.get("form", ""), filed=r.get("filed", ""),
            accession=r.get("accn", ""), period=self._period(r), url=self._url(r.get("accn", "")), basis=basis,
        )

    # ── instants: the latest balance sheet ───────────────────────────────
    def instant(self, key: str) -> Fact | None:
        """Newest balance-sheet figure across every periodic filing."""
        ck = f"i:{key}"
        if ck in self._cache:
            return self._cache[ck]
        _, unit, tags = CONCEPTS[key]
        best = None
        for tag in tags:
            rows = [r for r in self.observations(tag, unit) if r.get("form") in PERIODIC and (self._days(r) or 0) <= 1]
            if not rows:
                continue
            by_end: dict[str, dict] = {}
            for r in rows:
                k = by_end.get(r["end"])
                if not k or (r.get("filed") or "9999") < (k.get("filed") or "9999"):
                    by_end[r["end"]] = r
            newest = max(by_end.values(), key=lambda r: r["end"])
            if not best or newest["end"] > best["end"]:
                best = newest
        f = self._fact(key, best) if best else None
        self._cache[ck] = f
        return f

    # ── flows ────────────────────────────────────────────────────────────
    def _durations(self, key: str) -> tuple[str, list[dict]]:
        _, unit, tags = CONCEPTS[key]
        best_tag, best_rows, best_end = None, [], ""
        for tag in tags:
            rows = [r for r in self.observations(tag, unit) if r.get("form") in PERIODIC and r.get("start")]
            if not rows:
                continue
            end = max(r["end"] for r in rows)
            if end > best_end:
                best_tag, best_rows, best_end = tag, rows, end
        return best_tag or "", best_rows

    def annual(self, key: str) -> Fact | None:
        """The latest fiscal-year figure."""
        _, rows = self._durations(key)
        years = [r for r in rows if r.get("form") in ANNUAL and 340 <= (self._days(r) or 0) <= 400]
        if not years:
            return None
        by_end: dict[str, dict] = {}
        for r in years:
            k = by_end.get(r["end"])
            if not k or (r.get("filed") or "9999") < (k.get("filed") or "9999"):
                by_end[r["end"]] = r
        return self._fact(key, max(by_end.values(), key=lambda r: r["end"]))

    def ltm(self, key: str) -> Fact | None:
        """
        Last twelve months: fiscal year + current YTD - prior-year YTD.

        The 10-Q carries the year-to-date figure and the comparative for the
        same months a year earlier, so the twelve months to the latest quarter
        end are one subtraction away from the 10-K. When the pieces are not
        there the fiscal year stands, and the basis says which.
        """
        ck = f"l:{key}"
        if ck in self._cache:
            return self._cache[ck]
        fy = self.annual(key)
        if not fy:
            self._cache[ck] = None
            return None
        _, rows = self._durations(key)
        fy_end = date.fromisoformat(fy.end)
        ytd = [r for r in rows if r.get("start") == (fy_end + timedelta(days=1)).isoformat() and r["end"] > fy.end and (self._days(r) or 0) < 300]
        out = fy
        if ytd:
            cur = max(ytd, key=lambda r: r["end"])
            cur_days = self._days(cur) or 0
            prior_end = date.fromisoformat(cur["end"]).replace(year=date.fromisoformat(cur["end"]).year - 1)
            prior = [r for r in rows if r.get("start") == fy.start and abs(date.fromisoformat(r["end"]) - prior_end).days <= 7 and abs((self._days(r) or 0) - cur_days) <= 7]
            if prior:
                p = min(prior, key=lambda r: r.get("filed") or "9999")
                value = fy.value + cur["val"] - p["val"]
                out = self._fact(key, {**cur, "val": value}, basis=f"{fy.period} + {self._period(cur)} YTD − prior YTD", value=value)
                out.start = (date.fromisoformat(cur["end"]) - timedelta(days=365)).isoformat()
                out.also = f"{fy.form} for {fy.period}"
        self._cache[ck] = out
        return out

    def ebitda(self) -> Fact | None:
        """LTM operating income plus LTM depreciation and amortisation."""
        ebit = self.ltm("ebit")
        da = self.ltm("dAndA")
        if not ebit or not da:
            return None
        # Both pieces must describe the same twelve months: a filer that
        # dropped the operating-income tag years ago has no EBITDA here.
        if abs((date.fromisoformat(ebit.end) - date.fromisoformat(da.end)).days) > 100:
            return None
        basis = f"operating income + D&A ({ebit.tag.split(':')[1]} + {da.tag.split(':')[1]})"
        if ebit.basis:
            basis = f"{ebit.basis}; {basis}"
        return Fact(**{**asdict(ebit), "key": "ebitda", "label": "EBITDA", "value": ebit.value + da.value, "basis": basis, "also": ebit.also})


def _shares_at(fl: Filings, asof: str, floor: str) -> tuple[float | None, dict | None]:
    """
    Cover-page shares (dei) at the last cover date on or before `asof`, the
    classes on one cover summed; the balance-sheet count when the filer
    stopped tagging the cover (some did in 2018). None when both are older
    than `floor`.
    """
    rows = [r for r in fl.observations("EntityCommonStockSharesOutstanding", "shares") if r.get("end", "") <= asof]
    if rows:
        latest = max(r["end"] for r in rows)
        if latest >= floor:
            on = [r for r in rows if r["end"] == latest]
            # One filing, several rows: share classes (their sum is the count).
            # Several filings on one date: an amendment repeating the original.
            by_accn: dict[str, list] = {}
            for r in on:
                by_accn.setdefault(r.get("accn", ""), []).append(r)
            accn, group = sorted(by_accn.items(), key=lambda kv: max(x.get("filed", "") for x in kv[1]))[-1]
            total = sum(sorted({float(r["val"]) for r in group}))
            return total / 1e6, {"tag": "dei:EntityCommonStockSharesOutstanding", "end": latest, "form": group[0].get("form", ""), "accession": accn}
    f = fl.instant("sharesOutstanding")
    if f and f.end >= floor:
        return f.value / 1e6, {"tag": f.tag, "end": f.end, "form": f.form, "accession": f.accession}
    return None, None


def financials_at(cik: str, asof: str) -> dict:
    """
    LTM revenue and EBITDA to the last period end on or before `asof`, the
    balance sheet at that date and the cover-page shares, in $mm and mm shares.
    """
    fl = Filings(cik, asof=asof)
    out: dict = {"forms": []}
    rev = fl.ltm("revenue")
    ebitda = fl.ebitda()
    ebit = fl.ltm("ebit")
    # A stale series (the tag was abandoned years before the deal) is not the
    # LTM at announcement: keep flows ending within fifteen months of the date.
    floor = (date.fromisoformat(asof) - timedelta(days=456)).isoformat()
    if rev and rev.end >= floor:
        out["ltmRevenue"] = round(rev.value / 1e6, 1)
        out["ltmPeriodEnd"] = rev.end
        out["forms"].extend([f"{rev.form} for {rev.period}"] + ([rev.also] if rev.also else []))
    if ebitda and ebitda.end >= floor:
        out["ltmEbitda"] = round(ebitda.value / 1e6, 1)
        out["ltmPeriodEnd"] = out.get("ltmPeriodEnd") or ebitda.end
        out["ebitdaBasis"] = ebitda.basis
    elif ebit and ebit.end >= floor:
        out["ltmEbit"] = round(ebit.value / 1e6, 1)
    parts = {k: fl.instant(k) for k in ("shortTermDebt", "longTermDebt", "cash", "shortTermInvestments")}
    parts = {k: v for k, v in parts.items() if v}
    if parts:
        newest = max(v.end for v in parts.values())
        cutoff = (date.fromisoformat(newest) - timedelta(days=100)).isoformat()
        parts = {k: v for k, v in parts.items() if v.end >= cutoff}
        if newest >= floor:
            nd = sum(v.value for k, v in parts.items() if k in ("shortTermDebt", "longTermDebt")) - sum(v.value for k, v in parts.items() if k in ("cash", "shortTermInvestments"))
            out["netDebt"] = round(nd / 1e6, 1)
            out["balanceSheetDate"] = newest
            out["netDebtBasis"] = " + ".join(k for k in ("shortTermDebt", "longTermDebt") if k in parts) + " - " + " - ".join(k for k in ("cash", "shortTermInvestments") if k in parts)
    shares, meta = _shares_at(fl, asof, floor)
    if shares and meta:
        out["sharesOut"] = round(shares, 3)
        out["sharesBasis"] = meta
    out["entityName"] = fl.name
    return out
