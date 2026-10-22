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
import sys
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
    "impairment": ("Impairment charges", "USD", ["AssetImpairmentCharges", "GoodwillImpairmentLoss", "ImpairmentOfIntangibleAssetsExcludingGoodwill", "ImpairmentOfLongLivedAssetsHeldForUse", "GoodwillAndIntangibleAssetImpairment"]),
}

#: Concepts a filer uses for the whole line where none of the usual ones is
#: current: a regulated utility's operating revenue (WGL, Delta Natural Gas),
#: a goods company's net sales before 2018 (Snyder's-Lance, Mead Johnson), a
#: utility's depreciation inside operating expenses (El Paso Electric). They
#: are read only when every usual concept is missing or stale at the date,
#: because a company that tags the total under a usual concept may also tag a
#: part of it under one of these (goods sales beside service revenue), and the
#: part must never stand in for the whole.
FALLBACK: dict[str, list[str]] = {
    "revenue": ["RegulatedAndUnregulatedOperatingRevenue", "SalesRevenueGoodsNet", "RegulatedOperatingRevenue", "ElectricUtilityRevenue"],
    "dAndA": ["UtilitiesOperatingExpenseDepreciationAndAmortization", "DepreciationAndAmortizationExcludingNuclearFuel"],
}

#: the impairment share of EBITDA above which EV / EBITDA is not a multiple of
#: the business's earnings, the threshold the site's precedent rule applies
IMPAIRMENT_SHARE = 0.10


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
    statements: list[dict] = []
    aside: list[dict] = []
    texts: list[str] = []
    urls: list[str] = []
    for d in docs:
        own = any(s["basis"] == "close" and s["unaffected"] and not s["proposal"] for s in statements)
        if row["offerPrice"] is not None and own and row["announcedBasis"] in AGREEMENT_BASES:
            break
        try:
            text = to_text(fetch(d["url"], cap=cap))
        except Exception as e:  # noqa: BLE001
            row["readErrors"].append(f"{d['name']}: {str(e)[:60]}")
            continue
        row["documentsRead"].append(d["url"])
        texts.append(text)
        urls.append(d["url"])
        if "securitiesSought" not in row:
            sought = parse.securities_sought(text)
            if sought:
                row["securitiesSought"] = sought
                row["securitiesReader"] = SECURITIES_READER
        if row["announcedBasis"] != "merger agreement":
            agreed = parse.parse_agreement_date(text)
            if agreed:
                row["announced"], row["announcedBasis"] = agreed, "merger agreement"
        resolve_announcement(row, [text])
        if row["offerPrice"] is None:
            offer, basis = parse.parse_offer(text)
            if offer is not None:
                row["offerPrice"], row["offerBasis"] = offer, basis
        if parse.mixed_consideration(text):
            row["consideration"] = "cash and stock"
        if on_text:
            on_text(row, text)
        # The agreement date, not the filing date, is what a premium is measured
        # to; a proxy is filed weeks later.
        agreed = row["announced"] if row["announcedBasis"] in AGREEMENT_BASES else None
        kept, set_aside = parse.premium_statements(text, row.get("offerPrice"), agreed, cash_only=row.get("consideration") == "cash", original=row.get("announcedOriginal"))
        statements.extend({**s, "document": d["url"]} for s in kept)
        aside.extend({**s, "document": d["url"]} for s in set_aside)
    # The share count from every document read: what each class receives can
    # sit in a different document from the count of each (parse.stated_shares).
    if "statedShares" not in row:
        set_stated_shares(row, parse.stated_shares(texts, company=target_names(row, urls, texts), offer=row.get("offerPrice")))
    # The documents read, the premiums are read again against the whole offer:
    # its parts can sit in different documents (the ADS ratio on a cover, the
    # package's value in the proxy).
    if texts:
        resolve_offer(row, urls, texts)
        statements, aside = tied_statements(row, urls, texts)
    apply_premiums(row, statements, aside, texts)
    reason = parse.not_control_reason(row.get("securitiesSought"))
    if reason:
        # A tender for warrants, notes or a dividend-bearing preferred is not a
        # control acquisition: no precedent, and no premium or multiple of one.
        row["status"], row["error"] = "rejected", reason
        return row
    if row["offerPrice"] is None:
        row["status"] = "no-offer"
        return row
    try:
        fin = financials_at(cik, row["announced"])
    except Exception as e:  # noqa: BLE001
        fin = {}
        row["readErrors"].append(f"company facts: {str(e)[:60]}")
    for k in FINANCIAL_FIELDS:
        if k in fin:
            row[k] = fin[k]
    row["formsUsed"] = fin.get("forms", [])
    row["financialsReader"] = FINANCIALS_READER
    # A filer that stopped tagging its share count still states it in the
    # transaction statement; that is the count at announcement, near enough.
    _stated_fallback(row)
    return row


# ── the order rows due a re-read are worked through ──────────────────────────
#
# Every pass below reads again the stored rows an earlier reader wrote, inside
# a time budget, and a run cut short leaves the rest due for the next. On 22
# October 2026 review run 3 hit those budgets before reaching 182 ok rows, almost
# all filed between September 2025 and October 2026, because each pass worked
# oldest filing first. Those rows kept the 11 October reading, and Finance OS's
# default Premiums Paid sample, drawn from recent deals, fell to 24.
#
# So every pass now does the rows filed in the last RECENT_MONTHS first, then
# the rest, keeping its own priority inside each group. Nothing is skipped: a
# row not reached keeps its old reader version, so it is still due and the next
# run starts on it. Rows are due only when a reader version moves, and a new
# filing is read at the current versions, so the due set only shrinks between
# version bumps and the older rows are reached once the recent ones are done.

#: how far back a filing counts as recent for the re-read passes
RECENT_MONTHS = 24


def recent_cutoff(today: date | None = None) -> str:
    """The first filing date that counts as recent: RECENT_MONTHS before today, as an ISO date."""
    t = today or date.today()
    months = t.year * 12 + (t.month - 1) - RECENT_MONTHS
    y, m = divmod(months, 12)
    m += 1
    last = (date(y + (m == 12), m % 12 + 1, 1) - timedelta(days=1)).day
    return date(y, m, min(t.day, last)).isoformat()


def is_recent(row: dict, cutoff: str) -> bool:
    """Whether a row was filed on or after `cutoff` (its announcement date where it records no filing date)."""
    return (row.get("filed") or row.get("announced") or "")[:10] >= cutoff


