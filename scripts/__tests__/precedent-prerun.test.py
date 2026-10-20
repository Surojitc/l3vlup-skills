#!/usr/bin/env python3
"""
What the controlled-run dry run of October 2026 found, fixed before the run.

    python3 scripts/__tests__/precedent-prerun.test.py

WHY THIS EXISTS
---------------
The merged readers were run over the published database, read-only, before
the first real run was allowed to publish. The guard held, but four readings
were wrong:

  the announcement date  the loose reading took the date of any agreement a
                         proxy says was entered into: TESCO's mediated
                         settlement agreement (and its EBITDA read at that
                         date, $93.5m becoming -$131.7m), ADTRAN's revolving
                         credit agreement, Gaia's line of credit. It now takes
                         only the deal's own agreement (a merger, arrangement
                         or combination agreement, or the purchase, sale,
                         contribution or share exchange agreement of an asset
                         sale or share purchase), and the guard lets a
                         date move only when announcedReader moves, putting
                         the financials back with it when it does not.
  the buyer as target    in a joint proxy both companies' holders vote and the
                         target's shares are described converting, so the
                         issuance-proposal test cannot tell the sides apart.
                         Transocean's proxy for Valaris became a second deal
                         for Valaris, and Victory Capital stood as acquired at
                         $116.26 and 11.0x while buying First Eagle. The
                         company that issues the shares is the buyer.
  a losing bid's premium Baldwin's 83% is the Sponsors' $31.75 Round 2 bid
                         over $17.33; the $32.50 agreed is 87.5%.
  the de-SPAC order      oldest first, a 20-minute run reached 0 to 2 of the
                         65 de-SPACs a full check finds. Most likely first.

The fixtures are the passages of each deal's real filing around every
agreement date, every acquisition and share-exchange sentence and the cover,
and every premium, as EDGAR serves them; the readings were checked to be the
same over the excerpt as over the whole document.
"""

from __future__ import annotations

import copy
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))

from precedent_transactions import database, filings, formindex, guard, parse  # noqa: E402

FIX = {d["key"]: d for d in json.loads((ROOT / "scripts" / "__tests__" / "fixtures" / "precedent-prerun.json").read_text())}
passed = failed = 0


def eq(name, got, want):
    global passed, failed
    ok = got == want
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + ("" if ok else f" — got {got!r}, want {want!r}"))
    if ok:
        passed += 1
    else:
        failed += 1


def texts(key: str) -> list[str]:
    return [d["text"] for d in FIX[key]["documents"]]


def dated(key: str, **row) -> dict:
    d = FIX[key]
    r = {"filed": d["filed"], "announced": d["filed"], "announcedBasis": "filing date", "offerPrice": d["offerPrice"], **row}
    return filings.resolve_announcement(r, texts(key))


# ── 1. the announcement date is the deal's own agreement's ────────────────────

# the rule the dry run read with, kept here to show what it took
OLD = r"[Oo]n\s+" + parse._DATE + r",\s+[^.;]{0,120}?entered\s+into\s+(?:an?|the)\s+[^.;]{0,40}?[Aa]greement"


def old_reading(key: str) -> str | None:
    from collections import Counter
    found = Counter()
    for t in texts(key):
        for pat in parse._AGREEMENT_LOOSE[:2] + [OLD]:
            for m in re.finditer(pat, t):
                iso = parse.iso_date(m.group(1), m.group(2), m.group(3))
                if iso and "2014-01-01" <= iso <= FIX[key]["filed"]:
                    found[iso] += 1
    return found.most_common(1)[0][0] if found else None


