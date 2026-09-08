#!/usr/bin/env python3
"""
What the funds a candidate is interviewing at actually own, from their own filings.

Every institutional manager with more than $100m in US equities files a Form 13F-HR
within 45 days of each quarter end, listing every reportable position: issuer, CUSIP,
title of class, market value and share count. Since mid-2013 the holdings arrive as an
XML information table linked from the filing index, not as text inside the primary
document, so they can be read exactly rather than scraped approximately.

This reads them for a curated universe of roughly ninety managers (data/funds.universe.json)
and writes data/funds.auto.json: per manager, a quarterly history of portfolio value,
position count and concentration, plus the full latest holdings with a quarter-on-quarter
diff — what is new, added to, trimmed, held and sold out of.

  1. company search        name -> CIK, through EDGAR's own search, never hard-coded
  2. submissions           every 13F-HR the manager has filed, with period and date
  3. filing index          the information table XML inside each filing
  4. information table     the positions themselves

Three things decide whether the output is honest rather than merely plausible.

THE VALUE SCALE.  The value column was reported in THOUSANDS until the SEC's amended
Form 13F took effect, and in WHOLE DOLLARS after. Read it wrong and a manager looks a
thousand times bigger or smaller than it is. The filing says which itself: the primary
document carries <schemaVersion>, and X0202 is the version that came in with the whole
dollar requirement. Anything earlier, or absent, is thousands. We do not trust that
alone. Value divided by shares is a price per share, so the median across a filing's
positions lands near $100 when the column is dollars and near $0.10 when it is
thousands; where that evidence is unambiguous and contradicts the declared version, the
evidence wins and the run says so. Both are then checked against the filing's own
"Form 13F Information Table Value Total", which is stated in the same units as the
table and so proves the parse read every row.

THE DIFF.  action compares the latest quarter against the quarter immediately before it
for the same manager. Where that prior filing is missing, every position is reported as
held with prevShares null. A missing filing is not a hundred new positions, and printing
it as one would be a lie the page would then repeat.

THE TICKER.  The SEC does not publish a free CUSIP to ticker map. company_tickers.json
gives CIK, ticker and registrant name, so an issuer name that matches a registrant name
exactly, after normalising, resolves; anything else stays null. A wrong ticker on a
holdings page is worse than no ticker.

Incremental by default: a filing already parsed is read from .cache/funds rather than
fetched again. --full ignores the cache. One manager's failure never stops the run.

    python3 scripts/sync_funds.py                     # the curated universe, 8 quarters
    python3 scripts/sync_funds.py --resolve           # fill in missing CIKs, then stop
    python3 scripts/sync_funds.py --manager 0001067983   # refresh one, keep the rest
    python3 scripts/sync_funds.py --limit 5 --full
    python3 scripts/sync_funds.py --universe all      # every 13F filer; see below
"""

from __future__ import annotations

import argparse
import gzip
import html
import io
import json
import re
import statistics
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
UNIVERSE = ROOT / "data" / "funds.universe.json"
OUT = ROOT / "data" / "funds.auto.json"
CACHE = ROOT / ".cache" / "funds"

#: A contact in the user agent is what EDGAR asks for in return for no API key.
UA = "L3VLUP open skills contact@l3vlup.com"
ARCHIVES = "https://www.sec.gov/Archives/edgar"

#: Holdings written per manager. The cap is a file-size budget, not an opinion:
#: the site has to fetch this in one go. Position counts and portfolio value are
#: always the full filing, never the capped subset.
HOLDINGS_CAP = 200
EXITED_CAP = 100

#: Quarters of history per manager when --quarters is not given.
DEFAULT_QUARTERS = 8

#: The schema version that came in with the whole-dollar value column.
DOLLAR_SCHEMA = "X0202"


# ── HTTP ─────────────────────────────────────────────────────────────────────

_last = 0.0


def get(url: str, *, accept: str = "application/json", retries: int = 4) -> bytes:
    """One polite request: a contact in the user agent, a gap, and a backoff."""
    global _last
    err = None
    for attempt in range(retries):
        wait = _last + 0.15 - time.time()
        if wait > 0:
            time.sleep(wait)
        _last = time.time()
        req = urllib.request.Request(
            url, headers={"User-Agent": UA, "Accept": accept, "Accept-Encoding": "identity"}
        )
        try:
            with urllib.request.urlopen(req, timeout=90) as res:
                return res.read()
        except urllib.error.HTTPError as e:
            err = e
            if e.code == 404:
                raise
            # 403 and 429 are EDGAR asking us to slow down. 503 is EDGAR being busy.
            time.sleep(1.5 * (attempt + 1))
        except Exception as e:  # transient DNS, reset connection, read timeout
            err = e
            time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"{url} failed after {retries} attempts: {err}")


def get_json(url: str):
    return json.loads(get(url).decode("utf-8", "ignore"))


def get_text(url: str, accept: str = "text/html") -> str:
    return get(url, accept=accept).decode("utf-8", "ignore")


# ── names, slugs, quarters ───────────────────────────────────────────────────

#: Tokens that are legal form rather than identity, dropped from a slug.
ENTITY_SUFFIX = {
    "llc", "lp", "llp", "inc", "ltd", "plc", "corp", "co", "lc", "sa", "nv", "ag",
    "gmbh", "pte", "pty", "lllp", "cv", "ab", "as", "spa", "srl", "kk", "trust",
}

