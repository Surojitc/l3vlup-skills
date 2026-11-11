#!/usr/bin/env python3
"""
The 13F Explorer's precomputed data, from the published 13F record.

    python3 scripts/funds_explorer.py            # writes data/funds/explorer/
    python3 scripts/funds_explorer.py --check    # builds and reports, writes nothing

WHY THIS EXISTS
---------------
The Explorer (/intel/13f on the site) answers questions across every manager
and every symbol at once: which stocks the most managers bought last quarter,
what a sector's holders did, which theme a manager leans to. Answering those
from data/funds/by-ticker means reading four thousand files, and the site must
not do that at request time. So it is done once here, at publication, straight
after the history step, and the answers are published under
data/funds/explorer/. The decision record is docs/13f-explorer-2026-11.md in
the site repository; every rule below is one of its rules.

What it reads, all local and all already published (no SEC request is made):

- data/funds/books/<id>/<q>.json (complete books for the recent quarters,
  used only where their signature is the history's) and
  data/funds/securities.json (when each CUSIP was first listed);

- data/funds/history/<id>/index.json (every manager-quarter's book figures and
  filing) and, for the two quarters a manager row describes, its <year>.json
  (the listed positions);
- data/funds/by-ticker/<SYMBOL>.json (who listed each symbol, quarter by
  quarter: holders as [managerIndex, valueK, action, shares], exits as
  [managerIndex, priorValueK]);
- data/peers.auto.json (the SEC's SIC code per listed ticker),
  data/cusip-tickers.auto.json (CUSIP to ticker, and which tickers are funds)
  and data/funds.themes.json (the sector ranges and the theme table).

The rules it keeps
------------------
- Comparable managers only. A manager counts in a quarter's changes only if it
  filed that quarter and the one immediately before, and the history compared
  them (`vsPrior`). Holders, value and shares in a quarter file are counted
  over the same managers, so every number in one row shares one denominator.
- Buying means more shares. new / added / trimmed / held are the action codes
  funds_history.derive gave each position against the manager's WHOLE filing.
  A value that rose with no rise in shares is a price move and is never a buy.
- netShares is shares, from listed share counts on both sides of the quarter.
  Where a comparable manager's count on either side is not listed (a position
  below a large book's listed line), the sum is unknown and is null.
- A split is not trading. Where at least 70% of the comparable managers that
  listed a symbol in both quarters show the same split factor within 3%, the
  quarter is marked, its added and trimmed counts are not counted as buyers or
  sellers, and netShares is null.
- Complete books first (round two). For the recent quarters
  scripts/funds_books.py keeps every manager's whole information table under
  data/funds/books. A comparable manager with a book for the quarter and the
  one before is read from them: holders, value, actions (sync_funds.action_for
  on whole share counts), exits and share changes. Anyone else is read from
  its listed rows as before. A row is coverage 'complete' only when every
  comparable manager was read whole, and only then is conviction given.
- Listing status. A CUSIP first seen in any tracked book in q is a new
  listing in q; a symbol first seen in q whose CUSIP was held before is new
  coverage. Neither is ranked as accumulation (`rank: false`), nor is a split.
- Price consistency. With three or more filers of a security in a quarter, a
  line whose implied price is more than 5% from the others' median is
  flagged: it counts in holders and value as filed and is left out of
  netShares, conviction and split detection.
- Breadth is buyers - sellers (new + added - trimmed - exited among the
  comparable managers); conviction is netShares over the prior quarter's
  comparable shares of the same managers.
- The default quarter is the newest that at least 75% of the managers on file
  have filed, so a consensus is never read off a handful of early filers.
- Classification comes from a SIC code or a published ticker list and nothing
  else; funds and ETFs are their own bucket.

Deterministic: keys sorted, compact separators, and a file whose content is
unchanged apart from `generatedAt` is not rewritten (funds_history.same_content).
Standard library only.
"""

from __future__ import annotations

import argparse
import json
import math
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(Path(__file__).resolve().parent))
from sync_funds import action_for  # noqa: E402  the history's own rule: more shares is added, fewer trimmed

SCHEMA = 1
WINDOW = 12             # quarters with a cross-section file, newest first
SPARK = 8               # quarters of holders in each stock's sparkline, ending at the default
DEFAULT_SHARE = 0.75    # filed by at least this share of the managers on file
SPLIT_SHARE = 0.70      # of comparable managers listing the symbol in both quarters
SPLIT_TOLERANCE = 0.03  # within 3% of the factor
SPLIT_MIN_HOLDERS = 2   # one manager doubling a position is a trade, not a split
SPLIT_FACTORS = (2, 3, 4, 5, 10, 20)
PRICE_FACTORS = (2, 3, 4, 5, 6, 8, 10, 15, 20, 25, 50)  # forward splits the price test looks for
PRICE_MIN = 5            # holders in both quarters before the price test is tried
AGG_MIN = 10             # holders in both quarters before the aggregate test is tried
PRICE_FLAG = 0.05        # a line more than 5% from the others' median implied price
PRICE_FLAG_MIN = 3       # priced lines in the quarter before any is flagged
TOP_THEMES = 3
ACTION_CODE = {"new": "n", "added": "a", "trimmed": "t", "held": "h"}
RIGHTS = ("PUT", "CALL")
TICKER_FILE = re.compile(r"^[A-Z0-9][A-Z0-9.\-]{0,9}$")
QUARTER = re.compile(r"^\d{4}Q[1-4]$")


# ── small pure helpers ───────────────────────────────────────────────────────

def norm_ticker(t: str | None) -> str:
    """One spelling per symbol: the SEC file writes BRK-B where a 13F map may write BRK.B or BRK/B."""
    return re.sub(r"[./ ]", "-", (t or "").strip().upper())


def quarter_key(q: str) -> tuple[int, int]:
    return int(q[:4]), int(q[5])


def previous_quarter(q: str) -> str:
    y, n = quarter_key(q)
    return f"{y - 1}Q4" if n == 1 else f"{y}Q{n - 1}"


def parse_range(r: str) -> tuple[int, int]:
    a, _, b = str(r).partition("-")
    lo, hi = int(a), int(b or a)
    if lo > hi:
        raise ValueError(f"SIC range {r} runs backwards")
    return lo, hi


def in_ranges(code: str | None, ranges: list[str]) -> bool:
    if not code or not str(code).isdigit():
        return False
    c = int(code)
    return any(lo <= c <= hi for lo, hi in map(parse_range, ranges))


def same_content(old: str, new: str) -> bool:
    """Equal apart from the run's own timestamp (the same rule as funds_history.same_content)."""
    try:
        a, b = json.loads(old), json.loads(new)
    except Exception:
        return False
    a.pop("generatedAt", None)
    b.pop("generatedAt", None)
    return a == b