def recent_first(ids, rows: dict[str, dict], key=None, today: date | None = None) -> list[str]:
    """
    `ids` with the rows filed in the last RECENT_MONTHS first, then the rest,
    each group in the pass's own order: by `key` where one is given, else as
    `ids` came (the sort is stable).
    """
    cutoff = recent_cutoff(today)
    return sorted(ids, key=lambda i: (not is_recent(rows[i], cutoff), key(i) if key else 0))


#: The securities-class reading the stored rows were made with. A 13E-3 row
#: read before it has its cover read again (one cached document): a tender for
#: warrants, notes or a dividend-bearing preferred is rejected, with the reason.
SECURITIES_READER = 1


def needs_securities_reread(row: dict) -> bool:
    return (row.get("securitiesReader") or 0) < SECURITIES_READER and bool(row.get("documentsRead")) and (row.get("readStatus") or row.get("status")) in ("ok", "no-offer") and (row.get("source") or "SC 13E3") == "SC 13E3"


def reread_securities(row: dict) -> dict:
    """A stored 13E-3 row's cover read again for the class it seeks; nothing else changes unless the class is not the company's equity."""
    if not needs_securities_reread(row):
        return row
    try:
        text = to_text(fetch(row["documentsRead"][0]))
    except Exception as e:  # noqa: BLE001
        row.setdefault("readErrors", []).append(f"cover: {str(e)[:60]}")
        return row
    sought = parse.securities_sought(text)
    if sought:
        row["securitiesSought"] = sought
    row["securitiesReader"] = SECURITIES_READER
    reason = parse.not_control_reason(sought)
    if reason:
        row.pop("readStatus", None)
        row["status"], row["error"] = "rejected", reason
    return row


def reread_stale_securities(rows: dict[str, dict], ids: list[str], write, *, minutes: float = 10) -> int:
    """The stored 13E-3 rows in `ids` read before the securities-class reading, read again until the budget is spent, recent filings first (recent_first)."""
    budget = float(os.environ.get("PRECEDENTS_SECURITIES_MINUTES", minutes)) * 60
    todo = recent_first([i for i in ids if needs_securities_reread(rows[i])], rows)
    if not todo:
        return 0
    print(f"{len(todo)} rows read before the securities-class reading; reading their covers for up to {budget / 60:.0f} minutes", file=sys.stderr, flush=True)
    started, done = time.time(), 0
    for i in todo:
        if time.time() - started > budget:
            break
        reread_securities(rows[i])
        done += 1
        if done % 25 == 0:
            write(rows)
    print(f"{done} of {len(todo)} rows' covers read again", file=sys.stderr, flush=True)
    return done


#: The premium reading the stored rows were made with. A row read before this
#: version has its premiums read again from the documents it read (premiums
#: only: nothing else on the row changes), so a correction reaches every deal
#: already on file and not only the next one. 4: a statement whose reference
#: price plus its premium is not the final offer is another bid's (Baldwin's
#: 83% is the $31.75 Round 2 bid's), and a joint proxy whose registrant issues
#: the shares is the buyer's (set_aside_buyer). 5: the price is the whole
#: offer (resolve_offer), per share or per ADS, cash and stock alike; a
#: premium on a package whose value cannot be found stands untied and says so
#: (premiumTie). 6: a premium that prices another instrument's terms (a capped
#: call's cap, a conversion, exercise or strike price) is set aside: TESCO's
#: 75% is the cap on Nabors' capped calls, and its own premium is 19%.
PREMIUM_READER = 6


#: The offer reading the stored rows were made with. 2: the whole offer
#: (parse.read_offer): a contingent payment is not the price, the offer per
#: ADS from the ADS ratio the filing states, and a package with stock valued
#: as the filing states it on the reference day or from its stated parts. Each
#: part is kept with its passage and document (offerComponents), and a row
#: read before this version has its offer read again from its documents, so
#: the guard records every change under this version. 3: a ratio written out
#: as a compound ("seventy-two": Zhangmen) is read, a price per ADS over the
#: ratio is kept to eight significant figures rather than four decimal places
#: ($0.56 / 72 = $0.0077778 a share, not $0.0078), a per-share price the
#: filing states is kept only where times the ratio it comes back to the price
#: per ADS (Youku's rounded $1.53 x 18 is not $27.60), and the offer per ADS
#: is the one read or the one the filing states beside the product (LAIX's
#: $1.90, not $0.1357 x 14 = $1.8998). finalize values the shares only at a
#: price per share (equityValueBasis). 4: an all-stock deal is read too
#: (parse.read_stock_offer): a row with no cash price was left with
#: no offer at all, though its proxy states what the acquirer's shares were
#: worth ("The Arrangement values the Common Shares at $4.62 per share based on
#: Nabors' closing share price of $6.80 on August 11, 2017": TESCO, 0.68 x
#: $6.80 = $4.624). The package is valued by the rules a package with stock
#: already had, a price read that is the package's stated value is taken as
#: that value, the row's consideration is "stock" where no cash is part of it,
#: and a stock package's premium is tied only on the day its value is stated
#: for, the row saying so where it is not (premiumTie). 5: a ratio in a
#: holding company's shares for another company's shares is that company's
#: share exchange, not the target's consideration (Siliconware was paid cash;
#: ASE's shares moved into ASE Industrial Holding), on a package with cash and
#: an all-stock reading alike, and a re-read that finds no stock puts back the
#: cash the offer reader had called cash and stock.
#: 6: a price is read where the holders are paid, not where it is recited
#: (parse.offer_refusal): never the issuer's own repurchase or self-tender (FS
#: Investment Corp III and IV stood at the $9.24 of a 2018 quarterly tender),
#: never a proposal, framework or bid the background recites (Medley
#: Management at its first framework's $3.75 cash rather than the agreed $3.44;
#: Welbilt at Party A's $15.00), never a share count printed with a dollar
#: sign. Where every passage of the figure stated most often is refused, the
#: price is the one the sentences paying the holders state, and with none the
#: stored price is withdrawn with the reason (offerWithdrawn) rather than kept.
OFFER_READER = 6

#: the fields the offer reader owns, cleared before each reading
OFFER_FIELDS = ("offerComponents", "offerImplied", "offerImpliedMethod", "offerImpliedDate", "offerImpliedBasis", "adsRatio", "offerPerAds", "offerUnresolved", "offerWithdrawn")


def _where(urls: list[str], flat: list[str], excerpt: str | None) -> str | None:
    """The document a passage was read from."""
    if not excerpt:
        return None
    probe = excerpt[20:100] if len(excerpt) > 120 else excerpt
    for url, t in zip(urls, flat):
        if probe in t:
            return url
    return None


