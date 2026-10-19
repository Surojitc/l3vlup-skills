#!/usr/bin/env python3
"""
One deal per transaction when one reading names no buyer, and no deal for a
tender offer that is not for the company's equity.

    python3 scripts/__tests__/precedent-identity.test.py

WHY THIS EXISTS
---------------
A fresh ingestion of every stored deal through the October 2026 collector
left eight transactions with two primary rows, because one reading's
"acquirer" was not a buyer at all and so read as a second bidder:

  Tiffany          "Holding", a word the agreement sentence's split left
  Rouse, MEMSIC    "Inc.", a suffix on its own
  Northern Tier    "Nti GP", the defined term for Northern Tier Energy GP LLC,
                   the target's own general partner
  TransMontaigne   "TransMontaigne GP L.L.C.", the target's general partner
  RealD            "ReadD Inc.", the target misspelt on the filer list
  Pageflex         "Merger SPV.", the merger vehicle
  Medley           Medley Capital and Sierra Income, both parties to the one
                   three-way merger agreement

and it counted Direct Digital's tender for its warrants ($1.20 a warrant, an
"84% premium") as a take-private. Neff (H&E Equipment Services, then United
Rentals) is a real contest and stays two deals, as is Veoneer (Magna at
$31.25, then Qualcomm at $37.00), which read as one only because
"Incorporated" was not known as a corporate suffix.

The rows are the stored readings as the collector wrote them; the covers are
the first page of each filing, as EDGAR serves it.
"""

from __future__ import annotations

import copy
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))

from precedent_transactions import database, filings, parse  # noqa: E402

FIX = json.loads((ROOT / "scripts" / "__tests__" / "fixtures" / "precedent-identity.json").read_text())

passed = failed = 0


def eq(name, got, want):
    global passed, failed
    ok = got == want
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + ("" if ok else f" — got {got!r}, want {want!r}"))
    if ok:
        passed += 1
    else:
        failed += 1


rows = {r["id"]: copy.deepcopy(r) for r in FIX["rows"]}
database.dedupe(rows)
for r in rows.values():
    database.finalize(r)


def deal(name: str) -> list[dict]:
    return sorted((r for r in rows.values() if name.lower() in r["target"]["name"].lower()), key=lambda r: (r["filed"], r["id"]))


def primaries(name: str) -> list[dict]:
    return [r for r in deal(name) if r["status"] == "ok"]


# ── 1. a reading that names no buyer is no second bidder ─────────────────────

for name, buyer in (("Tiffany", "LVMH Moët Hennessy-Louis Vuitton SE"), ("Rouse", "BSREP II Retail Pooling LLC"), ("MEMSIC", "MZ Investment Holdings Limited"), ("Northern Tier", "Western Refining, Inc."), ("TransMontaigne", "TLP Holdings"), ("RealD", "Rhombus Cinema Holdings, LLC"), ("PAGEFLEX", "Marlborough Software Development Holdings, Inc.")):
    ps = primaries(name)
    eq(f"{name}: its readings are one deal, with one primary", len(ps), 1)
    eq(f"{name}: every reading carries the one deal identity", len({r["dealId"] for r in deal(name)}), 1)
    eq(f"{name}: the deal's buyer is the one a reading names, {buyer}", ps[0]["acquirer"] if ps else None, buyer)

eq("Tiffany: the revised $131.50 is the headline and the original $135.00 stays in the history", [o["offerPrice"] for o in primaries("Tiffany")[0]["offerHistory"]], [135.0, 131.5])
eq("Tiffany: 'Holding' is a fragment of the sentence and is never shown as the buyer", any(r.get("acquirer") == "Holding" for r in deal("Tiffany")), False)
eq("MEMSIC and Rouse: 'Inc.' on its own is never shown as the buyer", [r.get("acquirer") for r in deal("MEMSIC") + deal("Rouse") if r.get("acquirer") == "Inc."], [])
eq("TransMontaigne: its general partner is the target's own, and the buyer is taken from the 13E-3 that names TLP Holdings", primaries("TransMontaigne")[0].get("filledFrom", {}).get("acquirer") is not None, True)
eq("Medley Management: Medley Capital and Sierra Income are both parties to the one merger agreement, so one deal", len(primaries("MEDLEY MANAGEMENT")), 1)

# buyer_named, case by case
t = {"name": "Northern Tier Energy LP"}
eq("'Nti GP' is the defined term for the target's own general partner", database.buyer_named({"acquirer": "Nti GP", "target": t, "acquirerBasis": "by and among NTI, Northern Tier Energy GP LLC (“NTI GP”), an indirect wholly-owned subsidiary of WNR"}), None)
eq("'ReadD Inc.' is RealD misspelt, the target, not a buyer", database.buyer_named({"acquirer": "ReadD Inc.", "target": {"name": "RealD Inc."}}), None)
eq("'Merger SPV.' is the merger vehicle", database.buyer_named({"acquirer": "Merger SPV.", "target": {"name": "PAGEFLEX INC."}}), None)
eq("a named firm is a buyer", database.buyer_named({"acquirer": "Western Refining, Inc.", "target": t}), "Western Refining, Inc.")
eq("so is a holding company that is not the target's ('TLP Holdings' for TransMontaigne Partners)", database.buyer_named({"acquirer": "TLP Holdings", "target": {"name": "TransMontaigne Partners LLC"}}), "TLP Holdings")

