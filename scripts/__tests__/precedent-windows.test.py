#!/usr/bin/env python3
"""
One window rule per premium statement, a revised deal's own premium, and the
reference price a small premium sits beside.

    python3 scripts/__tests__/precedent-windows.test.py

WHY THIS EXISTS
---------------
A fresh ingestion of every stored deal through the October 2026 premium
reader found three ways it still misread a filing:

  R1 RCM       39% to the 30-day VWAP ending 23 February 2024 thrown out as
  Green Plains "not near the agreement", while the 29% to the close of that
  Nalco        same day was kept: the VWAP's sentence lacks the word
               "unaffected", the close's has it. Nalco's 20% over its 52-week
               high was thrown out because the high was reached on
               20 December 2010, seven months before the agreement.
  iRobot       the $51.75 revised offer carried the 22% stated for the
               original $61.00 offer (borrowed from the other reading), and
               was dated by the August 2022 agreement, not its July 2023
               amendment.
  Press Ganey  the unaffected price read as $40.97, the 52-week high stated
               for the same day, because the $40.33 close sits within half a
               percent of the $40.50 offer and was taken for the offer.

The fixtures are the passages around every "premium" in each deal's real
filing (and, for iRobot and Press Ganey, around the amendment and the
unaffected date), as EDGAR serves them.
"""

from __future__ import annotations

import copy
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))

from precedent_transactions import database, filings, parse  # noqa: E402

FIX = {d["ticker"]: d for d in json.loads((ROOT / "scripts" / "__tests__" / "fixtures" / "precedent-windows.json").read_text())}

passed = failed = 0


def eq(name, got, want):
    global passed, failed
    ok = got == want
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + ("" if ok else f" — got {got!r}, want {want!r}"))
    if ok:
        passed += 1
    else:
        failed += 1


def read(deal: dict, *, redate: bool = False) -> dict:
    """A deal's premiums read the way filings.reread_premiums reads them, then finalized."""
    row = {
        "id": deal["id"], "status": "ok", "source": "DEFM14A", "dealType": "public merger", "target": {"name": deal["name"], "cik": "1"},
        "offerPrice": deal["offerPrice"], "announced": deal["announced"], "announcedBasis": "merger agreement", "filed": deal["filed"],
        "consideration": deal["consideration"], "acquirerBasis": "x", "acquirer": None,
    }
    texts = [d["text"] for d in deal["documents"]]
    if redate:
        filings.resolve_announcement(row, texts)
    statements, aside = [], []
    for d in deal["documents"]:
        kept, set_aside = parse.premium_statements(d["text"], row["offerPrice"], row["announced"], cash_only=row["consideration"] == "cash", original=row.get("announcedOriginal"))
        statements += [{**s, "document": d["url"]} for s in kept]
        aside += [{**s, "document": d["url"]} for s in set_aside]
    filings.apply_premiums(row, statements, aside, texts)
    return database.finalize(row)


# ── 1. one window rule, applied to the date each statement is measured to ────

r = read(FIX["RCM"])
eq("R1 RCM: the 29% to the 23 February close stands", (r["premium1Day"], r["unaffectedDate"]), (0.29, "2024-02-23"))
eq("R1 RCM: the 39% to the 30-day VWAP ending that same day shares its reference and is kept", r["premium30DayVwap"], 0.39)
eq("R1 RCM: it is marked as measured to the unaffected statement's day", any(s.get("sharesReference") and s["premium"] == 0.39 for s in r["premiumStatements"]), True)
eq("R1 RCM: and it no longer appears among the statements set aside", any("39%" in s["excerpt"] and "not near" in s["reason"] for s in r["premiumsSetAside"]), False)
eq("R1 RCM: the window is still 159 days, so the long-window flag still stands", (r["unaffectedGapDays"], any(f.startswith("long-unaffected-window") for f in r["flags"])), (159, True))

g = read(FIX["GPP"])
eq("Green Plains Partners: 19.9% to the 3 May 2023 close", (g["premium1Day"], g["unaffectedDate"]), (0.199, "2023-05-03"))
eq("Green Plains Partners: 20.5% to the trailing 30-day VWAP as of 3 May 2023, the same reference, kept", g["premium30DayVwap"], 0.205)

n = read(FIX["NLC"])
eq("Nalco: 34.4% to the close", n["premium1Day"], 0.344)
eq("Nalco: 20% over the 52-week high reached on 20 December 2010: the high's own date is inside the year ending on the reference", n["premium52WeekHigh"], 0.2)
eq("Nalco: the 52-week high's date is never taken as the unaffected date", n["unaffectedDate"], "2011-07-19")

