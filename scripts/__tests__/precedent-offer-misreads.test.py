#!/usr/bin/env python3
"""
A price recited is not the price paid.

    python3 scripts/__tests__/precedent-offer-misreads.test.py

WHY THIS EXISTS
---------------
Validating share counts found offers read from the wrong sentence. The offer
reader takes the per-share cash figure a document states most often, and a
proxy states many figures that are nobody's price for this deal:

  a self-tender   FS Investment Corp III and IV stood at $9.24, the price of a
                  2018 quarterly tender by one of the funds being merged ("the
                  Company offered to purchase 284,984 shares of its issued and
                  outstanding common shares at a purchase price of $9.24 per
                  share"). An issuer buying its own shares (a self-tender, an
                  odd-lot offer, a repurchase programme) is never a deal's price.
  a proposal      Medley Management stood at $3.75, the cash of the first
                  framework the background recites; the agreed consideration is
                  0.3836 Sierra shares plus "cash in an amount equal to $3.44",
                  a phrase the reader did not know. Welbilt stood at Party A's
                  $15.00 proposal, Veeco at Axcelis's $10.15 first proposal,
                  Chico's at Sycamore's $8.00 offer before the $7.60 agreed.
  a share count   a figure printed with a dollar sign and followed by "shares
                  of" is an exchange ratio, not dollars.

Liberty TripAdvisor's $0.2567 was reported as an exchange ratio read as dollars.
It is not: "each share of Liberty TripAdvisor common stock ... will be converted
into the right to receive $0.2567 in cash", and the reading stands.

Where every passage of the figure stated most often is refused, the price is
the figure the sentences paying the holders state; with none, the stored price
is withdrawn and offerWithdrawn says why. A runner-up of the count is never
promoted on frequency alone. The guard records each change under offerReader.

The fixtures are each row's documents cut to every offer pattern's sentence,
every exchange ratio, stated value, sum and package and every quotation of a
candidate price, at their own offsets; each reads as its whole document did
(checked when the fixture was cut, and again here against that reading).
"""

from __future__ import annotations

import copy
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))

from precedent_transactions import filings, guard, parse  # noqa: E402

FIX = {d["key"]: d for d in json.loads((ROOT / "scripts" / "__tests__" / "fixtures" / "precedent-offer-misreads.json").read_text())}
passed = failed = 0


def eq(name, got, want):
    global passed, failed
    ok = got == want
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + ("" if ok else f" — got {got!r}, want {want!r}"))
    if ok:
        passed += 1
    else:
        failed += 1


def placed(pieces) -> str:
    """The excerpt as the reader sees it: each passage at its own offset, the gaps blank and closed with ';'."""
    out, at = [], 0
    for off, t in pieces:
        gap = off - at
        if gap > 0:
            out.append(";" + "\n" * (gap - 2) + ";" if gap >= 2 else "\n" * gap)
        out.append(t)
        at = off + len(t)
    return "".join(out)


def texts(key: str) -> list[str]:
    return [placed(d["pieces"]) for d in FIX[key]["documents"]]


def row(key: str, **extra) -> dict:
    d = FIX[key]
    return {"id": d["id"], "source": d["source"], "status": d["status"], "offerPrice": d["offerPrice"], "offerBasis": d["offerBasis"], "consideration": d["consideration"],
            "announced": d["announced"], "announcedBasis": d["announcedBasis"], "offerReader": 3, "target": {"name": d["name"]}, "documentsRead": [x["url"] for x in d["documents"]], **extra}


def reread(key: str, **extra) -> dict:
    r = row(key, **extra)
    return filings.resolve_offer(r, r["documentsRead"], texts(key), reread=True)


def candidates(key: str, value: float) -> list[dict]:
    return [c for t in texts(key) for c in parse.offer_candidates(t) if abs(c["value"] - value) < 1e-6]


# ── 0. the excerpts read as their documents did ───────────────────────────────

for key, d in FIX.items():
    t = texts(key)
    offers = [list(parse.parse_offer(x)) for x in t]
    first = next((o for o in offers if o[0] is not None), [None, None])
    ref = parse.refused_offer(t, d["offerPrice"]) if first[0] is None else None
    agreed = d["announced"] if d["announcedBasis"] in filings.AGREEMENT_BASES else None
    o = parse.read_offer(t, first[0], first[1], agreed, None, d["name"]) if first[0] is not None else None
    got = {"offers": offers, "refused": ref and ref["reason"], "stock": o and o["stock"], "implied": o and o["implied"], "unresolved": o and o["unresolved"],
           "ratio": o and next((c.get("exchangeRatio") for c in o["components"] if c.get("exchangeRatio")), None), "mixed": [parse.mixed_consideration(x) for x in t]}
    eq(f"{key}: the excerpt reads as the whole filing did", got, d["reading"])

