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
- a run that changes nothing rewrites nothing;
- round two: a row is complete only when every comparable manager's whole
  book was read, a CUSIP first seen this quarter is a new listing and is not
  ranked, a line priced off the other filers' median is flagged and kept out
  of share arithmetic and split detection, and breadth and conviction are the
  sums worked by hand.

And it rebuilds NVDA, MSFT and UNH at the default quarter straight from the
published by-ticker files, history indexes and complete books, by code written
here and not by the module, and holds the published Explorer files to the
answer, and every book to its history quarter.
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


# The aggregate test (round two): a ten-for-one in a quarter the stock doubled.
# Holders traded heavily, so few sit near ten and the price fell only five-fold,
# but their summed shares are ten times what they were.
klac = [(b * k, b, b * k * 30, b * 150) for b, k in
        [(100, 3), (100, 5), (100, 7), (100, 9.8), (100, 10), (100, 10.2), (100, 11), (100, 12), (100, 13),
         (100, 15), (100, 14), (100, 10)]]   # summed 120 = 10 times 12, median ratio 10.1, price 150 to 30
eq("the aggregate test finds a split the holders and price tests cannot", fe.split_test(klac), (10.0, "aggregate"))
eq("...and needs ten holders in both quarters", fe.split_test(klac[:9]), None)
eq("...and a price that fell: the same share counts at an unchanged price are buying",
   fe.split_test([(a, b, a * 15, b * 15) for a, b, _va, _vb in klac]), None)
eq("...and leaves two-for-one to the other tests",
   fe.split_test([(b * k, b, b * k * 6.67, b * 10) for b, k in [(100, x) for x in (1, 1.5, 1.8, 2, 2, 2, 2.2, 2.5, 2.5, 2.5)]]), None)


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
eq("one file per quarter in the window, plus the five", sorted(f for f in files if not f.startswith("holders/")),
   ["filings.json", "managers.json", "meta.json", "quarters/2026Q1.json", "quarters/2026Q2.json", "sectors.json", "stocks.json"])
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


# ── round two: complete books ────────────────────────────────────────────────
#
# Three managers whose books are larger than their listed rows (listed 5 of 8
# positions). p1 holds CCC below its listed line in both quarters, so the
# listed rows cannot see it; its complete book can.

def bq(q, vs):
    return qrec(q, vs, positions=8, listed=5)


TICK = {"tickers": {"C0000000C": "CCC", "D0000000D": "DDD", "N0000000N": "NEWCO", "O0000000O": "OLDCO"}, "funds": []}
idx3 = [index(m, [bq("2026Q2", "2026Q1"), bq("2026Q1", None)]) for m in ("p0", "p1", "p2")]
ccc = {"ticker": "CCC", "name": "CCC", "cusips": ["C0000000C"], "managers": [["p0", "P0"]],
       "quarters": {"2026Q1": [[0, 10, "h", 10]], "2026Q2": [[0, 15, "a", 15]]}, "exits": {}}
BOOKS = {
    ("p0", "2026Q1"): [["C0000000C", "COM", 10, 10, None]],
    ("p0", "2026Q2"): [["C0000000C", "COM", 15, 15, None]],
    ("p1", "2026Q1"): [["C0000000C", "COM", 100, 100, None], ["C0000000C", "COM", 7, 70, "CALL"]],
    ("p1", "2026Q2"): [["C0000000C", "COM", 120, 120, None]],
    ("p2", "2026Q1"): [["Z0000000Z", "COM", 5, 5, None]],
    ("p2", "2026Q2"): [["Z0000000Z", "COM", 5, 5, None]],
}


def qrow(files, q, t):
    return next(r for r in files[f"quarters/{q}.json"]["rows"] if r["t"] == t)


