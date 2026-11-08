#!/usr/bin/env python3
"""
The 13F Explorer's rules, offline.

    python3 scripts/__tests__/funds-explorer.test.py

WHY THIS EXISTS
---------------
The Explorer says, across ninety-five managers at once, who bought and who
sold a stock, what a sector's holders did, and which theme a manager leans
to. Every count is a claim about real firms, so the rules behind them are
pinned here on small hand-built books:

- a manager counts in a quarter only if it filed that quarter and the one
  before;
- buyers and sellers come from share actions only: a value that rose with no
  rise in shares is not a buy;
- a split is not trading, and a manager adding to a position is not a split;
- netShares is null when either side of a change is not listed;
- the default quarter is the newest filed by 75% of managers on file;
- a sector or theme comes from a SIC code or a published ticker list and
  nothing else, ticker punctuation never splits one symbol in two, and funds
  are their own bucket;
- a run that changes nothing rewrites nothing.

And it rebuilds NVDA, MSFT and UNH at the default quarter straight from the
published by-ticker files and history indexes, by code written here and not
by the module, and holds the published Explorer files to the answer.
"""

from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("funds_explorer", ROOT / "scripts" / "funds_explorer.py")
fe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fe)

passed = failed = 0


def check(name: str, cond: bool, detail: object = "") -> None:
    global passed, failed
    if cond:
        passed += 1
        print(f"PASS  {name}")
    else:
        failed += 1
        print(f"FAIL  {name}{f' — {detail}' if detail != '' else ''}")


def eq(name: str, got, want) -> None:
    check(name, got == want, f"got {got!r}, want {want!r}")


# ── fixtures ─────────────────────────────────────────────────────────────────

def qrec(q: str, vs: str | None, **kw) -> dict:
    return {"quarter": q, "periodOfReport": q, "filed": "x", "vsPrior": vs, "aumK": 100, "positions": 10,
            "listed": 10, "listedValuePct": 1.0, "top10Pct": 1.0, "hhi": 0.1, "turnover": 0.1, "counts": None, **kw}


def index(mid: str, quarters: list[dict]) -> dict:
    return {"id": mid, "name": mid.title(), "quarters": quarters}


TABLE = {
    "source": "test",
    "sectors": {
        "semis": {"label": "Semis", "sic": ["3674"]},
        "insurance": {"label": "Insurance", "sic": ["6311-6411"]},
        "funds": {"label": "Funds and ETFs", "sic": []},
    },
    "themes": {
        "chips": {"label": "Chips", "kind": "standard", "definition": "SIC 3674.", "sic": ["3674"]},
        "conglom": {"label": "Conglomerates", "kind": "bespoke", "definition": "Ours.", "sic": [], "tickers": ["BRK.B"]},
        "fundy": {"label": "Fund-like", "kind": "bespoke", "definition": "Ours.", "sic": ["6311"], "tickers": ["QQQ"]},
    },
}
PEERS = {"industries": {
    "3674": {"listed": [{"ticker": "AAA"}, {"ticker": "BBB"}]},
    "6331": {"listed": [{"ticker": "BRK-B"}]},
    "6311": {"listed": [{"ticker": "SPY"}]},       # an ETF the SEC file happens to code: still a fund
}}
CUSIPS = {"tickers": {}, "funds": ["SPY", "QQQ"]}


# ── comparable managers ──────────────────────────────────────────────────────

filed = fe.filings([
    index("a", [qrec("2026Q2", "2026Q1"), qrec("2026Q1", "2025Q4")]),
    index("b", [qrec("2026Q2", None)]),                           # new to the record
    index("c", [qrec("2026Q2", None), qrec("2025Q4", None)]),     # skipped 2026Q1
    index("d", [qrec("2026Q1", None)]),                           # has not filed 2026Q2 yet
    index("e", [qrec("2026Q2", None), qrec("2026Q1", None)]),     # both filed, but the history could not compare them
])
eq("comparable: only managers that filed the quarter and the one before, compared across them",
   fe.comparable(filed, "2026Q2"), {"a"})