# ── 1. an issuer buying its own shares ────────────────────────────────────────

c = candidates("FSIC3", 9.24)
eq("FS Investment Corp III: the only $9.24 is a 2018 tender by one of the funds for its own shares", (len(c), "offered to purchase 284,984 shares of its issued and outstanding common shares" in c[0]["excerpt"]), (1, True))
eq("and it is refused as the issuer's own repurchase", c[0]["refused"], "the issuer buying its own shares (a repurchase or self-tender), not the deal")
eq("284,984 shares offered for, 71,891 more approved: 356,875 bought", 284_984 + 71_891, 356_875)
eq("356,875 shares at $9.24 is the $3,298 thousand the repurchase table states", round(356_875 * 9.24 / 1000), 3298)
for key in ("FSIC3", "FSIC4"):
    r = reread(key)
    eq(f"{key}: no price is read, and the stored $9.24 is withdrawn", (r["offerPrice"], r["offerBasis"], r["status"]), (None, None, "no-offer"))
    eq(f"{key}: offerWithdrawn says why", r["offerWithdrawn"].startswith("no per-share price is stated where the holders are paid; the $9.24 read before is the issuer buying its own shares"), True)
    eq(f"{key}: and the merger, paid in FSIC II's shares at net asset value, is read as stock whose value the proxy does not state: unresolved, never made up", (r["consideration"], r.get("offerImplied"), r["offerUnresolved"].startswith("the consideration is stock")), ("stock", None, True))
    eq(f"{key}: under this reader's version", r["offerReader"], filings.OFFER_READER)
for s in ("The Company repurchased 1,000,000 shares at $12.50 per share in cash under its share repurchase program.",
          "Holders of fewer than 100 shares may tender in the odd-lot offer at a purchase price of $4.00 per share.",
          "In March, we commenced a modified Dutch auction tender offer to purchase up to 5,000,000 shares of our common stock at a purchase price of $21.00 per share."):
    eq(f"a repurchase is never the price: {s[:60]}...", parse.parse_offer(s), (None, None))
eq("a buyer's tender for the company is still the price", parse.parse_offer("Parent commenced a tender offer to purchase all outstanding shares of the Company at a purchase price of $21.00 per share, net to the seller in cash.")[0], 21.0)

# ── 2. a proposal the background recites ─────────────────────────────────────

three_75 = candidates("MDLY", 3.75)
three_44 = candidates("MDLY", 3.44)
eq("Medley: the first framework's $3.75 is stated five times, three of them in a proposal or framework sentence", (len(three_75), sum(1 for c in three_75 if c["refused"])), (5, 3))
eq("Medley: the agreed $3.44 twenty times, 'cash in an amount equal to $3.44 per share'", (len(three_44), any("cash in an amount equal to $3.44" in c["excerpt"] for c in three_44)), (20, True))
r = reread("MDLY")
eq("Medley: the price is the agreed cash, $3.44, not the framework's $3.75", (r["offerPrice"], r["status"]), (3.44, "ok"))
eq("Medley: the consideration includes 0.3836 Sierra shares, whose value the proxy states on no day near the agreement: unresolved, never made up", (r["offerImplied"] if "offerImplied" in r else None, r["offerUnresolved"]), (None, "the consideration includes stock and the filing states its value on no day near the agreement, nor parts that add up to it"))
r = reread("MDLY13E3")
eq("Medley's 13E-3: its statement states no price, its proxy $3.44, with Sierra's 0.3836 shares", (r["offerPrice"], next(c["exchangeRatio"] for c in r["offerComponents"] if c.get("exchangeRatio"))), (3.44, 0.3836))
for key, was, why in (("WLB", 15.0, "Party A's proposal"), ("VECO", 10.15, "Axcelis's first, non-binding proposal")):
    r = reread(key)
    eq(f"{FIX[key]['name']}: ${was:,.2f} is {why}, and every passage stating it is refused: withdrawn, the deal read as the stock deal it is", (r["offerPrice"], r["status"], "a proposal, framework or bid" in r["offerWithdrawn"], r["consideration"]), (None, "no-offer", True, "stock"))
