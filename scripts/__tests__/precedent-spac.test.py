#!/usr/bin/env python3
"""
Which merger proxies are de-SPACs, decided by what the proxy describes.

    python3 scripts/__tests__/precedent-spac.test.py

WHY THIS EXISTS
---------------
The collector rejected a proxy as a de-SPAC whenever the merger agreement's
counterparty was called "... Acquisition Corp.". A strategic buyer's merger
subsidiary is called that as often as a blank-check shell is, so Synopsys's
purchase of Ansys (its vehicle: ALTA Acquisition Corp.) was thrown out, and with
it 53 more strategic and sponsor deals: Qorvo, Cubic, HMS, TD Ameritrade,
Atmel, Jarden, Pepco, Kraft Heinz and others. Seven of the 61 were real.

A de-SPAC proxy describes the shell's trust account, its holders' redemption
from it and the merger as the shell's "initial business combination", and
does so hundreds of times. Those words are the evidence now, and they cut
the other way too: 66 proxies the name test had accepted (Odysseus, D-Wave,
Hagerty, BigBear.ai, Hostess, Magnolia) are a shell's combination, 33 of them
stored with a trust unit's $10.00 as the offer price. The counts below were
measured on each proxy as EDGAR serves it.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))

from precedent_transactions import parse  # noqa: E402

FIX = json.loads((ROOT / "scripts" / "__tests__" / "fixtures" / "precedent-spac.json").read_text())
passed = failed = 0


def eq(name, got, want):
    global passed, failed
    ok = got == want
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + ("" if ok else f" — got {got!r}, want {want!r}"))
    if ok:
        passed += 1
    else:
        failed += 1


ansys = FIX["ansys"]["text"]
ev = parse.spac_evidence(ansys)
eq("Ansys: the proxy never mentions a trust account or an initial business combination", (ev["trustAccount"], ev["initialBusinessCombination"]), (0, 0))
eq("Ansys: so it is not a de-SPAC, whatever its counterparty is called", parse.is_despac(ev), False)
eq("Ansys: the buyer is Synopsys, the party the agreement lists before its merger vehicle", parse.parse_acquirer(ansys, "ANSYS INC")[0], "Synopsys")
eq("Ansys: ALTA Acquisition Corp. is defined as Merger Sub and is never the buyer", parse._defined_vehicle('Synopsys, ALTA Acquisition Corp. (“ Merger Sub ”) and Ansys', "ALTA Acquisition Corp."), True)

sp = parse.spac_evidence(FIX["despac"]["text"])
eq("SANUWAVE / SEP Acquisition Corp.: a 31,000-character passage of the proxy already names the trust account 49 times and the initial business combination 15", (sp["trustAccount"], sp["initialBusinessCombination"]), (49, 15))
whole = next(m for m in FIX["measured"] if m["name"] == "SANUWAVE Health, Inc.")
eq("SANUWAVE: the whole proxy, 217 and 107, is a de-SPAC on its own evidence", ((whole["trustAccount"], whole["initialBusinessCombination"]), parse.is_despac(whole)), ((217, 107), True))

measured = FIX["measured"]
real = sorted(m["name"] for m in measured if parse.is_despac(m))
eq("of the 61 proxies the name rule rejected, exactly these seven are de-SPACs", real, sorted(["Angel Studios, Inc.", "SANUWAVE Health, Inc.", "Net Element, Inc.", "Nexeo Solutions, Inc.", "Mobile Infrastructure Corp", "Electric Last Mile Solutions, Inc.", "Nukkleus Inc."]))
kept = {m["name"] for m in measured if not parse.is_despac(m)}
eq("and 54 strategic and sponsor deals come back", len(kept), 54)
for name in ("ANSYS INC", "Qorvo, Inc.", "CUBIC CORP /DE/", "TD AMERITRADE HOLDING CORP", "ATMEL CORP", "JARDEN CORP", "PEPCO HOLDINGS LLC", "Kraft Heinz Foods Co", "MOMENTIVE GLOBAL INC."):
    eq(f"{name} is not a de-SPAC", name in kept, True)
low = max(m["trustAccount"] for m in measured if not parse.is_despac(m))
high = min(m["trustAccount"] for m in measured if parse.is_despac(m))
eq(f"the evidence separates cleanly: at most {low} trust-account mentions in a strategic deal, at least {high} in a de-SPAC", (low < parse.SPAC_TRUST_MIN <= high), True)
eq("FaZe (one stray 'trust account', four 'SPAC's, no business combination) is GameSquare's acquisition, not a de-SPAC", "FaZe Holdings Inc." in kept, True)

# The other direction: proxies the name rule let through. Their counts were
# measured on every stored proxy that mentions a trust account five times or
# more, or a SPAC or an initial business combination five times or more.
accepted = {m["name"]: m for m in FIX["accepted"]}
despacs = sorted({m["name"] for m in FIX["accepted"] if parse.is_despac(m)})
eq("66 accepted proxies are de-SPACs on their own evidence", len([m for m in FIX["accepted"] if parse.is_despac(m)]), 66)
for name in ("Odysseus (Cayman) Ltd", "D-Wave Quantum Inc.", "Hagerty, Inc.", "BigBear.ai Holdings, Inc.", "Hostess Brands, Inc.", "Magnolia Oil & Gas Corp", "VERRA MOBILITY Corp", "Granite Ridge Resources, Inc."):
    eq(f"{name}: a shell's combination, stored as an acquisition until now", name in despacs, True)
eq("Odysseus: 415 trust-account mentions and 303 of the initial business combination, at $10.00 a unit", (accepted["Odysseus (Cayman) Ltd"]["trustAccount"], accepted["Odysseus (Cayman) Ltd"]["initialBusinessCombination"], accepted["Odysseus (Cayman) Ltd"]["offerPrice"]), (415, 303, 10.0))
eq("a $10.00 'offer' is a trust unit in half of them", sum(1 for m in FIX["accepted"] if parse.is_despac(m) and m["offerPrice"] == 10.0), 33)
for name, why in (
    ("Heliogen, Inc.", "itself once a SPAC, bought by Zeo Energy"),
    ("Lionsgate Studios Holding Corp.", "itself once a SPAC, recombined with Lionsgate"),
    ("Metromile, LLC", "bought by Lemonade"),
    ("HWH International Inc.", "a former SPAC's later merger"),
    ("Fidelity & Guaranty Life", "a listed insurer bought for $31.10 cash: the target's own proxy"),
    ("STUDENT LOAN CORP", "86 mentions of its loan trusts, none of a business combination"),
    ("WEBSTER FINANCIAL CORP", "a bank's trust department"),
):
    eq(f"{name} is not a de-SPAC ({why})", parse.is_despac(accepted[name]), False)
ordinary = [m for m in FIX["accepted"] if not parse.is_despac(m)]
eq("no ordinary proxy reaches the trust-account bar", max(m["trustAccount"] for m in ordinary) < parse.SPAC_TRUST_MIN, True)
eq("and the de-SPACs clear it with room: the fewest is 133", min(m["trustAccount"] for m in FIX["accepted"] if parse.is_despac(m)) >= parse.SPAC_TRUST_MIN + 30, True)

# The re-check of accepted proxies changes the de-SPAC call and nothing else.
from precedent_transactions import formindex  # noqa: E402

row = {"id": "x", "status": "ok", "source": "DEFM14A", "offerPrice": 10.0, "documentsRead": ["u"], "target": {"name": "Odysseus (Cayman) Ltd"}}
eq("an accepted proxy judged by the name rule is due a check", formindex.needs_spac_check(row), True)
formindex.judge_spac(row, {k: accepted["Odysseus (Cayman) Ltd"][k] for k in ("trustAccount", "initialBusinessCombination", "blankCheck", "specialPurpose")})
eq("and on its evidence is rejected, the counts kept, the offer as read", (row["status"], row["spacEvidence"]["trustAccount"], row["offerPrice"], row["spacRule"]), ("rejected", 415, 10.0, formindex.SPAC_RULE))
eq("once judged it is not checked again", formindex.needs_spac_check(row), False)
row = {"id": "y", "status": "ok", "source": "DEFM14A", "offerPrice": 31.1, "documentsRead": ["u"], "target": {"name": "Fidelity & Guaranty Life"}}
formindex.judge_spac(row, {k: accepted["Fidelity & Guaranty Life"][k] for k in ("trustAccount", "initialBusinessCombination", "blankCheck", "specialPurpose")})
eq("a deal the evidence clears keeps its status", (row["status"], row.get("error")), ("ok", None))
eq("a take-private 13E-3 is never re-checked here", formindex.needs_spac_check({"status": "ok", "source": "SC 13E3", "documentsRead": ["u"]}), False)

eq("a stray phrase is not evidence", parse.is_despac(parse.spac_evidence("The Company's former SPAC sponsor holds a trust account at a bank.")), False)
eq("a counterparty's name is not evidence", parse.is_despac(parse.spac_evidence("by and among Acme Inc., Hero Acquisition Corporation and Target Inc.")), False)

for s, buyer in (
    ("Agreement and Plan of Merger, dated as of June 1, 2020, by and among Acme Corporation, Bolt Merger Sub, Inc. and Target Inc. This", "Acme Corporation"),
    ("Agreement and Plan of Merger, dated as of June 1, 2020, by and among Johnson & Johnson, Charm Sub, Inc. and Ambrx Biopharma Inc. This", "Johnson & Johnson"),
    ("Agreement and Plan of Merger, dated as of June 1, 2020, by and among Parent, Merger Sub and the Company. This", None),
):
    eq(f"the acquirer of '{s[57:110]}…' is {buyer}", parse.parse_acquirer(s, "Target Inc")[0], buyer)

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