cov = fe.coverage(filed, ["2026Q2", "2026Q1"])
eq("coverage counts filed, comparable and on file", cov["2026Q2"], {"managersFiled": 4, "managersComparable": 1, "managersOnFile": 5})
eq("previous quarter crosses a year", fe.previous_quarter("2026Q1"), "2025Q4")


# ── one symbol in one quarter ────────────────────────────────────────────────

def doc(ticker: str, managers: list[str], quarters: dict, exits: dict | None = None) -> dict:
    return {"ticker": ticker, "name": ticker, "cusips": ["X"], "managers": [[m, m] for m in managers],
            "quarters": quarters, "exits": exits or {}}


COMP = {"m0", "m1", "m2", "m3"}
d = doc("AAA", ["m0", "m1", "m2", "m3", "m4"], {
    "2026Q1": [[0, 100, "h", 10], [1, 50, "h", 20], [2, 70, "h", 30]],
    # m0: value doubled, shares unchanged (a price move); m1 added; m3 new; m4 not comparable
    "2026Q2": [[0, 200, "h", 10], [1, 90, "a", 30], [3, 40, "n", 5], [4, 999, "a", 999]],
}, {"2026Q2": [[2, 70]]})
r = fe.symbol_quarter(d, "2026Q2", COMP)
eq("holders, value and shares count comparable managers only", (r["h"], r["v"], r["s"]), (3, 330, 45))
eq("a value rise with no share rise is held, not bought", (r["held"], r["added"], r["new"]), (1, 1, 1))
eq("buyers are new + added", r["buyers"], 2)
eq("sellers are trimmed + exited", (r["sellers"], r["exited"]), (1, 1))
eq("netShares sums share changes: +10 added, +5 new, -30 exited", r["netShares"], -15)
eq("no split", r["split"], None)

# One side not listed: m2 was listed in 2026Q1 and is neither listed nor an exit in 2026Q2.
d2 = doc("AAA", ["m0", "m2"], {"2026Q1": [[0, 100, "h", 10], [1, 70, "h", 30]], "2026Q2": [[0, 120, "a", 12]]})
eq("netShares is null when a comparable manager's count is not listed on one side",
   fe.symbol_quarter(d2, "2026Q2", COMP)["netShares"], None)
# The other side: listed now as added, not listed before.
d3 = doc("AAA", ["m0", "m1"], {"2026Q1": [[0, 100, "h", 10]], "2026Q2": [[0, 100, "h", 10], [1, 50, "a", 9]]})
eq("...and when the earlier count is the one below the listed line", fe.symbol_quarter(d3, "2026Q2", COMP)["netShares"], None)
eq("...but an added position still counts as a buyer", fe.symbol_quarter(d3, "2026Q2", COMP)["buyers"], 1)


# ── splits ───────────────────────────────────────────────────────────────────

d4 = doc("BBB", ["m0", "m1", "m2", "m3"], {
    "2026Q1": [[0, 400, "h", 100], [1, 400, "h", 100], [2, 400, "h", 100], [3, 400, "h", 100]],
    "2026Q2": [[0, 410, "a", 400], [1, 405, "a", 398], [2, 420, "a", 404], [3, 500, "a", 150]],
})
r4 = fe.symbol_quarter(d4, "2026Q2", COMP)
eq("a split: 3 of 4 holders (75%) within 3% of four-for-one", r4["split"], 4)
eq("...found by the holders test", r4.get("splitTest"), "holders")
eq("...its added counts are not buyers", (r4["added"], r4["buyers"]), (4, 0))
eq("...and netShares is not claimed across it", r4["netShares"], None)