def resolve_offer(row: dict, urls: list[str], texts: list[str], *, reread: bool = False) -> dict:
    """
    The whole offer onto the row, every part with its passage, its document
    and this reader's version. On a re-read the per-share cash is read again
    too (a stored row may carry a contingent payment as its price); a reading
    that finds none keeps the stored figure.
    """
    refused = None
    if reread:
        for text in texts:
            offer, basis = parse.parse_offer(text)
            if offer is not None:
                if offer != row.get("offerPrice"):
                    row["offerPrice"], row["offerBasis"] = offer, basis
                break
        else:
            # Nothing read. The stored figure stands where this reader cannot
            # see it at all, and is withdrawn where every passage it is stated
            # in is one the reader now refuses: a price is never kept because
            # an earlier reader took it from the wrong sentence.
            refused = parse.refused_offer(texts, row.get("offerPrice"))
    # Cash and stock is the offer reader's own call where no document says
    # the consideration is mixed: on a re-read it is made again, so a
    # correction that finds no stock puts the cash back.
    if reread and row.get("consideration") == "cash and stock" and not any(parse.mixed_consideration(t) for t in texts):
        row["consideration"] = "cash"
    for k in OFFER_FIELDS:
        row.pop(k, None)
    row["offerReader"] = OFFER_READER
    if refused:
        was = row.get("offerPrice")
        row["offerPrice"], row["offerBasis"] = None, None
        row["offerWithdrawn"] = f"no per-share price is stated where the holders are paid; the ${was:,.4g} read before is {refused['reason']}: {refused['excerpt'][:300]}"
        if row.get("status") == "ok":
            row["status"] = "no-offer"
    agreed = row.get("announced") if row.get("announcedBasis") in AGREEMENT_BASES else None
    # With no cash price the deal is read as one paid in stock: the value its
    # filing states for the acquirer's shares, or the ratio times the close it
    # states, and nothing where it states neither (parse.read_stock_offer).
    o = parse.read_offer(texts, row.get("offerPrice"), row.get("offerBasis"), agreed, row.get("announcedOriginal"), (row.get("target") or {}).get("name"))
    if row.get("offerPrice") is None and not o["stock"]:
        if row.get("offerWithdrawn"):
            row["offerUnresolved"] = row["offerWithdrawn"]
        return row
    if o["perShare"]:
        # The price read was the price per ADS: the row's price is per share.
        row["offerPrice"], row["offerBasis"] = o["perShare"]
    flat = [re.sub(r"\s+", " ", t) for t in texts]
    row["offerComponents"] = [{**c, "document": _where(urls, flat, c.get("excerpt")), "reader": OFFER_READER} for c in o["components"]][:12]
    if o["allStock"]:
        # Paid in the acquirer's shares alone: no cash price was read, or the
        # price read is the stated value of shares the ratio alone makes up.
        row["consideration"] = "stock"
    elif o["stock"] and row.get("consideration") in ("cash", None):
        row["consideration"] = "cash and stock"
    if o["implied"] is not None:
        row["offerImplied"], row["offerImpliedMethod"], row["offerImpliedDate"], row["offerImpliedBasis"] = o["implied"], o["method"], o["date"], o["basis"]
    if o["adsRatio"]:
        row["adsRatio"] = o["adsRatio"]
    if o["perAds"] is not None:
        row["offerPerAds"] = o["perAds"]
    if o["unresolved"]:
        row["offerUnresolved"] = o["unresolved"]
    return row


def offer_ties(row: dict) -> list[tuple[float, str]] | None:
    """What a premium is tied to: the whole offer per share and per ADS, [] where it is unresolved, None for a row read before the offer reader."""
    if not row.get("offerReader") or (row.get("offerReader") or 1) < OFFER_READER:
        return None
    if row.get("offerImplied") is None:
        # Quoted per ADS with no ratio stated: the ADS price alone.
        return [(row["offerPerAds"], "ADS")] if row.get("offerPerAds") is not None and not row.get("offerUnresolved") else []
    ties = [(row["offerImplied"], "share")]
    if row.get("offerPerAds") is not None:
        ties.append((row["offerPerAds"], "ADS"))
    return ties


def tied_statements(row: dict, urls: list[str], texts: list[str]) -> tuple[list[dict], list[dict]]:
    """Every document's premium statements, tied to the row's whole offer."""
    statements: list[dict] = []
    aside: list[dict] = []
    agreed = row.get("announced") if row.get("announcedBasis") in AGREEMENT_BASES else None
    ties = offer_ties(row)
    for url, text in zip(urls, texts):
        kept, set_aside = parse.premium_statements(text, row.get("offerPrice"), agreed, cash_only=row.get("consideration") == "cash", original=row.get("announcedOriginal"), ties=ties, tie_date=row.get("offerImpliedDate"))
        statements.extend({**s, "document": url} for s in kept)
        aside.extend({**s, "document": url} for s in set_aside)
    return statements, aside


def apply_premiums(row: dict, statements: list[dict], aside: list[dict], texts: list[str]) -> dict:
    """The deal's premiums onto its row, with every statement kept and set aside as the provenance behind them."""
    chosen = parse.choose_premiums(statements, row.get("offerPrice"), cash_only=row.get("consideration") == "cash", texts=texts, ties=offer_ties(row))
    # Where the package includes stock and the filing gives no value for it,
    # there is nothing to check a premium against. The premium is then the
    # filing's own statement, untied, as it was before the offer reader, and
    # the row says so: setting every such statement aside would take the
    # premium off some 330 stock deals whose proxies state it plainly.
    row.pop("premiumTie", None)
    # A package with stock is worth what the acquirer's shares are worth on the
    # day: its premium is checked against the whole offer where it is measured
    # on the day the offer is valued (premium_statements), or where the price
    # it states reproduces it from the whole offer (Coventry's 30.2% is the
    # $42.08 of 17 August over the $32.32 unaffected close of 14 August), and
    # stands untied, saying so, where it is measured on another day or on none
    # and nothing checks it (TWC's 17% is to 11 February, the package valued on
    # the 12th).
    valued_on = row.get("offerImpliedDate") if row.get("consideration") != "cash" else None
    if row.get("offerReader") and statements:
        if row.get("offerUnresolved"):
            row["premiumTie"] = f"untied: the offer is unresolved ({row['offerUnresolved']}); the premium is the filing's own statement, not checked against the offer"
        elif offer_ties(row) and chosen.get("premium1DayUntied"):
            row["premiumTie"] = f"untied: the premium {chosen['premium1DayUntied']}; a stock package's premium over its unaffected price is often measured on its value at signing, so the premium is the filing's own statement, not checked against the offer"
        elif offer_ties(row) and valued_on and chosen["premium1Day"] is not None and chosen["unaffectedDate"] != valued_on and chosen["unaffectedPriceStated"] is None:
            on = f"measured to {chosen['unaffectedDate']}" if chosen["unaffectedDate"] else "measured to no stated day"
            row["premiumTie"] = f"untied: the premium is {on} and the whole offer is valued on {valued_on}; a package with stock is worth what the acquirer's shares are worth on the day, so the premium is the filing's own statement, not checked against the offer"
        elif offer_ties(row):
            row["premiumTie"] = "tied to the whole offer"
    for k in ("premium1Day", "premium30DayVwap", "premium52WeekHigh", "unaffectedPriceStated", "unaffectedPricePer", "unaffectedDate", "unaffectedPriceBasis", "premiumBasis", "premiumPreAnnouncement", "premiumPreAnnouncementDate"):
        row[k] = chosen[k]
    keep = ("basis", "window", "premium", "price", "date", "unaffected", "proposal", "namesOffer", "sharesReference", "excerpt", "document")
    row["premiumStatements"] = [{**{k: s.get(k) for k in keep}, **({"untied": s["untied"]} if s.get("untied") else {})} for s in statements][:12]
    row["premiumsSetAside"] = [{k: s.get(k) for k in ("reason", "excerpt", "document")} for s in aside][:8]
    row["premiumReader"] = PREMIUM_READER
    return row