def dumps(body: dict) -> str:
    return json.dumps(body, separators=(",", ":"), sort_keys=True, ensure_ascii=False) + "\n"


# ── classification ───────────────────────────────────────────────────────────

class Classifier:
    """
    Sector and themes for a ticker, from the SIC code the SEC assigns it, the
    CUSIP map's fund list and the explicit ticker lists of the theme table.
    Nothing else is consulted.
    """

    def __init__(self, table: dict, sic_by_ticker: dict[str, str], funds: set[str]):
        self.table = table
        self.sic = sic_by_ticker
        self.funds = funds
        self.sectors = {k: v for k, v in table["sectors"].items()}
        self.themes = table["themes"]
        self.theme_tickers = {k: {norm_ticker(t) for t in v.get("tickers", [])} for k, v in self.themes.items()}

    def classify(self, ticker: str) -> dict:
        t = norm_ticker(ticker)
        fund = t in self.funds
        sic = self.sic.get(t)
        if fund:
            sec = "funds"
        else:
            sec = next((k for k, v in self.sectors.items() if v.get("sic") and in_ranges(sic, v["sic"])), None)
        themes = []
        for k, v in self.themes.items():
            if t in self.theme_tickers[k] or (not fund and in_ranges(sic, v.get("sic", []))):
                themes.append(k)
        return {"sic": sic, "sec": sec, "th": sorted(themes), "fund": fund}


def sic_map(peers: dict) -> dict[str, str]:
    """Ticker (normalised) to SIC code. A ticker listed under two codes is left unclassified."""
    seen: dict[str, set[str]] = {}
    for code, ind in (peers.get("industries") or {}).items():
        for row in ind.get("listed") or []:
            t = norm_ticker(row.get("ticker"))
            if t:
                seen.setdefault(t, set()).add(str(code))
    return {t: next(iter(c)) for t, c in seen.items() if len(c) == 1}


def issuer_sics(sics: dict[str, str], cusip_tickers: dict[str, str]) -> dict[str, str]:
    """
    The SIC map, with a share class the SEC's ticker file does not list
    classified by its issuer.

    The SEC's file names one ticker per company, so a second class (GOOG
    beside GOOGL, a company's B shares) has no SIC of its own and was counted
    as unclassified: most of the 2.7% of value at Q2 2026. A CUSIP's first six
    characters are the issuer number, the same for every class of one issuer,
    so a ticker with no SIC takes the SIC its issuer's other classes carry,
    and only when they all agree. Nothing is inferred from a name.
    """
    by_issuer: dict[str, set[str]] = {}
    for cusip, t in cusip_tickers.items():
        if isinstance(cusip, str) and len(cusip) >= 6 and t:
            by_issuer.setdefault(cusip[:6], set()).add(norm_ticker(t))
    out = dict(sics)
    for tickers in by_issuer.values():
        codes = {sics[t] for t in tickers if t in sics}
        if len(codes) != 1:
            continue
        code = next(iter(codes))
        for t in tickers:
            out.setdefault(t, code)
    return out


def table_problems(table: dict) -> list[str]:
    """What is wrong with a theme table, so a bad hand edit fails loudly instead of misfiling stocks."""
    out = []
    owner: dict[int, str] = {}
    for key, s in table.get("sectors", {}).items():
        if not s.get("label"):
            out.append(f"sector {key} has no label")
        for r in s.get("sic", []):
            try:
                lo, hi = parse_range(r)
            except Exception:
                out.append(f"sector {key}: unreadable range {r!r}")
                continue
            for c in range(lo, hi + 1):
                if c in owner:
                    out.append(f"SIC {c:04d} is in both {owner[c]} and {key}")
                    break
                owner[c] = key
    for key, th in table.get("themes", {}).items():
        if th.get("kind") not in ("standard", "bespoke"):
            out.append(f"theme {key}: kind must be standard or bespoke")
        if not th.get("label") or not th.get("definition"):
            out.append(f"theme {key} needs a label and a one-line definition")
        if th.get("kind") == "standard" and th.get("tickers"):
            out.append(f"theme {key} is standard, so it is SIC codes only; a ticker list makes it bespoke")
        if th.get("kind") == "bespoke" and not th.get("tickers"):
            out.append(f"theme {key} is bespoke and publishes no ticker list")
        for r in th.get("sic", []):
            try:
                parse_range(r)
            except Exception:
                out.append(f"theme {key}: unreadable range {r!r}")
    return out


# ── who filed what ───────────────────────────────────────────────────────────

def filings(indexes: list[dict]) -> dict[str, dict[str, dict]]:
    """Manager id to {quarter: that quarter's record in its history index}."""
    return {d["id"]: {q["quarter"]: q for q in d.get("quarters", [])} for d in indexes}


def comparable(filed: dict[str, dict[str, dict]], q: str) -> set[str]:
    """Managers that filed q and the quarter immediately before it, and were compared across the two."""
    prior = previous_quarter(q)
    return {m for m, qs in filed.items() if q in qs and prior in qs and qs[q].get("vsPrior") == prior}


def coverage(filed: dict[str, dict[str, dict]], quarters: list[str]) -> dict[str, dict]:
    on_file = len(filed)
    return {
        q: {
            "managersFiled": sum(1 for qs in filed.values() if q in qs),
            "managersComparable": len(comparable(filed, q)),
            "managersOnFile": on_file,
        }
        for q in quarters
    }


def window(filed: dict[str, dict[str, dict]], n: int = WINDOW) -> list[str]:
    """The newest n quarters any manager has filed, newest first."""
    qs = {q for m in filed.values() for q in m if QUARTER.match(q)}
    return sorted(qs, key=quarter_key, reverse=True)[:n]


def default_quarter(cov: dict[str, dict], quarters: list[str]) -> str | None:
    """The newest quarter filed by at least 75% of the managers on file."""
    for q in sorted(quarters, key=quarter_key, reverse=True):
        c = cov[q]
        if c["managersOnFile"] and c["managersFiled"] >= DEFAULT_SHARE * c["managersOnFile"]:
            return q
    return None


# ── one symbol in one quarter ────────────────────────────────────────────────