_LOWER_WORDS = {"of", "and", "the", "for", "de", "van", "von", "&"}

#: Words EDGAR writes in capitals that are capitals in life too.
_KEEP_UPPER = {
    "LLC", "LP", "LLP", "L.P.", "L.L.C.", "PLC", "AG", "NV", "SA",
    "UK", "US", "USA", "HK", "AB", "AS", "GP", "II", "III", "IV", "MFS", "AQR",
    "TCI", "PDT", "ARK", "GAMCO", "FMR", "D1", "AT&T", "ADR", "ADS", "ETF",
    "REIT", "PLC.", "NV.", "SPDR", "AMD", "IBM", "3M", "HP", "SAP", "UBS",
    "BHP", "CVS", "AIG", "TJX", "PNC", "KKR", "S&P", "NIKE",
}

#: Names whose own capitalisation is not a rule anything can derive.
_CASED = {
    "JPMORGAN": "JPMorgan", "ISHARES": "iShares", "ETRADE": "E*TRADE",
    "MCDONALDS": "McDonald's", "MCDONALD": "McDonald", "PAYPAL": "PayPal",
    "EBAY": "eBay", "SALESFORCE": "Salesforce", "GOPRO": "GoPro",
    "LINKEDIN": "LinkedIn", "YOUTUBE": "YouTube", "TSMC": "TSMC",
    "SANDISK": "SanDisk", "MICROSTRATEGY": "MicroStrategy",
}

_VOWELS = set("AEIOUY")


def title_case(name: str) -> str:
    """
    EDGAR shouts. 'TIGER GLOBAL MANAGEMENT LLC' is a database record, not a name.

    Applied to EDGAR's conformed name and to issuer names off the information
    table, never to a display name written by hand in the curated list.

    A short word with no vowel in it is an abbreviation, not a word, so it keeps
    its capitals: PLC, SPDR, TJX. The alternative rule, lowercase everything and
    capitalise the first letter, turns those into Plc and Tjx.
    """
    out = []
    for word in name.split():
        bare = word.strip(".,'")
        upper = bare.upper()
        if upper in _CASED:
            out.append(word.replace(bare, _CASED[upper]))
        elif word.upper() in _KEEP_UPPER or upper in _KEEP_UPPER:
            out.append(word.upper())
        elif len(bare) <= 5 and bare.isalnum() and not (set(upper) & _VOWELS):
            out.append(word.upper())  # PLC, TJX, SPDR, and initials
        elif len(bare) == 1 and bare.isalpha():
            out.append(word.upper())  # initials, as in SHAW D E & CO
        elif word.lower() in _LOWER_WORDS and out:
            out.append(word.lower())
        else:
            out.append(word.capitalize())
    return " ".join(out)


def slugify(name: str) -> str:
    """URL-safe, stable, and without the legal form nobody says out loud."""
    words = re.split(r"[^a-z0-9]+", name.lower())
    words = [w for w in words if w]
    while words and words[-1] in ENTITY_SUFFIX:
        words.pop()
    return "-".join(words) or "manager"


#: EDGAR writes a business address outside the United States as a code from its
#: own list, not as a country. Only codes actually seen in a run are mapped, and
#: each was confirmed against the domicile of the managers carrying it: X0 on
#: seven London firms, Y9 on two Jersey ones, K3 on a Hong Kong one. An unmapped
#: code is passed through as EDGAR wrote it rather than guessed at.
EDGAR_COUNTRY = {"X0": "United Kingdom", "Y9": "Jersey", "K3": "Hong Kong"}


def quarter_of(period: str) -> str:
    """'2026-06-30' -> '2026Q2'. The period of report, never the filing date."""
    y, m, _ = period.split("-")
    return f"{y}Q{(int(m) - 1) // 3 + 1}"


def quarter_key(q: str) -> tuple[int, int]:
    return int(q[:4]), int(q[5:])


# ── CIK resolution, through EDGAR's own search ───────────────────────────────

_CO_SEARCH = "https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&type=13F-HR&dateb=&owner=include&count=100"


def _norm_name(s: str) -> str:
    return " ".join(re.split(r"[^a-z0-9]+", s.lower())).strip()


def company_search(query: str) -> list[tuple[str, str, str]]:
    """
    (CIK, EDGAR conformed name, state) for every 13F filer whose name matches.

    EDGAR answers a company search two ways. When exactly one filer matches it
    returns that filer's record and its filing list; when several do it returns a
    table of them. The atom feed is clean for the first case and mangles the names
    in the second (it serialises Perl array refs), so the single case is read from
    atom and the ambiguous case from the HTML table, which is correct in both.
    """
    q = urllib.parse.quote(query)
    atom = get_text(f"{_CO_SEARCH}&company={q}&output=atom", accept="application/atom+xml")
    single = re.search(
        r"<company-info>(.*?)</company-info>", atom, re.S
    )
    if single and "<conformed-name>" in single.group(1):
        block = single.group(1)
        cik = re.search(r"<cik>(\d+)</cik>", block)
        name = re.search(r"<conformed-name>(.*?)</conformed-name>", block, re.S)
        state = re.search(r"<state-location>(.*?)</state-location>", block)
        if cik and name:
            return [(cik.group(1).zfill(10), name.group(1).strip(), state.group(1) if state else "")]

    page = get_text(f"{_CO_SEARCH}&company={q}")
    rows = re.findall(
        r'CIK=(\d{10})&amp;[^"]*"[^>]*>\s*\1\s*</a>\s*</td>\s*'
        r'<td[^>]*>(.*?)</td>\s*<td[^>]*>(?:<a[^>]*>)?(.*?)(?:</a>)?</td>',
        page,
        re.S,
    )
    out = []
    for cik, name, state in rows:
        # The name cell sometimes carries the filer's SIC code on a second line,
        # and EDGAR serves the page as HTML entities: 'BAILLIE GIFFORD &amp; CO'.
        name = re.split(r"\bSIC\s*:", html.unescape(re.sub(r"<[^>]+>", " ", name)))[0]
        name = " ".join(name.replace("\xa0", " ").split()).strip().rstrip(",")
        state = html.unescape(re.sub(r"<[^>]+>", "", state)).strip()
        if name:
            out.append((cik, name, state))
    return out