#: the bases under which "announced" is an agreement's date, so a premium's reference date can be measured against it
AGREEMENT_BASES = ("merger agreement", "amended merger agreement")

#: The rule that dates a row. 2: the loose reading takes only the deal's own
#: agreement ("entered into a merger agreement", "an Asset Purchase
#: Agreement"), not any agreement the proxy recites (a settlement, a credit
#: facility, a confidentiality agreement). A row dated under an earlier
#: rule is resolved again with its premiums; the guard lets a date move only
#: when this moves, and the financials then move with it.
ANNOUNCED_READER = 2


def resolve_announcement(row: dict, texts: list[str]) -> dict:
    """
    The date of the agreement whose terms the row records, where the row has
    only the filing date or an agreement date more than a year before the
    filing (which finalize replaces with the filing date):

      - a revised deal is dated by its latest amendment or restatement
        (Alere's $51.00 is the April 2017 amendment's; the January 2016
        agreement goes to announcedOriginal), and
      - an agreement the filing names without "Agreement and Plan of Merger,
        dated ..." is read from its other wordings (Paramount's "transaction
        agreement, dated as of July 7, 2024").

    A filing date stands where neither is stated. A row re-dated here has its
    financials read again at the new date (financialsReader is cleared).
    """
    filed = row.get("filed") or row.get("announced")
    if not filed:
        return row
    row["announcedReader"] = ANNOUNCED_READER
    floor = (date.fromisoformat(filed[:10]) - timedelta(days=400)).isoformat()
    current = row.get("announced") or ""
    amended = max((d for d in (parse.parse_amendment_date(t) for t in texts) if d and floor <= d <= filed), default=None)
    # A row already dated by an agreement stands, unless the documents state a
    # later amendment of it that changed the price the row records: iRobot's
    # $51.75 is the July 2023 amendment's ("reduced from $61.00 in cash, to
    # $51.75 in cash"). Most amendments are technical and leave the terms, the
    # announcement and the premium's reference where they were.
    if row.get("announcedBasis") in AGREEMENT_BASES and floor <= current <= filed and not (amended and amended > current and parse.price_revised(texts, row.get("offerPrice"))):
        return row
    loose = None
    for t in texts:
        loose = loose or parse.parse_agreement_date_loose(t, floor, filed)
    if amended and (not loose or amended >= loose):
        was_agreement = row.get("announcedBasis") in AGREEMENT_BASES and current and current != amended
        # The first agreement, which may be well over a year before the filing.
        earlier = [d for t in texts for d in [parse.parse_agreement_date(t) or parse.parse_agreement_date_loose(t, "1990-01-01", amended)] if d and d < amended]
        original = current if was_agreement else (min(earlier) if earlier else None)
        if original:
            row["announcedOriginal"] = original
        row["announced"], row["announcedBasis"] = amended, "amended merger agreement"
    elif loose:
        row["announced"], row["announcedBasis"] = loose, "merger agreement"
    if row.get("announced") != current:
        row.pop("financialsReader", None)
    return row


def set_aside_buyer(row: dict, found: dict | None) -> dict:
    """
    A proxy whose registrant issues the shares is the buyer's, not the
    target's (parse.filer_is_buyer): no price, no premium and no multiple of
    its own, the same verdict as an acquirer-side vote. Only a merger proxy
    still standing as a deal is judged: a de-SPAC or a rejection stands.
    """
    if not found or (row.get("source") or "SC 13E3") not in ("DEFM14A", "DEFM14C") or row.get("status") not in ("ok", "no-offer"):
        return row
    row["offerPrice"], row["offerBasis"] = None, None
    row["status"] = "no-consideration"
    row["error"] = "the filer issues the shares: it is the buyer in a joint proxy, not the company acquired"
    row["acquirerSideBasis"] = found.get("evidence") or []
    return row


#: The rule that says which company a row is about. 2: the company whose
#: holders are paid. A merger proxy that pays another company's holders in the
#: registrant's own stock is the buyer's (parse.paid_elsewhere: Endologix for
#: Nellix, Real Goods Solar for Earth Friendly, Crescent Capital BDC for
#: Alcentra), one that puts a split-off to its own holders acquires nothing
#: (parse.split_off: FNF's FNFV redemption, Liberty Interactive's and Liberty
#: Media's), and either is set aside with its reason rather than kept as a deal
#: for the wrong company. The name is the one the registrant filed under (the
#: form index), not the one EDGAR shows today: Meredith, not "Hawkeye
#: Acquisition, Inc.", the vehicle Gray merged into it; Brigham Minerals, not
#: "MNRL Sub Inc.". A take-private statement the deck index now files under
#: another deal's subject company takes that company (Liberty TripAdvisor's
#: last 13E-3 amendment was stored under Tripadvisor, its buyer). A row judged
#: before this version is judged again from its first document, and the guard
#: records each change under this version.
TARGET_READER = 2