listed_only = qrow(fe.build(indexes=idx3, by_ticker=[ccc], peers=PEERS, cusips=TICK, table=TABLE, now="x"), "2026Q2", "CCC")
eq("without books: coverage is listed, and p1 below its line is not seen", (listed_only["coverage"], listed_only["h"]), ("listed", 1))
eq("...and conviction is not given on listed coverage", listed_only["conviction"], None)
full = qrow(fe.build(indexes=idx3, by_ticker=[ccc], peers=PEERS, cusips=TICK, table=TABLE, books=BOOKS, now="x"), "2026Q2", "CCC")
eq("with every comparable manager's book: coverage is complete", full["coverage"], "complete")
eq("...holders and value from the books, the call left out", (full["h"], full["v"], full["s"]), (2, 135, 135))
eq("...p1's added comes from its whole share counts (100 to 120)", (full["added"], full["buyers"]), (2, 2))
eq("...netShares is +5 (p0) +20 (p1)", full["netShares"], 25)
eq("...and conviction is 25 over the 110 comparable shares before", full["conviction"], round(25 / 110, 4))
part = qrow(fe.build(indexes=idx3, by_ticker=[ccc], peers=PEERS, cusips=TICK, table=TABLE,
                     books={k: v for k, v in BOOKS.items() if k[0] != "p2"}, now="x"), "2026Q2", "CCC")
eq("one comparable manager without a book (and not whole): coverage falls back to listed", part["coverage"], "listed")
eq("...though the managers with books still count from them", part["h"], 2)
whole_idx = [index("p0", [bq("2026Q2", "2026Q1"), bq("2026Q1", None)]), index("p1", [bq("2026Q2", "2026Q1"), bq("2026Q1", None)]),
             index("p2", [qrec("2026Q2", "2026Q1"), qrec("2026Q1", None)])]
part2 = qrow(fe.build(indexes=whole_idx, by_ticker=[ccc], peers=PEERS, cusips=TICK, table=TABLE,
                      books={k: v for k, v in BOOKS.items() if k[0] != "p2"}, now="x"), "2026Q2", "CCC")
eq("...but a manager whose listed rows are its whole book in both quarters counts as complete", part2["coverage"], "complete")
one_side = qrow(fe.build(indexes=idx3, by_ticker=[ccc], peers=PEERS, cusips=TICK, table=TABLE,
                         books={k: v for k, v in BOOKS.items() if k != ("p1", "2026Q1")}, now="x"), "2026Q2", "CCC")
eq("a book for one side only is not used: p1 falls back to its listed rows", (one_side["coverage"], one_side["h"]), ("listed", 1))

# Breadth and conviction by hand, five managers all on complete books.
idx5 = [index(m, [bq("2026Q2", "2026Q1"), bq("2026Q1", None)]) for m in ("p0", "p1", "p2", "p3", "p4")]
ddd = {"ticker": "DDD", "name": "DDD", "cusips": ["D0000000D"], "managers": [["p0", "P0"], ["p1", "P1"]],
       "quarters": {"2026Q1": [[0, 100, "h", 100], [1, 200, "h", 200]], "2026Q2": [[0, 150, "a", 150], [1, 200, "h", 200]]},
       "exits": {}}
before5 = {"p0": 100, "p1": 200, "p2": 300, "p4": 50}
after5 = {"p0": 150, "p1": 200, "p2": 250, "p3": 40}
B5 = {}
for m in ("p0", "p1", "p2", "p3", "p4"):
    B5[(m, "2026Q1")] = [["D0000000D", "COM", before5[m], before5[m], None]] if m in before5 else [["Z0000000Z", "COM", 1, 1, None]]
    B5[(m, "2026Q2")] = [["D0000000D", "COM", after5[m], after5[m], None]] if m in after5 else [["Z0000000Z", "COM", 1, 1, None]]
r5b = qrow(fe.build(indexes=idx5, by_ticker=[ddd], peers=PEERS, cusips=TICK, table=TABLE, books=B5, now="x"), "2026Q2", "DDD")
eq("by hand: p0 added, p1 held, p2 trimmed, p3 new, p4 exited",
   (r5b["added"], r5b["held"], r5b["trimmed"], r5b["new"], r5b["exited"]), (1, 1, 1, 1, 1))
eq("breadth = added 1 + new 1 - trimmed 1 - exited 1 = 0", r5b["breadth"], 0)
eq("netShares = +50 + 0 - 50 + 40 - 50 = -10", r5b["netShares"], -10)
eq("conviction = -10 / 650 prior comparable shares", r5b["conviction"], round(-10 / 650, 4))
eq("an ordinary row is ranked", r5b["rank"], True)


