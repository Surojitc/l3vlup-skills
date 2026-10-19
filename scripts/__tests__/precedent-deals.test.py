#!/usr/bin/env python3
"""
One row per transaction, with every filing of it kept.

    python3 scripts/__tests__/precedent-deals.test.py

WHY THIS EXISTS
---------------
A deal is read from every filing that states it, and each reading was its own
row: Endeavor's 13E-3 and its information statement, Vista Outdoor's proxy and
the supplement after CSG raised its offer, Satsuma's statement listed under two
filers. 243 readings counted their deals a second or third time, and every
premium median and multiple quartile built on the database counted them too.

The fixtures are the rows as the collector stored them. What is checked:

  the same deal      one primary, the others "duplicate" with their reading kept
  a revised offer    one deal; the final terms headline, the earlier in history
  a contest          Netflix's and Paramount's bids for Warner Bros. Discovery,
                     and UWM's and CrossCountry's for Two Harbors, stay two deals
  years apart        Talkspace in 2021 and in 2026 stay two deals
  a misreading       two readings filed the same day that disagree are flagged
  idempotence        a second write re-decides from the readings, not from
                     the previous marking
"""

from __future__ import annotations

import copy
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))

from precedent_transactions import database  # noqa: E402

FIX = json.loads((ROOT / "scripts" / "__tests__" / "fixtures" / "precedent-deals.json").read_text())
passed = failed = 0


def eq(name, got, want):
    global passed, failed
    ok = got == want
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + ("" if ok else f" — got {got!r}, want {want!r}"))
    if ok:
        passed += 1
    else:
        failed += 1


rows = {r["id"]: copy.deepcopy(r) for r in FIX}
database.dedupe(rows)
by = lambda name: sorted((r for r in rows.values() if name.lower() in r["target"]["name"].lower()), key=lambda r: r["filed"])  # noqa: E731

wbd = by("Warner Bros")
eq("Warner Bros. Discovery: Netflix's $27.75 and Paramount's $31.00 are two deals", [(r["status"], r["acquirer"], r["offerPrice"]) for r in wbd], [("ok", "Netflix, Inc.", 27.75), ("ok", "Paramount Skydance Corporation", 31.0)])
two = by("TWO HARBORS")
eq("Two Harbors: UWM and CrossCountry are two deals", [r["status"] for r in two], ["ok", "ok"])

vista = by("Vista Outdoor")
eq("Vista Outdoor: one deal, the October supplement's $25.75 is the headline", [(r["status"], r["offerPrice"]) for r in vista], [("duplicate", 12.9), ("ok", 25.75)])
eq("Vista Outdoor: the April $12.90 stays in the offer history", vista[1]["offerHistory"], [{"filed": "2024-04-02", "offerPrice": 12.9}, {"filed": "2024-10-21", "offerPrice": 25.75}])
eq("Vista Outdoor: the earlier reading keeps its own figures and its status", (vista[0]["readStatus"], vista[0]["duplicateOf"], vista[0]["offerPrice"]), ("ok", vista[1]["id"], 12.9))
eq("Vista Outdoor: both filings listed on the primary", [x["filed"] for x in vista[1]["readings"]], ["2024-04-02", "2024-10-21"])

end = by("Endeavor")
eq("Endeavor: the 13E-3 and the information statement are one deal; the later filing is primary", [(r["source"], r["status"]) for r in end], [("SC 13E3", "duplicate"), ("DEFM14C", "ok")])
eq("Endeavor: the primary borrows the 13E-3's buyer group, advisers and fee-table value, and names the reading", end[1].get("filledFrom"), {"buyers": end[0]["id"], "advisers": end[0]["id"], "dealValue": end[0]["id"]})

sat = by("Satsuma")
eq("Satsuma: two readings filed the same day, one deal", sorted(r["status"] for r in sat), ["duplicate", "ok"])
prim = next(r for r in sat if r["status"] == "ok")
fin = database.finalize(copy.deepcopy(prim))
eq("Satsuma: $0.91 and $5.68 on the same day is a misreading, and is flagged", any("state different offers" in f for f in fin["flags"]), True)
eq("Satsuma: the flag puts the multiples and the premiums in doubt", fin["doubt"], ["multiples", "premiums"])

talk = by("Talkspace")
eq("Talkspace: deals in 2021 and 2026 are two deals", [r["status"] for r in talk], ["ok", "ok"])

agr = by("Avangrid")
eq("Avangrid: under two CIKs (the 13E-3 row carries Iberdrola's) the readings cannot be matched; the subject-identity fix is what joins them", sorted(r["status"] for r in agr), ["ok", "ok"])
fixed = copy.deepcopy({r["id"]: r for r in FIX})
for r in fixed.values():
    if "Avangrid" in r["target"]["name"]:
        r["target"]["cik"] = "0001634997"
database.dedupe(fixed)
a2 = sorted((r for r in fixed.values() if "Avangrid" in r["target"]["name"]), key=lambda r: r["filed"])
eq("Avangrid: with the subject's CIK on both, one deal; the 13E-3 is the duplicate", [(r["source"], r["status"]) for r in a2], [("SC 13E3", "duplicate"), ("DEFM14A", "ok")])

before = json.dumps(rows, sort_keys=True)
database.dedupe(rows)
eq("a second pass changes nothing", json.dumps(rows, sort_keys=True) == before, True)

again = copy.deepcopy(rows)
vp = next(r for r in again.values() if r["id"] == vista[1]["id"])
vp["premium1Day"] = 0.5
database.dedupe(again)
eq("a field the primary has read for itself is kept on the next pass", next(r for r in again.values() if r["id"] == vista[1]["id"])["premium1Day"], 0.5)

counts = {"deals": sum(1 for r in rows.values() if r["status"] != "duplicate"), "duplicates": sum(1 for r in rows.values() if r["status"] == "duplicate")}
eq("14 readings, 11 deals (Avangrid's two CIKs keep it two here)", counts, {"deals": 11, "duplicates": 3})

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