def entity_search(query: str) -> list[tuple[str, str, str]]:
    """
    The same question put to EDGAR full-text search, for filers company search misses.

    Company search matches the name index, which does not carry every 13F-only
    filer: Balyasny, T. Rowe Price and AllianceBernstein are all absent from it and
    all file every quarter. Full-text search indexes the filings themselves, so it
    finds them, but it ranks by relevance and will happily return an unrelated firm
    when nothing matches. Only filers whose own name contains every word of the
    query are kept, which makes a wrong answer impossible rather than unlikely.
    """
    url = ("https://efts.sec.gov/LATEST/search-index?forms=13F-HR&q="
           + urllib.parse.quote(f'"{query}"'))
    hits = get_json(url).get("hits", {}).get("hits", [])
    want = set(_norm_name(query).split())
    seen: dict[str, tuple[str, int]] = {}
    for h in hits:
        for display in h.get("_source", {}).get("display_names", []):
            m = re.match(r"^(.*?)\s*\(CIK (\d{10})\)$", display.strip())
            if not m:
                continue
            name = re.sub(r"\s*\([A-Z., ]+\)\s*$", "", m.group(1)).strip()
            if not want <= set(_norm_name(name).split()):
                continue
            cik = m.group(2)
            count = seen.get(cik, (name, 0))[1] + 1
            seen[cik] = (name, count)
    ranked = sorted(seen.items(), key=lambda kv: -kv[1][1])
    return [(cik, name, "") for cik, (name, _) in ranked]


def resolve_cik(entry: dict) -> tuple[str, str, str] | None:
    """
    A curated entry to (CIK, conformed name, state), or None with a reason printed.

    'match' pins the answer when the search is ambiguous. Without it, an ambiguous
    search is left unresolved and its candidates printed, because a manager pointing
    at the wrong CIK is worse than a manager missing from the page.
    """
    query = entry.get("search") or entry["name"]
    try:
        cands = company_search(query) or entity_search(query)
    except Exception as e:
        print(f"    search failed: {type(e).__name__}: {e}")
        return None
    if not cands:
        print(f"    no 13F filer named {query!r}")
        return None

    want = entry.get("match")
    if want:
        hit = [c for c in cands if _norm_name(c[1]) == _norm_name(want)]
        if not hit:
            print(f"    match {want!r} not among {[c[1] for c in cands][:8]}")
            return None
        return hit[0]

    if len(cands) == 1:
        return cands[0]

    # An exact hit on the display name settles it without a hand-written 'match'.
    exact = [c for c in cands if _norm_name(c[1]) == _norm_name(entry["name"])]
    if len(exact) == 1:
        return exact[0]
    print(f"    ambiguous ({len(cands)}): {[c[1] for c in cands][:8]} — add a \"match\"")
    return None


# ── submissions ──────────────────────────────────────────────────────────────

def submissions(cik: str, *, quarters: int = DEFAULT_QUARTERS) -> dict:
    """
    The filer's submission record, extended into EDGAR's overflow pages if needed.

    data.sec.gov keeps only the most recent filings inline and pushes the rest into
    numbered files. A manager who files a lot of something else — Berkshire and its
    Forms 4, a fund family and its N-PORTs — can have its 13F history pushed out of
    the inline list entirely, so the overflow is read whenever the inline list does
    not already reach back far enough.
    """
    sub = get_json(f"https://data.sec.gov/submissions/CIK{cik}.json")
    if len(filings_13f(sub)) >= quarters + 2:
        return sub
    recent = sub.get("filings", {}).get("recent", {})
    for extra in sub.get("filings", {}).get("files", []) or []:
        try:
            more = get_json(f"https://data.sec.gov/submissions/{extra['name']}")
        except Exception:
            break
        for key, values in more.items():
            recent.setdefault(key, [])
            recent[key].extend(values)
        if len(filings_13f(sub)) >= quarters + 2:
            break
    return sub