# The books themselves (scripts/funds_books.py): which quarters, what a row
# is, and that a book whose signature is the history's is never read again.
spec_b = importlib.util.spec_from_file_location("funds_books", ROOT / "scripts" / "funds_books.py")
fb = importlib.util.module_from_spec(spec_b)
spec_b.loader.exec_module(fb)
fq = fe.filings([index(m, [qrec(q, None) for q in ("2025Q2", "2025Q3", "2025Q4", "2026Q1", "2026Q2")]
                       + ([qrec("2026Q3", None)] if m == "a" else [])) for m in ("a", "b", "c", "d")])
eq("books: the four quarters ending at the default, and the newer quarter already filed",
   fb.book_quarters(fq), ["2026Q3", "2026Q2", "2026Q1", "2025Q4", "2025Q3"])
eq("a book row: thousands rounded as the history rounds, the right moved out of the class",
   fb.book_rows([{"cusip": "X", "class": "COM CALL", "value": 1499.0, "shares": 10},
                 {"cusip": "X", "class": "COM", "value": 2500.0, "shares": 20}]),
   [["X", "COM", 2, 20, None], ["X", "COM", 1, 10, "CALL"]])
with tempfile.TemporaryDirectory() as tmp:
    out = Path(tmp)
    hx = [{"id": "a", "quarters": [{"quarter": "2026Q2", "periodOfReport": "2026-06-30", "signature": ["acc1", "acc2"]},
                                   {"quarter": "2026Q1", "periodOfReport": "2026-03-31", "signature": ["acc0"]}]}]
    (out / "a").mkdir()
    (out / "a" / "2026Q1.json").write_text(json.dumps({"schema": 1, "signature": ["acc0"], "rows": []}))
    (out / "a" / "2026Q2.json").write_text(json.dumps({"schema": 1, "signature": ["acc1"], "rows": []}))
    eq("a book is read again only when its signature is not the history's (a new amendment)",
       fb.plan(hx, out, ["2026Q2", "2026Q1"]), [("a", "2026Q2", ["acc1", "acc2"], "2026-06-30")])


# ── round two: listing status ────────────────────────────────────────────────

eq("a CUSIP first seen this quarter is a new listing", fe.listing_status("2026Q2", "2026Q2", "2026Q2"), "new-listing")
eq("a symbol first seen this quarter whose CUSIP was held before is new coverage",
   fe.listing_status("2026Q2", "2024Q1", "2026Q2"), "new-coverage")
eq("an established symbol has no listing status", fe.listing_status("2026Q2", "2024Q1", "2024Q1"), None)
eq("the quarter after a listing, from a thin base, is a recent listing, not a change of view", fe.listing_status("2026Q3", "2026Q2", "2026Q2", 3, 40), "recent-listing")
eq("...but not from a broad base: first seen in the earliest book because it sat below a listed line", fe.listing_status("2026Q3", "2026Q2", "2026Q2", 30, 40), None)
eq("...and the quarter after that is ordinary", fe.listing_status("2026Q4", "2026Q2", "2026Q2"), None)
newco = {"ticker": "NEWCO", "name": "NEWCO", "cusips": ["N0000000N"], "managers": [["p0", "P0"], ["p1", "P1"]],
         "quarters": {"2026Q2": [[0, 50, "n", 50], [1, 60, "n", 60]]}, "exits": {}}
oldco = {"ticker": "OLDCO", "name": "OLDCO", "cusips": ["O0000000O"], "managers": [["p0", "P0"], ["p1", "P1"]],
         "quarters": {"2026Q2": [[0, 50, "n", 50], [1, 60, "n", 60]]}, "exits": {}}
lf = fe.build(indexes=idx3, by_ticker=[newco, oldco], peers=PEERS, cusips=TICK, table=TABLE,
              first_seen={"N0000000N": "2026Q2", "O0000000O": "2025Q1"}, now="x")
