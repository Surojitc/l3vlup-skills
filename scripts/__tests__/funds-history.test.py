#!/usr/bin/env python3
"""
The 13F history builder's rules, offline.

    python3 scripts/__tests__/funds-history.test.py

WHY THIS EXISTS
---------------
The history is what the site will say a manager did over a decade: what it
opened, added to, cut and sold, quarter by quarter. Every one of those words is
a claim about a real firm, so the rules behind them are pinned here:

- a quarter is compared only with the quarter immediately before it, and a gap
  is never read as the manager selling everything;
- counts cover the whole book even where only the largest positions are listed;
- an exit is a security no class of which remains, counted once;
- a quarter is read again only when its filing or amendments change, and the
  quarter after it is re-derived with it;
- a run that changes nothing writes nothing, and a past year's file is never
  rewritten;
- a budget bounds every run, and what it left undone is written down;
- a comparison across a change of filer says so;
- a ticker is given only where the SEC's own CUSIP map gives it.

EDGAR is replaced by stubs; nothing here touches the network.
"""

from __future__ import annotations

import importlib.util
import io
import json
import sys
import tempfile
from contextlib import redirect_stdout
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
spec = importlib.util.spec_from_file_location("funds_history", ROOT / "scripts" / "funds_history.py")
fh = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fh)
sf = fh.sf

passed = failed = 0


def check(name: str, cond: bool, detail: object = "") -> None:
    global passed, failed
    if cond:
        passed += 1
        print(f"PASS  {name}")
    else:
        failed += 1
        print(f"FAIL  {name}{f' — {detail}' if detail != '' else ''}")


def pos(cusip, value, shares, cls="COM", issuer=None):
    return {"cusip": cusip, "issuer": issuer or f"{cusip} CORP", "class": cls, "value": float(value), "shares": shares}


def table(quarter, holdings, cik="0000000001", acc=None):
    period = {"1": "03-31", "2": "06-30", "3": "09-30", "4": "12-31"}[quarter[-1]]
    hs = sorted(holdings, key=lambda p: -p["value"])
    total = sum(p["value"] for p in hs)
    return {"quarter": quarter, "periodOfReport": f"{quarter[:4]}-{period}", "filed": f"{quarter[:4]}-{period}",
            "accession": acc or f"A-{quarter}", "filingUrl": f"https://example/{quarter}", "cik": cik,
            "holdings": hs, "aum": round(total / 1e6, 1), "positions": len(hs)}


# ── 1. derive: the comparison ────────────────────────────────────────────────
q1 = table("2026Q1", [pos("AAA", 100e6, 100), pos("BBB", 50e6, 50), pos("CCC", 30e6, 30),
                      pos("DDD", 10e6, 10), pos("DDD", 2e6, 1, cls="COM CALL")])
q2 = table("2026Q2", [pos("AAA", 132e6, 120), pos("BBB", 25e6, 25), pos("CCC", 33e6, 30),
                      pos("EEE", 20e6, 20), pos("DDD", 1e6, 1, cls="COM CALL")])
d = fh.derive(q2, q1)
codes = {r[0] + "|" + r[1]: r[4] for r in d["holdings"]}
check("derive: compared with the quarter before", d["vsPrior"] == "2026Q1", d["vsPrior"])
check("derive: actions", codes == {"AAA|COM": "a", "BBB|COM": "t", "CCC|COM": "h", "EEE|COM": "n", "DDD|COM CALL": "h"}, codes)
check("derive: counts over the whole book", d["counts"] == {"new": 1, "added": 1, "trimmed": 1, "held": 2, "exited": 0}, d["counts"])
check("derive: the common stock gone but a call kept is not an exit of the security", d["exits"] == [], d["exits"])
check("derive: values in thousands", d["aumK"] == 211000 and d["openedK"] == 20000, (d["aumK"], d["openedK"]))
bought = 20e6 + 20 * (132e6 / 120)
sold = 25 * (25e6 / 25)
check("derive: turnover is min(bought, sold) over the average book",
      d["turnover"] == round(min(bought, sold) / ((211e6 + 192e6) / 2), 4), d["turnover"])
check("derive: largest increase listed", d["increases"][0][:3] == ["AAA", "COM", 20], d["increases"])
check("derive: largest reduction listed", d["decreases"][0][:3] == ["BBB", "COM", -25], d["decreases"])
check("derive: top ten and concentration", d["top10Pct"] == 1.0 and 0 < d["hhi"] < 1, (d["top10Pct"], d["hhi"]))