def _median(xs: list[float]) -> float:
    xs = sorted(xs)
    n = len(xs)
    return xs[n // 2] if n % 2 else (xs[n // 2 - 1] + xs[n // 2]) / 2


def split_test(pairs: list[tuple]) -> tuple[float, str] | None:
    """
    The split factor these holders agree on, and which test found it, or None.

    `pairs` is one (shares now, shares before, valueK now, valueK before) per
    comparable manager that listed the symbol in both quarters.

    "holders" is the rule in the decision record: at least SPLIT_MIN_HOLDERS
    holders, and at least 70% of them within 3% of one factor in
    SPLIT_FACTORS or its inverse.

    "price" catches the splits that rule cannot see. Active managers trade in
    the quarter a split happens, so on the real data NVDA's 10-for-1 (2024Q2)
    had 8 of 53 holders within 3% of ten and every other holder would have
    been called a buyer. A split also divides the price every manager
    reports, so this test asks for both signs at once: at least PRICE_MIN
    holders; the median share ratio within 15% of a forward factor (the
    nearest one, so the factor is approximate where holders traded heavily
    through the split); at least 15% of holders within 10% of it; and the median reported price per share
    (value over shares) fallen by that factor, give or take the quarter's own
    price move (40%, or 20% for a two-for-one, where a stock that halved and
    holders who averaged down would otherwise look the same). Reverse splits
    are left to the holders test: in this universe a halving of shares beside
    a doubling of price is far more often a sale into a rally.
    """
    pairs = [p for p in pairs if all(x and x > 0 for x in p)]
    if len(pairs) >= SPLIT_MIN_HOLDERS:
        best, best_n = None, 0
        for f in [*SPLIT_FACTORS, *(1 / f for f in SPLIT_FACTORS)]:
            n = sum(1 for a, b, _va, _vb in pairs if abs(a / b - f) <= SPLIT_TOLERANCE * f)
            if n > best_n:
                best, best_n = f, n
        if best is not None and best_n >= SPLIT_SHARE * len(pairs):
            return round(best, 4), "holders"
    if len(pairs) >= PRICE_MIN:
        ratio = _median([a / b for a, b, _va, _vb in pairs])
        price = _median([vb / b for _a, b, _va, vb in pairs]) / _median([va / a for a, _b, va, _vb in pairs])
        f = min(PRICE_FACTORS, key=lambda f: abs(math.log(ratio / f)))
        near = sum(1 for a, b, _va, _vb in pairs if abs(math.log(a / b / f)) <= math.log(1.10)) / len(pairs)
        band = 1.20 if f == 2 else 1.40
        if (abs(math.log(ratio / f)) <= math.log(1.15) and near >= 0.15
                and abs(math.log(price / f)) <= math.log(band)):
            return float(f), "price"
    if len(pairs) >= AGG_MIN:
        # "aggregate": the holders' summed shares. Trading nets out across
        # thirty managers far better than it does in any one median: on the
        # complete books KLA (2026Q2) had summed shares x9.99 and Booking
        # x24.1, while the median ratio (10.1, 21.6) sat between factors and
        # KLA's price fell only 4.9-fold because the stock doubled through
        # its ten-for-one. So, with at least AGG_MIN holders in both
        # quarters: the summed-share ratio within 5% of a forward factor of
        # three or more, the median ratio within 25% of it, at least 15% of
        # holders within 10% of it, and the median price fallen by at least
        # the factor over 2.5 and at most 1.4 times it. Two-for-one is left
        # to the other tests: a stock that halved while its holders doubled
        # down looks the same.
        ratio = _median([a / b for a, b, _va, _vb in pairs])
        price = _median([vb / b for _a, b, _va, vb in pairs]) / _median([va / a for a, _b, va, _vb in pairs])
        total = sum(a for a, _b, _va, _vb in pairs) / sum(b for _a, b, _va, _vb in pairs)
        f = min(PRICE_FACTORS, key=lambda f: abs(math.log(total / f)))
        near = sum(1 for a, b, _va, _vb in pairs if abs(math.log(a / b / f)) <= math.log(1.10)) / len(pairs)
        if (f >= 3 and abs(math.log(total / f)) <= math.log(1.05) and abs(math.log(ratio / f)) <= math.log(1.25)
                and near >= 0.15 and f / 2.5 <= price <= f * 1.40):
            return float(f), "aggregate"
    return None


STALE_MATCH = 0.02       # a line within 2% of last quarter's consensus price is priced at last quarter
STALE_SHARE = 0.80       # of a manager-quarter's comparable lines, before the filing is read as last quarter's prices
ROUNDING_K = 0.5         # values are filed rounded to the nearest $1,000: half of it, in $K


def consensus_prices(lines_by_symbol: dict[str, dict[str, dict[str, tuple[float, float]]]]) -> dict[tuple[str, str], float]:
    """(symbol, quarter) -> the median implied price ($K per share) over every line, where three or more lines are priced."""
    out: dict[tuple[str, str], float] = {}
    for t, by_q in lines_by_symbol.items():
        for qq, lines in by_q.items():
            ps = sorted(v / s for v, s in lines.values() if v and s and v > 0 and s > 0)
            if len(ps) >= PRICE_FLAG_MIN:
                out[(t, qq)] = _median(ps)
    return out


def stale_valuations(lines_by_symbol: dict, consensus: dict[tuple[str, str], float], quarters: list[str]) -> dict[str, set[str]]:
    """
    The manager-quarters valued at the previous quarter end's prices.

    AllianceBernstein's 13F for Q1 and for Q2 2026 values every position at
    the prices of the quarter before: in both, 99 to 100% of its lines sit
    within 2% of the other filers' prior-quarter price, against 11% within 2%
    of the same quarter's (its NVDA line, $16.78bn for 96.2m shares, is
    $174.40 a share, the March close, against $200.09 for every other filer
    at June). Its share counts are the quarter end's. So such a filing's
    values are shown as filed, with a note, and its share counts are used:
    excluding them, as a price flag did, dropped the largest book of its kind
    from every net share change in two quarters for a pricing convention.

    Read as stale when at least STALE_SHARE of the manager's lines that can
    be judged both ways match last quarter's consensus within STALE_MATCH and
    fewer than half match this quarter's within PRICE_FLAG.
    """
    out: dict[str, set[str]] = {}
    for qq in quarters:
        prev = previous_quarter(qq)
        prior_hits: dict[str, int] = {}
        same_hits: dict[str, int] = {}
        judged: dict[str, int] = {}
        for t, by_q in lines_by_symbol.items():
            now, before = consensus.get((t, qq)), consensus.get((t, prev))
            if not now or not before or abs(now / before - 1) <= PRICE_FLAG:
                continue  # a price that barely moved cannot tell the two quarters apart
            for m, (v, sh) in by_q.get(qq, {}).items():
                if not (v and sh and v > 0 and sh > 0) or ROUNDING_K / sh > PRICE_FLAG * now:
                    continue
                p = v / sh
                judged[m] = judged.get(m, 0) + 1
                if abs(p / before - 1) <= STALE_MATCH:
                    prior_hits[m] = prior_hits.get(m, 0) + 1
                if abs(p / now - 1) <= PRICE_FLAG:
                    same_hits[m] = same_hits.get(m, 0) + 1
        out[qq] = {m for m, n in judged.items()
                   if n >= 20 and prior_hits.get(m, 0) >= STALE_SHARE * n and same_hits.get(m, 0) < 0.5 * n}
    return out


def price_flags(lines: dict[str, tuple[float, float]], *, stale: set[str] | None = None) -> set[str]:
    """
    The lines whose implied price disagrees with everyone else's (round two, rule 3).

    `lines` is {manager: (valueK, shares)} for every tracked manager holding
    the security in one quarter. With three or more priced lines, a line whose
    value over shares is more than PRICE_FLAG from the median of the OTHER
    lines is flagged. These are the managers' own filed figures (a stale
    price, a share count in the wrong unit); they are shown as filed and kept
    out of share arithmetic, never corrected.
    """
    priced = sorted(((v / s, m) for m, (v, s) in lines.items() if v and s and v > 0 and s > 0))
    n = len(priced)
    if n < PRICE_FLAG_MIN:
        return set()
    ps = [p for p, _m in priced]
    out = set()
    k = n - 1  # the others
    for i, (p, m) in enumerate(priced):
        def at(j: int) -> float:
            return ps[j] if j < i else ps[j + 1]
        med = at(k // 2) if k % 2 else (at(k // 2 - 1) + at(k // 2)) / 2
        if not (med > 0 and abs(p / med - 1) > PRICE_FLAG):
            continue
        # Not flagged, its share count kept: a filing valued at last quarter's
        # prices (above), or a small line whose value, filed to the nearest
        # $1,000, cannot carry a price to 5% (462 of the unexplained 943 at Q2
        # 2026, median value $13K). A single line at last quarter's price is
        # NOT excused on its own: in a split quarter that is a stale share
        # count at the old price, the opposite case, and only a whole filing
        # priced at last quarter can tell the two apart.
        if stale and m in stale:
            continue
        sh = lines[m][1]
        if sh and ROUNDING_K / sh > PRICE_FLAG * med:
            continue
        out.add(m)
    return out


def listing_status(q: str, first_cusip: str | None, first_ticker: str | None,
                   prior_holders: int | None = None, holders: int | None = None) -> str | None:
    """
    'new-listing' when the security's CUSIP first appears in any tracked book
    in q; 'recent-listing' when it first appeared in the quarter before;
    'new-coverage' when the symbol first appears in q but its CUSIP was
    held earlier (the CUSIP map learned it, or it was held only as a right or
    below a listed line); otherwise None. Neither is ranked as accumulation.
    """
    if first_cusip == q:
        return "new-listing"
    # The quarter after a listing is still a listing's quarter, not a change
    # of view: a spin-off traded when-issued (Versigent, VGNT, held by three
    # managers at its first quarter end) or an IPO's first full quarter moves
    # from a base of a few holders, so its breadth and conviction (254x for
    # VGNT) measure the listing, not managers turning towards the stock.
    # Only from a thin base (at most three holders, or a quarter of today's,
    # the quarter before), so a security first seen in the window's earliest
    # book because it sat below a listed line before is not called one.
    if (first_cusip is not None and first_cusip == previous_quarter(q)
            and prior_holders is not None and holders
            and prior_holders <= max(3, holders // 4)):
        return "recent-listing"
    if first_ticker == q and first_cusip is not None and quarter_key(first_cusip) < quarter_key(q):
        return "new-coverage"
    return None


def symbol_quarter(doc: dict, q: str, comp: set[str], *, agg: dict | None = None, paired: set[str] | None = None,
                   whole: set[str] | None = None, flags: dict[str, set[str]] | None = None,
                   listing: str | None = None) -> dict:
    """
    One symbol's row in quarter q, over the comparable managers `comp` only.

    `doc` is a by-ticker file: the listed rows. `agg` is {(manager, quarter):
    {ticker: (shares, valueK)}} from the complete books, and `paired` the
    comparable managers with a book for both q and the quarter before: for
    those, holders, value, actions (sf.action_for on whole share counts),
    exits and share changes come from the books, and every other manager is
    read from its listed rows as before. `whole` is the comparable managers
    whose listed rows are their whole book in both quarters. The row is
    `coverage: 'complete'` only when every comparable manager is paired or
    whole, so a manager not listing the stock is known not to hold it.

    `flags` is {quarter: managers whose line fails the price test}: they count
    in holders and value as filed and are left out of netShares, conviction
    and split detection.
    """
    agg = agg or {}
    paired = paired or set()
    whole = whole or set()
    flags = flags or {}
    t = doc["ticker"]
    ids = [m[0] for m in doc.get("managers", [])]
    prior = previous_quarter(q)

    def rows(qq: str) -> dict[str, tuple[int, str, float]]:
        out = {}
        for r in doc.get("quarters", {}).get(qq, []):
            mid = ids[r[0]]
            if mid in comp and mid not in paired:
                out[mid] = (r[1], r[2], r[3] if len(r) > 3 else None)
        return out

    cur, before = rows(q), rows(prior)
    exited = {ids[r[0]] for r in doc.get("exits", {}).get(q, []) if ids[r[0]] in comp and ids[r[0]] not in paired}
    for m in paired:
        c = agg.get((m, q), {}).get(t)
        b = agg.get((m, prior), {}).get(t)
        if b is not None:
            before[m] = (b[1], "h", b[0])
        if c is not None:
            action = "n" if b is None else ACTION_CODE[action_for(c[0], b[0])]
            cur[m] = (c[1], action, c[0])
        elif b is not None:
            exited.add(m)

    counts = {"new": 0, "added": 0, "trimmed": 0, "held": 0}
    code = {"n": "new", "a": "added", "t": "trimmed", "h": "held"}
    for _v, a, _s in cur.values():
        counts[code.get(a, "held")] += 1

    flagged_now = sorted(m for m in cur if m in flags.get(q, set()))
    out_of_shares = flags.get(q, set()) | flags.get(prior, set())
    pairs = [(cur[m][2], before[m][2], cur[m][0], before[m][0]) for m in cur if m in before and m not in out_of_shares]
    found = split_test(pairs)
    split = found[0] if found else None

    # Shares bought or sold, summed over the comparable managers, only where
    # both sides of every change are known: from a book, or from listed rows.
    # A manager with a flagged line on either side is left out.
    net: float | None = 0
    prior_shares = 0.0
    for m in comp:
        if m in out_of_shares:
            continue
        c, b = cur.get(m), before.get(m)
        if c is None and b is None:
            continue
        if c is not None and c[2] is None or b is not None and b[2] is None:
            net = None
            break
        if b is not None:
            prior_shares += b[2]
        if c is not None and b is not None:
            net += c[2] - b[2]
        elif c is not None and c[1] == "n":
            net += c[2]            # new against the whole prior filing: it held none
        elif c is None and m in exited:
            net -= b[2]            # the filing shows the position gone
        else:
            net = None             # one side is below the manager's listed line
            break
    if split is not None:
        net = None

    complete = bool(comp) and all(m in paired or m in whole for m in comp)
    buyers = counts["new"] + (0 if split is not None else counts["added"])
    sellers = len(exited) + (0 if split is not None else counts["trimmed"])
    conviction = (round(net / prior_shares, 4) if complete and split is None and net is not None and prior_shares > 0
                  else None)
    return {
        "t": t,
        "h": len(cur),
        "v": int(sum(v for v, _a, _s in cur.values())),
        "s": int(sum(s or 0 for _v, _a, s in cur.values())),
        **counts,
        "exited": len(exited),
        "buyers": buyers,
        "sellers": sellers,
        "netShares": None if net is None else int(net),
        "split": split,
        **({"splitTest": found[1]} if found else {}),
        "coverage": "complete" if complete else "listed",
        "listing": listing,
        "priceFlags": len(flagged_now),
        **({"flagged": flagged_now} if flagged_now else {}),
        # Positioning, not value: managers that bought less managers that sold,
        # among those holding it in either quarter (added and trimmed are
        # already left out of buyers and sellers in a split quarter).
        "breadth": buyers - sellers,
        "conviction": conviction,
        "rank": listing is None and split is None,
        "_holders": sorted(cur),
        # Each comparable holder's line, for the stock page's holder table in
        # a quarter read from complete books: [valueK, shares, action, shares
        # the quarter before or None]; and the exits with their prior value.
        "_detail": {m: [int(v), int(sh or 0), a, (int(before[m][2]) if m in before and before[m][2] is not None else None)]
                    for m, (v, a, sh) in sorted(cur.items())},
        "_exits": {m: int(before[m][0]) for m in sorted(exited) if m in before},
    }


# ── the whole build (pure: every input passed in) ────────────────────────────

def manager_weights(holdings: list, tickers: dict[str, str], clf: Classifier) -> tuple[dict, dict]:
    """A manager's listed positions as sector and theme weights among listed value. Puts and calls left out."""
    total = 0.0
    sec: dict[str, float] = {}
    th: dict[str, float] = {}
    for cusip, cls, _shares, value_k, _code in holdings:
        if str(cls).upper().endswith(RIGHTS) or not value_k or value_k <= 0:
            continue
        total += value_k
        t = tickers.get(cusip)
        c = clf.classify(t) if t else {"sec": None, "th": []}
        key = c["sec"] or "unclassified"
        sec[key] = sec.get(key, 0.0) + value_k
        for k in c["th"]:
            th[k] = th.get(k, 0.0) + value_k
    if not total:
        return {}, {}
    return ({k: round(v / total, 4) for k, v in sec.items() if round(v / total, 4)},
            {k: round(v / total, 4) for k, v in th.items() if round(v / total, 4)})


# (ticker, quarter) -> {cusip: managers whose book lists it}, filled by
# book_aggregates for reissued(): which CUSIP each holder held the symbol under.
holders_of: dict[tuple[str, str], dict[str, set[str]]] = {}


def reissued(t: str, q: str) -> bool:
    """
    Whether the symbol was reissued under a new CUSIP in q: a CUSIP held by
    three or more managers the quarter before is held by none now, and a CUSIP
    none held then is held now by at least half of the old one's holders.
    That is a corporate action (a reverse split, a reorganisation, an
    exchange), and the share counts either side of it are not comparable.
    DuPont at 2026Q2 (26614N102 to 26614N201, shares a third, price three
    times) and Honeywell (438516106 to 438516205) are the cases that led the
    reduction table as selling before this.
    """
    before = holders_of.get((t, previous_quarter(q)), {})
    now = holders_of.get((t, q), {})
    for old, had in before.items():
        if len(had) < 3 or old in now:
            continue
        for new, has in now.items():
            if new not in before and len(has & had) >= len(had) / 2:
                return True
    return False


def book_aggregates(books: dict[tuple[str, str], list], tickers: dict[str, str]) -> tuple[dict, dict, dict]:
    """
    The complete books by symbol, the way the by-ticker files group listed rows.

    Returns ({(manager, quarter): {ticker: (shares, valueK)}}, {ticker: {cusips}},
    {cusip: first quarter in any book}). Puts and calls are left out of the
    symbol totals, as everywhere; every line counts towards when a CUSIP was
    first seen.
    """
    agg: dict[tuple[str, str], dict[str, tuple[int, int]]] = {}
    cusips_of: dict[str, set[str]] = {}
    first: dict[str, str] = {}
    holders_of.clear()
    for (m, q), rows in books.items():
        here: dict[str, list] = {}
        for cusip, _cls, value_k, shares, put_call in rows:
            if cusip not in first or quarter_key(q) < quarter_key(first[cusip]):
                first[cusip] = q
            if put_call:
                continue
            t = tickers.get(cusip)
            if not t:
                continue
            a = here.setdefault(t, [0, 0])
            a[0] += shares
            a[1] += value_k
            cusips_of.setdefault(t, set()).add(cusip)
            holders_of.setdefault((t, q), {}).setdefault(cusip, set()).add(m)
        agg[(m, q)] = {t: (a[0], a[1]) for t, a in here.items()}
    return agg, cusips_of, first


def build(*, indexes: list[dict], by_ticker: list[dict], peers: dict, cusips: dict, table: dict,
          holdings: dict[tuple[str, str], list] | None = None, books: dict[tuple[str, str], list] | None = None,
          first_seen: dict[str, str] | None = None, now: str | None = None) -> dict[str, dict]:
    """
    Every Explorer file, as {relative path: body}.

    `holdings` maps (manager id, quarter) to that quarter's listed positions,
    for the manager rows; only the quarters a manager row describes are needed.
    `books` maps (manager id, quarter) to that quarter's complete information
    table (data/funds/books rows), only where its signature is the history's.
    `first_seen` is each CUSIP's first quarter in the listed history
    (securities.json); the books add what sat below a listed line.
    """
    problems = table_problems(table)
    if problems:
        raise SystemExit("data/funds.themes.json: " + "; ".join(problems))
    now = now or datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    tickers = cusips.get("tickers", {}) or {}
    funds = {norm_ticker(t) for t in cusips.get("funds", []) or []}
    clf = Classifier(table, issuer_sics(sic_map(peers), tickers), funds)
    holdings = holdings or {}

    filed = filings(indexes)
    quarters = window(filed)
    cov = coverage(filed, quarters)
    default = default_quarter(cov, quarters)
    comp = {q: comparable(filed, q) for q in quarters}
    spark_qs = sorted([q for q in quarters if default and quarter_key(q) <= quarter_key(default)], key=quarter_key)[-SPARK:]

    docs = sorted((d for d in by_ticker if TICKER_FILE.match(d.get("ticker", ""))), key=lambda d: d["ticker"])
    cls_of = {d["ticker"]: clf.classify(d["ticker"]) for d in docs}

    # The complete books, and who is complete in each quarter: a comparable
    # manager with a book for the quarter and the one before (`paired`), or
    # one whose listed rows are its whole book on both sides (`whole`).
    books = books or {}
    agg, book_cusips, book_first = book_aggregates(books, tickers)
    first_seen = dict(first_seen or {})
    for c, q in book_first.items():
        if c not in first_seen or quarter_key(q) < quarter_key(first_seen[c]):
            first_seen[c] = q
    paired = {q: {m for m in comp[q] if (m, q) in books and (m, previous_quarter(q)) in books} for q in quarters}

    def is_whole(m: str, q: str) -> bool:
        r = filed.get(m, {}).get(q)
        return bool(r) and (r.get("listed") or 0) >= (r.get("positions") or 0)
    whole = {q: {m for m in comp[q] if is_whole(m, q) and is_whole(m, previous_quarter(q))} for q in quarters}
    by_book: dict[str, dict[str, dict[str, tuple[int, int]]]] = {}
    for (m, bq), a in agg.items():
        for t, sv in a.items():
            by_book.setdefault(t, {}).setdefault(bq, {})[m] = sv
    flag_qs = sorted(set(quarters) | {previous_quarter(q) for q in quarters}, key=quarter_key)

    per_q: dict[str, list[dict]] = {q: [] for q in quarters}
    flag_counts: dict[str, dict[str, int]] = {q: {} for q in quarters}
    # Every manager's line for every symbol and quarter, from its book where it
    # has one: first for the consensus prices and the filings valued at last
    # quarter's prices, then for each symbol's flags.
    all_lines: dict[str, dict[str, dict[str, tuple[float, float]]]] = {}
    for d in docs:
        t = d["ticker"]
        ids = [m[0] for m in d.get("managers", [])]
        lines: dict[str, dict[str, tuple[float, float]]] = {}
        for qq in flag_qs:
            here = {ids[r[0]]: (r[1], r[3] if len(r) > 3 else 0) for r in d.get("quarters", {}).get(qq, [])
                    if (ids[r[0]], qq) not in books}
            for m, (shares, value_k) in by_book.get(t, {}).get(qq, {}).items():
                here[m] = (value_k, shares)
            lines[qq] = here
        all_lines[t] = lines
    consensus = consensus_prices(all_lines)
    stale = stale_valuations(all_lines, consensus, flag_qs)
    for d in docs:
        t = d["ticker"]
        ids = [m[0] for m in d.get("managers", [])]
        lines = all_lines[t]
        flags = {qq: price_flags(v, stale=stale.get(qq)) for qq, v in lines.items()}
        held_in = [qq for qq, v in d.get("quarters", {}).items() if v]
        held_in += list(by_book.get(t, {}))
        first_ticker = min(held_in, key=quarter_key) if held_in else None
        cs = set(d.get("cusips", [])) | book_cusips.get(t, set())
        seen = [first_seen[c] for c in cs if c in first_seen]
        first_cusip = min(seen, key=quarter_key) if seen else None
        def holders_in(qq: str) -> int:
            listed = {ids[r[0]] for r in d.get("quarters", {}).get(qq, [])}
            return len(listed | set(by_book.get(t, {}).get(qq, {})))

        for q in quarters:
            status = listing_status(q, first_cusip, first_ticker, holders_in(previous_quarter(q)), holders_in(q))
            row = symbol_quarter(d, q, comp[q], agg=agg, paired=paired[q], whole=whole[q], flags=flags,
                                 listing=status)
            # Held by no tracked manager at the quarter end, after being held
            # the quarter before: the security ended (an acquisition closing,
            # a take-private, a delisting), and the exits are its holders
            # being paid out, not managers selling. Shown, never ranked.
            # Also ended when a stray holder is all that is left: at least
            # five holders exited, what remains is at most a tenth of them,
            # and the comparable shares fell 95% or more. SunOpta (STKL) at
            # Q2 2026, 20 exits, one remaining holder and shares down 99.8%,
            # ranked second on reductions as selling while its sale closed.
            residual = (row["exited"] >= 5 and row["h"] <= max(1, row["exited"] // 10)
                        and row.get("conviction") is not None and row["conviction"] <= -0.95)
            if (not row["h"] or residual) and row["exited"] and row["listing"] is None:
                row["listing"] = "ended"
                row["rank"] = False
            elif row["listing"] is None and reissued(t, q):
                row["listing"] = "reissued"
                row["rank"] = False
                row["netShares"] = None
                row["conviction"] = None
            if row["h"] or row["exited"]:
                per_q[q].append(row)
                for m in row.get("flagged", []):
                    flag_counts[q][m] = flag_counts[q].get(m, 0) + 1
    by_sym = {q: {r["t"]: r for r in rows} for q, rows in per_q.items()}
    for q in quarters:
        cov[q]["managersComplete"] = len(paired[q] | whole[q])
        cov[q]["managersWithBooks"] = len(paired[q])
        cov[q]["rowsComplete"] = sum(1 for r in per_q[q] if r["coverage"] == "complete")
        cov[q]["rows"] = len(per_q[q])

    files: dict[str, dict] = {}
    splits: dict[str, list[str]] = {}
    for q in quarters:
        rows = sorted(per_q[q], key=lambda r: (-r["v"], r["t"]))
        splits_here = sorted([r["t"], r["split"], r["splitTest"]] for r in rows if r["split"] is not None)
        if splits_here:
            splits[q] = splits_here
        files[f"quarters/{q}.json"] = {
            "schema": SCHEMA, "generatedAt": now, "q": q, "prior": previous_quarter(q),
            "comparable": sorted(comp[q]), "count": len(rows),
            "rows": [{k: v for k, v in r.items() if not k.startswith("_")} for r in rows],
        }

    # The search index and the latest picture, one row per symbol.
    stocks = []
    for d in docs:
        t = d["ticker"]
        c = cls_of[t]
        held = [q for q, v in d.get("quarters", {}).items() if v]
        r = by_sym.get(default, {}).get(t) if default else None
        stocks.append({
            "t": t, "n": d.get("name"), "c": d.get("cusips", []), "sic": c["sic"], "sec": c["sec"], "th": c["th"],
            "q": max(held, key=quarter_key) if held else None,
            "h": r["h"] if r else 0, "v": r["v"] if r else 0, "s": r["s"] if r else 0,
            "d": {k: (r[k] if r else 0) for k in ("new", "added", "trimmed", "held", "exited")},
            "listing": r["listing"] if r else None,
            "spark": [by_sym[q][t]["h"] if t in by_sym[q] else 0 for q in spark_qs],
            "fund": c["fund"],
        })
    stocks.sort(key=lambda s: (-s["v"], s["t"]))
    files["stocks.json"] = {"schema": SCHEMA, "generatedAt": now, "defaultQuarter": default,
                            "sparkQuarters": spark_qs, "count": len(stocks), "stocks": stocks}

    # Sectors and themes, by quarter.
    by_quarter: dict[str, dict] = {}
    unclassified_share: dict[str, float] = {}
    for q in quarters:
        agg = {"sectors": {}, "themes": {}, "unclassified": None}

        def add(bucket: dict, key: str, r: dict) -> None:
            a = bucket.setdefault(key, {"v": 0, "h": set(), "buyers": 0, "sellers": 0, "stocks": 0})
            a["v"] += r["v"]
            a["h"].update(r["_holders"])
            a["buyers"] += r["buyers"]
            a["sellers"] += r["sellers"]
            a["stocks"] += 1 if r["h"] else 0

        unc: dict = {}
        total = 0
        for r in per_q[q]:
            c = cls_of[r["t"]]
            total += r["v"]
            if c["sec"]:
                add(agg["sectors"], c["sec"], r)
            else:
                add(unc, "unclassified", r)
            for k in c["th"]:
                add(agg["themes"], k, r)
        fix = lambda a: {**a, "h": len(a["h"])}  # noqa: E731
        agg["sectors"] = {k: fix(v) for k, v in agg["sectors"].items()}
        agg["themes"] = {k: fix(v) for k, v in agg["themes"].items()}
        agg["unclassified"] = fix(unc["unclassified"]) if unc else {"v": 0, "h": 0, "buyers": 0, "sellers": 0, "stocks": 0}
        by_quarter[q] = agg
        unclassified_share[q] = round(agg["unclassified"]["v"] / total, 4) if total else 0.0
    # The stock page's holder table, from complete books. The by-ticker files
    # list each manager to its largest 500 positions, so a holder below that
    # line was missing from the table while counted in the aggregates (MSFT at
    # Q2 2026: 60 in the table, 62 counted). For each quarter whose row was
    # built from complete books, every comparable holder's line is published
    # here, keyed by manager id, with the exits.
    for q in quarters:
        for r in per_q[q]:
            if r.get("coverage") != "complete":
                continue
            rec = files.setdefault(f"holders/{r['t']}.json", {
                "schema": SCHEMA, "generatedAt": now, "ticker": r["t"],
                "fields": ["valueK", "shares", "action", "priorShares"], "quarters": {}})
            rec["quarters"][q] = {"rows": r["_detail"], "exits": r["_exits"]}

    files["sectors.json"] = {
        "schema": SCHEMA, "generatedAt": now,
        "taxonomy": {"sectors": {k: {kk: vv for kk, vv in v.items()} for k, v in table["sectors"].items()},
                     "source": table.get("source")},
        "themes": table["themes"],
        "byQuarter": by_quarter,
        "unclassifiedValueShare": unclassified_share,
    }

    # Managers at their latest quarter, and at the default.
    def figures(mid: str, rec: dict) -> dict:
        sec, th = manager_weights(holdings.get((mid, rec["quarter"]), []), tickers, clf)
        return {
            "q": rec["quarter"], "periodOfReport": rec.get("periodOfReport"), "filed": rec.get("filed"),
            "aumK": rec.get("aumK"), "positions": rec.get("positions"), "listed": rec.get("listed"),
            "listedValuePct": rec.get("listedValuePct"), "top10Pct": rec.get("top10Pct"), "hhi": rec.get("hhi"),
            "turnover": rec.get("turnover"), "counts": rec.get("counts"),
            "sectors": sec,
            "topThemes": [[k, w] for k, w in sorted(th.items(), key=lambda kv: (-kv[1], kv[0]))[:TOP_THEMES]],
        }

    managers = []
    for d in sorted(indexes, key=lambda d: d["id"]):
        qs = filed[d["id"]]
        if not qs:
            continue
        latest = qs[max(qs, key=quarter_key)]
        managers.append({
            "id": d["id"], "name": d.get("name"), "slug": d["id"],
            **figures(d["id"], latest),
            "atDefault": figures(d["id"], qs[default]) if default and default in qs else None,
        })
    files["managers.json"] = {"schema": SCHEMA, "generatedAt": now, "defaultQuarter": default,
                              "count": len(managers), "managers": managers}

    # Each manager's quarters in one file: the reported 13F value (the
    # denominator of a position's share of the book), the filing date, the
    # period end and the filing on sec.gov. A stock page needs these for every
    # holder, and reading ninety history indexes per page took fifteen seconds
    # on a cold cache; this is one read. Row: [aumK, filed, periodOfReport,
    # filingUrl], keyed manager then quarter.
    files["filings.json"] = {
        "schema": SCHEMA, "generatedAt": now,
        "fields": ["aumK", "filed", "periodOfReport", "filingUrl"],
        "count": len(filed),
        "managers": {m: {q: [r.get("aumK"), r.get("filed"), r.get("periodOfReport"), r.get("filingUrl")]
                         for q, r in sorted(qs.items())}
                     for m, qs in sorted(filed.items())},
    }

    files["meta.json"] = {
        "schema": SCHEMA, "generatedAt": now,
        "quarters": quarters, "defaultQuarter": default,
        "quarterCoverage": cov, "managersOnFile": len(filed),
        "sparkQuarters": spark_qs,
        "splits": splits,
        "symbols": len(docs),
        # Lines whose implied price is more than 5% from the other filers' median,
        # by quarter and manager: shown as filed, left out of share arithmetic.
        "priceFlags": {q: dict(sorted(v.items())) for q, v in flag_counts.items() if v},
        # Filings whose values are at the previous quarter end's prices: shown
        # as filed, share counts used (stale_valuations).
        "staleValuations": {q: sorted(v) for q, v in stale.items() if v and q in quarters},
        "notes": [
            "A 13F is a manager's long US-listed equity book at a quarter end, filed up to 45 days later: never today's portfolio, shorts, cash or performance.",
            "Changes in a quarter count only managers that filed both it and the quarter before.",
            "Buying means more shares: added and trimmed come from share counts against the manager's whole filing, never from value.",
            "Where 70% of the comparable holders show one split factor within 3%, the quarter is a split and its added and trimmed are not counted as buying or selling.",
            "Large books are listed to their largest 500 positions, so holder, new and exit counts are at least counts, among listed positions.",
            "The default quarter is the newest filed by at least 75% of the managers on file.",
            "For the recent quarters every manager's complete information table is read; a row is coverage 'complete' only when every comparable manager's whole book was read in both quarters, and 'listed' rows count among listed positions only.",
            "A security whose CUSIP first appears in any tracked book in a quarter is a new listing: its holders are allocations, not accumulation, so it is not ranked. One newly under a ticker while its CUSIP was held before is new coverage, and is not ranked either.",
            "A line whose implied price (value over shares) is more than 5% from the median of the other filers of the security, with three or more filers, is flagged: it counts in holders and value as filed and is left out of net shares, conviction and split detection.",
            "Breadth is new + added - trimmed - exited among comparable managers; conviction is net shares over the prior quarter's comparable shares, given only with complete coverage and no split.",
            "Sectors are SEC SIC code ranges; funds and ETFs are their own bucket; bespoke themes are L3VLUP definitions with published ticker lists.",
            "These managers are a curated universe (data/funds.universe.json), not the institutional market.",
        ],
    }
    return files


# ── reading and writing ──────────────────────────────────────────────────────

def read_json(path: Path, default=None):
    try:
        return json.loads(path.read_text())
    except Exception:
        return default


def load_inputs(root: Path) -> dict:
    hist = root / "data" / "funds" / "history"
    indexes = []
    for folder in sorted(p for p in hist.iterdir() if p.is_dir()) if hist.exists() else []:
        idx = read_json(folder / "index.json")
        if idx and idx.get("id") and isinstance(idx.get("quarters"), list):
            indexes.append(idx)
    by_ticker = [d for p in sorted((root / "data" / "funds" / "by-ticker").glob("*.json"))
                 if (d := read_json(p)) and d.get("ticker")]
    filed = filings(indexes)
    quarters = window(filed)
    cov = coverage(filed, quarters)
    default = default_quarter(cov, quarters)
    # The listed positions for each manager's latest and default quarter.
    holdings: dict[tuple[str, str], list] = {}
    for idx in indexes:
        qs = filed[idx["id"]]
        if not qs:
            continue
        want = {max(qs, key=quarter_key)} | ({default} if default in qs else set())
        for q in want:
            yd = read_json(hist / idx["id"] / f"{q[:4]}.json", {})
            holdings[(idx["id"], q)] = (yd.get("quarters") or {}).get(q, [])
    # The complete books (scripts/funds_books.py), each only where it was read
    # from the filings the history chose for that quarter.
    books: dict[tuple[str, str], list] = {}
    for idx in indexes:
        for q, rec in filed[idx["id"]].items():
            if q not in quarters and q not in {previous_quarter(x) for x in quarters}:
                continue
            b = read_json(root / "data" / "funds" / "books" / idx["id"] / f"{q}.json")
            if b and b.get("signature") and b.get("signature") == rec.get("signature") and isinstance(b.get("rows"), list):
                books[(idx["id"], q)] = b["rows"]
    sec = read_json(root / "data" / "funds" / "securities.json", {}) or {}
    first_seen = {c: r["firstSeen"] for c, r in (sec.get("securities") or {}).items() if r.get("firstSeen")}
    return {
        "indexes": indexes,
        "by_ticker": by_ticker,
        "books": books,
        "first_seen": first_seen,
        "peers": read_json(root / "data" / "peers.auto.json", {}),
        "cusips": read_json(root / "data" / "cusip-tickers.auto.json", {}),
        "table": read_json(root / "data" / "funds.themes.json"),
        "holdings": holdings,
    }


def write(files: dict[str, dict], out: Path) -> list[str]:
    """Write each file whose content changed. Returns the paths written. Quarter files that fall out of the window are left in place."""
    written = []
    for rel, body in sorted(files.items()):
        path = out / rel
        # A stock's holder lines are a record: a quarter published from
        # complete books stays when the four-quarter books window moves on
        # (it would otherwise be refused as a shrinking history). This run's
        # quarters replace the same quarters on file; older ones are kept.
        if rel.startswith("holders/") and path.exists():
            try:
                old = json.loads(path.read_text())
                body = {**body, "quarters": {**(old.get("quarters") or {}), **body["quarters"]}}
            except Exception:
                pass
        text = dumps(body)
        if path.exists() and same_content(path.read_text(), text):
            continue
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
        written.append(rel)
    return written


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--root", type=Path, default=ROOT, help="the repository root to read from")
    ap.add_argument("--out", type=Path, default=None, help="where to write (default <root>/data/funds/explorer)")
    ap.add_argument("--check", action="store_true", help="build and report, write nothing")
    args = ap.parse_args(argv)
    inputs = load_inputs(args.root)
    if not inputs["table"]:
        print("data/funds.themes.json is missing or unreadable", file=sys.stderr)
        return 1
    if not inputs["indexes"] or not inputs["by_ticker"]:
        print("no 13F history or by-ticker files to build from; nothing written")
        return 0
    files = build(**inputs)
    out = args.out or args.root / "data" / "funds" / "explorer"
    meta = files["meta.json"]
    print(f"quarters {meta['quarters'][-1]}..{meta['quarters'][0]} · default {meta['defaultQuarter']} · "
          f"managers {meta['managersOnFile']} · symbols {meta['symbols']}")
    for q in meta["quarters"]:
        c = meta["quarterCoverage"][q]
        print(f"  {q}: filed {c['managersFiled']}, comparable {c['managersComparable']}, "
              f"complete {c['managersComplete']} ({c['managersWithBooks']} from books), "
              f"rows complete {c['rowsComplete']}/{c['rows']}, "
              f"unclassified {files['sectors.json']['unclassifiedValueShare'][q]:.1%}"
              f"{', splits ' + ' '.join(f'{t}x{f:g}' for t, f, _k in meta['splits'][q]) if q in meta['splits'] else ''}")
    if args.check:
        return 0
    written = write(files, out)
    print(f"wrote {len(written)} of {len(files)} files under {out}")
    for rel in written:
        print(f"  {rel} {(out / rel).stat().st_size / 1e3:,.0f} KB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