nr, orow = qrow(lf, "2026Q2", "NEWCO"), qrow(lf, "2026Q2", "OLDCO")
eq("NEWCO: every holder new, first seen in any book this quarter: a new listing, not ranked",
   (nr["listing"], nr["rank"], nr["new"], nr["breadth"]), ("new-listing", False, 2, 2))
eq("OLDCO: first under its ticker now, its CUSIP held in 2025Q1: new coverage, not ranked",
   (orow["listing"], orow["rank"]), ("new-coverage", False))
eq("stocks.json carries the listing status at the default quarter",
   {s["t"]: s["listing"] for s in lf["stocks.json"]["stocks"]}, {"NEWCO": "new-listing", "OLDCO": "new-coverage"})
lb = fe.build(indexes=idx3, by_ticker=[newco], peers=PEERS, cusips=TICK, table=TABLE,
              books={**BOOKS, ("p2", "2026Q1"): [["N0000000N", "COM", 1, 1, None]]}, first_seen={"N0000000N": "2026Q2"}, now="x")
check("a CUSIP a book shows below a listed line the quarter before is not a new listing", qrow(lb, "2026Q2", "NEWCO")["listing"] != "new-listing", qrow(lb, "2026Q2", "NEWCO")["listing"])


# ── round two: price flags ───────────────────────────────────────────────────

eq("a line more than 5% from the others' median price is flagged",
   fe.price_flags({"a": (100, 10), "b": (101, 10), "c": (99, 10), "d": (120, 10)}), {"d"})
eq("...within 5% is not", fe.price_flags({"a": (100, 10), "b": (104, 10), "c": (99, 10)}), set())
eq("...and nothing is flagged with fewer than three priced lines", fe.price_flags({"a": (100, 10), "b": (200, 10)}), set())
# Six holders of SSS. Four doubled their shares on a two-for-one (price 100 to
# 50); two report a stale count at the old price, so their line implies 100.
mids6 = ["s0", "s1", "s2", "s3", "s4", "s5"]
idx6 = [index(m, [qrec("2026Q2", "2026Q1"), qrec("2026Q1", None)]) for m in mids6]
sss = {"ticker": "SSS", "name": "SSS", "cusips": ["S"], "managers": [[m, m] for m in mids6],
       "quarters": {"2026Q1": [[i, 1000, "h", 10] for i in range(6)],
                    "2026Q2": [[i, 1000, "a", 20] for i in range(4)] + [[4, 1000, "h", 10], [5, 1000, "h", 10]]},
       "exits": {}}
pf = fe.build(indexes=idx6, by_ticker=[sss], peers=PEERS, cusips=TICK, table=TABLE, now="x")
pr = qrow(pf, "2026Q2", "SSS")
eq("the two stale lines are flagged and named", (pr["priceFlags"], pr["flagged"]), (2, ["s4", "s5"]))
eq("...they still count in holders and value as filed", (pr["h"], pr["v"]), (6, 6000))
eq("...and without them every holder shows the same factor: the holders test finds the split",
   (pr["split"], pr["splitTest"]), (2, "holders"))
eq("meta counts flagged lines by quarter and manager", pf["meta.json"]["priceFlags"], {"2026Q2": {"s4": 1, "s5": 1}})
# A flagged line is left out of netShares: four managers on whole books, one
# with a stale count that would read as a sale of 90 shares.
idx4 = [index(m, [qrec("2026Q2", "2026Q1"), qrec("2026Q1", None)]) for m in ("f0", "f1", "f2", "f3")]
fff = {"ticker": "FFF", "name": "FFF", "cusips": ["F"], "managers": [[m, m] for m in ("f0", "f1", "f2", "f3")],
       "quarters": {"2026Q1": [[0, 100, "h", 10], [1, 100, "h", 10], [2, 100, "h", 10], [3, 1000, "h", 100]],
                    "2026Q2": [[0, 110, "a", 11], [1, 110, "a", 11], [2, 100, "h", 10], [3, 110, "t", 10]]},
       "exits": {}}