# a statement admitted by its shared day fills an empty basis, never displaces
# one inside the window (Distribution Solutions: 14.2% to the 30-day VWAP; a
# sentence of closes and VWAPs to March 13 misfiled as an 81% VWAP)
base = {"proposal": False, "namesOffer": False, "defined": False, "price": None, "excerpt": "x", "basis": "vwap", "window": "30-day"}
c = parse.choose_premiums([{**base, "premium": 0.142, "unaffected": False, "date": None}, {**base, "premium": 0.81, "unaffected": True, "date": "2026-03-13", "sharesReference": True}], 35.0, True)
eq("Distribution Solutions: the in-window 14.2% stands over a statement admitted by its shared day", c["premium30DayVwap"], 0.142)

# a statement that shares no reference and lies outside the window still goes
kept, aside = parse.premium_statements(
    "The merger consideration represents a premium of approximately 40% to the closing price of the common stock on January 3, 2020.",
    10.0, "2021-06-01",
)
eq("a close statement 18 months before the agreement, with no unaffected wording and nothing sharing its day, is set aside", (kept, [a["reason"] for a in aside]), ([], ["measured to 2020-01-03, not near the agreement of 2021-06-01"]))
kept, _ = parse.premium_statements(
    "The merger consideration represents a premium of approximately 30% over the 52-week high closing price of $8.00 reached on July 1, 2019.",
    10.4, "2021-06-01",
)
eq("a 52-week high reached two years before the agreement is outside even the high's year", kept, [])

eq("Rock of Ages: 84% to the average close over twelve months is no premium to a high", parse._basis("an 84% premium to the average closing price of our Class A common stock for the twelve months prior to the May 7, 2010 public announcement")[0], "other")
eq("while 44% to the highest close over those twelve months is", parse._basis("a 44% premium to the highest closing price for the twelve months prior to such announcement")[0], "high")
eq("Cornerstone: a premium to the high end of a proposal's range is no premium to a high", parse._basis("a premium of approximately 42% over the high end of the Initial Proposal range")[0], "other")
eq("a 52-week high is a high", parse._basis("a premium of 6.7% to the 52-week high price on July 2, 2014 of $75.64 per share")[0], "high")

# ── 2. a revised deal: its own premium, dated by its amendment ──────────────

i = read(FIX["IRBT"], redate=True)
eq("iRobot: the $51.75 revised offer is dated by the 24 July 2023 amendment, the August 2022 agreement kept as the original", (i["announced"], i["announcedBasis"], i["announcedOriginal"]), ("2023-07-24", "amended merger agreement", "2022-08-04"))
eq("iRobot: its own statement is 25% to the 30-day VWAP as of the original agreement, which the original date admits", i["premium30DayVwap"], 0.25)
eq("iRobot: no one-day premium is stated for $51.75, and none is claimed", i["premium1Day"], None)
eq("iRobot: so no unaffected price is worked back from a percentage", (i.get("unaffectedPrice"), i.get("unaffectedPriceMethod")), (None, None))
eq("iRobot: $51.75 / 1.25 = $41.40, the VWAP the 25% implies, kept as vwap30 for this all-cash deal", i.get("vwap30"), 41.4)

orig = read(FIX["IRBT61"])
eq("iRobot's original $61.00 reading: 22% to its own unaffected close", orig["premium1Day"], 0.22)

rows = {i["id"]: copy.deepcopy(i), orig["id"]: copy.deepcopy(orig)}
for x in rows.values():
    x["target"]["cik"] = "1159167"
    x["filed"] = "2023-08-24" if x["id"] == i["id"] else "2022-09-07"
database.dedupe(rows)
p = rows[i["id"]]
eq("iRobot: the two readings are one deal, linked by the original agreement the amendment records", (p["status"], rows[orig["id"]]["status"], rows[orig["id"]]["duplicateOf"]), ("ok", "duplicate", i["id"]))
eq("iRobot: the deal is identified by its first agreement", p["dealId"], "0001159167:2022-08-04")
eq("iRobot: the primary keeps its own premium and never borrows the $61.00 offer's 22%", (p["premium1Day"], (p.get("filledFrom") or {}).get("premium1Day")), (None, None))
eq("iRobot: both offers stay in the history, $61.00 then $51.75", [o["offerPrice"] for o in p["offerHistory"]], [61.0, 51.75])