d5 = doc("BBB", ["m0", "m1", "m2"], {
    "2026Q1": [[0, 100, "h", 100], [1, 100, "h", 100], [2, 100, "h", 100]],
    "2026Q2": [[0, 200, "a", 200], [1, 150, "a", 150], [2, 100, "h", 100]],
})
r5 = fe.symbol_quarter(d5, "2026Q2", COMP)
eq("not a split: only one of three holders doubled", r5["split"], None)
eq("...so its buyers stand", r5["buyers"], 2)
eq("one holder doubling is a trade, never a split", fe.split_test([(200, 100, 200, 100)]), None)
eq("a reverse split is found too", fe.split_test([(10, 100, 100, 100), (10.2, 100, 102, 100)]), (0.1, "holders"))

# The price test: holders traded through a ten-for-one, so few sit within 3%,
# but the median share ratio is near ten and the reported price fell about ten-fold.
traded = [(s * 10 * k, s, s * 10 * k * 13, s * 100) for s, k in
          [(100, 0.95), (200, 1.0), (300, 0.9), (400, 1.2), (500, 0.85), (600, 1.05), (700, 0.98)]]
eq("the price test finds a split the holders test cannot", fe.split_test(traded), (10.0, "price"))
# The same share ratios with the price unchanged is buying, not a split.
bought = [(a, b, a * 10, b * 10) for a, b, _va, _vb in traded]
eq("...and does not call it a split when the price did not fall", fe.split_test(bought), None)
# Halved price and doubled shares on a two-for-one is held to the tighter band.
halving = [(s * 2 * k, s, s * 2 * k * 6.4, s * 10) for s, k in
           [(10, 0.9), (20, 1.0), (30, 1.1), (40, 0.95), (50, 1.06)]]   # price 10 -> 6.4, a ratio of 1.56
eq("a stock that fell by a third while holders doubled is not a split", fe.split_test(halving), None)


# ── default quarter ──────────────────────────────────────────────────────────

f2 = fe.filings([
    index("a", [qrec("2026Q3", "2026Q2"), qrec("2026Q2", None)]),
    index("b", [qrec("2026Q3", "2026Q2"), qrec("2026Q2", None)]),
    index("c", [qrec("2026Q2", None)]),
    index("d", [qrec("2026Q1", None)]),
])
qs = fe.window(f2)
eq("the window is newest first", qs, ["2026Q3", "2026Q2", "2026Q1"])
eq("default quarter: 2026Q3 has 2 of 4 (50%), 2026Q2 has 3 of 4 (75%)", fe.default_quarter(fe.coverage(f2, qs), qs), "2026Q2")
f3 = fe.filings([index("a", [qrec("2026Q2", None)]), index("b", [qrec("2026Q1", None)])])
eq("no quarter reaching 75% gives no default rather than a guess", fe.default_quarter(fe.coverage(f3, fe.window(f3)), fe.window(f3)), None)


# ── classification ───────────────────────────────────────────────────────────

clf = fe.Classifier(TABLE, fe.sic_map(PEERS), {fe.norm_ticker(t) for t in CUSIPS["funds"]})
eq("ticker punctuation is normalised", [fe.norm_ticker(t) for t in ("BRK.B", "brk/b", "BRK-B")], ["BRK-B"] * 3)
eq("a sector from the SIC code", clf.classify("AAA"), {"sic": "3674", "sec": "semis", "th": ["chips"], "fund": False})
eq("BRK.B finds the SEC's BRK-B code, and the theme list's BRK.B finds BRK-B",
   clf.classify("BRK.B"), {"sic": "6331", "sec": "insurance", "th": ["conglom"], "fund": False})
eq("...and BRK-B reads the same", clf.classify("BRK-B"), clf.classify("BRK.B"))
eq("an ETF is the funds bucket even where the SEC file codes it, and joins no theme by code",
   clf.classify("SPY"), {"sic": "6311", "sec": "funds", "th": [], "fund": True})
eq("...a fund joins a theme only by being named in its list", clf.classify("QQQ")["th"], ["fundy"])
eq("a ticker the SEC file does not list is unclassified, never guessed",
   clf.classify("ZZZ"), {"sic": None, "sec": None, "th": [], "fund": False})
