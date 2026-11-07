"""
Regression: a non-positive enterprise value and a negative LTM revenue are
flagged on the row and put its multiples in doubt (database.finalize).

    python3 scripts/__tests__/precedent-nonpositive.test.py

Found on the published file of 11 October 2026: 139 ok rows with EV <= 0,
24 of them with a negative EV / revenue and no flag or doubt (iClick -0.29x,
Singular Genomics -19.74x, LAVA Therapeutics -2.14x), and five ok rows with a
negative LTM revenue, three of them clean (Capstone Holding -2.0, Fantex -1.5,
Entertainment Gaming Asia -2.8). Every figure below is worked by hand.
"""

from __future__ import annotations

import copy
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))

from precedent_transactions import database  # noqa: E402

passed = failed = 0


def check(name, ok, detail=""):
    global passed, failed
    if ok:
        passed += 1
        print(f"PASS  {name}")
    else:
        failed += 1
        print(f"FAIL  {name}  {detail}")


def base(**kw) -> dict:
    row = {
        "id": "0000000000-26-000001",
        "source": "DEFM14A",
        "dealType": "public merger",
        "target": {"name": "Example Therapeutics, Inc.", "cik": "0000000001"},
        "buyers": [],
        "filed": "2026-09-01",
        "announced": "2026-08-20",
        "status": "ok",
        "offerPrice": 2.00,
        "consideration": "cash",
        "acquirer": None,
        "sharesOut": 50.0,
        "netDebt": -40.0,
        "ltmRevenue": 20.0,
        "ltmEbitda": 5.0,
    }
    row.update(kw)
    return row


def has(row, text):
    return any(text in f for f in row.get("flags") or [])


# 1. A positive EV: unchanged, no new flag. 2.00 x 50 = 100; EV 100 - 40 = 60;
#    EV / revenue 60 / 20 = 3.0x; EV / EBITDA 60 / 5 = 12.0x.
r = database.finalize(base())
check("a positive EV is valued as before", (r["equityValue"], r["ev"], r["evLtmRev"], r["evLtmEbitda"]) == (100.0, 60.0, 3.0, 12.0), r)
check("and carries no flag and no doubt", r["flags"] == [] and r["doubt"] == [], r["flags"])

# 2. Net cash above the price: 2.00 x 50 = 100; EV 100 - 125 = -25;
#    EV / revenue -25 / 20 = -1.25x, which no earlier bound caught.
r = database.finalize(base(netDebt=-125.0))
check("a negative EV is still computed as the filing gives it", r["ev"] == -25.0 and r["evLtmRev"] == -1.25, r)
check("a negative EV is flagged", has(r, "enterprise value of -25.0 is not positive"), r["flags"])
check("and puts the multiples in doubt", "multiples" in r["doubt"], r["doubt"])
check("but not the premiums", "premiums" not in r["doubt"], r["doubt"])

# 3. The boundary: EV exactly nil. 100 - 100 = 0.
r = database.finalize(base(netDebt=-100.0))
check("an EV of exactly nil is flagged too", r["ev"] == 0.0 and has(r, "is not positive"), r["flags"])

# 4. Negative LTM revenue: no revenue multiple (as before), now said why.
r = database.finalize(base(ltmRevenue=-2.0))
check("a negative revenue gives no revenue multiple", "evLtmRev" not in r, r)
check("a negative revenue is flagged", has(r, "LTM revenue of -2.0 is negative"), r["flags"])
check("and puts the multiples in doubt", "multiples" in r["doubt"], r["doubt"])
check("the EBITDA multiple is still computed (60 / 5)", r["evLtmEbitda"] == 12.0, r)

# 5. Nil revenue is not negative: no flag, no multiple.
r = database.finalize(base(ltmRevenue=0.0))
check("nil revenue is not flagged as negative", not has(r, "is negative"), r["flags"])

# 6. Rows that are not ok, or have no offer, are untouched by either rule.
r = database.finalize(base(status="no-offer", netDebt=-500.0, ltmRevenue=-3.0))
check("a row that is not ok carries no flag", r["flags"] == [] and r["doubt"] == [], r["flags"])

# 7. finalize stays idempotent with the new flags: a second pass adds nothing.
once = database.finalize(base(netDebt=-125.0, ltmRevenue=-2.0))
twice = database.finalize(copy.deepcopy(once))
check("a second finalize gives the same flags", once["flags"] == twice["flags"] and once["doubt"] == twice["doubt"], (once["flags"], twice["flags"]))

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
