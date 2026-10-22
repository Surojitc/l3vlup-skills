#!/usr/bin/env python3
"""
Which company a precedent row is about.

    python3 scripts/__tests__/precedent-target.test.py

WHY THIS EXISTS
---------------
Validating share counts found rows whose "target" was not the company
acquired: the buyer, a merger vehicle, or a company putting a split-off to its
own holders. The joint-proxy test (parse.filer_is_buyer) and the acquirer-side
vote test (parse.acquirer_side) each missed them for a reason of its own:

  the buyer       Endologix's proxy to issue shares for Nellix is an issuance
                  vote, but Nellix's shares are described "converted into the
                  right to receive", which acquirer_side takes to mean the
                  filer is bought; Real Goods Solar's information statement
                  (a written consent) has no issuance proposal at all; Crescent
                  Capital BDC's cover wraps its name onto two lines, so the
                  joint-proxy test knew it only as "BDC, Inc."; Liberty
                  Interactive's proxy for GCI is GCI's prospectus as well. Each
                  pays another company's holders in the filer's own stock (or
                  says the filer will acquire them), and never its own holders.
  a split-off     FNF redeeming its FNFV tracking stock for Cannae, Liberty
                  Interactive its Ventures stock for Liberty Expedia, Liberty
                  Media its Capital and Starz stock for Liberty Splitco: nothing
                  is acquired. FNF's row stood at $15.00, the price of a 2015
                  tender for FNFV; Liberty Interactive's at $10.15, the cash
                  Expedia paid HomeAway's holders, from Expedia's annexed notes.
  today's name    a company bought is renamed for the vehicle merged into it:
                  Meredith files under "Hawkeye Acquisition, Inc." now, Brigham
                  Minerals under "MNRL Sub Inc.", Liberty Interactive under "Old
                  QVC Group, Inc.". The row takes the name the registrant filed
                  under, from the form index, and keeps today's beside it.
  a stray 13E-3   Liberty TripAdvisor's last 13E-3 amendment was filed from
                  Tripadvisor's EDGAR folder, and stored as a deal for
                  Tripadvisor (the buyer) with Tripadvisor's revenue and share
                  count. The deck index now files it under Liberty TripAdvisor.

The rule is general: the target is the company whose holders are paid. A row
that cannot be shown to be that company is set aside with the sentences that
say so (targetBasis), never kept with the wrong company, and the guard records
every change under targetReader.

The fixtures are each proxy's passages, at their own offsets in the document,
that the target readers look at: the cover, the registrant's own definitions,
every payment, acquisition, issuance and split-off sentence in the front of the
proxy, the conversion phrases read anywhere, and the passage an earlier reader
took its price from. Each reads as its whole document did (checked when the
fixture was cut); the test checks it again against the readings recorded then.
"""

from __future__ import annotations

import copy
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))

from precedent_transactions import database, filings, guard, parse, takeprivates  # noqa: E402

FIX = {d["key"]: d for d in json.loads((ROOT / "scripts" / "__tests__" / "fixtures" / "precedent-target.json").read_text())}
passed = failed = 0


def eq(name, got, want):
    global passed, failed
    ok = got == want
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + ("" if ok else f" — got {got!r}, want {want!r}"))
    if ok:
        passed += 1
    else:
        failed += 1


def text(key: str) -> str:
    """The excerpt as the readers see it: each passage at its own offset, the gaps blank and closed with ';'."""
    out, at = [], 0
    for off, t in FIX[key]["documents"][0]["pieces"]:
        gap = off - at
        if gap > 0:
            out.append(";" + "\n" * (gap - 2) + ";" if gap >= 2 else "\n" * gap)
        out.append(t)
        at = off + len(t)
    return "".join(out)


def name(key: str) -> str:
    return FIX[key]["name"]


def paid(key: str):
    found = parse.paid_elsewhere(text(key), name(key))
    return found and found["paid"]


def row(key: str, **extra) -> dict:
    d = FIX[key]
    return {"id": d["id"], "source": d["source"], "dealType": "public merger", "status": d["status"], "offerPrice": d["offerPrice"], "offerBasis": d["offerBasis"],
            "target": {"name": d["currentName"], "cik": d["cik"]}, "documentsRead": [d["documents"][0]["url"]], **extra}