def set_aside_target(row: dict, split: dict | None, paid: dict | None) -> dict:
    """
    A merger proxy that is not the acquired company's own: a split-off is
    rejected (nothing is acquired), a proxy that pays another company's
    holders in the registrant's stock is the buyer's (no-consideration, as an
    acquirer-side vote is). Only a row still standing as a deal is judged.
    """
    if (row.get("source") or "SC 13E3") not in ("DEFM14A", "DEFM14C") or row.get("status") not in ("ok", "no-offer"):
        return row
    # A reverse merger is kept and labelled for what it is (formindex.judge_spac):
    # the private company's holders are paid in the listed company's stock by design.
    if row.get("dealType") == "reverse-merger" and not split:
        return row
    if split:
        row["offerPrice"], row["offerBasis"] = None, None
        row["status"] = "rejected"
        row["error"] = "a split-off: the filer redeems its own stock for a subsidiary's shares, and no company is acquired"
        row["targetBasis"] = split.get("evidence") or []
    elif paid:
        row["offerPrice"], row["offerBasis"] = None, None
        row["status"] = "no-consideration"
        row["error"] = f"the consideration is paid to {', '.join(paid.get('paid') or ['another company'])}'s holders, in the filer's own stock: the filer is the buyer, not the company acquired"
        row["targetBasis"] = paid.get("evidence") or []
    return row


def name_as_filed(row: dict, filed: str | None) -> dict:
    """
    The target under the name it filed under. EDGAR's name is today's, and a
    company bought is often renamed for the vehicle merged into it ("Hawkeye
    Acquisition, Inc." for Meredith); today's name is kept beside it as
    currentName, since it is the one EDGAR searches by.
    """
    target = row.get("target") or {}
    filed = (filed or "").strip()
    if filed and parse.norm_name(filed) != parse.norm_name(target.get("name")):
        target.setdefault("currentName", target.get("name"))
        target["name"] = filed
    return row


def _reading_status(row: dict) -> str | None:
    """A row's own reading's status: a duplicate keeps it as readStatus, and is judged on it."""
    return row.get("readStatus") if row.get("status") == "duplicate" else row.get("status")


def judge_target(row: dict, text: str | None, filed: str | None = None) -> dict:
    """
    A stored merger proxy's target judged again from its first document: the
    name it filed under, then whose holders it pays. A duplicate is judged on
    its own reading, which dedupe restores before it re-decides the deal: a
    buyer's earlier proxy left standing as a duplicate would otherwise become
    the deal's primary once the later one is set aside.
    """
    name_as_filed(row, filed)
    if text:
        name = (row.get("target") or {}).get("name") or ""
        dup = row.get("status") == "duplicate"
        if dup:
            row["status"] = row.get("readStatus")
        set_aside_buyer(row, parse.filer_is_buyer(text, name))
        set_aside_target(row, parse.split_off(text, name), parse.paid_elsewhere(text, name))
        if dup:
            row["readStatus"], row["status"] = row["status"], "duplicate"
    row["targetReader"] = TARGET_READER
    return row


def reidentify_target(row: dict, target: dict, basis: str) -> dict:
    """
    A row stored under the wrong company takes the right one. What was read
    at the old company's CIK (the share count, the LTM, the balance sheet) is
    dropped, so the financials pass reads it again at the new one.
    """
    row["target"] = {k: target.get(k) for k in ("name", "cik", "sic", "sicDescription", "state")}
    row["targetBasis"] = [basis]
    # The buyer is derived again from the deal's buyer group (database.finalize).
    for k in FINANCIAL_FIELDS + ("formsUsed", "financialsReader", "companyFactsMissing", "acquirer"):
        row.pop(k, None)
    row["targetReader"] = TARGET_READER
    return row


def needs_target_reread(row: dict) -> bool:
    """A merger proxy still standing as a reading of a deal (a duplicate on its own reading) whose target was judged under an earlier rule."""
    return (row.get("targetReader") or 1) < TARGET_READER and (row.get("source") or "SC 13E3") in ("DEFM14A", "DEFM14C") and _reading_status(row) in ("ok", "no-offer") and bool(row.get("documentsRead"))


def reread_stale_targets(rows: dict[str, dict], ids: list[str], write, *, filed: dict[str, str] | None = None, cap: int | None = None, minutes: float = 15) -> int:
    """
    Judge again the target of every merger proxy in `ids` judged under an
    earlier rule, from its first document only, until the time budget is
    spent; a run cut short carries on next time. Filings of the last
    RECENT_MONTHS first, then the rest, oldest first within each (recent_first).
    `filed` maps an accession to the name its filer filed under (the form index).
    """
    budget = float(os.environ.get("PRECEDENTS_TARGET_MINUTES", minutes)) * 60
    todo = recent_first([i for i in ids if needs_target_reread(rows[i])], rows, key=lambda i: rows[i].get("filed") or "")
    if not todo:
        return 0
    print(f"{len(todo)} merger proxies whose target was judged under an earlier rule; judging them again for up to {budget / 60:.0f} minutes", file=sys.stderr, flush=True)
    started, done, aside = time.time(), 0, 0
    for i in todo:
        if time.time() - started > budget:
            break
        row = rows[i]
        try:
            text = to_text(fetch(row["documentsRead"][0], cap=cap))
        except Exception as e:  # noqa: BLE001
            row.setdefault("readErrors", []).append(f"{row['documentsRead'][0].rsplit('/', 1)[-1]}: {str(e)[:60]}")
            continue
        status = row.get("status")
        judge_target(row, text, (filed or {}).get(i))
        aside += row.get("status") != status
        done += 1
        if done % 10 == 0:
            write(rows)
    print(f"{done} of {len(todo)} targets judged again, {aside} set aside", file=sys.stderr, flush=True)
    return done


def reread_premiums(row: dict, *, cap: int | None = None, filed: str | None = None) -> dict:
    """
    A stored row's premiums read again from the documents it was read from.
    The agreement date and the financials stand: they were not what was
    wrong. The offer is read again only where an earlier offer reader read it
    (resolve_offer), and premiums are then tied to the whole offer.
    """
    statements: list[dict] = []
    aside: list[dict] = []
    texts: list[str] = []
    urls = row.get("documentsRead") or []
    for url in urls:
        try:
            texts.append(to_text(fetch(url, cap=cap)))
        except Exception as e:  # noqa: BLE001
            row.setdefault("readErrors", []).append(f"{url.rsplit('/', 1)[-1]}: {str(e)[:60]}")
            return row
    # A row dated by its filing, or by an agreement since revised, is dated
    # by the agreement it records before any premium is measured against it.
    resolve_announcement(row, texts)
    if (row.get("offerReader") or 1) < OFFER_READER:
        resolve_offer(row, urls, texts, reread=True)
    statements, aside = tied_statements(row, urls, texts)
    row = apply_premiums(row, statements, aside, texts)
    # A stored merger proxy read again is asked the joint-proxy question too
    # (Teledyne's proxy for FLIR stood as a deal for FLIR at $56.00), and
    # whose holders it pays.
    if texts and (row.get("source") or "SC 13E3") in ("DEFM14A", "DEFM14C"):
        return judge_target(row, texts[0], filed)
    return row