def filings_13f(sub: dict) -> list[dict]:
    """
    The manager's 13F holdings reports, newest period first, one per period.

    Where a period has both an original and a later amendment, the amendment is
    taken only when it restates the whole table. EDGAR's other amendment types add
    holdings previously withheld under confidential treatment rather than replacing
    what was filed, and merging those correctly needs both documents; taking the
    original is the conservative reading and the run says when it did.
    """
    r = sub.get("filings", {}).get("recent", {})
    forms = r.get("form", [])
    out = []
    for i, form in enumerate(forms):
        if form not in ("13F-HR", "13F-HR/A"):
            continue
        period = r["reportDate"][i]
        if not period:
            continue
        out.append({
            "form": form,
            "periodOfReport": period,
            "quarter": quarter_of(period),
            "filed": r["filingDate"][i],
            "accession": r["accessionNumber"][i],
        })
    out.sort(key=lambda f: (f["periodOfReport"], f["filed"]), reverse=True)
    return out


# ── the filing itself ────────────────────────────────────────────────────────

def _tag(el) -> str:
    return el.tag.rsplit("}", 1)[-1]


def _text(el, name: str) -> str | None:
    for child in el.iter():
        if _tag(child) == name and child.text:
            return child.text.strip()
    return None


def filing_dir(cik: str, accession: str) -> str:
    return f"{ARCHIVES}/data/{int(cik)}/{accession.replace('-', '')}"


def filing_url(cik: str, accession: str) -> str:
    return f"{filing_dir(cik, accession)}/{accession}-index.htm"


def parse_primary(xml: str) -> dict:
    """The cover page and summary page: who filed, for when, and their own totals."""
    root = ET.fromstring(xml)
    summary = next((e for e in root.iter() if _tag(e) == "summaryPage"), None)
    amend = next((e for e in root.iter() if _tag(e) == "amendmentInfo"), None)
    manager = next((e for e in root.iter() if _tag(e) == "filingManager"), None)

    def num(el, name):
        v = _text(el, name) if el is not None else None
        try:
            return int(float(v))
        except (TypeError, ValueError):
            return None

    return {
        "schemaVersion": _text(root, "schemaVersion") or "",
        "isAmendment": (_text(root, "isAmendment") or "").lower() == "true",
        "amendmentType": (_text(amend, "amendmentType") if amend is not None else None) or "",
        "managerName": (_text(manager, "name") if manager is not None else None) or "",
        "entryTotal": num(summary, "tableEntryTotal"),
        "valueTotal": num(summary, "tableValueTotal"),
    }


def parse_infotable(xml: bytes) -> list[dict]:
    """
    Every row of the information table.

    A manager reports one row per (position, other-manager combination), so the same
    CUSIP appears many times in a filing from anyone who allocates across funds.
    Rows are returned raw here and aggregated by the caller; summing before knowing
    the value scale would throw away the evidence the scale is decided on.
    """
    rows = []
    for _, el in ET.iterparse(io.BytesIO(xml), events=("end",)):
        if _tag(el) != "infoTable":
            continue
        cusip = (_text(el, "cusip") or "").strip().upper()
        try:
            value = float(_text(el, "value") or 0)
        except ValueError:
            value = 0.0
        try:
            shares = float(_text(el, "sshPrnamt") or 0)
        except ValueError:
            shares = 0.0
        rows.append({
            "cusip": cusip,
            "issuer": (_text(el, "nameOfIssuer") or "").strip(),
            "class": (_text(el, "titleOfClass") or "").strip(),
            "putCall": (_text(el, "putCall") or "").strip().upper(),
            "type": (_text(el, "sshPrnamtType") or "SH").strip().upper(),
            "value": value,
            "shares": shares,
        })
        el.clear()
    return rows


def value_scale(schema_version: str, rows: list[dict]) -> tuple[float, str]:
    """
    How many dollars one unit of the value column is worth, and why we think so.

    Declared: <schemaVersion>X0202</schemaVersion> or later is the amended Form 13F,
    whole dollars. Earlier, or absent, is thousands.

    Observed: value divided by shares is a price. Across a filing's ordinary share
    lines the median of that lands in the tens or hundreds of dollars when the column
    is dollars, and three orders of magnitude lower when it is thousands. Where the
    observation is unambiguous — a median above $2 or below $0.50, over at least ten
    lines — it is the stronger evidence, because it comes from the numbers themselves
    rather than from a version string a filer's agent may have got wrong.
    """
    declared = 1.0 if (schema_version or "").upper() >= DOLLAR_SCHEMA else 1000.0
    prices = [
        r["value"] / r["shares"]
        for r in rows
        if r["type"] == "SH" and r["shares"] > 0 and r["value"] > 0 and not r["putCall"]
    ]
    if len(prices) < 10:
        return declared, f"schemaVersion {schema_version or 'absent'}"
    median = statistics.median(prices)
    observed = 1.0 if median >= 2.0 else 1000.0 if median <= 0.5 else None
    if observed is None or observed == declared:
        return declared, f"schemaVersion {schema_version or 'absent'}, median price ${median * declared:,.2f}"
    return observed, (
        f"median price ${median * observed:,.2f} over {len(prices)} lines overrides "
        f"schemaVersion {schema_version or 'absent'}"
    )


def aggregate(rows: list[dict], scale: float) -> list[dict]:
    """
    Rows to positions, in dollars, largest first.

    Keyed on CUSIP, class and option flag together. A call on a stock is not the same
    position as the stock, and a manager who holds both would otherwise appear to hold
    one position of the sum, which is not what the filing says.
    """
    agg: dict[tuple, dict] = {}
    for r in rows:
        cls = r["class"]
        if r["putCall"]:
            cls = f"{cls} {r['putCall']}".strip()
        key = (r["cusip"], cls.upper())
        pos = agg.get(key)
        if pos is None:
            pos = agg[key] = {
                "cusip": r["cusip"], "issuer": r["issuer"], "class": cls,
                "value": 0.0, "shares": 0.0,
            }
        pos["value"] += r["value"] * scale
        pos["shares"] += r["shares"]
    out = sorted(agg.values(), key=lambda p: p["value"], reverse=True)
    for p in out:
        p["shares"] = int(round(p["shares"]))
    return out