eq("a ticker filed under two codes is left unclassified",
   fe.sic_map({"industries": {"1000": {"listed": [{"ticker": "X"}]}, "2000": {"listed": [{"ticker": "X"}]}}}), {})
bad = {"sectors": {"a": {"label": "A", "sic": ["1000-1999"]}, "b": {"label": "B", "sic": ["1500"]}},
       "themes": {"s": {"label": "S", "kind": "standard", "definition": "x", "sic": ["1000"], "tickers": ["X"]},
                  "t": {"label": "T", "kind": "bespoke", "definition": "x", "sic": ["1000"]}}}
probs = fe.table_problems(bad)
check("an overlapping sector range is refused", any("1500" in p for p in probs), probs)
check("a standard theme carrying tickers is refused", any("theme s" in p for p in probs), probs)
check("a bespoke theme without a published list is refused", any("theme t" in p for p in probs), probs)


# ── the whole build, and writing ─────────────────────────────────────────────

idx = [index(m, [qrec("2026Q2", "2026Q1"), qrec("2026Q1", None)]) for m in ("m0", "m1", "m2", "m3")]
files = fe.build(indexes=idx, by_ticker=[d, d4, doc("SPY", ["m0", "m1"], {"2026Q2": [[0, 5, "h", 1]], "2026Q1": [[0, 5, "h", 1]]})],
                 peers=PEERS, cusips=CUSIPS, table=TABLE, now="2026-11-08T00:00:00Z")
eq("one file per quarter in the window, plus the four", sorted(files),
   ["managers.json", "meta.json", "quarters/2026Q1.json", "quarters/2026Q2.json", "sectors.json", "stocks.json"])
meta = files["meta.json"]
eq("meta names the default and the splits", (meta["defaultQuarter"], meta["splits"]), ("2026Q2", {"2026Q2": [["BBB", 4, "holders"]]}))
stocks = {s["t"]: s for s in files["stocks.json"]["stocks"]}
eq("every by-ticker symbol appears in stocks.json", sorted(stocks), ["AAA", "BBB", "SPY"])
eq("stocks are sorted by value at the default", [s["t"] for s in files["stocks.json"]["stocks"]], ["BBB", "AAA", "SPY"])
eq("the stock row is the default quarter's row", stocks["AAA"]["d"], {"new": 1, "added": 1, "trimmed": 0, "held": 1, "exited": 1})
eq("an ETF is flagged and bucketed", (stocks["SPY"]["fund"], stocks["SPY"]["sec"]), (True, "funds"))
agg = files["sectors.json"]["byQuarter"]["2026Q2"]
eq("a sector aggregate counts distinct managers, summed value and actions, and its stocks",
   agg["sectors"]["semis"], {"v": 330 + 1735, "h": 4, "buyers": 2 + 0, "sellers": 1 + 0, "stocks": 2})
eq("the unclassified value share is recorded", files["sectors.json"]["unclassifiedValueShare"]["2026Q2"], 0.0)

with tempfile.TemporaryDirectory() as tmp:
    out = Path(tmp)
    first = fe.write(files, out)
    again = fe.build(indexes=idx, by_ticker=[d, d4, doc("SPY", ["m0", "m1"], {"2026Q2": [[0, 5, "h", 1]], "2026Q1": [[0, 5, "h", 1]]})],
                     peers=PEERS, cusips=CUSIPS, table=TABLE, now="2026-11-09T00:00:00Z")
    eq("a first run writes every file", len(first), len(files))
    eq("a run that changed nothing but generatedAt writes nothing", fe.write(again, out), [])
    text = (out / "meta.json").read_text()
    eq("output is compact with sorted keys", text, fe.dumps(json.loads(text)))


# ── reproducibility on the real record ───────────────────────────────────────
#
# Rebuilt here from the published files with no help from the module: which
# managers are comparable, then each symbol's holders, value and buyers and
# sellers, then the published Explorer files are held to that.

