#!/usr/bin/env python3
"""
What a run may not do to the observations already on file.

    python3 scripts/__tests__/precedent-guard.test.py

WHY THIS EXISTS
---------------
The database accumulates, and each monthly run reads some rows again: a reader
change (premiumReader, financialsReader), a target the deck index corrects, a
de-SPAC verdict revisited. Before this guard, a re-read that failed (EDGAR
down, a 429 storm, a filing moved) replaced a good row with status "error", and
a re-read that simply found less cleared the figure, and the publication gate,
which counts rows, published it. The fixtures are four real rows as stored on
11 October 2026: Juniper/HPE, iRobot/Amazon, Advanced Disposal/Waste Management
and Snyder's-Lance/Campbell. What is checked:

  a failed re-read      the row stays as it was, the failure is noted on it
  a lost figure         put back when no reader moved and nothing was reclassified
  a reader correction   a premium or EBITDA withdrawn under a reader bump stands,
                        recorded as a revision with the old value
  a re-identified row   a target that changed company may change its figures
  history               every change carries run, field, from, to and cause; a
                        second write in the same run does not duplicate it
  a missing row         put back
  the run-level check   more than 5% of the rows carrying a field, and at
                        least 25 rows, losing it refuses the write and leaves
                        the file untouched; 5% or fewer is written, and so is
                        a loss of fewer than 25 rows
  the real first run    the merged readers' first run over the published
                        database (48 of 1,724 one-day premiums, 18 of 298
                        30-day VWAPs, 14 of 163 LTM EBITs) passes
"""

from __future__ import annotations

import copy
import json
import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))

from precedent_transactions import database, guard  # noqa: E402

FIX = json.loads((ROOT / "scripts" / "__tests__" / "fixtures" / "precedent-guard.json").read_text())["rows"]
BASE = {r["id"]: r for r in FIX}
JNPR, IRBT, ADSW, LNCE = "0001193125-24-046175", "0001193125-22-240062", "0001047469-20-004238", "0001174947-18-000230"
passed = failed = 0


def eq(name, got, want):
    global passed, failed
    ok = got == want
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + ("" if ok else f" — got {got!r}, want {want!r}"))
    if ok:
        passed += 1
    else:
        failed += 1


def fresh():
    return copy.deepcopy(BASE)


# ── the real rows are what the fixtures say ────────────────────────────────
eq("the fixture rows as stored", [(BASE[i]["target"]["name"], BASE[i]["premium1Day"], BASE[i]["ltmEbitda"]) for i in (JNPR, IRBT, ADSW, LNCE)],
   [("JUNIPER NETWORKS INC", 0.2, 664.8), ("IROBOT CORP", 0.22, -54.3), ("Advanced Disposal Services, Inc.", 0.116, 371.3), ("SNYDER'S-LANCE, INC.", 0.27, 136.0)])

# ── a failed re-read keeps the row ─────────────────────────────────────────
rows = fresh()
rows[JNPR] = {"id": JNPR, "target": BASE[JNPR]["target"], "status": "error", "error": "RuntimeError: fetch failed https://www.sec.gov/...", "flags": []}
rep = guard.protect(BASE, rows)
eq("a re-read that errors leaves Juniper as stored", (rows[JNPR]["status"], rows[JNPR]["offerPrice"], rows[JNPR]["premium1Day"], rows[JNPR]["ltmEbitda"]), ("ok", 40.0, 0.2, 664.8))
eq("and notes the failure on the row", any("re-read failed, prior reading kept" in e for e in rows[JNPR]["readErrors"]), True)
eq("and reports it", [r["id"] for r in rep["restoredRows"]], [JNPR])
eq("a row already in error may stay in error", guard.protect({JNPR: {**BASE[JNPR], "status": "error"}}, {JNPR: {**BASE[JNPR], "status": "error", "error": "x"}})["restoredRows"], [])