q3 = table("2026Q3", [pos("AAA", 140e6, 120)])
d3 = fh.derive(q3, q2)
check("derive: exits counted per security, classes summed",
      d3["counts"]["exited"] == 4 and [e[0] for e in d3["exits"]] == ["CCC", "BBB", "EEE", "DDD"], d3["exits"])
check("derive: closed value is the prior value of what left", d3["closedK"] == 79000, d3["closedK"])

# A gap: Q4 missing, Q1 2027 compared with nothing.
gap = fh.derive(table("2027Q1", [pos("ZZZ", 5e6, 5)]), q3)
check("derive: a gap is never read as selling everything",
      gap["vsPrior"] is None and gap["counts"] is None and gap["exits"] == [] and gap["turnover"] is None, gap)
check("derive: without a comparison every position is held", {r[4] for r in gap["holdings"]} == {"h"})
empty = fh.derive(table("2026Q4", []), q3)
check("derive: an empty table compares with nothing", empty["vsPrior"] is None and empty["aumK"] == 0, empty)

# The listed cap: counts and coverage still describe the whole book.
fh.KEEP = 2
capped = fh.derive(q2, q1)
check("derive: only the largest KEEP are listed", capped["listed"] == 2 and len(capped["holdings"]) == 2)
check("derive: listed share of value", capped["listedValuePct"] == round(165 / 211, 4), capped["listedValuePct"])
check("derive: counts are still the whole book", sum(capped["counts"].values()) == 5, capped["counts"])
fh.KEEP = 500

# ── 2. plan_work: what must be read ──────────────────────────────────────────
planned = [
    {"periodOfReport": "2026-06-30", "accession": "Q2"},
    {"periodOfReport": "2026-03-31", "accession": "Q1", "extras": [{"accession": "Q1A"}]},
    {"periodOfReport": "2025-12-31", "accession": "Q4"},
]
existing = {"quarters": [
    {"periodOfReport": "2026-06-30", "signature": ["Q2"]},
    {"periodOfReport": "2026-03-31", "signature": ["Q1"]},          # an amendment arrived since
    {"periodOfReport": "2025-12-31", "signature": ["Q4"]},
]}
check("plan: an amended quarter and the one after it are read again",
      fh.plan_work(planned, existing) == ["2026-03-31", "2026-06-30"], fh.plan_work(planned, existing))
check("plan: nothing new, nothing read",
      fh.plan_work(planned[:1] + planned[2:], {"quarters": existing["quarters"][:1] + existing["quarters"][2:]}) == [])
check("plan: no file, everything read", fh.plan_work(planned, None) == ["2025-12-31", "2026-03-31", "2026-06-30"])

# ── 3. build_history with stubs: budget, unreadable quarters, filer change ───
def make_sub(rows):
    return {"filings": {"recent": {
        "form": [r[0] for r in rows], "reportDate": [r[1] for r in rows],
        "filingDate": [r[2] for r in rows], "accessionNumber": [r[3] for r in rows]}}}


TABLES = {
    "O-2025Q4": [pos("AAA", 100e6, 100), pos("OLD", 40e6, 40)],
    "O-2026Q1": [pos("AAA", 110e6, 100), pos("OLD", 40e6, 40)],
    "N-2026Q2": [pos("AAA", 150e6, 120), pos("NEW", 60e6, 60)],
    "O-2025Q3": None,  # a filing with no readable table
}


def fake_read_quarter(entry, f, *, use_cache, stats):
    rows = TABLES.get(f["accession"])
    if rows is None:
        return None
    return table(f["quarter"], [dict(p) for p in rows], cik=f["cik"], acc=f["accession"])


sf.read_quarter = fake_read_quarter
sf.read_cover = lambda cik, acc, use_cache=True: {"otherManagers": ["Fund LP", "Holdings LLC"]} if acc.startswith("N-") else {}
old = {"cik": "0000000001", "to": "2026-03-31"}
new = {"cik": "0000000002", "from": "2026-06-30"}
sources = [
    (old, make_sub([("13F-HR", "2026-03-31", "2026-05-15", "O-2026Q1"), ("13F-HR", "2025-12-31", "2026-02-14", "O-2025Q4"),
                    ("13F-HR", "2025-09-30", "2025-11-14", "O-2025Q3")])),
    (new, make_sub([("13F-HR", "2026-06-30", "2026-08-14", "N-2026Q2"), ("13F-HR", "2026-03-31", "2026-05-15", "N-2026Q1")])),
]
entry = {"name": "Test Capital", "id": "test-capital", "filers": [old, new], "cik": "0000000002"}
stats = {k: 0 for k in ("fetched", "cached", "filingErrors", "filingsEmpty", "amendmentsSkipped",
                        "amendmentsApplied", "amendmentsTreatedAsRestated")}