def read_cover(cik: str, accession: str, *, use_cache: bool = True) -> dict:
    """
    An amendment's cover page alone, cached, to learn whether it restates the table.

    Reading the cover is one small request; reading the table is a large one. An
    amendment that only adds previously withheld holdings is never downloaded.
    """
    path = CACHE / cik / f"{accession}.cover.json"
    if use_cache and path.exists():
        try:
            return json.loads(path.read_text())
        except Exception:
            path.unlink(missing_ok=True)
    meta = parse_primary(
        get_text(f"{filing_dir(cik, accession)}/primary_doc.xml", accept="application/xml")
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(meta, separators=(",", ":")))
    return meta


def read_filing(cik: str, f: dict, *, use_cache: bool = True) -> dict | None:
    """
    One filing, parsed to positions, cached on disk.

    The cache is keyed on accession, which never changes once a filing is accepted,
    so a cache hit is exact rather than merely recent. Returns None where the filing
    carries no information table at all: a manager whose whole table is under
    confidential treatment files the form with nothing in it, and pre-2013 filings
    put the table in the primary document as plain text, which this does not read.
    """
    path = CACHE / cik / f"{f['accession']}.json.gz"
    if use_cache and path.exists():
        try:
            with gzip.open(path, "rt", encoding="utf-8") as fh:
                cached = json.load(fh)
            cached["fromCache"] = True
            return cached
        except Exception:
            path.unlink(missing_ok=True)

    base = filing_dir(cik, f["accession"])
    index = get_json(f"{base}/index.json")
    names = [i["name"] for i in index.get("directory", {}).get("item", [])]

    primary = next((n for n in names if n.lower().endswith("primary_doc.xml")), None)
    meta = parse_primary(get_text(f"{base}/{primary}", accept="application/xml")) if primary else {}

    table = next(
        (n for n in names
         if n.lower().endswith(".xml") and not n.lower().endswith("primary_doc.xml")),
        None,
    )
    if not table:
        return None

    rows = parse_infotable(get(f"{base}/{table}", accept="application/xml"))
    if not rows:
        return None

    # EDGAR writes a single placeholder row — CUSIP 000000000, 'No Issuer',
    # 'Empty Title' — into a holdings report that has no holdings to report,
    # which is what a manager files when every position is under confidential
    # treatment or when it has nothing reportable that quarter. It is a real
    # filing of an empty table, not a position worth nothing, so the row goes
    # and the filing stays: the quarter belongs in the history with a zero.
    rows = [r for r in rows if r["cusip"] and r["cusip"] != "0" * 9]

    scale, basis = value_scale(meta.get("schemaVersion", ""), rows)
    positions = aggregate(rows, scale)
    total = sum(p["value"] for p in positions)

    # The filing states its own totals in the units of its own table. Comparing
    # against them proves every row was read, independently of the scale question.
    declared_total = meta.get("valueTotal")
    declared_rows = meta.get("entryTotal")
    checks = {
        "declaredValueTotal": declared_total,
        "declaredEntryTotal": declared_rows,
        "readRows": len(rows),
        "valueTotalDeltaPct": (
            round((total / scale - declared_total) / declared_total * 100, 4)
            if declared_total else None
        ),
    }

    out = {
        "accession": f["accession"],
        "quarter": f["quarter"],
        "periodOfReport": f["periodOfReport"],
        "filed": f["filed"],
        "form": f["form"],
        "filingUrl": filing_url(cik, f["accession"]),
        "scale": scale,
        "scaleBasis": basis,
        "aum": round(total / 1e6, 1),
        "positions": len(positions),
        "top10Pct": round(sum(p["value"] for p in positions[:10]) / total, 4) if total else None,
        "checks": checks,
        "holdings": positions,
    }

    path.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(path, "wt", encoding="utf-8") as fh:
        json.dump(out, fh, separators=(",", ":"))
    out["fromCache"] = False
    return out


# ── tickers ──────────────────────────────────────────────────────────────────

_STRIP_WORDS = {
    "inc", "incorporated", "corp", "corporation", "co", "company", "the", "plc",
    "ltd", "limited", "lp", "llc", "holdings", "holding", "group", "sa", "nv",
    "ag", "class", "cl", "com", "new", "adr", "ads", "spons", "sponsored",
}


def _issuer_key(name: str) -> str:
    words = [w for w in re.split(r"[^a-z0-9]+", name.lower()) if w]
    kept = [w for w in words if w not in _STRIP_WORDS]
    return " ".join(kept or words)