# ── 0. the excerpts read as their documents did ───────────────────────────────

for key, d in FIX.items():
    if "reading" not in d:
        continue
    t, n = text(key), d["name"]
    hp = parse.holders_paid(t, n)
    pe = parse.paid_elsewhere(t, n)
    got = {"cover": parse.cover_registrant(t), "names": sorted(parse._registrant_names(t, n)), "registrantPaid": bool(hp["registrant"]), "others": sorted({c for c, _ in hp["other"]}),
           "payer": bool(hp["payer"]), "paidElsewhere": pe and pe["paid"], "splitOff": bool(parse.split_off(t, n)), "filerIsBuyer": bool(parse.filer_is_buyer(t, n)), "acquirerSide": parse.acquirer_side(t)}
    eq(f"{key}: the excerpt reads as the whole proxy did", got, d["reading"])

# ── 1. why the earlier rules let the buyer through ───────────────────────────

eq("Endologix: an issuance vote, but Nellix's shares 'converted into the right to receive' make acquirer_side read it as the target's", parse.acquirer_side(text("ELGX")), False)
eq("Endologix: and it is no joint proxy/prospectus, so filer_is_buyer has nothing to go on", parse.filer_is_buyer(text("ELGX"), name("ELGX")), None)
eq("Real Goods Solar: a written consent, with no issuance proposal for acquirer_side to find", (parse.acquirer_side(text("RGS")), parse.filer_is_buyer(text("RGS"), name("RGS"))), (False, None))
eq("Crescent Capital BDC: the cover wraps the name, and the earlier reading took only its last line", parse.cover_registrant("☐ Soliciting Material under §240.14a-12 \n Crescent Capital\nBDC, Inc. \n (Name of Registrant as Specified In Its Charter)"), "Crescent Capital BDC, Inc.")
eq("Crescent Capital BDC: the whole name now, from the real cover", parse.cover_registrant(text("CCAP")), "Crescent Capital BDC, Inc.")
eq("a cover with no name above its label gives none, not the label's caption", parse.cover_registrant("☐ \n Soliciting Material under §240.14a-12 \n (Name of Registrant as Specified In Its Charter)"), None)
eq("FNF: a definition whose quotation marks did not survive the conversion still names the registrant ('( FNF )')", "fnf" in parse.filer_aliases(text("FNF"), parse.cover_registrant(text("FNF"))), True)
eq("a word that opens a hundred names is the registrant only as the whole name: 'Liberty', never 'Liberty Expedia'", sorted(a for a in parse.filer_aliases(text("LINTA16"), "Liberty Interactive Corporation") if a.startswith("liberty")), ["liberty interactive", "liberty$"])

# ── 2. whose holders are paid ─────────────────────────────────────────────────

eq("Endologix: Nellix's holders are paid, in shares of Endologix's own common stock", paid("ELGX"), ["Nellix"])
eq("Real Goods Solar: 'our issuance to equity holders of Earth Friendly Energy Group Holdings, LLC ... of 8.7 million shares'", paid("RGS"), ["Earth Friendly Energy Group Holdings"])
ev = parse.paid_elsewhere(text("RGS"), name("RGS"))["evidence"]
eq("Real Goods Solar: the evidence is the consent's own sentence", any("our issuance to equity holders of Earth Friendly" in e for e in ev), True)
eq("Crescent Capital BDC: Alcentra Capital's holders are paid", paid("CCAP")[:1], ["Alcentra Capital"])
ev = parse.paid_elsewhere(text("CCAP"), name("CCAP"))["evidence"]
eq("Crescent Capital BDC: '(a) 0.4041 shares of Crescent Capital Maryland BDC Common Stock and (b) $3.1784 in cash'", any("0.4041 shares of Crescent Capital Maryland BDC" in e and "$3.1784" in e for e in ev), True)
eq("$3.1784 of cash is $1.6761 from the adviser and $1.5023 from the company", round(1.6761 + 1.5023, 4), 3.1784)
hp = parse.holders_paid(text("CCAP"), name("CCAP"))
eq("Crescent Capital BDC: its own holders' one-for-one exchange into its Maryland successor is a reincorporation, not a payment", hp["registrant"], [])
eq("Alcentra Capital: the same joint proxy filed by Alcentra is the target's, and stands", (paid("ABDC"), bool(parse.holders_paid(text("ABDC"), name("ABDC"))["registrant"])), (None, True))
eq("Liberty Interactive (2017): GCI's holders are paid, and 'Liberty Interactive will acquire GCI'", ("Gci" in paid("LINTA17"), any("Liberty Interactive will acquire GCI" in e for e in parse.paid_elsewhere(text("LINTA17"), name("LINTA17"))["evidence"])), (True, True))
eq("Eaton: Cooper's holders are paid, and 'New Eaton will acquire Cooper' (New Eaton being Eaton's own holding company)", paid("ETN"), ["Cooper"])
for key, who in (("MDP", "Meredith"), ("MNRL", "Brigham Minerals"), ("NOVL", "Novell"), ("KCI", "Kinetic Concepts ('which we refer to as KCI')"), ("CLNY", "Colony Capital (one of three merging, its holders paid 1.4663 shares)"), ("DPS", "Dr Pepper Snapple (its holders paid a $103.75 special dividend)")):
    eq(f"{who}: its own holders are paid, so it is the target and stands", (paid(key), bool(parse.holders_paid(text(key), name(key))["registrant"])), (None, True))
