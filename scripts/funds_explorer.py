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
TOP_THEMES = 3
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
    return None


def symbol_quarter(doc: dict, q: str, comp: set[str]) -> dict:
    """
    One symbol's row in quarter q, over the comparable managers `comp` only.

    `doc` is a by-ticker file. Holders, value and shares are the comparable
    managers listing it in q; the counts are their action codes; exited is
    the comparable managers whose filing shows they left it in q.
    """
    ids = [m[0] for m in doc.get("managers", [])]
    prior = previous_quarter(q)

    def rows(qq: str) -> dict[str, tuple[int, str, float]]:
        out = {}
        for r in doc.get("quarters", {}).get(qq, []):
            mid = ids[r[0]]
            if mid in comp:
                out[mid] = (r[1], r[2], r[3] if len(r) > 3 else None)
        return out

    cur, before = rows(q), rows(prior)
    exited = {ids[r[0]] for r in doc.get("exits", {}).get(q, []) if ids[r[0]] in comp}
    counts = {"new": 0, "added": 0, "trimmed": 0, "held": 0}
    code = {"n": "new", "a": "added", "t": "trimmed", "h": "held"}
    for _v, a, _s in cur.values():
        counts[code.get(a, "held")] += 1

    pairs = [(cur[m][2], before[m][2], cur[m][0], before[m][0]) for m in cur if m in before]
    found = split_test(pairs)
    split = found[0] if found else None

    # Shares bought or sold, summed over the comparable managers, only where
    # both sides of every change are known from listed rows.
    net: float | None = 0
    for m in comp:
        c, b = cur.get(m), before.get(m)
        if c is None and b is None:
            continue
        if c is not None and c[2] is None or b is not None and b[2] is None:
            net = None
            break
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

    buyers = counts["new"] + (0 if split is not None else counts["added"])
    sellers = len(exited) + (0 if split is not None else counts["trimmed"])
    return {
        "t": doc["ticker"],
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
        "_holders": sorted(cur),
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


def build(*, indexes: list[dict], by_ticker: list[dict], peers: dict, cusips: dict, table: dict,
          holdings: dict[tuple[str, str], list] | None = None, now: str | None = None) -> dict[str, dict]:
    """
    Every Explorer file, as {relative path: body}.

    `holdings` maps (manager id, quarter) to that quarter's listed positions,
    for the manager rows; only the quarters a manager row describes are needed.
    """
    problems = table_problems(table)
    if problems:
        raise SystemExit("data/funds.themes.json: " + "; ".join(problems))
    now = now or datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    tickers = cusips.get("tickers", {}) or {}
    funds = {norm_ticker(t) for t in cusips.get("funds", []) or []}
    clf = Classifier(table, sic_map(peers), funds)
    holdings = holdings or {}

    filed = filings(indexes)
    quarters = window(filed)
    cov = coverage(filed, quarters)
    default = default_quarter(cov, quarters)
    comp = {q: comparable(filed, q) for q in quarters}
    spark_qs = sorted([q for q in quarters if default and quarter_key(q) <= quarter_key(default)], key=quarter_key)[-SPARK:]

    docs = sorted((d for d in by_ticker if TICKER_FILE.match(d.get("ticker", ""))), key=lambda d: d["ticker"])
    cls_of = {d["ticker"]: clf.classify(d["ticker"]) for d in docs}

    per_q: dict[str, list[dict]] = {q: [] for q in quarters}
    for d in docs:
        for q in quarters:
            row = symbol_quarter(d, q, comp[q])
            if row["h"] or row["exited"]:
                per_q[q].append(row)
    by_sym = {q: {r["t"]: r for r in rows} for q, rows in per_q.items()}

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
        "notes": [
            "A 13F is a manager's long US-listed equity book at a quarter end, filed up to 45 days later: never today's portfolio, shorts, cash or performance.",
            "Changes in a quarter count only managers that filed both it and the quarter before.",
            "Buying means more shares: added and trimmed come from share counts against the manager's whole filing, never from value.",
            "Where 70% of the comparable holders show one split factor within 3%, the quarter is a split and its added and trimmed are not counted as buying or selling.",
            "Large books are listed to their largest 500 positions, so holder, new and exit counts are at least counts, among listed positions.",
            "The default quarter is the newest filed by at least 75% of the managers on file.",
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
    return {
        "indexes": indexes,
        "by_ticker": by_ticker,
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