HIST = ROOT / "data" / "funds" / "history"
BYT = ROOT / "data" / "funds" / "by-ticker"
EXP = ROOT / "data" / "funds" / "explorer"
if not (EXP / "meta.json").exists() or not HIST.exists():
    check("the Explorer files exist to be checked (run scripts/funds_explorer.py)", False)
else:
    meta = json.loads((EXP / "meta.json").read_text())
    dq = meta["defaultQuarter"]
    y, n = int(dq[:4]), int(dq[5])
    prior = f"{y - 1}Q4" if n == 1 else f"{y}Q{n - 1}"
    by_mgr = {}
    for p in sorted(HIST.iterdir()):
        if (p / "index.json").exists():
            ix = json.loads((p / "index.json").read_text())
            by_mgr[ix["id"]] = {q["quarter"]: q for q in ix["quarters"]}
    on_file = len(by_mgr)
    filed_dq = sum(1 for qs in by_mgr.values() if dq in qs)
    check(f"{dq} was filed by at least 75% of the {on_file} managers on file", filed_dq >= 0.75 * on_file, filed_dq)
    newer = [q for q in meta["quarters"] if (int(q[:4]), int(q[5])) > (y, n)]
    for q in newer:
        c = sum(1 for qs in by_mgr.values() if q in qs)
        check(f"...and the newer {q} was not ({c} of {on_file})", c < 0.75 * on_file)
    comp = sorted(m for m, qs in by_mgr.items() if dq in qs and prior in qs and qs[dq].get("vsPrior") == prior)
    qfile = json.loads((EXP / "quarters" / f"{dq}.json").read_text())
    eq(f"the comparable managers in {dq} are those that filed {dq} and {prior}", qfile["comparable"], comp)
    rows = {r["t"]: r for r in qfile["rows"]}
    stock_rows = {s["t"]: s for s in json.loads((EXP / "stocks.json").read_text())["stocks"]}
    for sym in ("NVDA", "MSFT", "UNH"):
        bt = json.loads((BYT / f"{sym}.json").read_text())
        ids = [m[0] for m in bt["managers"]]
        held = [r for r in bt["quarters"].get(dq, []) if ids[r[0]] in comp]
        holders = len(held)
        value = sum(r[1] for r in held)
        new = sum(1 for r in held if r[2] == "n")
        added = sum(1 for r in held if r[2] == "a")
        trimmed = sum(1 for r in held if r[2] == "t")
        exited = sum(1 for r in bt["exits"].get(dq, []) if ids[r[0]] in comp)
        row = rows.get(sym, {})
        split = row.get("split")
        want_buyers = new + (0 if split else added)
        want_sellers = exited + (0 if split else trimmed)
        eq(f"{sym} {dq}: holders, valueK, buyers, sellers rebuilt by hand equal the quarter file",
           (row.get("h"), row.get("v"), row.get("buyers"), row.get("sellers")), (holders, value, want_buyers, want_sellers))
        eq(f"{sym} {dq}: and the stock index", (stock_rows[sym]["h"], stock_rows[sym]["v"]), (holders, value))
    size = (EXP / "stocks.json").stat().st_size
    check(f"stocks.json stays under 2 MB ({size / 1e6:.2f} MB)", size < 2_000_000)
    eq("every symbol with a by-ticker file appears in stocks.json",
       sorted(p.stem for p in BYT.glob("*.json") if fe.TICKER_FILE.match(p.stem)), sorted(stock_rows))
    table = json.loads((ROOT / "data" / "funds.themes.json").read_text())
    eq("the published theme table has no problems", fe.table_problems(table), [])
    missing = sorted({t for th in table["themes"].values() for t in th.get("tickers", [])} - {fe.norm_ticker(t) for t in stock_rows})
    eq("every ticker a bespoke theme publishes is a symbol in the Explorer", missing, [])

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