eq("TESCO: the old reading took the mediated settlement agreement of 12 December 2016", old_reading("TESCO"), "2016-12-12")
t = dated("TESCO")
eq("TESCO: dated by the Arrangement Agreement of 13 August 2017", (t["announced"], t["announcedBasis"]), ("2017-08-13", "merger agreement"))
eq("ADTRAN: the old reading took the revolving credit agreement of 4 November 2020", old_reading("ADTRAN"), "2020-11-04")
a = dated("ADTRAN")
eq("ADTRAN: dated by the business combination agreement of 30 August 2021", (a["announced"], a["announcedBasis"]), ("2021-08-30", "merger agreement"))
eq("Gaia: the old reading took a subsidiary's line of credit of 23 July 2015", old_reading("GAIA"), "2015-07-23")
g = dated("GAIA")
eq("Gaia: dated by the deal it put to its holders, the Membership Interest Purchase Agreement of 10 May 2016", (g["announced"], g["announcedBasis"]), ("2016-05-10", "merger agreement"))
w = dated("ADSW")
eq("Advanced Disposal: a revised deal is still dated by its amendment of 24 June 2020, the April 2019 agreement kept", (w["announced"], w["announcedBasis"], w["announcedOriginal"]), ("2020-06-24", "amended merger agreement", "2019-04-14"))
eq("every row the date rule resolves carries the rule's version", (t["announcedReader"], w["announcedReader"]), (filings.ANNOUNCED_READER, filings.ANNOUNCED_READER))
eq("a re-dated row has its financials read again; one whose date stands does not", ("financialsReader" in dated("TESCO", financialsReader=3), "financialsReader" in dated("TESCO", announced="2017-08-13", announcedBasis="merger agreement", financialsReader=3)), (False, True))
eq("a row dated under an earlier rule is due a re-read with its premiums", filings.needs_premium_reread({"premiumReader": filings.PREMIUM_READER, "announcedReader": 1, "documentsRead": ["x"], "status": "ok"}), True)
eq("and one dated under this rule, with current premiums, is not", filings.needs_premium_reread({"premiumReader": filings.PREMIUM_READER, "announcedReader": filings.ANNOUNCED_READER, "documentsRead": ["x"], "status": "ok"}), False)
for wording, want in [
    ("On March 10, 2014, the Company entered into a merger agreement with Parent", "2014-03-10"),
    ("On July 9, 2017, the parties entered into an Agreement and Plan of Merger", "2017-07-09"),
    ("On May 2, 2022, the Company entered into a definitive Merger Agreement with Parent", "2022-05-02"),
    ("On January 23, 2020, the Company entered into a share purchase agreement with the Buyer Consortium", "2020-01-23"),
    ("On November 26, 2017, Civeo entered into a Purchase Agreement with the Noralta shareholders", "2017-11-26"),
    ("On June 1, 2022, the Company entered into an amended and restated credit agreement with its lenders", None),
    ("On June 1, 2022, the Company entered into a Securities Purchase Agreement with certain investors", None),
    ("On June 1, 2022, the Company entered into a mutual confidentiality agreement with Party A", None),
    ("On June 1, 2022, the Company entered into a voting agreement with its largest holder", None),
    ("On June 1, 2022, the Company entered into a lease agreement for its headquarters", None),
    ("On June 1, 2022, the Company entered into an employment agreement with its chief executive", None),
]:
    eq(f"the loose date: {wording[:60]}…", parse.parse_agreement_date_loose(wording + ".", "2010-01-01", "2026-12-31"), want)

# ── 2. the guard: a date may move only for a reason, and the financials move with it ──

FIN = {"sharesOut": 40.0, "ltmRevenue": 150.0, "ltmEbitda": 93.5, "ltmEbit": 30.0, "netDebt": -10.0, "ltmPeriodEnd": "2016-09-30", "ltmEbitdaEnd": "2016-09-30", "financialsReader": 3, "formsUsed": ["10-K"]}
prev = {"id": "T", "status": "ok", "dealType": "public merger", "target": {"cik": "1022705"}, "filed": "2017-10-26", "announced": "2017-10-26", "announcedBasis": "filing date", "offerPrice": 4.62, **FIN}
moved = {**copy.deepcopy(prev), "announced": "2016-12-12", "announcedBasis": "merger agreement", "ltmEbitda": -131.7, "ltmPeriodEnd": "2016-09-30", "ltmRevenue": 160.0, "financialsReader": 3}
rows = {"T": copy.deepcopy(moved)}
rep = guard.protect({"T": prev}, rows)
r = rows["T"]
eq("a date moved with no reader change is put back, with its basis", (r["announced"], r["announcedBasis"]), ("2017-10-26", "filing date"))
eq("and the financials read at the wrong date go back with it", (r["ltmEbitda"], r["ltmRevenue"], r["financialsReader"]), (93.5, 150.0, 3))
eq("the report says so", [k["field"] for k in rep["keptPrior"]], ["announced"])
eq("nothing is recorded as a revision, because nothing changed", r.get("revisions"), None)