def reread_stale_premiums(rows: dict[str, dict], ids: list[str], write, *, cap: int | None = None, minutes: float | None = None, filed: dict[str, str] | None = None) -> int:
    """
    Read again the premiums of every row in `ids` that an earlier reader
    wrote, filings of the last RECENT_MONTHS first and then the rest, oldest
    first within each (recent_first), until the time budget is spent. A run
    cut short keeps what it read (written every ten rows) and the next run
    carries on, so a correction to the reader reaches the whole database over
    a run or two without a step ever overrunning its timeout.
    """
    budget = float(os.environ.get("PRECEDENTS_REREAD_MINUTES", minutes if minutes is not None else 40)) * 60
    todo = recent_first([i for i in ids if needs_premium_reread(rows[i])], rows, key=lambda i: rows[i].get("filed") or "")
    if not todo:
        return 0
    print(f"{len(todo)} rows read with an earlier premium reader; reading their premiums again for up to {budget / 60:.0f} minutes", file=sys.stderr, flush=True)
    started, done = time.time(), 0
    for i in todo:
        if time.time() - started > budget:
            break
        reread_premiums(rows[i], cap=cap, filed=(filed or {}).get(i))
        done += 1
        if done % 10 == 0:
            write(rows)
    print(f"{done} of {len(todo)} rows' premiums read again", file=sys.stderr, flush=True)
    return done


def needs_premium_reread(row: dict) -> bool:
    """A stored row with documents read and premiums, its date or its offer from an earlier reading."""
    stale = (row.get("premiumReader") or 1) < PREMIUM_READER or (row.get("announcedReader") or 1) < ANNOUNCED_READER or (row.get("offerReader") or 1) < OFFER_READER
    return stale and bool(row.get("documentsRead")) and row.get("status") in ("ok", "no-offer")


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
        """
        The period's own label. Company facts' fy and fp describe the filing
        the figure came from, not the figure: the prior-year comparative in a
        Q3 2022 10-Q carries fp Q3 and fy 2022 though it ends in September
        2021. The label is read from the period's end and length.
        """
        y, m = r["end"][:4], int(r["end"][5:7])
        days = Filings._days(r)
        if days is not None and days >= 340:
            return f"FY{y}" if r.get("fp") == "FY" and str(r.get("fy")) == y else f"year to {r['end']}"
        if days is not None and days > 100:
            return f"{round(days / 91.3)}Q to {r['end']}"
        return f"Q{(m + 2) // 3} {y}" if days is not None else (f"FY{y}" if r.get("form") in ANNUAL else f"Q{(m + 2) // 3} {y}")

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
    def _durations(self, key: str, only: list[str] | None = None) -> tuple[str, list[dict]]:
        _, unit, tags = CONCEPTS[key]
        if only is not None:
            tags = only

        def best(candidates: list[str]) -> tuple[str, list[dict], str]:
            best_tag, best_rows, best_end = None, [], ""
            for tag in candidates:
                rows = [r for r in self.observations(tag, unit) if r.get("form") in PERIODIC and r.get("start")]
                if not rows:
                    continue
                end = max(r["end"] for r in rows)
                if end > best_end:
                    best_tag, best_rows, best_end = tag, rows, end
            return best_tag or "", best_rows, best_end

        tag, rows, end = best(tags)
        if only is not None:
            return tag, rows
        # Revenue is the total. A REIT tags its rent as lease income and only
        # its fees as contract revenue, beside a Revenues total (Wheeler: $0.2m
        # of contract revenue in a $18.7m quarter); where another revenue
        # concept is tagged for the same latest period and is larger, it is
        # the total and the smaller one is a part of it.
        # Only the Revenues total takes over, never a figure including excise
        # and sales taxes (RevenueFromContractWithCustomerIncludingAssessedTax
        # is larger for a brewer, and is not its revenue).
        if key == "revenue" and rows and tag != "Revenues":
            tot = [r for r in self.observations("Revenues", unit) if r.get("form") in PERIODIC and r.get("start")]
            mine = [r for r in rows if r["end"] == end]
            at = [r for r in tot if r["end"] == end]
            if at and mine and max(abs(float(r["val"])) for r in at) > max(abs(float(r["val"])) for r in mine):
                tag, rows = "Revenues", tot
        # The fallback concepts, only where every usual one is missing or more
        # than fifteen months older than the date (see FALLBACK).
        floor = (date.fromisoformat(self.asof) - timedelta(days=456)).isoformat() if self.asof else ""
        if key in FALLBACK and (not rows or (floor and end < floor)):
            ftag, frows, fend = best(FALLBACK[key])
            if frows and fend > end:
                return ftag, frows
        return tag, rows

    def annual(self, key: str, only: list[str] | None = None) -> Fact | None:
        """The latest fiscal-year figure."""
        _, rows = self._durations(key, only)
        years = [r for r in rows if r.get("form") in ANNUAL and 340 <= (self._days(r) or 0) <= 400]
        if not years:
            return None
        by_end: dict[str, dict] = {}
        for r in years:
            k = by_end.get(r["end"])
            if not k or (r.get("filed") or "9999") < (k.get("filed") or "9999"):
                by_end[r["end"]] = r
        return self._fact(key, max(by_end.values(), key=lambda r: r["end"]))

    def ltm(self, key: str, only: list[str] | None = None) -> Fact | None:
        """
        Last twelve months: fiscal year + current YTD - prior-year YTD.

        The 10-Q carries the year-to-date figure and the comparative for the
        same months a year earlier, so the twelve months to the latest quarter
        end are one subtraction away from the 10-K. When the pieces are not
        there the fiscal year stands, and the basis says which.
        """
        ck = f"l:{key}:{','.join(only) if only else ''}"
        if ck in self._cache:
            return self._cache[ck]
        fy = self.annual(key, only)
        if not fy:
            self._cache[ck] = None
            return None
        _, rows = self._durations(key, only)
        fy_end = date.fromisoformat(fy.end)
        ytd = [r for r in rows if r.get("start") == (fy_end + timedelta(days=1)).isoformat() and r["end"] > fy.end and (self._days(r) or 0) < 300]
        out = fy
        if ytd:
            cur = max(ytd, key=lambda r: r["end"])
            cur_days = self._days(cur) or 0
            # A year earlier, within the week the match allows: a period ending
            # 29 February has no anniversary to replace(year=) into (Lennar).
            prior_end = date.fromisoformat(cur["end"]) - timedelta(days=365)
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
        # Both pieces must describe the same twelve months, to the week: one
        # period per multiple, never operating income of one year added to
        # depreciation of another. Where the D&A concept read first ends
        # elsewhere, another D&A concept the filer tags for the same twelve
        # months is used (WGL tags utility D&A to the quarter, total D&A only
        # to the year).
        same = lambda f: abs((date.fromisoformat(ebit.end) - date.fromisoformat(f.end)).days) <= 7  # noqa: E731
        if not same(da):
            da = next((f for f in (self.ltm("dAndA", [t]) for t in CONCEPTS["dAndA"][2] + FALLBACK["dAndA"]) if f and same(f)), None)
            if not da:
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