eq("a captured name that is a security names nobody: 'holders of the Senior Secured Notes of Pioneer'",
   parse.holders_paid("Pioneer Energy Services Corp. \n (Name of Registrant as Specified in its Charter) \n shares of Patterson-UTI common stock to be delivered to the holders of the Senior Secured Floating Rate Notes due 2025 of Pioneer", "Pioneer Energy Services Corp.")["other"], [])
eq("a past reorganisation recited ('each share of NWI common stock was automatically converted') is not this deal's payment",
   parse.holders_paid("Inseego Corp. \n (Name of Registrant as Specified in its Charter) \n In connection with the completion of the Merger, each share of NWI common stock was automatically converted into an equivalent share of Inseego common stock.", "Inseego Corp.")["other"], [])
eq("another company paid in a third company's stock says nothing of who pays: no verdict",
   parse.paid_elsewhere("Acme Corp. \n (Name of Registrant as Specified in its Charter) \n Each share of Widget common stock will be converted into the right to receive 0.5 shares of Bigco common stock.", "Acme Corp."), None)

# ── 3. a split-off acquires nothing ───────────────────────────────────────────

for key, who, sub in (("FNF", "FNF (FNFV for Cannae)", "Splitco from FNF"), ("LINTA16", "Liberty Interactive (Ventures for Liberty Expedia)", "Splitco from Liberty Interactive"), ("LMC", "Liberty Media (Capital and Starz for Liberty Splitco)", "Splitco from Liberty Media")):
    found = parse.split_off(text(key), name(key))
    eq(f"{who}: 'the resulting separation of {sub} pursuant to the redemption as the Split-Off'", bool(found) and sub in found["evidence"][0], True)
eq("a split-off by another company named in the proxy is not the registrant's", parse.split_off("Acme Corp. \n (Name of Registrant as Specified in its Charter) \n We refer to the redemption and the resulting separation of Splitco from Bigco pursuant to the redemption as the Split-Off.", "Acme Corp."), None)
eq("FNF's $15.00 is the 2015 tender for FNFV, not a price anyone is paid in this proxy", any("purchase price of $15.00" in t for _, t in FIX["FNF"]["documents"][0]["pieces"]), True)
eq("Liberty Interactive's $10.15 is the cash Expedia paid HomeAway's holders, from Expedia's annexed notes", any("HomeAway" in t and "$10.15 in cash" in t for _, t in FIX["LINTA16"]["documents"][0]["pieces"]), True)
eq("Real Goods Solar's $5.05 is a liquidation preference of Earth Friendly's Senior Preferred Units", any("Senior Preferred Units have the right to receive a distribution equal to $5.05" in t for _, t in FIX["RGS"]["documents"][0]["pieces"]), True)

# ── 4. the row: set aside with its reason, under the name it filed under ─────