ok = {**copy.deepcopy(moved), "announced": "2017-08-13", "announcedReader": filings.ANNOUNCED_READER}
rows = {"T": ok}
guard.protect({"T": prev}, rows)
r = rows["T"]
revs = {x["field"]: x for x in r["revisions"]}
eq("a date moved under a new date rule stands", (r["announced"], r["ltmEbitda"]), ("2017-08-13", -131.7))
eq("and is recorded with its cause", (revs["announced"]["from"], revs["announced"]["to"], revs["announced"]["cause"]), ("2017-10-26", "2017-08-13", f"announcedReader 1 to {filings.ANNOUNCED_READER}"))
eq("the financials that moved with it name the re-dating as their cause", revs["ltmEbitda"]["cause"].startswith("re-dated 2017-10-26 to 2017-08-13"), True)
eq("a target re-identified may move its date too", guard._cause(prev, {**moved, "target": {"cik": "9"}}, guard.DATE_READER), "target re-identified")
eq("the guard puts back every field the financials reader writes", set(filings.FINANCIAL_FIELDS) <= set(guard.AT_DATE), True)

# ── 3. a joint proxy: the company issuing the shares is the buyer ─────────────

rig, vctr, val = (FIX[k] for k in ("RIG", "VCTR", "VAL"))
eq("Transocean: the cover names the registrant", parse.cover_registrant(texts("RIG")[0]), "Transocean Ltd.")
eq("Transocean: the acquirer-side test alone cannot tell (Valaris's shares are described converting)", parse.acquirer_side(texts("RIG")[0]), False)
found = parse.filer_is_buyer(texts("RIG")[0], rig["name"])
eq("Transocean: 'Transocean will acquire all of the issued and outstanding common shares of Valaris'", bool(found) and any("Transocean will acquire" in e for e in found["evidence"]), True)
eq("Valaris: the same joint proxy filed by Valaris is the target's", parse.filer_is_buyer(texts("VAL")[0], val["name"]), None)
found = parse.filer_is_buyer(texts("VCTR")[0], vctr["name"])
eq("Victory Capital: 'Victory will acquire First Eagle'", bool(found) and any("Victory will acquire First Eagle" in e for e in found["evidence"]), True)
row = {"source": "DEFM14A", "status": "ok", "offerPrice": 116.26, "offerBasis": "x"}
filings.set_aside_buyer(row, found)
eq("Victory Capital: set aside as the buyer's proxy, with no price of its own", (row["status"], row["offerPrice"]), ("no-consideration", None))
eq("the evidence stays on the row", row["acquirerSideBasis"][:1], ["Victory will acquire First Eagle"])
kept = {"source": "DEFM14A", "status": "rejected", "error": "de-SPAC"}
eq("a row already rejected stands as it was", filings.set_aside_buyer(dict(kept), found), kept)
eq("a take-private statement is never judged this way", filings.set_aside_buyer({"source": "SC 13E3", "status": "ok"}, found)["status"], "ok")
eq("EDGAR's name today is not the proxy's: Memorial's filing under 'Range Resources - Louisiana' still reads as the target's",
   parse.filer_is_buyer("Memorial Resource Development Corp. \n (Name of Registrant as Specified in its Charter) \n JOINT PROXY STATEMENT/PROSPECTUS. This document is a prospectus of Range Resources Corporation. Range will acquire all of the outstanding shares of Memorial in the merger.", "Range Resources - Louisiana, Inc."), None)
eq("the first word alone names the company only as a whole name: Symmetry Surgical is not Symmetry Medical",
   parse.filer_is_buyer("Symmetry Medical Inc. \n (Name of Registrant as Specified in its Charter) \n The spin-off shares are described in the prospectus of Symmetry Surgical Inc., which is attached.", "Symmetry Medical Inc."), None)
eq("a parent buying out its partnership: 'Williams' is defined for The Williams Companies, so it is not Williams Partners",
   parse.filer_is_buyer("Williams Partners L.P. \n (Name of Registrant as Specified in its Charter) \n The Williams Companies, Inc. (“Williams”) and Williams Partners L.P. (“WPZ”) have agreed to a merger. This document is a prospectus of Williams. Pursuant to the merger agreement, Williams will acquire all of the outstanding common units of WPZ.", "WILLIAMS PARTNERS L.P."), None)