def ticker_index() -> dict[str, str]:
    """
    Registrant name to ticker, from the SEC's own file, keeping only unique keys.

    company_tickers.json is CIK, ticker and registrant name. It is not a CUSIP map
    and there is no free one, so an issuer name on a 13F is matched against the
    registrant name. Where two registrants normalise to the same key the key is
    dropped rather than guessed at: half the ambiguous pairs are share classes of
    one company and half are unrelated companies, and telling them apart from the
    name alone is not possible.
    """
    try:
        rows = get_json("https://www.sec.gov/files/company_tickers.json")
    except Exception as e:
        print(f"  ticker file unavailable ({type(e).__name__}); every ticker will be null")
        return {}
    idx: dict[str, str | None] = {}
    for r in rows.values():
        key = _issuer_key(str(r.get("title", "")))
        tick = str(r.get("ticker", "")).upper().strip()
        if not key or not tick:
            continue
        if key in idx and idx[key] != tick:
            idx[key] = None
        else:
            idx.setdefault(key, tick)
    return {k: v for k, v in idx.items() if v}


# ── assembling one manager ───────────────────────────────────────────────────

def place(code: str) -> str | None:
    """A US state code as it stands; a country code as its country; nothing as null."""
    return EDGAR_COUNTRY.get(code, code) or None


def action_for(shares: float, prev: float | None) -> str:
    if prev is None:
        return "held"
    if shares > prev:
        return "added"
    if shares < prev:
        return "trimmed"
    return "held"


def build_manager(entry: dict, cik: str, sub: dict, quarters: int, *, use_cache: bool,
                  tickers: dict[str, str], stats: dict) -> dict | None:
    filings = filings_13f(sub)
    if not filings:
        print("    no 13F-HR filings on file")
        return None

    # One filing per period: the latest original, replaced by a later amendment only
    # when that amendment restates the table.
    by_period: dict[str, dict] = {}
    for f in filings:
        p = f["periodOfReport"]
        if p not in by_period:
            by_period[p] = f
        elif f["form"] == "13F-HR" and by_period[p]["form"] == "13F-HR/A":
            by_period[p] = f
    chosen = sorted(by_period.values(), key=lambda f: f["periodOfReport"], reverse=True)[:quarters]

    for f in chosen:
        later = [
            a for a in filings
            if a["periodOfReport"] == f["periodOfReport"]
            and a["form"] == "13F-HR/A"
            and a["filed"] >= f["filed"]
            and a["accession"] != f["accession"]
        ]
        for a in sorted(later, key=lambda a: a["filed"]):
            try:
                meta = read_cover(cik, a["accession"], use_cache=use_cache)
            except Exception:
                continue
            if meta.get("amendmentType", "").upper().startswith("RESTAT"):
                f.update(a)
            elif meta.get("amendmentType"):
                stats["amendmentsSkipped"] += 1

    parsed: list[dict] = []
    for f in chosen:
        try:
            got = read_filing(cik, f, use_cache=use_cache)
        except Exception as e:
            print(f"    {f['quarter']} {f['accession']}: {type(e).__name__}: {e}")
            stats["filingErrors"] += 1
            continue
        if got is None:
            stats["filingsEmpty"] += 1
            continue
        stats["cached" if got.get("fromCache") else "fetched"] += 1
        delta = (got.get("checks") or {}).get("valueTotalDeltaPct")
        if delta is not None and abs(delta) > 0.5:
            stats["totalMismatch"].append(
                f"{entry['name']} {got['quarter']} off the filing's own total by {delta}%"
            )
        parsed.append(got)

    if not parsed:
        return None
    parsed.sort(key=lambda p: p["periodOfReport"], reverse=True)

    history = [{
        "quarter": p["quarter"],
        "periodOfReport": p["periodOfReport"],
        "filed": p["filed"],
        "accession": p["accession"],
        "filingUrl": p["filingUrl"],
        "aum": p["aum"],
        "positions": p["positions"],
        "top10Pct": p["top10Pct"],
    } for p in parsed]

    latest = parsed[0]
    prior = parsed[1] if len(parsed) > 1 else None
    # A prior filing is only a comparison if it is the quarter immediately before.
    if prior is not None:
        y, q = quarter_key(latest["quarter"])
        want = f"{y - 1}Q4" if q == 1 else f"{y}Q{q - 1}"
        if prior["quarter"] != want:
            prior = None

    # A quarter-on-quarter diff needs both quarters to say something. A filing
    # with an empty table says only that nothing was reported, so comparing to it
    # would turn a reporting event into a hundred sales that never happened.
    if not latest["holdings"]:
        prior = None

    prev_by_key = {}
    if prior:
        for p in prior["holdings"]:
            prev_by_key[(p["cusip"], p["class"].upper())] = p

    total = sum(p["value"] for p in latest["holdings"]) or 1.0
    holdings = []
    for p in latest["holdings"][:HOLDINGS_CAP]:
        key = (p["cusip"], p["class"].upper())
        prev = prev_by_key.get(key)
        tick = tickers.get(_issuer_key(p["issuer"]))
        stats["tickerTried"] += 1
        if tick:
            stats["tickerHit"] += 1
        # No prior filing at all: everything is held with nothing to compare to.
        # A prior filing that does not carry the position: genuinely new.
        if prior is None:
            action = "held"
        elif prev is None:
            action = "new"
        else:
            action = action_for(p["shares"], prev["shares"])
        holdings.append({
            "cusip": p["cusip"],
            "issuer": title_case(p["issuer"]) if p["issuer"].isupper() else p["issuer"],
            "class": p["class"],
            "ticker": tick,
            "value": round(p["value"] / 1e6, 1),
            "shares": p["shares"],
            "weight": round(p["value"] / total, 6),
            "prevShares": prev["shares"] if prev else None,
            "prevValue": round(prev["value"] / 1e6, 1) if prev else None,
            "changeShares": (p["shares"] - prev["shares"]) if prev else None,
            "changeValue": round((p["value"] - prev["value"]) / 1e6, 1) if prev else None,
            "action": action,
        })

    # Exits are counted per security, not per line of the table. A manager who
    # closed a call but kept the common stock has not exited the name, and a
    # manager who reported one CUSIP under two classes has not exited it twice;
    # a CUSIP leaves only when no class of it is reported any more, and the
    # classes it did hold are added together.
    exited = []
    if prior:
        still_held = {p["cusip"] for p in latest["holdings"]}
        gone: dict[str, dict] = {}
        for p in prior["holdings"]:
            if p["cusip"] in still_held:
                continue
            row = gone.setdefault(p["cusip"], {
                "cusip": p["cusip"],
                "issuer": title_case(p["issuer"]) if p["issuer"].isupper() else p["issuer"],
                "ticker": tickers.get(_issuer_key(p["issuer"])),
                "prevValue": 0.0,
                "prevShares": 0,
            })
            row["prevValue"] += p["value"]
            row["prevShares"] += p["shares"]
        for row in sorted(gone.values(), key=lambda r: -r["prevValue"])[:EXITED_CAP]:
            row["prevValue"] = round(row["prevValue"] / 1e6, 1)
            exited.append(row)

    business = sub.get("addresses", {}).get("business", {}) or {}
    return {
        "cik": cik,
        "name": entry.get("name") or title_case(sub.get("name", "")),
        "slug": slugify(entry.get("name") or sub.get("name", "") or cik),
        "strategy": entry.get("strategy") or "Unclassified",
        "state": place((business.get("stateOrCountry") or "").strip()),
        "history": history,
        "latest": {
            "quarter": latest["quarter"],
            "periodOfReport": latest["periodOfReport"],
            "filed": latest["filed"],
            "filingUrl": latest["filingUrl"],
            "aum": latest["aum"],
            "positions": latest["positions"],
            "top10Pct": latest["top10Pct"],
            "holdings": holdings,
            "exited": exited,
        },
    }