r = reread("CHS")
eq("Chico's: Sycamore's $8.00 offer is the background's; the holders are paid $7.60", (r["offerPrice"], r["offerImplied"]), (7.6, 7.6))
eq("the vote put to the holders is not a proposal of a price: 'if the merger proposal is approved, you will receive $10.00 in cash'",
   parse.parse_offer("If the merger proposal is approved and the merger is completed, you will receive $10.00 in cash for each share you own."), (10.0, "$10.00 in cash"))
eq("a runner-up is never promoted on frequency alone: a preferred stock's liquidation preference is not the price",
   parse.parse_offer("Party A submitted a non-binding proposal at $21.90 per share in cash. Party A then raised its proposal to $21.90 per share in cash. The Liquidation Preference means an amount in cash equal to $25.00 per share of Series B Preferred Stock."), (None, None))
eq("nor a contingent payment that pays the holders", parse.parse_offer("Party B submitted an all-cash proposal of $1.05 per share in cash. Each share will be converted into the right to receive future conditional payments worth up to $0.20 in cash."), (None, None))

# ── 3. a share count is not dollars; a cash price stays one ──────────────────

eq("a figure printed with a dollar sign before 'shares of' is an exchange ratio", parse.offer_refusal("will receive $0.4041 shares of Crescent common stock", 13, 19), "an exchange ratio printed with a dollar sign, not dollars")
eq("'$28.25 per share of Tripadvisor common stock' is a price per share, not a count", parse.offer_refusal("a purchase price of $28.25 per share of Tripadvisor common stock in cash", 21, 26), None)
r = reread("LTRIP")
eq("Liberty TripAdvisor: $0.2567 is cash ('converted into the right to receive $0.2567 in cash'), and stands", (r["offerPrice"], r["offerImplied"], r["consideration"]), (0.2567, 0.2567, "cash"))
eq("77.900m shares at $0.2567 is the $20.0m the fee table's count implies", round(77.900 * 0.2567, 1), 20.0)
eq("its rivals' and earlier prices are refused (Party 4's $28.25, Party 7's $17.50 to $19.00), never the agreed $0.2567", (0.2567 in {c["value"] for t in texts("LTRIP") for c in parse.offer_candidates(t) if c["refused"]}, {0.308, 17.5, 19.0, 28.25} <= {c["value"] for t in texts("LTRIP") for c in parse.offer_candidates(t) if c["refused"]}), (False, True))

# ── 4. the guard records each change under offerReader ───────────────────────

base = row("FSIC3")
cur = reread("FSIC3")
rows = {base["id"]: cur}
rep = guard.protect({base["id"]: base}, rows)
revs = {v["field"]: v for v in rows[base["id"]]["revisions"]}
eq("the $9.24 withdrawn stays withdrawn, under the reader that moved", (rows[base["id"]]["offerPrice"], revs["offerPrice"]["from"], revs["offerPrice"]["cause"]), (None, 9.24, f"offerReader 3 to {filings.OFFER_READER}"))
base = row("MDLY")
rows = {base["id"]: reread("MDLY")}
guard.protect({base["id"]: base}, rows)
rev = next(v for v in rows[base["id"]]["revisions"] if v["field"] == "offerPrice")
eq("Medley's $3.75 to $3.44 is recorded", (rev["from"], rev["to"], rev["cause"]), (3.75, 3.44, f"offerReader 3 to {filings.OFFER_READER}"))
base = row("FSIC3", offerReader=filings.OFFER_READER)
rows = {base["id"]: {**copy.deepcopy(base), "offerPrice": None}}
rep = guard.protect({base["id"]: base}, rows)
eq("the guard is not loosened: a price lost with no reader change is put back", rows[base["id"]]["offerPrice"], 9.24)
eq("a reading that cannot see the stored figure at all keeps it", parse.refused_offer(["nothing here"], 9.24), None)
cvr = "Each share will be converted into the right to receive 0.1783 shares of Assertio and one CVR, representing the right to receive future conditional payments worth up to an aggregate maximum amount of $0.20 in cash."
eq("a stored price that is a CVR's payment ('worth up to ... $0.20', Spectrum's) is withdrawn: never counted, and a reason", (parse.parse_offer(cvr), parse.refused_offer([cvr], 0.2)["reason"]), ((None, None), "a contingent payment (a CVR or milestone), not the price"))

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