eq("and the partnership's own initials are its own: 'Cheniere will acquire CQH' is CQH's proxy as the target",
   parse.filer_is_buyer("Cheniere Energy Partners LP Holdings, LLC \n (Name of Registrant as Specified in its Charter) \n Cheniere Energy Partners LP Holdings, LLC (“CQH”) ... Q: What is the proposed transaction? A: Cheniere and CQH have agreed that Cheniere will acquire CQH by merging CQH with and into Merger Sub.", "Cheniere Energy Partners LP Holdings, LLC"), None)
eq("a target's proxy that says the buyer will acquire it is the target's",
   parse.filer_is_buyer("Acme Corp. \n (Name of Registrant as Specified in its Charter) \n Acme Corp. (the “Company”) ... pursuant to which the merger agreement provides that Parent will acquire the Company.", "Acme Corp."), None)
eq("an acquisition in the filer's history is not this deal: no agreement words near it, deep in the document",
   parse.filer_is_buyer("Acme Corp. \n (Name of Registrant as Specified in its Charter) \n" + "x " * 30_000 + "In 2015 Acme will acquire Widgets.", "Acme Corp."), None)

# ── 4. a premium is the deal's only at the deal's price ───────────────────────

d = FIX["BWIN"]
statements, aside = [], []
for doc in d["documents"]:
    k, a = parse.premium_statements(doc["text"], d["offerPrice"], "2026-09-14", cash_only=True)
    statements += k
    aside += a
eq("Baldwin: the 83% over $17.33 is set aside: it measures $31.71, the Sponsors' $31.75 bid", any("83" in s["excerpt"] and s["reason"].startswith("measures $31.71") for s in aside), True)
eq("Baldwin: and is not among the statements kept", any(s["premium"] == 0.83 for s in statements), False)
c = parse.choose_premiums(statements, d["offerPrice"], True, texts("BWIN"))
eq("Baldwin: the premium is the $32.50 merger price's 87.5% over $17.33", (c["premium1Day"], c["unaffectedPriceStated"]), (0.875, 17.33))
eq("$32.50 / $17.33 - 1 = 87.5%", round(32.5 / 17.33 - 1, 3), 0.875)
k, a = parse.premium_statements("The Merger Consideration represents a premium of approximately 83% to the closing price of $17.33 on June 17, 2026.", 32.5, "2026-09-14")
eq("a statement that names the agreed consideration stands even off the arithmetic: it is explicitly the deal's", [s["premium"] for s in k], [0.83])
k, a = parse.premium_statements("That price represented a premium of approximately 29% to the unaffected closing price of $10.00 on June 17, 2026.", 12.95, "2026-09-14")
eq("a rounded premium within two points of offer / price - 1 is the deal's (29% against 29.5%)", [s["premium"] for s in k], [0.29])
k, a = parse.premium_statements("That price represented a premium of approximately 29% to the unaffected closing price of $10.00 on June 17, 2026.", 12.95, "2026-09-14", cash_only=False)
eq("a cash-and-stock deal's per-share cash is not the whole price, so nothing is set aside on it", len(a), 0)

# ── 5. the de-SPAC check: most likely first ───────────────────────────────────

rows = {
    "old-10": {"filed": "2011-03-01", "offerPrice": 10.0},
    "boom": {"filed": "2021-06-01", "offerPrice": 23.4},
    "new": {"filed": "2026-02-01", "offerPrice": 41.0},
    "old": {"filed": "2010-01-01", "offerPrice": 8.0},
    "warrant": {"filed": "2019-05-01", "offerPrice": 11.5},
    "shell": {"filed": "2014-05-01", "offerPrice": 7.0, "acquirer": "Landcadia Acquisition Corp."},
    "boom2": {"filed": "2018-02-01", "offerPrice": 15.0},
}
eq("a shell's price or name first, then the 2018-2023 boom, then the rest, newest first within each",
   formindex.spac_check_order(rows), ["warrant", "shell", "old-10", "boom", "boom2", "new", "old"])

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