r = filings.judge_target(row("ELGX"), text("ELGX"), "ENDOLOGIX INC /DE/")
eq("Endologix: set aside as the buyer's proxy, with no price of its own", (r["status"], r["offerPrice"], r["offerBasis"]), ("no-consideration", None, None))
eq("Endologix: the error names who is paid", r["error"], "the consideration is paid to Nellix's holders, in the filer's own stock: the filer is the buyer, not the company acquired")
eq("Endologix: the sentences that say so stay on the row", any("Nellix capital stock" in e for e in r["targetBasis"]), True)
eq("every row judged carries the rule's version", r["targetReader"], filings.TARGET_READER)
r = filings.judge_target(row("FNF"), text("FNF"), "Fidelity National Financial, Inc.")
eq("FNF: a split-off is rejected, not a deal at $15.00", (r["status"], r["offerPrice"], r["error"]), ("rejected", None, "a split-off: the filer redeems its own stock for a subsidiary's shares, and no company is acquired"))
r = filings.judge_target(row("LMC"), text("LMC"), "LIBERTY MEDIA CORP")
eq("Liberty Media 2011: a no-offer row is set aside too, and named as it filed", (r["status"], r["target"]["name"], r["target"]["currentName"]), ("rejected", "LIBERTY MEDIA CORP", "Old QVC Group, Inc."))
r = filings.judge_target(row("MDP"), text("MDP"), "MEREDITH CORP")
eq("Meredith: the target stands, under the name it filed under, today's kept beside it", (r["status"], r["offerPrice"], r["target"]["name"], r["target"]["currentName"]), ("ok", 16.99, "MEREDITH CORP", "Hawkeye Acquisition, Inc."))
r = filings.judge_target(row("MNRL"), text("MNRL"), "Brigham Minerals, Inc.")
eq("Brigham Minerals: not 'MNRL Sub Inc.'", (r["status"], r["target"]["name"], r["target"]["currentName"]), ("ok", "Brigham Minerals, Inc.", "MNRL Sub Inc."))
r = filings.name_as_filed({"target": {"name": "Novell, Inc."}}, "NOVELL INC")
eq("a name that differs only in case and suffix is not a rename", r["target"], {"name": "Novell, Inc."})
kept = filings.set_aside_target({"source": "DEFM14A", "status": "ok", "dealType": "reverse-merger", "offerPrice": 1.0}, None, {"paid": ["Privateco"], "evidence": ["x"]})
eq("a reverse merger is kept and labelled as it is: its private company's holders are paid in the listed company's stock by design", kept["status"], "ok")
eq("a take-private statement is never judged this way", filings.set_aside_target({"source": "SC 13E3", "status": "ok"}, {"evidence": ["x"]}, None)["status"], "ok")
eq("a row already rejected stands as it was", filings.set_aside_target({"source": "DEFM14A", "status": "rejected", "error": "de-SPAC"}, None, {"paid": ["X"], "evidence": ["x"]})["error"], "de-SPAC")
d = row("ELGX", status="duplicate", readStatus="ok", duplicateOf="x")
filings.judge_target(d, text("ELGX"), "ENDOLOGIX INC /DE/")
eq("a duplicate is judged on its own reading, which dedupe restores: an earlier copy of the buyer's proxy cannot become the deal", (d["status"], d["readStatus"], d["offerPrice"]), ("duplicate", "no-consideration", None))
eq("a duplicate reading still standing is due a judgement", filings.needs_target_reread(row("ELGX", status="duplicate", readStatus="ok")), True)
eq("a stored proxy judged under the earlier rule is due a judgement; one judged now is not",
   (filings.needs_target_reread(row("ELGX")), filings.needs_target_reread(row("ELGX", targetReader=filings.TARGET_READER)), filings.needs_target_reread({**row("ELGX"), "source": "SC 13E3"})), (True, False, False))

# ── 5. the guard records each change under targetReader ──────────────────────