stats["totalMismatch"] = []

with redirect_stdout(io.StringIO()):
    doc, read = fh.build_history(entry, sources, since="2013-06-30", budget=2, existing=None, use_cache=False, stats=stats)
# Q1's table was read for Q2's comparison, but Q1's own record needs Q4 for its
# comparison, so it waits rather than being written without one.
check("budget: newest quarters first, the rest pending",
      [q["quarter"] for q in doc["quarters"]] == ["2026Q2"]
      and doc["pending"] == ["2025-09-30", "2025-12-31", "2026-03-31"] and not doc["complete"],
      ([q["quarter"] for q in doc["quarters"]], doc.get("pending")))
check("budget: the prior quarter read for the comparison counts against it", read == 2, read)

with redirect_stdout(io.StringIO()):
    doc, read = fh.build_history(entry, sources, since="2013-06-30", budget=50, existing=doc, use_cache=False, stats=stats)
qs = {q["quarter"]: q for q in doc["quarters"]}
check("continue: the backfill completes on the next run", doc["complete"] and sorted(qs) == ["2025Q4", "2026Q1", "2026Q2"], sorted(qs))
check("continue: an unreadable quarter is listed, not hidden", doc.get("unreadable") == ["2025-09-30"], doc.get("unreadable"))
check("identity: each quarter keeps its filer", qs["2026Q2"]["cik"] == "0000000002" and qs["2026Q1"]["cik"] == "0000000001")
check("identity: the successor's reports outside its window are not read",
      qs["2026Q1"]["accession"] == "O-2026Q1", qs["2026Q1"]["accession"])
check("filer change: the comparison across it is marked, with the included managers",
      qs["2026Q2"].get("filerChange") == {"fromCik": "0000000001", "includedManagers": ["Fund LP", "Holdings LLC"]},
      qs["2026Q2"].get("filerChange"))
check("filer change: an ordinary quarter is not marked", "filerChange" not in qs["2026Q1"])
check("filer change: OLD reads as exited, NEW as new",
      [e[0] for e in qs["2026Q2"]["exits"]] == ["OLD"] and qs["2026Q2"]["counts"]["new"] == 1)

# ── 4. the files: split, read back, written only when changed ────────────────
with tempfile.TemporaryDirectory() as tmp:
    out = Path(tmp)
    fh.write_split(doc, out)
    folder = out / "test-capital"
    check("files: an index and one file per year", sorted(p.name for p in folder.iterdir()) == ["2025.json", "2026.json", "index.json"],
          sorted(p.name for p in folder.iterdir()))
    index = json.loads((folder / "index.json").read_text())
    check("files: the index carries no full holdings list", all("holdings" not in q for q in index["quarters"]))
    check("files: the index carries each quarter's top positions", all(q["top"] for q in index["quarters"]))
    check("files: a series for every position ever in the top", "AAA|COM" in index["series"]
          and [r[0] for r in index["series"]["AAA|COM"]] == ["2025Q4", "2026Q1", "2026Q2"], index["series"].get("AAA|COM"))
    back = fh.load_existing(folder)
    check("files: read back to the same quarters",
          [q["holdings"] for q in back["quarters"]] == [q["holdings"] for q in doc["quarters"]])
    before = {p.name: p.stat().st_mtime_ns for p in folder.iterdir()}
    again = dict(doc, generatedAt="2099-01-01T00:00:00Z")
    wrote = fh.write_split(again, out)
    after = {p.name: p.stat().st_mtime_ns for p in folder.iterdir()}
    check("files: a run that changed nothing writes nothing", wrote == 0 and before == after, wrote)
    changed = json.loads(json.dumps(doc))
    changed["quarters"][0]["holdings"][0][2] += 1
    fh.write_split(changed, out)
    after2 = {p.name: p.stat().st_mtime_ns for p in folder.iterdir()}
    check("files: a past year is not rewritten when only this year changed",
          after2["2025.json"] == before["2025.json"] and after2["2026.json"] != before["2026.json"])
    (folder / "2025.json").unlink()
    check("files: a missing year file means rebuild, not guess", fh.load_existing(folder) is None)