def _millions(value: float) -> float:
    """
    A flow in $m. Below $1m it keeps thousands: Arena Pharmaceuticals filed
    $37 thousand of revenue for the twelve months to September 2021, which at
    one decimal reads as 0.0, a revenue of nothing it never filed. A figure is
    0.0 only where the filing says zero.
    """
    return round(value / 1e6, 1 if abs(value) >= 1e6 else 3)


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
        out["ltmRevenue"] = _millions(rev.value)
        out["ltmPeriodEnd"] = rev.end
        out["forms"].extend([f"{rev.form} for {rev.period}"] + ([rev.also] if rev.also else []))
    if rev and rev.end >= floor:
        out["ltmRevenueEnd"] = rev.end
        out["revenueTag"] = rev.tag
    if ebitda and ebitda.end >= floor:
        out["ltmEbitda"] = _millions(ebitda.value)
        out["ltmPeriodEnd"] = out.get("ltmPeriodEnd") or ebitda.end
        out["ltmEbitdaEnd"] = ebitda.end
        out["ebitdaBasis"] = ebitda.basis
        # The impairment charged inside the same twelve months, as tagged, so
        # a reader can see an EBITDA that a write-down has depressed.
        imp = fl.ltm("impairment")
        if imp and abs((date.fromisoformat(imp.end) - date.fromisoformat(ebitda.end)).days) <= 7 and imp.value > 0:
            out["ltmImpairment"] = round(imp.value / 1e6, 1)
            out["impairmentTag"] = imp.tag
    # Operating income on its own twelve months, whether or not EBITDA was
    # built: an EV / EBIT multiple needs only the one concept, and a row whose
    # EBITDA pieces did not line up keeps its EBIT (Capri: $528m).
    if ebit and ebit.end >= floor:
        out["ltmEbit"] = _millions(ebit.value)
        out["ltmEbitEnd"] = ebit.end
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


# ── reading stored rows again ───────────────────────────────────────────────


#: what financials_at puts on a row
FINANCIAL_FIELDS = ("sharesOut", "ltmRevenue", "ltmEbitda", "ltmEbit", "ltmEbitEnd", "netDebt", "ltmPeriodEnd", "ltmRevenueEnd", "ltmEbitdaEnd", "revenueTag", "ltmImpairment", "impairmentTag", "balanceSheetDate", "ebitdaBasis", "netDebtBasis", "sharesBasis")

#: The reading a row's financials were made with. 3: the concept list (a
#: priced row read before it has its company facts read again, one request:
#: those with no revenue or no EBITDA first, because the concepts added may
#: give them one, then the rest, because an EBITDA read before may add
#: operating income and D&A of different twelve months). 4: the share count
#: the transaction statement states is a count of the shares outstanding,
#: never the shares issuable under options, awards, warrants or convertibles
#: (parse.outstanding_count). A row whose share count is the stated one, or
#: whose stated count's phrase now fails, has the count read again from its
#: own documents (stated_shares_stale); nothing else is asked of EDGAR, and
#: a row with neither is stamped without a request. 5: where the documents
#: state the target's share classes, the count is the sum of the classes that
#: receive the consideration on the same terms, or none (parse.stated_shares),
#: and a count naming another company is passed over; read again the same way.
#: The budget spreads it over a run or two.
FINANCIALS_READER = 5
#: the version at which the company-facts reading last changed: a row read at
#: it or later is not asked for its company facts again when only the share
#: count's reading moves on
FACTS_CONCEPTS = 3

#: days before a target whose company facts were not found (EDGAR answers 404:
#: it filed before XBRL, or not as itself) is asked again, rather than every month
FACTS_404_RETRY_DAYS = 183

#: what sharesOut says when it is the count the transaction statement states
STATED = "stated in the transaction statement"


def _facts_due(row: dict, today: date | None = None) -> bool:
    """Whether a row's company facts are to be asked for: read under an earlier concept list, or a 404 that has waited its six months."""
    missing = row.get("companyFactsMissing")
    if missing:
        try:
            return ((today or date.today()) - date.fromisoformat(missing[:10])).days >= FACTS_404_RETRY_DAYS
        except ValueError:
            return True
    return (row.get("financialsReader") or 1) < FACTS_CONCEPTS


def needs_financials_reread(row: dict, today: date | None = None) -> bool:
    if not (row.get("status") == "ok" and row.get("offerPrice") is not None):
        return False
    # A 404 waits its six months for the company facts, but not for the share
    # count, which is read from the row's own documents.
    return (row.get("financialsReader") or 1) < FINANCIALS_READER or _facts_due(row, today)


def stated_shares_stale(row: dict) -> bool:
    """
    Whether the row's stated share count is to be read again from its
    documents: where it is the row's share count (the company facts carry
    none), always, because the count chosen is the one stated most often and
    passing over an award's or a holding's mention of the same number can
    change which that is; elsewhere, where the phrase kept with it is one the
    reader now passes over (the phrase is the whole match, so it is judged
    again on its own). A stated count beside the company facts' count is not
    the one equity value is built on, so its phrase is enough (the words
    before a count are not kept with it, so a count only they disqualify is
    judged when the row's documents are next read).
    """
    if row.get("statedShares") is None:
        return False
    if (row.get("sharesBasis") or {}).get("tag") == STATED:
        return True
    n, _ = parse.parse_shares(row.get("statedSharesBasis") or "")
    return n is None or round(n, 3) != row["statedShares"]


def reread_stated_shares(row: dict, *, cap: int | None = None) -> bool:
    """
    A stale stated share count read again from the documents the row was read
    from, as on a first reading (parse.stated_shares: the first that states
    one gives it, all of them read for the target's classes and what each
    receives); none stated, none kept. False where a document could not be
    fetched: the row keeps what it has and is asked again next run.
    """
    if not stated_shares_stale(row):
        return True
    texts = []
    for url in row.get("documentsRead") or []:
        try:
            texts.append(to_text(fetch(url, cap=cap)))
        except Exception as e:  # noqa: BLE001
            row.setdefault("readErrors", []).append(f"{url.rsplit('/', 1)[-1]}: {str(e)[:60]}")
            return False
    for k in ("statedShares", "statedSharesBasis", "statedSharesClasses"):
        row.pop(k, None)
    set_stated_shares(row, parse.stated_shares(texts, company=target_names(row, row.get("documentsRead") or [], texts), offer=row.get("offerPrice")))
    return True