# a buyer named without a corporate suffix the list knows is still a buyer
eq("'QUALCOMM Incorporated' is a firm: 'Incorporated' is a corporate suffix", database.buyer_named({"acquirer": "QUALCOMM Incorporated", "target": {"name": "Arriver Holdco, Inc."}}), "QUALCOMM Incorporated")
eq("'Eli Lilly' names someone, so a primary holding it never borrows another reading's buyer", database.names_no_one({"acquirer": "Eli Lilly", "target": {"name": "Ventyx Biosciences, Inc."}}), False)
eq("a named investor vehicle ('Celadon Partners SPV 35 Limited') keeps its name", (deal("Senti")[0].get("acquirer"),), ("Celadon Partners SPV 35 Limited",))

# ── 2. a real contest stays two deals, with two identities ──────────────────

neff = primaries("Neff Corp")
eq("Neff: H&E Equipment Services and United Rentals are two deals", sorted(r["acquirer"] for r in neff), ["H&E Equipment Services, Inc.", "United Rentals, Inc."])
eq("Neff: each has its own identity although both readings carry the July agreement date", len({r["dealId"] for r in neff}), 2)
eq("Neff: the first deal keeps the plain identity, the later one carries its buyer", sorted(r["dealId"] for r in neff), ["0001617667:2017-07-14", "0001617667:2017-07-14:united-rentals"])

veo = primaries("Arriver")
eq("Veoneer: Magna's $31.25 and Qualcomm's $37.00 are two agreements with two buyers, so two deals", sorted((r["acquirer"], r["offerPrice"]) for r in veo), [("Magna International Inc.", 31.25), ("QUALCOMM Incorporated", 37.0)])
eq("Veoneer: each keeps its own buyer, never one borrowed from the other", [(r.get("filledFrom") or {}).get("acquirer") for r in veo], [None, None])
eq("Veoneer: two identities, though both readings carry the same July date", len({r["dealId"] for r in veo}), 2)

# idempotent: a second pass decides the same deals
again = copy.deepcopy(rows)
database.dedupe(again)
eq("deduping twice gives the same identities and statuses", {i: (r["status"], r.get("dealId")) for i, r in again.items()}, {i: (r["status"], r.get("dealId")) for i, r in rows.items()})

# ── 3. the class of securities a tender offer seeks ─────────────────────────

cov = {c["name"]: c for c in FIX["covers"]}
s = parse.securities_sought(cov["Direct Digital"]["text"])
eq("Direct Digital: the class is warrants, though they are exercisable for common stock", (s["kind"], s["title"][:24]), ("warrants", "Warrants exercisable for"))
eq("Direct Digital: so it is no control acquisition, and says why", parse.not_control_reason(s), "a tender offer for warrants (Warrants exercisable for Class A Common Stock at an exercise price of $5.50 per ), not a control acquisition")
s = parse.securities_sought(cov["Kimco"]["text"])
eq("Kimco: depositary shares of a 7.25% cumulative convertible preferred are a senior security", s["kind"], "preferred")
s = parse.securities_sought(cov["NET Servicos"]["text"])
eq("NET Serviços: 'Preferred Shares, no par value' with no dividend terms are the listed equity, so a take-private", s["kind"], "common")
s = parse.securities_sought(cov["TransMontaigne"]["text"])
eq("TransMontaigne: common units are the partnership's equity", s["kind"], "common")
eq("a cover with no class named gives nothing", parse.securities_sought("SCHEDULE 13E-3 RULE 13e-3 TRANSACTION STATEMENT"), None)
eq("notes are debt", parse.securities_sought("4.75% Senior Notes due 2027 (Title of Class of Securities)")["kind"], "debt")

# a stored row is read again from its cover, once, and rejected with the reason
dd = {"id": "0001104659-23-100844", "status": "ok", "source": "SC 13E3", "documentsRead": [cov["Direct Digital"]["url"]], "target": {"name": "Direct Digital Holdings, Inc."}}
real_fetch, real_text = filings.fetch, filings.to_text
filings.fetch = lambda url, **k: cov["Direct Digital"]["text"]
filings.to_text = lambda raw: raw
try:
    filings.reread_securities(dd)
finally:
    filings.fetch, filings.to_text = real_fetch, real_text
eq("Direct Digital's stored row is rejected with the reason, and the reading is versioned", (dd["status"], dd["error"].startswith("a tender offer for warrants"), dd["securitiesReader"]), ("rejected", True, filings.SECURITIES_READER))
eq("and is not read again", filings.needs_securities_reread(dd), False)
eq("a merger proxy is never read for a class: only a 13E-3 row is", filings.needs_securities_reread({"status": "ok", "source": "DEFM14A", "documentsRead": ["x"]}), False)

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
