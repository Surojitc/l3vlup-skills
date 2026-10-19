#!/usr/bin/env python3
"""
A take-private row is read for the company being taken private.

    python3 scripts/__tests__/precedent-subject.test.py

WHY THIS EXISTS
---------------
The deck index took a joint 13E-3's target CIK from whichever filer the
quarterly form index listed, which for Avangrid's going-private statement was
Iberdrola's (0001360587). The precedent row built from it read Iberdrola's
company facts, got a 404, and carried Avangrid's name over the wrong CIK with
no financials. lib/decks.mjs subjectOf (tested in decks.test.mjs) now takes
the subject company's CIK; this is the precedent side: a stored row whose
target the index has since corrected is read again, once, and no other is.
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))

from precedent_transactions import takeprivates  # noqa: E402

passed = failed = 0


def eq(name, got, want):
    global passed, failed
    ok = got == want
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + ("" if ok else f" — got {got!r}, want {want!r}"))
    if ok:
        passed += 1
    else:
        failed += 1


stored = {"id": "0001193125-24-165806", "target": {"name": "Avangrid, Inc.", "cik": "0001360587"}}
corrected = {"id": "0001193125-24-165806", "target": {"name": "Avangrid, Inc.", "cik": "0001634997"}}
eq("Avangrid: the row read under Iberdrola's CIK is read again under Avangrid's", takeprivates.target_moved(stored, corrected), True)
eq("a row whose target is unchanged is not read again", takeprivates.target_moved(corrected, corrected), False)
eq("CIKs compare as numbers, padded or not", takeprivates.target_moved({"target": {"cik": "1634997"}}, corrected), False)
eq("a deal not yet on file is new, not moved", takeprivates.target_moved(None, corrected), False)
eq("an index entry with no CIK never forces a read", takeprivates.target_moved(stored, {"target": {"cik": None}}), False)

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