# ── a lost figure with no reason is put back ───────────────────────────────
rows = fresh()
rows[LNCE]["premium1Day"] = None          # same premiumReader: nothing moved
rows[LNCE]["ltmEbitda"] = None            # same financialsReader
rows[ADSW]["offerPrice"] = None           # no reader owns the offer
rep = guard.protect(BASE, rows)
eq("Snyder's-Lance's 27% premium put back", rows[LNCE]["premium1Day"], 0.27)
eq("its $136.0m LTM EBITDA put back", rows[LNCE]["ltmEbitda"], 136.0)
eq("Advanced Disposal's $30.30 offer put back", rows[ADSW]["offerPrice"], 30.3)
eq("each one reported", sorted((k["id"], k["field"]) for k in rep["keptPrior"]), sorted([(LNCE, "premium1Day"), (LNCE, "ltmEbitda"), (ADSW, "offerPrice")]))
eq("nothing recorded as a revision for a figure that was put back", [r["field"] for r in rows[LNCE].get("revisions", [])], [])

# ── a reader correction withdraws on purpose, and is recorded ──────────────
rows = fresh()
rows[JNPR].update({"premium1Day": None, "premiumReader": 2})   # the adviser's range, withdrawn by reader 2
rows[LNCE].update({"ltmEbitda": None, "financialsReader": 2})  # EBITDA whose parts were different twelve months
rep = guard.protect(BASE, rows)
eq("Juniper's 20% (Goldman's illustrative range) stays withdrawn under premiumReader 2", rows[JNPR]["premium1Day"], None)
eq("recorded with the old value and the cause", [(r["field"], r["from"], r["to"], r["cause"]) for r in rows[JNPR]["revisions"]], [("premium1Day", 0.2, None, "premiumReader 1 to 2")])
eq("Snyder's-Lance's mixed-period EBITDA stays withdrawn under financialsReader 2", (rows[LNCE]["ltmEbitda"], rows[LNCE]["revisions"][0]["cause"]), (None, "financialsReader 1 to 2"))
eq("no figure put back", rep["keptPrior"], [])

# ── a corrected value is a revision ────────────────────────────────────────
rows = fresh()
rows[JNPR].update({"premium1Day": 40 / 30.22 - 1, "unaffectedPriceStated": 30.22, "premiumReader": 2})
guard.protect(BASE, rows)
r0 = [r for r in rows[JNPR]["revisions"] if r["field"] == "premium1Day"][0]
eq("Juniper 20.0% to 32.4% recorded", (r0["from"], round(r0["to"], 4), r0["cause"]), (0.2, 0.3236, "premiumReader 1 to 2"))
eq("the stated unaffected price, new, recorded too", [(r["field"], r["from"], r["to"]) for r in rows[JNPR]["revisions"] if r["field"] == "unaffectedPriceStated"], [("unaffectedPriceStated", None, 30.22)])
guard.protect(BASE, rows)
eq("a second write in the same run does not record it twice", len([r for r in rows[JNPR]["revisions"] if r["field"] == "premium1Day"]), 1)
rows[JNPR]["revisions"] = [{"run": f"2026-0{m}-01T08:00:00Z", "field": "acquirer", "from": "a", "to": "b", "cause": "read again"} for m in range(1, 10)] * 3
guard.protect(BASE, rows)
eq("history is capped at the newest 20", (len(rows[JNPR]["revisions"]), rows[JNPR]["revisions"][-1]["run"]), (20, guard.RUN_AT))

# ── a re-identified row may change its figures ─────────────────────────────
rows = fresh()
rows[ADSW]["target"] = {**BASE[ADSW]["target"], "cik": "0000823768"}
rows[ADSW].update({"ltmEbitda": None, "sharesOut": None})
rep = guard.protect(BASE, rows)
eq("a row read for a different company keeps its new (empty) figures", (rows[ADSW]["ltmEbitda"], rows[ADSW]["sharesOut"]), (None, None))
eq("with the cause named", {r["cause"] for r in rows[ADSW]["revisions"]}, {"target re-identified"})