# a price is revised only by an amendment of an agreed price, never by the
# negotiation before it (the sentences are the filings' own)
revised = [
    ("Tiffany", "The Company, Parent, Holding and Merger Sub agreed to reduce the per share merger consideration from $135.00 as set forth in the original merger agreement to $131.50 as set forth in the merger agreement amendment", 131.5, True),
    ("Landry's", "Moelis was not requested to, and did not, deliver an opinion in connection with the execution of the second amendment to the merger agreement on June 20, 2010 which provided for an increase of the merger consideration from $24.00 to $24.50 per share in cash.", 24.5, True),
    ("Paramount Group", "Later that day, representatives of Parent contacted representatives of BofA Securities to increase the proposed price from $6.50 per share to $6.60 per share, in cash.", 6.6, False),
    ("J.Crew", "the special committee's extensive negotiations with TPG and Leonard Green, which, among other things, resulted in an increase in the offer price from $41.00 to $43.50 per share", 43.5, False),
    ("HCC", "On May 8, 2015, a representative of Credit Suisse contacted a representative of Goldman Sachs by telephone and indicated that Tokio Marine had agreed to increase the merger consideration from $77.50 per share to $78.00 per share.", 78.0, False),
    ("RTB Digital", "The parties agreed to sign the Amendment and (ii) increase the Stated Value (as defined in the Purchase Agreement) per share of Series C Preferred Stock in the Certificate of Designation from $100.00 to $130.00", 130.0, False),
]
for who, text, offer, want in revised:
    eq(f"{who}: {'an amendment revised the agreed price' if want else 'a change stated outside any amendment revises no agreed price'}", parse.price_revised([text], offer), want)

# a primary with no premium statement of its own may still borrow from a
# reading of the same offer, but never from a different offer
a = {"id": "a", "status": "ok", "target": {"cik": "5"}, "announced": "2024-01-10", "announcedBasis": "merger agreement", "filed": "2024-02-01", "offerPrice": 20.0, "premium1Day": None, "premiumStatements": []}
b = {"id": "b", "status": "ok", "target": {"cik": "5"}, "announced": "2024-01-10", "announcedBasis": "merger agreement", "filed": "2024-01-20", "offerPrice": 20.0, "premium1Day": 0.3, "premiumStatements": [{"premium": 0.3}]}
rows = database.dedupe({"a": a, "b": b})
eq("a primary with no premium statement borrows the premium a reading of the same $20.00 offer states", (rows["a"]["premium1Day"], rows["a"]["filledFrom"]["premium1Day"]), (0.3, "b"))
c = {**copy.deepcopy(b), "id": "c", "offerPrice": 24.0}
a2 = {**copy.deepcopy(a), "premium1Day": None}
a2.pop("filledFrom", None)
rows = database.dedupe({"a": a2, "c": c})
eq("but not the premium of a different offer ($24.00 against $20.00)", rows["a"].get("premium1Day"), None)

# ── 3. a small premium's reference price sits within half a percent of the offer ──

pg = read(FIX["PGND"])
eq("Press Ganey: 0.4% to the 8 August 2016 close", (pg["premium1Day"], pg["unaffectedDate"]), (0.004, "2016-08-08"))
eq("Press Ganey: the unaffected price is the $40.33 close stated with the premium, not the $40.97 52-week high", (pg["unaffectedPrice"], pg["unaffectedPriceMethod"]), (40.33, "stated"))
eq("Press Ganey: $40.50 / $40.33 - 1 = 0.42%, which the stated 0.4% reproduces", round(40.5 / 40.33 - 1, 4), 0.0042)
eq("a price within half a percent of the offer that does not reproduce the premium is the offer restated, not the reference", parse._price_in("a premium of 25% to the closing price; the $40.50 per share", 40.5, 0.25), None)
eq("and a price equal to the offer to the cent is never the reference", parse._price_in("a premium of 0.0% to the price of $40.50 per share", 40.5, 0.0), None)
eq("a 52-week high stated for the unaffected date is never read as that day's close", parse._stated_price_on("the highest closing price per share over the 52-week period ended August 8, 2016 of $40.97 per share", "2016-08-08", 40.5), (None, None))
eq("nor is an adviser's illustrative range based on that day's close (Aircastle)", parse._stated_price_on("This analysis indicated an illustrative range of prices per Company common share of $28.60 to $31.00, based on the closing share prices of Aircastle's common shares on October 23, 2019, and $23.70 to $25.60 based on", "2019-10-23", 32.0), (None, None))
eq("while a close stated for that date is", parse._stated_price_on("the closing price of our common stock on August 8, 2016 of $40.33 per share", "2016-08-08", 40.5)[0], 40.33)

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