# ── the wider universe ───────────────────────────────────────────────────────

def all_filers(quarter: str) -> list[dict]:
    """
    Every manager that filed a 13F-HR in one quarter, from EDGAR's own form index.

    The documented switch out of the curated list. The 2026 Q3 index carries 8,883
    of them, most being registered investment advisers running index sleeves and
    separately managed accounts, so a full crawl runs to hundreds of megabytes and
    tells a candidate nothing the curated list does not. Off by default and kept
    honest rather than kept secret: pair it with --limit, or with a size filter of
    your own, before running it for real.
    """
    y, q = quarter[:4], quarter[5:]
    idx = get_text(f"{ARCHIVES}/full-index/{y}/QTR{q}/form.idx", accept="text/plain")
    seen: dict[str, dict] = {}
    for line in idx.splitlines():
        line = line.rstrip()
        if not line.startswith("13F-HR"):
            continue
        # form type | company name | CIK | date filed | file name, column-aligned
        m = re.match(r"^(13F-HR(?:/A)?)\s{2,}(.+?)\s{2,}(\d+)\s+(\d{4}-\d{2}-\d{2})\s+(\S+)$", line)
        if not m:
            continue
        cik = m.group(3).zfill(10)
        seen.setdefault(cik, {"name": title_case(m.group(2).strip()), "strategy": "Unclassified"})
    return [dict(v, cik=k) for k, v in seen.items()]


# ── the run ──────────────────────────────────────────────────────────────────

def load_universe() -> dict:
    return json.loads(UNIVERSE.read_text())