base = {**row("ELGX"), "offerReader": 2, "acquirerReader": 2}
cur = filings.judge_target(copy.deepcopy(base), text("ELGX"), "ENDOLOGIX INC /DE/")
rows = {base["id"]: cur}
rep = guard.protect({base["id"]: base}, rows)
revs = {v["field"]: v for v in rows[base["id"]]["revisions"]}
eq("the price withdrawn stays withdrawn: the row was set aside", rows[base["id"]]["offerPrice"], None)
eq("and the revision names the rule", revs["offerPrice"]["cause"], "reclassified ok/public merger to no-consideration/public merger under targetReader 1 to 2")
eq("the status change is recorded too", (revs["status"]["from"], revs["status"]["to"], revs["status"]["cause"]), ("ok", "no-consideration", "targetReader 1 to 2"))
base = row("MDP")
cur = filings.judge_target(copy.deepcopy(base), text("MDP"), "MEREDITH CORP")
rows = {base["id"]: cur}
guard.protect({base["id"]: base}, rows)
revs = {v["field"]: v for v in rows[base["id"]]["revisions"]}
eq("a rename is recorded with the rule that made it", (revs["target.name"]["from"], revs["target.name"]["to"], revs["target.name"]["cause"]), ("Hawkeye Acquisition, Inc.", "MEREDITH CORP", "targetReader 1 to 2"))
base = row("MDP", targetReader=filings.TARGET_READER, premiumReader=filings.PREMIUM_READER)
cur = {**copy.deepcopy(base), "offerPrice": None}
rows = {base["id"]: cur}
rep = guard.protect({base["id"]: base}, rows)
eq("the guard is not loosened: a price lost with no reader, target or status change is put back", (rows[base["id"]]["offerPrice"], rep["keptPrior"][:1]), (16.99, [{"id": base["id"], "field": "offerPrice", "value": 16.99}]))

# ── 6. a 13E-3 stored under the buyer takes the deal's subject company ───────

o = FIX["LTRIP-ORPHAN"]
stray, primary = (copy.deepcopy(r) for r in o["rows"])
eq("the stray amendment was stored under Tripadvisor's CIK, the deal's under Liberty TripAdvisor's", (stray["target"]["cik"], primary["target"]["cik"]), ("0001526520", "0001606745"))
eq("the deck index files it inside Liberty TripAdvisor's deal", takeprivates.filed_under([o["deal"]])[stray["id"]]["id"], "0001104659-25-005457")
# the stray row's equity value was Tripadvisor's share count at Liberty TripAdvisor's price: 126.415m x $0.2567 = $32.45m, EV $32.45m - $275.0m = -$242.5m
eq("its equity value was Tripadvisor's 126.415m shares at $0.2567: $32.5m, and its EV -$242.5m", (round(126.415 * 0.2567, 1), round(126.415 * 0.2567 - 275.0, 1)), (32.5, -242.5))
rows = {stray["id"]: stray, primary["id"]: primary}
moved = takeprivates.reidentify_orphans(rows, [o["deal"]])
r = rows[stray["id"]]
eq("one row re-identified", moved, 1)
eq("it takes the deal's subject company", (r["target"]["cik"], r["target"]["name"]), ("0001606745", "Liberty TripAdvisor Holdings, Inc."))
eq("Tripadvisor's figures are dropped, to be read again at Liberty TripAdvisor's CIK", [k for k in ("sharesOut", "ltmRevenue", "ltmEbitda", "netDebt", "financialsReader") if k in r], [])
eq("and the row says why", r["targetBasis"], ["the deck index files 0001104659-25-041353 under the take-private of Liberty TripAdvisor Holdings, Inc. (0001104659-25-005457), its subject company"])
eq("and the deal's buyer group, the stray row's being an early copy", r["buyers"], ["TELLURIDESUB LLC", "TRIPADVISOR, INC.", "TELLURIDE MERGER SUB CORP."])
eq("the deal's own row is untouched", rows[primary["id"]]["target"]["cik"], "0001606745")
eq("the two are now one deal", database.same_deal(database.finalize(copy.deepcopy(r)), database.finalize(copy.deepcopy(primary))), True)
eq("a row that is a deal of its own in the index is never moved", takeprivates.reidentify_orphans({primary["id"]: copy.deepcopy(primary)}, [o["deal"]]), 0)
base = copy.deepcopy(o["rows"][0])
rows = {base["id"]: takeprivates.filings.reidentify_target(copy.deepcopy(base), o["deal"]["target"], "x")}
guard.protect({base["id"]: base}, rows)
causes = {v["field"]: v["cause"] for v in rows[base["id"]]["revisions"]}
eq("the guard lets Tripadvisor's figures go, as a re-identified target, and records each under the rule", (causes.get("sharesOut"), causes.get("ltmRevenue")), ("target re-identified under targetReader 1 to 2", "target re-identified under targetReader 1 to 2"))

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