# ── a reclassified row may lose its figures ────────────────────────────────
rows = fresh()
rows[IRBT].update({"status": "duplicate", "premium1Day": None})
guard.protect(BASE, rows)
eq("iRobot's first proxy, now a duplicate of the revised deal, may lose its premium", rows[IRBT]["premium1Day"], None)

# ── a missing row is put back ──────────────────────────────────────────────
rows = fresh()
del rows[IRBT]
rep = guard.protect(BASE, rows)
eq("a row the run dropped is put back", (IRBT in rows, rows[IRBT]["offerPrice"]), (True, 61.0))

# ── the run-level check ────────────────────────────────────────────────────
def population(n: int, lost: int, *, bump: bool):
    base, cur = {}, {}
    for i in range(n):
        rid = f"0000000000-26-{i:06d}"
        # each its own company, so dedupe sees a hundred deals, not one deal read a hundred times
        r = {**copy.deepcopy(BASE[JNPR]), "id": rid, "premiumReader": 1}
        r["target"] = {**r["target"], "cik": f"{9000000 + i:010d}", "name": f"TARGET {i}"}
        base[rid] = r
        c = copy.deepcopy(r)
        if i < lost:
            c["premium1Day"] = None
            if bump:
                c["premiumReader"] = 2
        cur[rid] = c
    return base, cur


def refused(base, cur):
    rep = guard.protect(base, cur)
    try:
        guard.check(base, cur, rep)
        return False
    except guard.GuardRefused:
        return True


os.environ["RUNNER_TEMP"] = tempfile.mkdtemp()
eq("60 of 1,000 premiums withdrawn by a reader bump: refused", refused(*population(1000, 60, bump=True)), True)
eq("the report written outside the checkout", (Path(os.environ["RUNNER_TEMP"]) / "precedent-transactions.guard.json").exists(), True)
eq("50 of 1,000: written (the limit is more than 5%)", refused(*population(1000, 50, bump=True)), False)
eq("26 of 300 (8.7%): refused", refused(*population(300, 26, bump=True)), True)
eq("18 of 298 30-day VWAPs (6.0%), the real first run: written, under 25 rows", refused(*population(298, 18, bump=True)), False)
eq("14 of 163 LTM EBITs (8.6%), the real first run: written", refused(*population(163, 14, bump=True)), False)
eq("100 of 298 (a reader losing a third): refused", refused(*population(298, 100, bump=True)), True)
eq("100 of 100 lost without a bump: all put back, so nothing refused", refused(*population(100, 100, bump=False)), False)
eq("48 of 1,724 one-day premiums, the real first run, passes", refused(*population(1724, 48, bump=True)), False)

# ── through database.write: a refused write leaves the file as it was ──────
tmp = Path(tempfile.mkdtemp()) / "precedent-transactions.auto.json"
database.OUT = tmp
base, cur = population(100, 30, bump=True)
tmp.write_text(json.dumps({"transactions": list(base.values())}) + "\n")
database._baseline = None
stored = database.load_stored()
before = tmp.read_text()
try:
    database.write(cur)
    wrote = True
except guard.GuardRefused:
    wrote = False
eq("database.write refuses 30 of 100 withdrawn premiums", wrote, False)
eq("and the file on disk is unchanged", tmp.read_text() == before, True)
database.set_baseline(stored)
cur2 = copy.deepcopy(stored)
cur2[next(iter(cur2))]["status"] = "error"
out = database.write(cur2)
eq("an accepted write with a failed re-read publishes the prior reading", {r["status"] for r in out["transactions"]}, {"ok"})
database.set_baseline(None)
eq("with no baseline (a fresh database), write is unguarded", database.write(copy.deepcopy(cur))["counts"]["transactions"], 100)

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