def target_names(row: dict, urls: list[str], texts: list[str]) -> tuple[str, ...]:
    """
    The names a share count may call the target by: its name now, and the
    name on the cover of a document filed in its own EDGAR folder (the
    registrant, or a 13E-3's subject company). PhenixFIN's merger proxy was
    filed as Medley Capital Corporation, and states "54,474,211 shares of MCC
    Common Stock outstanding": the target's own count, under its old name.
    """
    target = row.get("target") or {}
    names = [target.get("name")] if target.get("name") else []
    try:
        folder = f"/data/{int(target.get('cik') or 0)}/"
    except ValueError:
        folder = None
    for url, text in zip(urls, texts):
        if folder and folder in url:
            names += [n for n in parse.registrant_names(text) if n not in names]
    return tuple(names)


def set_stated_shares(row: dict, reading: dict | None) -> None:
    """
    A stated share reading put on a row: statedShares (millions, to the
    thousand) and statedSharesBasis (the phrase), and, where the documents
    state classes, statedSharesClasses: each class's count, the classes summed
    and the sentence that shows they receive the same consideration, those
    left out and why, or why there is no count.
    """
    if not reading:
        return
    if reading.get("count"):
        row["statedShares"], row["statedSharesBasis"] = round(reading["count"], 3), reading.get("phrase")
    if reading.get("classes"):
        row["statedSharesClasses"] = {k: reading[k] for k in ("classes", "summed", "terms", "excluded", "classPrices", "why") if reading.get(k)}


def _stated_fallback(row: dict) -> None:
    """The share count the transaction statement gives, where the company facts carry none; a stated count withdrawn takes sharesOut with it. A sum of classes says which, on sharesBasis."""
    if (row.get("sharesBasis") or {}).get("tag") == STATED and row.get("sharesOut") != row.get("statedShares"):
        row["sharesOut"] = None
        row["sharesBasis"] = None
    if not row.get("sharesOut") and row.get("statedShares"):
        row["sharesOut"] = row["statedShares"]
        row["sharesBasis"] = None
    if row.get("sharesOut") and (row.get("sharesBasis") is None or row["sharesBasis"].get("tag") == STATED):
        basis = {"tag": STATED, "phrase": row.get("statedSharesBasis")}
        classes = row.get("statedSharesClasses") or {}
        if classes.get("summed"):
            basis["classes"] = classes["summed"]
            basis["terms"] = classes.get("terms")
            if classes.get("excluded"):
                basis["excluded"] = classes["excluded"]
            if classes.get("classPrices"):
                basis["classPrices"] = classes["classPrices"]
        row["sharesBasis"] = basis


def reread_financials(row: dict, *, cap: int | None = None) -> dict:
    """A stored row's financials at announcement read again; nothing else on the row changes."""
    # The share count first: a document that cannot be fetched leaves the row
    # as it was, at the reader it was read with, for the next run.
    if not reread_stated_shares(row, cap=cap):
        return row
    if not _facts_due(row):
        # Only the share count's reading moved since this row's company facts
        # were read (or EDGAR said it has none, and the six months are not up):
        # no request, and the facts stand as they were read.
        row["financialsReader"] = FINANCIALS_READER
        _stated_fallback(row)
        return row
    try:
        fin = financials_at(row["target"]["cik"], row["announced"])
    except Exception as e:  # noqa: BLE001
        # EDGAR has no company facts for the target: keep the financials the
        # row has, record when it was asked, and ask again only after
        # FACTS_404_RETRY_DAYS rather than on every monthly run. Any other
        # failure is retried next run, as before.
        if "404" in str(e):
            row["companyFactsMissing"] = date.today().isoformat()
            row["readErrors"] = [x for x in (row.get("readErrors") or []) if "404" not in x] + [f"company facts: {str(e)[:60]}"]
            # The share count was read at this version all the same; the
            # marker, not the version, brings the facts back in six months.
            row["financialsReader"] = FINANCIALS_READER
            _stated_fallback(row)
        else:
            row.setdefault("readErrors", []).append(f"company facts: {str(e)[:60]}")
        return row
    row.pop("companyFactsMissing", None)
    # Every field the reader owns is replaced, a missing one included: an
    # EBITDA whose operating income and D&A were for different twelve months
    # is withdrawn, not left standing beside the corrected revenue.
    for k in FINANCIAL_FIELDS:
        row[k] = fin.get(k)
    row["formsUsed"] = fin.get("forms", [])
    row["financialsReader"] = FINANCIALS_READER
    # The share count the transaction statement gives stands where the
    # company facts carry none, as on a first reading.
    _stated_fallback(row)
    return row


def reread_stale_financials(rows: dict[str, dict], ids: list[str], write, *, minutes: float = 30, cap: int | None = None) -> int:
    """The priced rows in `ids` read under an earlier financials reader, read again until the budget is spent, recent filings first (recent_first)."""
    budget = float(os.environ.get("PRECEDENTS_FINANCIALS_MINUTES", minutes)) * 60
    due = [i for i in ids if needs_financials_reread(rows[i])]
    if not due:
        return 0
    # Filings of the last RECENT_MONTHS first, then the rest (recent_first).
    # Within each, the rows that need a request (company facts, or a stated
    # share count read again from the documents) first, those with no revenue
    # or no EBITDA first among them; a row whose only change is the version is
    # stamped without one, and the file is written every ten requests, not
    # every ten rows.
    asks = lambda i: _facts_due(rows[i]) or stated_shares_stale(rows[i])  # noqa: E731
    todo = recent_first(due, rows, key=lambda i: (not asks(i), rows[i].get("ltmRevenue") is not None and rows[i].get("ltmEbitda") is not None, rows[i].get("filed") or ""))
    n_ask = sum(1 for i in due if asks(i))
    print(f"{len(todo)} priced rows read under an earlier financials reader, {n_ask} needing a request (company facts, or a stated share count read again from the documents); reading them for up to {budget / 60:.0f} minutes", file=sys.stderr, flush=True)
    started, done, asked = time.time(), 0, 0
    for i in todo:
        if time.time() - started > budget:
            break
        ask = asks(i)
        reread_financials(rows[i], cap=cap)
        done += 1
        if ask:
            asked += 1
            if asked % 10 == 0:
                write(rows)
    print(f"{done} of {len(todo)} rows' financials read again, {asked} with a request", file=sys.stderr, flush=True)
    return done