# ── 5. the security register ─────────────────────────────────────────────────
docs = [
    {"id": "a", "names": {"AAA": "Alpha Corp"}, "quarters": [
        {"quarter": "2025Q4", "periodOfReport": "2025-12-31", "holdings": [["AAA", "COM", 1, 1, "h"]]}]},
    {"id": "b", "names": {"AAA": "Alpha Holdings Inc", "ZZZ": "Zeta"}, "quarters": [
        {"quarter": "2026Q2", "periodOfReport": "2026-06-30", "holdings": [["AAA", "COM", 1, 1, "h"], ["ZZZ", "COM", 1, 1, "n"]]}]},
]
reg = fh.build_securities(docs, {"AAA": "ALP"})
check("register: latest name, earlier names with their quarters",
      reg["AAA"]["name"] == "Alpha Holdings Inc"
      and reg["AAA"]["names"] == [{"name": "Alpha Corp", "from": "2025Q4", "to": "2025Q4"},
                                   {"name": "Alpha Holdings Inc", "from": "2026Q2", "to": "2026Q2"}], reg["AAA"])
check("register: first and last seen, and how many managers", (reg["AAA"]["firstSeen"], reg["AAA"]["lastSeen"], reg["AAA"]["managers"])
      == ("2025Q4", "2026Q2", 2), reg["AAA"])
check("register: a ticker only from the SEC's map, and labelled so",
      reg["AAA"].get("ticker") == "ALP" and reg["AAA"].get("tickerSource") == "sec-ftd" and "ticker" not in reg["ZZZ"], reg)

# ── 6. who held a name, quarter by quarter ───────────────────────────────────
def hq(quarter, rows, *, vs=True, positions=None, listed=None, exits=()):
    period = {"1": "03-31", "2": "06-30", "3": "09-30", "4": "12-31"}[quarter[-1]]
    return {"quarter": quarter, "periodOfReport": f"{quarter[:4]}-{period}", "vsPrior": "x" if vs else None,
            "holdings": rows, "positions": positions if positions is not None else len(rows),
            "listed": listed if listed is not None else len(rows), "exits": [list(e) for e in exits]}


small = {"id": "small", "name": "Small Fund", "names": {"AAA9": "Alpha Inc"}, "quarters": [
    hq("2026Q1", [["AAA9", "COM", 10, 100, "h"], ["BBB9", "COM", 5, 50, "h"]], vs=False),
    hq("2026Q2", [["AAA9", "COM", 12, 130, "a"], ["AAA9", "COM CALL", 1, 9, "n"]]),
]}
big = {"id": "big", "name": "Big Fund", "names": {}, "quarters": [
    hq("2026Q1", [["AAA9", "COM", 50, 500, "h"], ["BBB9", "COM", 7, 70, "h"]], vs=False, positions=900, listed=2),
    hq("2026Q2", [["AAA9", "COM", 40, 420, "t"]], positions=900, listed=1),
]}
files = fh.build_by_ticker([small, big], {"AAA9": "AAA", "BBB9": "BBB"})
a = files["AAA"]
mi = {mid: i for i, (mid, _) in enumerate(a["managers"])}
check("by ticker: a file for a name two managers listed", set(files) == {"AAA", "BBB"}, set(files))
check("by ticker: each quarter's holders, largest first, with their action",
      a["quarters"]["2026Q2"] == [[mi["big"], 420, "t", 40], [mi["small"], 130, "a", 12]], a["quarters"]["2026Q2"])
check("by ticker: a call on the name is not a holding of it", all(r[1] != 139 for r in a["quarters"]["2026Q2"]))
check("by ticker: a quarter with no comparison has no action", {r[2] for r in a["quarters"]["2026Q1"]} == {"h"})
b = files["BBB"]
bi = {mid: i for i, (mid, _) in enumerate(b["managers"])}
check("by ticker: a manager listing its whole book that dropped a name exited it",
      b["exits"].get("2026Q2") == [[bi["small"], 50]], b["exits"])
check("by ticker: a name below a large manager's listed range is not called an exit",
      all(r[0] != bi["big"] for r in b["exits"].get("2026Q2", [])))
check("by ticker: the name and every CUSIP behind the symbol", a["name"] == "Alpha Inc" and a["cusips"] == ["AAA9"], a)
check("by ticker: no symbol without the SEC's map",
      fh.build_by_ticker([small, big], {}) == {})