def cmd_resolve(uni: dict) -> None:
    """Fill in every missing CIK from EDGAR's company search and save the list."""
    changed = 0
    for entry in uni["managers"]:
        if entry.get("cik"):
            continue
        print(f"  {entry['name']}")
        got = resolve_cik(entry)
        if not got:
            continue
        cik, conformed, state = got
        entry["cik"] = cik
        entry["edgarName"] = conformed
        changed += 1
        print(f"    {cik}  {conformed}")
    if changed:
        UNIVERSE.write_text(json.dumps(uni, indent=2) + "\n")
    missing = [m["name"] for m in uni["managers"] if not m.get("cik")]
    print(f"\nresolved {changed}, unresolved {len(missing)}")
    for m in missing:
        print(f"  unresolved: {m}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--quarters", type=int, default=DEFAULT_QUARTERS,
                    help=f"quarters of history per manager (default {DEFAULT_QUARTERS})")
    ap.add_argument("--limit", type=int, help="stop after this many managers")
    ap.add_argument("--manager", help="one CIK only")
    ap.add_argument("--full", action="store_true", help="re-read filings already cached")
    ap.add_argument("--resolve", action="store_true", help="fill in missing CIKs and stop")
    ap.add_argument("--universe", choices=("curated", "all"), default="curated",
                    help="'all' crawls every 13F-HR filer in the latest quarter (see all_filers)")
    ap.add_argument("--out", type=Path, action="append", default=None,
                    help="write the output here as well as data/funds.auto.json")
    args = ap.parse_args()

    uni = load_universe()
    if args.resolve:
        cmd_resolve(uni)
        return

    managers = uni["managers"]
    if args.universe == "all":
        now = datetime.now(timezone.utc)
        q = f"{now.year}Q{(now.month - 1) // 3 + 1}"
        print(f"enumerating every 13F-HR filer in {q}")
        managers = all_filers(q)
        print(f"  {len(managers)} filers")

    if args.manager:
        want = args.manager.zfill(10)
        managers = [m for m in managers if (m.get("cik") or "").zfill(10) == want]
    if args.limit:
        managers = managers[: args.limit]

    print(f"{len(managers)} managers · {args.quarters} quarters · "
          f"cache {'ignored' if args.full else CACHE}")

    tickers = ticker_index()
    print(f"ticker index: {len(tickers)} unambiguous registrant names\n")

    stats = {
        "fetched": 0, "cached": 0, "filingErrors": 0, "filingsEmpty": 0,
        "amendmentsSkipped": 0, "tickerTried": 0, "tickerHit": 0,
        "totalMismatch": [], "failed": [],
    }
    out: list[dict] = []

    for i, entry in enumerate(managers, 1):
        label = entry.get("name", entry.get("cik", "?"))
        cik = (entry.get("cik") or "").zfill(10) if entry.get("cik") else None
        try:
            if not cik:
                got = resolve_cik(entry)
                if not got:
                    stats["failed"].append(f"{label}: unresolved CIK")
                    continue
                cik = got[0]
            sub = submissions(cik, quarters=args.quarters)
            m = build_manager(entry, cik, sub, args.quarters,
                              use_cache=not args.full, tickers=tickers, stats=stats)
        except Exception as e:
            print(f"[{i:>3}/{len(managers)}] {label}: {type(e).__name__}: {e}")
            stats["failed"].append(f"{label}: {type(e).__name__}: {e}")
            continue
        if not m:
            print(f"[{i:>3}/{len(managers)}] {label}: no readable holdings")
            stats["failed"].append(f"{label}: no readable holdings")
            continue
        out.append(m)
        lat = m["latest"]
        print(f"[{i:>3}/{len(managers)}] {m['slug']:<38} {lat['quarter']}  "
              f"${lat['aum']:>12,.1f}mm  {lat['positions']:>6,} pos  "
              f"top10 {(lat['top10Pct'] or 0) * 100:>5.1f}%  "
              f"{len(m['history'])}q  {len(lat['exited'])} exited")

    # A partial run refreshes part of the file rather than replacing it. Rebuilding
    # one manager should not throw away the other ninety-four, and --manager is
    # only useful if it can be run on its own.
    partial = bool(args.manager or args.limit) and OUT.exists()
    if partial:
        try:
            kept = json.loads(OUT.read_text()).get("managers", [])
        except Exception:
            kept = []
        fresh = {m["cik"] for m in out}
        out = out + [m for m in kept if m["cik"] not in fresh]
        print(f"merged {len(fresh)} rebuilt manager(s) into {len(out)} already in {OUT.name}")

    # Slugs are what the page routes on, so a collision would silently merge two
    # managers into one URL. Disambiguate with the CIK rather than dropping either.
    seen: dict[str, dict] = {}
    for m in out:
        if m["slug"] in seen:
            m["slug"] = f"{m['slug']}-{m['cik'].lstrip('0')}"
        seen[m["slug"]] = m

    quarters = sorted({h["quarter"] for m in out for h in m["history"]},
                      key=quarter_key, reverse=True)
    payload = {
        "generatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "quarters": quarters,
        "counts": {
            "managers": len(out),
            "withHoldings": sum(1 for m in out if m["latest"]["holdings"]),
            "quarters": len(quarters),
            # Every position in every manager's latest filing, uncapped: what the
            # dataset describes, not what it prints.
            "positions": sum(m["latest"]["positions"] for m in out),
        },
        "managers": sorted(out, key=lambda m: -(m["latest"]["aum"] or 0)),
    }

    body = json.dumps(payload, separators=(",", ":")) + "\n"
    targets = [OUT] + list(args.out or [])
    for t in targets:
        t.parent.mkdir(parents=True, exist_ok=True)
        t.write_text(body)
        print(f"\nwrote {t} ({len(body) / 1e6:.2f} MB)")

    hit = stats["tickerHit"] / stats["tickerTried"] * 100 if stats["tickerTried"] else 0
    print(f"managers {len(out)} in the file, {len(managers) - len(stats['failed'])}/{len(managers)} "
          f"read this run · quarters {len(quarters)} · positions {payload['counts']['positions']:,}")
    print(f"filings fetched {stats['fetched']} · from cache {stats['cached']} · "
          f"errors {stats['filingErrors']} · no table {stats['filingsEmpty']} · "
          f"non-restating amendments skipped {stats['amendmentsSkipped']}")
    print(f"tickers resolved {stats['tickerHit']:,}/{stats['tickerTried']:,} ({hit:.1f}%)")
    for msg in stats["totalMismatch"][:20]:
        print(f"  value total: {msg}")
    for msg in stats["failed"]:
        print(f"  no data: {msg}")
    if len(body) > 8e6:
        print(f"  over the 8MB budget at {len(body) / 1e6:.2f} MB — "
              f"lower --quarters before lowering HOLDINGS_CAP")


if __name__ == "__main__":
    sys.exit(main())