fr = qrow(fe.build(indexes=idx4, by_ticker=[fff], peers=PEERS, cusips=TICK, table=TABLE, now="x"), "2026Q2", "FFF")
eq("f3's line implies 11 a share against 10 for the others: flagged", fr["flagged"], ["f3"])
eq("netShares counts f0 +1, f1 +1, f2 0 and leaves f3's -90 out", fr["netShares"], 2)
eq("...but its trim still counts among sellers", fr["sellers"], 1)


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
        # From listed rows alone, which is the answer only while no comparable
        # manager has complete books; the rebuild from the books follows.
        if not any((ROOT / "data" / "funds" / "books" / m / f"{dq}.json").exists() for m in comp):
            eq(f"{sym} {dq}: holders, valueK, buyers, sellers rebuilt by hand equal the quarter file",
               (row.get("h"), row.get("v"), row.get("buyers"), row.get("sellers")), (holders, value, want_buyers, want_sellers))
        else:
            check(f"{sym} {dq}: the listed rows are a floor under the complete count ({holders} listed, {row.get('h')} holders)",
                  row.get("h", 0) >= holders)

    # The same three rebuilt from the complete books, again by code written
    # here: a comparable manager with a book on both sides (whose signature
    # is the history's) is read from its books, anyone else from its listed
    # rows; prices are checked against the median of the other filers.
    BOOKS_DIR = ROOT / "data" / "funds" / "books"
    cmap = json.loads((ROOT / "data" / "cusip-tickers.auto.json").read_text()).get("tickers", {})

    def book(m, q):
        p = BOOKS_DIR / m / f"{q}.json"
        if not p.exists() or q not in by_mgr.get(m, {}):
            return None
        b = json.loads(p.read_text())
        return b if b.get("signature") == by_mgr[m][q].get("signature") else None

    def whole_listed(m, q):
        r = by_mgr.get(m, {}).get(q)
        return bool(r) and r["listed"] >= r["positions"]

    books_seen = 0
    for sym in ("NVDA", "MSFT", "UNH"):
        bt = json.loads((BYT / f"{sym}.json").read_text())
        ids = [m[0] for m in bt["managers"]]
        listed_rows = {qq: {ids[r[0]]: (r[1], r[3], r[2]) for r in bt["quarters"].get(qq, [])} for qq in (dq, prior)}

        def from_book(b):
            v = s = 0
            hit = False
            for c, _cls, vk, sh, pc in b["rows"]:
                if not pc and cmap.get(c) == sym:
                    v, s, hit = v + vk, s + sh, True
            return (v, s) if hit else None

        def line(m, qq):
            b = book(m, qq)
            if b is not None:
                return from_book(b)
            r = listed_rows[qq].get(m)
            return (r[0], r[1]) if r else None

        def flagged(qq):
            lines = {m: line(m, qq) for m in by_mgr}
            px = {m: l[0] / l[1] for m, l in lines.items() if l and l[0] > 0 and l[1] > 0}
            out = set()
            if len(px) >= 3:
                for m, p in px.items():
                    others = sorted(v for k, v in px.items() if k != m)
                    k = len(others)
                    med = others[k // 2] if k % 2 else (others[k // 2 - 1] + others[k // 2]) / 2
                    # A filing the published meta names as valued at last
                    # quarter's prices keeps its share count, and a small line
                    # whose $1,000 rounding cannot carry 5% is not judged.
                    if m in stale_by_q.get(qq, set()) or 0.5 / lines[m][1] > 0.05 * med:
                        continue
                    if abs(p / med - 1) > 0.05:
                        out.add(m)
            return out

        stale_by_q = {q: set(v) for q, v in json.loads((EXP / "meta.json").read_text()).get("staleValuations", {}).items()}
        fl_now, fl_before = flagged(dq), flagged(prior)
        cur, before, exits = {}, {}, set()
        paired_all = True
        for m in comp:
            if book(m, dq) is not None and book(m, prior) is not None:
                books_seen += 1
                c, b = from_book(book(m, dq)), from_book(book(m, prior))
                if c:
                    act = "n" if not b else "a" if c[1] > b[1] else "t" if c[1] < b[1] else "h"
                    cur[m] = (c[0], c[1], act)
                if b:
                    before[m] = (b[0], b[1])
                    if not c:
                        exits.add(m)
            else:
                paired_all = paired_all and whole_listed(m, dq) and whole_listed(m, prior)
                if m in listed_rows[dq]:
                    cur[m] = listed_rows[dq][m]
                if m in listed_rows[prior]:
                    before[m] = listed_rows[prior][m][:2]
                exits |= {ids[r[0]] for r in bt["exits"].get(dq, []) if ids[r[0]] == m}
        row = rows.get(sym, {})
        split = row.get("split")
        n_new = sum(1 for x in cur.values() if x[2] == "n")
        n_add = sum(1 for x in cur.values() if x[2] == "a")
        n_trim = sum(1 for x in cur.values() if x[2] == "t")
        buyers = n_new + (0 if split else n_add)
        sellers = len(exits) + (0 if split else n_trim)
        eq(f"{sym} {dq} from the books: holders, valueK, buyers, sellers, breadth",
           (row.get("h"), row.get("v"), row.get("buyers"), row.get("sellers"), row.get("breadth")),
           (len(cur), sum(x[0] for x in cur.values()), buyers, sellers, buyers - sellers))
        eq(f"{sym} {dq} from the books: coverage", row.get("coverage"), "complete" if paired_all else "listed")
        eq(f"{sym} {dq}: the flagged holders are the ones whose price is off the others' median",
           row.get("flagged", []), sorted(m for m in cur if m in fl_now))
        if paired_all and not split:
            keep = [m for m in comp if m not in fl_now and m not in fl_before]
            net = sum(cur.get(m, (0, 0))[1] - before.get(m, (0, 0))[1] for m in keep)
            base = sum(before.get(m, (0, 0))[1] for m in keep)
            eq(f"{sym} {dq} from the books: netShares and conviction, flagged lines left out",
               (row.get("netShares"), row.get("conviction")), (net, round(net / base, 4) if base else None))
        eq(f"{sym} {dq}: and the stock index", (stock_rows[sym]["h"], stock_rows[sym]["v"]), (row.get("h"), row.get("v")))
    check("the rebuild read complete books for the comparable managers", books_seen > 0, books_seen)

    # Every book on file is the quarter its history describes.
    off = []
    nbooks = 0
    for p in sorted(BOOKS_DIR.glob("*/*.json")) if BOOKS_DIR.exists() else []:
        b = json.loads(p.read_text())
        nbooks += 1
        h = by_mgr.get(b["id"], {}).get(b["quarter"])
        if (not h or b["signature"] != h["signature"] or b["positions"] != h["positions"] or b["aumK"] != h["aumK"]
                or len(b["rows"]) != b["positions"] or any(len(r) != 5 for r in b["rows"])):
            off.append(p.name if not h else f"{b['id']}/{b['quarter']}")
    check(f"every one of the {nbooks} books matches its history quarter's signature, positions and value", nbooks and not off, off[:5])
    size = (EXP / "stocks.json").stat().st_size
    check(f"stocks.json stays under 2 MB ({size / 1e6:.2f} MB)", size < 2_000_000)
    eq("every symbol with a by-ticker file appears in stocks.json",
       sorted(p.stem for p in BYT.glob("*.json") if fe.TICKER_FILE.match(p.stem)), sorted(stock_rows))
    table = json.loads((ROOT / "data" / "funds.themes.json").read_text())
    eq("the published theme table has no problems", fe.table_problems(table), [])
    missing = sorted({t for th in table["themes"].values() for t in th.get("tickers", [])} - {fe.norm_ticker(t) for t in stock_rows})
    eq("every ticker a bespoke theme publishes is a symbol in the Explorer", missing, [])
    fl = json.loads((EXP / "filings.json").read_text())
    hist = ROOT / "data" / "funds" / "history"
    for mid in ("citadel-advisors", "neuberger-berman-group"):
        idx = json.loads((hist / mid / "index.json").read_text())
        want = {q["quarter"]: [q.get("aumK"), q.get("filed"), q.get("periodOfReport"), q.get("filingUrl")] for q in idx["quarters"]}
        eq(f"filings.json carries {mid}'s every quarter as its history index states it", fl["managers"].get(mid), want)
    size = (EXP / "filings.json").stat().st_size
    check(f"filings.json stays under 1.5 MB, inside the data cache's entry limit ({size / 1e6:.2f} MB)", size < 1_500_000)

# A reissue under a new CUSIP is a corporate action, not selling (DuPont, Honeywell 2026Q2).
fe.holders_of.clear()
fe.holders_of[("DD", "2026Q1")] = {"OLD000001": {"a", "b", "c", "d"}}
fe.holders_of[("DD", "2026Q2")] = {"NEW000001": {"a", "b", "c"}}
check("a CUSIP replaced by a new one held by most of its holders is a reissue", fe.reissued("DD", "2026Q2"))
fe.holders_of[("DD", "2026Q2")] = {"NEW000001": {"x"}}
check("...not when the new CUSIP's holders are different managers", not fe.reissued("DD", "2026Q2"))
fe.holders_of[("DD", "2026Q2")] = {"OLD000001": {"a"}, "NEW000001": {"a", "b", "c"}}
check("...not while the old CUSIP is still held", not fe.reissued("DD", "2026Q2"))
fe.holders_of.clear()

# A filing valued at last quarter's prices (AllianceBernstein, Q1 and Q2 2026):
# its lines are not flagged and its share counts are used.
check("a stale-valued filing's line is not flagged",
      fe.price_flags({"a": (100, 10), "b": (101, 10), "c": (99, 10), "ab": (80, 10)}, stale={"ab"}) == set())
check("...the same line from any other filing is", fe.price_flags({"a": (100, 10), "b": (101, 10), "c": (99, 10), "ab": (80, 10)}) == {"ab"})
check("a small line whose $1,000 rounding cannot carry its price to 5% is not flagged",
      fe.price_flags({"a": (100, 1000), "b": (101, 1000), "c": (99, 1000), "tiny": (2, 10)}) == set())
check("...while a large line off by the same margin is", fe.price_flags({"a": (100, 1000), "b": (101, 1000), "c": (99, 1000), "big": (200, 1000)}) == {"big"})
_sv = {f"T{i}": {"2026Q2": {"x": (10.0 * (i + 1), 10), "y": (12.0 * (i + 1), 10), "z": (12.0 * (i + 1), 10), "w": (12.0 * (i + 1), 10)},
                 "2026Q1": {"x": (10.0 * (i + 1), 10), "y": (10.0 * (i + 1), 10), "z": (10.0 * (i + 1), 10), "w": (10.0 * (i + 1), 10)}}
       for i in range(25)}
_cons = fe.consensus_prices(_sv)
eq("a manager pricing 25 of 25 lines at last quarter's consensus is read as stale-valued",
   fe.stale_valuations(_sv, _cons, ["2026Q2"]), {"2026Q2": {"x"}})

# The stock page's holder table from complete books: every counted holder is listed.
if (EXP / "holders").exists():
    for _sym in ("NVDA", "MSFT", "UNH"):
        _h = json.loads((EXP / "holders" / f"{_sym}.json").read_text())
        _q = json.loads((EXP / "quarters" / "2026Q2.json").read_text())
        _row = next(r for r in _q["rows"] if r["t"] == _sym)
        eq(f"{_sym} 2026Q2: the holder lines published are the holders counted", len(_h["quarters"]["2026Q2"]["rows"]), _row["h"])
        eq(f"{_sym} 2026Q2: and their value sums to the row's", sum(v[0] for v in _h["quarters"]["2026Q2"]["rows"].values()), _row["v"])
with tempfile.TemporaryDirectory() as _tmp:
    _out = Path(_tmp)
    fe.write({"holders/ZZZ.json": {"ticker": "ZZZ", "quarters": {"2025Q4": {"rows": {"a": [1, 1, "h", 1]}, "exits": {}}}}}, _out)
    fe.write({"holders/ZZZ.json": {"ticker": "ZZZ", "quarters": {"2026Q1": {"rows": {"a": [2, 2, "a", 1]}, "exits": {}}}}}, _out)
    eq("a holders file keeps a quarter once the books window has moved past it",
       sorted(json.loads((_out / "holders" / "ZZZ.json").read_text())["quarters"]), ["2025Q4", "2026Q1"])

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