check("by ticker: one manager's name gets no file", fh.build_by_ticker([small], {"AAA9": "AAA"}) == {})
with tempfile.TemporaryDirectory() as tmp:
    out = Path(tmp) / "by-ticker"
    n1 = fh.write_by_ticker(files, out, on_file=["small", "big"])
    n2 = fh.write_by_ticker(files, out, on_file=["small", "big"])
    bad = fh.write_by_ticker({"../X": files["AAA"]}, out, on_file=[])
    check("by ticker: written once, then nothing when unchanged; a bad symbol is never a path",
          (n1, n2, bad) == (2, 0, 0) and json.loads((out / "AAA.json").read_text())["managersOnFile"] == 2, (n1, n2, bad))

# ── 7. how much of two books is the same ─────────────────────────────────────
def oq(quarter, rows, aum, *, positions=None):
    return {"quarter": quarter, "aumK": aum, "holdings": rows, "positions": positions if positions is not None else len(rows),
            "listed": len(rows)}


# By hand. In 2026Q2 A is 60% X, 40% Y; B is 30% X, 20% Z, 50% W.
# Shared: X only, min(0.6, 0.3) = 0.30. C is 40% Y (and a put on X, ignored), 60% V:
# A and C share Y, min(0.4, 0.4) = 0.40. B and C share nothing.
A = {"id": "a", "name": "A", "quarters": [
    oq("2026Q1", [["X", "COM", 1, 50, "h"], ["Y", "COM", 1, 50, "h"]], 100),
    oq("2026Q2", [["X", "COM", 1, 60, "a"], ["Y", "COM", 1, 40, "t"]], 100)]}
B = {"id": "b", "name": "B", "quarters": [
    oq("2026Q1", [["X", "COM", 1, 100, "h"]], 200),
    oq("2026Q2", [["X", "COM", 1, 60, "t"], ["Z", "COM", 1, 40, "h"], ["W", "COM", 1, 100, "h"]], 200, positions=900)]}
C = {"id": "c", "name": "C", "quarters": [
    oq("2026Q2", [["Y", "COM", 1, 40, "n"], ["X", "PUT", 1, 99, "n"], ["V", "COM", 1, 60, "h"]], 100)]}
D = {"id": "d", "name": "D", "quarters": [oq("2025Q4", [["X", "COM", 1, 100, "h"]], 100)]}
check("overlap: the smaller weight, summed over shared securities",
      fh.overlap(fh.book_weights(A["quarters"][1]), fh.book_weights(B["quarters"][1])) == (0.3, 1))
check("overlap: symmetric", fh.overlap(fh.book_weights(B["quarters"][1]), fh.book_weights(A["quarters"][1])) == (0.3, 1))
check("overlap: identical books are 1, disjoint books 0",
      fh.overlap({"X": 0.5, "Y": 0.5}, {"X": 0.5, "Y": 0.5}) == (1.0, 2) and fh.overlap({"X": 1.0}, {"Y": 1.0}) == (0.0, 0))
check("overlap: a put is not a position", "X" not in fh.book_weights(C["quarters"][0]))
ov = fh.build_overlap([A, B, C, D])
check("overlap: peers most in common first", [r["id"] for r in ov["a"]["peers"]] == ["c", "b"], ov["a"]["peers"])
check("overlap: the figures by hand", [(r["overlap"], r["shared"]) for r in ov["a"]["peers"]] == [(0.4, 1), (0.3, 1)], ov["a"]["peers"])
check("overlap: a manager that did not file that quarter is not compared", all(r["id"] != "d" for r in ov["a"]["peers"]))
check("overlap: nothing shared, no peer row", [r["id"] for r in ov["c"]["peers"]] == ["a"], ov["c"]["peers"])
check("overlap: a peer listing only part of its book is flagged",
      next(r for r in ov["a"]["peers"] if r["id"] == "b")["wholeBooks"] is False
      and next(r for r in ov["a"]["peers"] if r["id"] == "c")["wholeBooks"] is True)
check("overlap: through time, only quarters both filed",
      ov["a"]["series"]["b"] == [["2026Q1", 0.5, 1], ["2026Q2", 0.3, 1]] and ov["a"]["series"]["c"] == [["2026Q2", 0.4, 1]],
      ov["a"]["series"])
with tempfile.TemporaryDirectory() as tmp:
    out = Path(tmp) / "overlap"
    n1 = fh.write_overlap(ov, out)
    n2 = fh.write_overlap(ov, out)
    bad = fh.write_overlap({"../x": ov["a"]}, out)
    check("overlap: written once, unchanged writes nothing, a bad id is never a path", (n1, n2, bad) == (len(ov), 0, 0), (n1, n2, bad))

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
