#!/usr/bin/env python3
"""
The whole offer, read before a premium is tied to it.

    python3 scripts/__tests__/precedent-offer.test.py

WHY THIS EXISTS
---------------
The losing-bid rule ties a deal's 1-day premium to its offer: the reference
price times one plus the premium must come back to the offer within two
points. On the dry run of October 2026 that rule took the premium off 35
rows, and in most of them the premium was right and the offer was misread:

  per share, not per ADS   Verona's 23% is to the ADS price of $86.86; the
                           offer read was $13.375 a share, and an ADS is
                           eight shares, so $107.00 an ADS.
  the price per ADS read   First High-School's $0.15 is the price of an ADS
  as a share's             of three shares; a share's is $0.05.
  a CVR as the price       Orchard's $0.10 and Fusion's "up to $3.00" are
                           contingent payments, not the price.
  the cash part only       Coventry's $27.30 is the cash beside 0.3885 of an
                           Aetna share; the filing values the two together at
                           $42.08 on the last day before the announcement.
  a stock part in dollars  Rockwell Collins: $93.33 cash plus UTC stock worth
                           $46.67, so $140.00; Boots & Coots: $1.73 plus
                           $1.27, so $3.00.
  the filing's own sum     Qiao Xing: 1.9 x $1.68 + $0.80 = $3.992.
  a dividend beside it     Grindrod: $21.00 plus a $5.00 special dividend,
                           which the filing values together at $26.00.

The offer reader (parse.read_offer, filings.resolve_offer) now puts the offer
in the terms the premium uses, keeps every part of it with its passage, its
document and the reader's version. Where the consideration includes stock
and nothing gives its value (LaSalle: $37.80 cash or 0.92 of a Pebblebrook
share, at the holder's election) the offer is unresolved: nothing is made up,
and the filing's own premium stands untied, as it did before, with the row
saying so (premiumTie). Setting such statements aside took the premium off
some 330 stock deals in the first dry run and tripped the rollback guard.

Every figure below is worked by hand from the filing's own words, quoted in
the comment beside it. The fixtures are the passages of each deal's real
filing around every premium, offer, ratio, stock term and stated value, as
EDGAR serves them; the readings were checked to be the same over the excerpt
as over the whole document.
"""

from __future__ import annotations

import copy
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))

from precedent_transactions import filings, guard, parse  # noqa: E402

FIX = {d["key"]: d for d in json.loads((ROOT / "scripts" / "__tests__" / "fixtures" / "precedent-offer.json").read_text())}
passed = failed = 0


def eq(name, got, want):
    global passed, failed
    ok = got == want
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + ("" if ok else f" — got {got!r}, want {want!r}"))
    if ok:
        passed += 1
    else:
        failed += 1


def near(a, b, tol=0.0005):
    return a is not None and b is not None and abs(a - b) <= tol


def read(key: str) -> dict:
    """The stored row (as #183 left it) read again: the offer, then the premiums tied to it."""
    d = FIX[key]
    row = copy.deepcopy(d["stored"])
    urls = [x["url"] for x in d["documents"]]
    texts = [x["text"] for x in d["documents"]]
    filings.resolve_offer(row, urls, texts, reread=True)
    statements, aside = filings.tied_statements(row, urls, texts)
    filings.apply_premiums(row, statements, aside, texts)
    return row


def old_rule(key: str) -> list[dict]:
    """What #183's rule kept, tying to the stored per-share cash alone."""
    d = FIX[key]
    s = d["stored"]
    agreed = s["announced"] if s.get("announcedBasis") in filings.AGREEMENT_BASES else None
    kept = []
    for x in d["documents"]:
        k, _ = parse.premium_statements(x["text"], s["offerPrice"], agreed, cash_only=s.get("consideration") == "cash", original=s.get("announcedOriginal"))
        kept += k
    return kept


rows = {k: read(k) for k in FIX}

# ── ADS ──────────────────────────────────────────────────────────────────────

v = rows["VRNA"]
# "each American Depositary Share ... represents a beneficial ownership interest
# in eight (8) Verona ordinary shares": $13.375 x 8 = $107.00 an ADS.
eq("Verona: the ADS ratio is the eight the filing states", v["adsRatio"], 8.0)
eq("Verona: the offer per ADS is $13.375 x 8 = $107.00", v["offerPerAds"], 107.0)
eq("Verona: the 23% over the $86.86 ADS close was set aside under the per-share tie", any(s["premium"] == 0.23 for s in old_rule("VRNA")), False)
# $107.00 / $86.86 = 1.2319: 23%, inside two points.
eq("Verona: and now ties to $107.00 an ADS: 23% over $86.86", (v["premium1Day"], v["unaffectedPriceStated"], v["unaffectedPricePer"]), (0.23, 86.86, "ADS"))

t = rows["TSL"]
# "each ADS represents 50 Shares": $0.232 x 50 = $11.60; $11.60 / $8.25 = 1.406.
eq("Trina: $0.232 a share x 50 shares an ADS = $11.60 an ADS", (t["adsRatio"], t["offerPerAds"]), (50.0, 11.6))
eq("Trina: 40.6% over the $8.25 ADS close ties", (t["premium1Day"], t["unaffectedPriceStated"], t["unaffectedPricePer"]), (0.406, 8.25, "ADS"))

f = rows["FHS"]
# "the Per Share Merger Consideration of US$0.05 per Ordinary Share, or the Per
# ADS Merger Consideration of US$0.15 per ADS"; "ADSs, each representing three
# Class A ordinary shares". The $0.15 stored is the price of an ADS.
eq("First High-School: the $0.15 read was per ADS: the row's price is the $0.05 a share the filing states", (f["offerPrice"], f["adsRatio"], f["offerPerAds"]), (0.05, 3.0, 0.15))
eq("First High-School: the per-share price carries the passage it was read from", "US$0.05 in cash per Ordinary Share" in (f["offerBasis"] or ""), True)
# "a premium of approximately 185.2% to the closing price of US$0.081 per ADS":
# $0.081 x 2.852 = $0.231, not $0.15 ($0.15 / $0.081 = 1.852, an 85.2% premium).
# The filing's own figure does not reproduce, so it is still set aside.
eq("First High-School: the stated 185.2% measures $0.23 an ADS, not $0.15, and stays aside", any(s["reason"].startswith("measures $0.23 an ADS") for s in f["premiumsSetAside"]), True)
eq("First High-School: no 1-day premium", f["premium1Day"], None)

# ── contingent payments are not the price ────────────────────────────────────

o = rows["ORTX"]
# "one ... CVR per Orchard ordinary share, which each represent the right to
# receive a contingent payment of $0.10 in cash": not the price. The price is
# $1.60 a share, and an ADS is ten shares: $16.00.
eq("Orchard: the $0.10 CVR payment stored as the price is read again as $1.60 a share", (FIX["ORTX"]["stored"]["offerPrice"], o["offerPrice"]), (0.1, 1.6))
eq("Orchard: $1.60 x 10 = $16.00 an ADS", (o["adsRatio"], o["offerPerAds"]), (10.0, 16.0))
# $16.00 / $8.14 = 1.966: 97%.
eq("Orchard: 97% over the $8.14 ADS close ties", (o["premium1Day"], o["unaffectedPriceStated"], o["unaffectedPricePer"]), (0.97, 8.14, "ADS"))
eq("Orchard: no component of the offer is the $0.10 CVR", any(c.get("value") == 0.1 for c in o["offerComponents"]), False)

u = rows["FUSN"]
# "a contingent payment of up to $3.00 in cash": the price is $21.00.
# $21.00 / $10.64 = 1.974: 97%.
eq("Fusion: the CVR's $3.00 gives way to the $21.00 price", (FIX["FUSN"]["stored"]["offerPrice"], u["offerPrice"]), (3.0, 21.0))
eq("Fusion: 97% over $10.64 ties", (u["premium1Day"], u["unaffectedPriceStated"]), (0.97, 10.64))

# ── stock: a value the filing states ─────────────────────────────────────────

c = rows["CVH"]
# "Based on the closing price of Aetna common shares ... on August 17, 2012,
# the last trading day before the public announcement ..., the merger
# consideration represented approximately $42.08 in value for each share".
eq("Coventry: $27.30 cash is part of a package with 0.3885 of an Aetna share", c["consideration"], "cash and stock")
eq("Coventry: the package is the $42.08 the filing states for 17 August 2012", (c["offerImplied"], c["offerImpliedMethod"], c["offerImpliedDate"]), (42.08, "stated", "2012-08-17"))
eq("Coventry: the 30.2% was set aside under the cash-only tie", any(s["premium"] == 0.302 for s in old_rule("CVH")), False)
# $42.08 / $32.32 = 1.302.
eq("Coventry: 30.2% over $32.32 now ties to $42.08", (c["premium1Day"], c["unaffectedPriceStated"]), (0.302, 32.32))

j = rows["JPEP"]
# "valued at $8.63 per unit based on the closing price of AMID Common Units as
# of October 21, 2016, the last trading day before the public announcement".
# $8.63 / $7.54 = 1.1446: 14.5%.
eq("JP Energy: the $0.4125 stored is not the price; the units are valued at $8.63 on 21 October 2016", (j["offerImplied"], j["offerImpliedDate"]), (8.63, "2016-10-21"))
eq("JP Energy: 14.5% over $7.54 ties", (j["premium1Day"], j["unaffectedPriceStated"]), (0.145, 7.54))

q = rows["QRE"]
# "The unit consideration is valued at $22.48 per QRE unit ... based on the
# closing price of Breitburn's common units as of July 23, 2014".
# $22.48 / $18.87 = 1.1913: 19%.
eq("QR Energy: the unit consideration is the $22.48 stated for 23 July 2014", (q["offerImplied"], q["offerImpliedDate"]), (22.48, "2014-07-23"))
eq("QR Energy: 19% over $18.87 ties", (q["premium1Day"], q["unaffectedPriceStated"]), (0.19, 18.87))

m = rows["MPG"]
# "the implied value of the consideration payable per share of MPG common
# stock as of November 1, 2016 of $22.03". $22.03 / $14.65 = 1.5038: 50.2%.
eq("Metaldyne: $13.50 cash and AAM stock, the implied value $22.03 on 1 November 2016", (m["offerImplied"], m["offerImpliedDate"]), (22.03, "2016-11-01"))
eq("Metaldyne: 50.2% over $14.65 ties", (m["premium1Day"], m["unaffectedPriceStated"]), (0.502, 14.65))

r = rows["COL"]
# "(a) $93.33 in cash ... plus (b) a fraction of a share of UTC common stock
# equal to the quotient obtained by dividing $46.67 by the average ...":
# $93.33 + $46.67 = $140.00, which the filing states as the price.
# $140.00 / $112.36 = 1.246: 25%.
eq("Rockwell Collins: $93.33 cash + $46.67 in UTC stock = $140.00", (r["offerImplied"], r["offerImpliedMethod"]), (140.0, "stated"))
eq("Rockwell Collins: the stock part is kept as a component, in dollars", any(x.get("fixedValue") == 46.67 for x in r["offerComponents"]), True)
eq("Rockwell Collins: 25% over $112.36 ties", (r["premium1Day"], r["unaffectedPriceStated"]), (0.25, 112.36))

# ── stock: computed only from stated components ──────────────────────────────

x = rows["XING"]
# "the Scheme Consideration here was calculated by using the last closing
# price of XING's ordinary shares ... of US$1.68 as of September 7, 2010,
# multiplied by 1.9, plus US$0.80": 1.9 x $1.68 + $0.80 = $3.192 + $0.80 = $3.992.
eq("Qiao Xing: 1.9 x $1.68 + $0.80 = $3.992, computed from the stated parts on 7 September 2010", (x["offerImplied"], x["offerImpliedMethod"], x["offerImpliedDate"]), (3.992, "computed from stated components", "2010-09-07"))
eq("Qiao Xing: the basis names the reference date and every part", all(p in x["offerImpliedBasis"] for p in ("1.9", "$1.68", "2010-09-07", "$0.80")), True)
# $3.992 / $2.58 = 1.547: 55%.
eq("Qiao Xing: 55% over $2.58 ties", (x["premium1Day"], x["unaffectedPriceStated"]), (0.55, 2.58))

w = rows["WEL"]
# "(1) $1.73 in cash and (2) a fraction of a share of Halliburton common stock
# equal to an exchange ratio, which will be calculated by dividing $1.27 by":
# $1.73 + $1.27 = $3.00. $3.00 / $2.38 = 1.2605: 26%.
eq("Boots & Coots: $1.73 cash + $1.27 in Halliburton stock = $3.00", (w["offerImplied"], w["offerImpliedMethod"]), (3.0, "computed from stated components"))
eq("Boots & Coots: 26% over $2.38 ties", (w["premium1Day"], w["unaffectedPriceStated"]), (0.26, 2.38))

# ── cash with a dividend the filing values with it ───────────────────────────

g = rows["GRIN"]
# "$21.00 per Share ... in conjunction with a special dividend from the Company
# of $5.00 per Share, representing an aggregate transaction value to Company
# shareholders of $26.00 per Share": $21.00 + $5.00 = $26.00.
eq("Grindrod: $21.00 cash with the $5.00 special dividend, $26.00 as the filing values them", (g["offerPrice"], g["offerImplied"], g["consideration"]), (21.0, 26.0, "cash"))
eq("Grindrod: the dividend is kept as a component", any(x.get("payout") == 5.0 and x.get("value") == 26.0 for x in g["offerComponents"]), True)
# "a 26.8% premium to the last traded price per Share of $20.50": $26.00 / $20.50 = 1.268.
eq("Grindrod: 26.8% over $20.50 ties to $26.00", (g["premium1Day"], g["unaffectedPriceStated"]), (0.268, 20.5))

s = rows["SYA"]
# "a special dividend of $0.50 per share ..., for a total transaction value of
# $32.50 per share": $32.00 + $0.50. $32.50 / $24.97 = 1.3016: 30.2%.
eq("Symetra: $32.00 cash with a $0.50 special dividend, $32.50 in all", (s["offerImplied"], s["premium1Day"], s["unaffectedPriceStated"]), (32.5, 0.302, 24.97))

# ── unresolved: left out, with the reason ────────────────────────────────────

lho = rows["LHO"]
# "(a) 0.92 common shares ... of Pebblebrook ... or (b) $37.80 in cash", at
# the holder's election; the filing states the package's value on no day near
# the agreement. Nothing to tie a premium to: the filing's own statement
# stands, untied, and the row says so.
eq("LaSalle: a cash-or-stock election is not cash", lho["consideration"], "cash and stock")
eq("LaSalle: the offer is unresolved, and says why", "includes stock" in (lho.get("offerUnresolved") or ""), True)
eq("LaSalle: no implied offer is made up", lho.get("offerImplied"), None)
eq("LaSalle: the filing's 48% over $24.39 stands as stated", (lho["premium1Day"], lho["unaffectedPriceStated"]), (0.48, 24.39))
eq("LaSalle: and the row says it is untied, and why", (lho.get("premiumTie") or "").startswith("untied: the offer is unresolved"), True)
eq("a tied row says so", (rows["CVH"].get("premiumTie"), rows["ACAP"].get("premiumTie")), ("tied to the whole offer", "tied to the whole offer"))

# ── control: an all-cash deal is unchanged ───────────────────────────────────

a = rows["ACAP"]
# "$41.50 in cash"; 32% over $31.45: $41.50 / $31.45 = 1.3196.
st = FIX["ACAP"]["stored"]
eq("American Physicians: the cash price is the whole offer, as before", (a["offerPrice"], a["offerImplied"], a["offerImpliedMethod"], a["consideration"]), (41.5, 41.5, "cash", "cash"))
eq("American Physicians: no ADS, no stock, nothing unresolved", (a.get("adsRatio"), a.get("offerPerAds"), a.get("offerUnresolved")), (None, None, None))
eq("American Physicians: the premium and unaffected price are what #183 read", (a["premium1Day"], a["unaffectedPriceStated"]), (st["premium1Day"], st["unaffectedPriceStated"]))

# ── provenance and the guard ─────────────────────────────────────────────────

eq("every row read carries the offer reader's version", {k: r["offerReader"] for k, r in rows.items()}, {k: filings.OFFER_READER for k in rows})
eq("every component names the document it came from and the reader", all(c.get("document") in [d["url"] for d in FIX[k]["documents"]] and c.get("reader") == filings.OFFER_READER for k, r in rows.items() for c in r.get("offerComponents") or []), True)
eq("every implied offer says how it was found", all(r.get("offerImpliedBasis") for r in rows.values() if r.get("offerImplied") is not None), True)

base = {"ORTX": {**FIX["ORTX"]["stored"], "status": "ok", "premiumReader": 4}}
cur = {"ORTX": {**rows["ORTX"], "status": "ok"}}
guard.protect(base, cur)
rev = [x for x in cur["ORTX"].get("revisions") or [] if x["field"] == "offerPrice"]
eq("guard: Orchard's price moving from $0.10 to $1.60 is recorded, caused by the offer reader", [(x["from"], x["to"], x["cause"]) for x in rev], [(0.1, 1.6, f"offerReader 1 to {filings.OFFER_READER}")])
lost = {"LHO": {**FIX["LHO"]["stored"], "status": "ok", "offerImplied": 37.8, "offerReader": filings.OFFER_READER}}
now = {"LHO": {**lost["LHO"], "offerImplied": None}}
guard.protect(lost, now)
eq("guard: an implied offer lost with no reader moving is put back", now["LHO"]["offerImplied"], 37.8)

eq("a row read before the offer reader is due a re-read", filings.needs_premium_reread({"premiumReader": filings.PREMIUM_READER, "announcedReader": filings.ANNOUNCED_READER, "documentsRead": ["x"], "status": "ok"}), True)

# ── the pure reader, on wordings ─────────────────────────────────────────────

eq("an ADS ratio in words", parse.ads_ratio(["American Depositary Shares, each representing four ordinary shares"])[0], 4.0)
eq("no ratio stated, none assumed", parse.ads_ratio(["The ADSs trade on Nasdaq."])[0], None)
eq("two ratios stated equally often give none", parse.ads_ratio(["ADSs, each representing two Shares", "ADSs, each representing three Shares"])[0], None)
o2 = parse.read_offer(["holders will receive US$2.00 in cash per ADS. The ADSs trade on Nasdaq; US$2.00 per ADS."], 2.0, "US$2.00 in cash")
eq("quoted per ADS with no ratio: the offer ties per ADS only", (o2["implied"], o2["perAds"], o2["ties"]), (None, 2.0, [(2.0, "ADS")]))
o3 = parse.read_offer(["converted into the right to receive $10.00 in cash and 0.5000 of a share of Acquirer common stock. converted into the right to receive $10.00 in cash and 0.5000 of a share of Acquirer common stock."], 10.0, "$10.00 in cash")
eq("an exchange ratio with no value stated is not computed from a price the filing never gives", (o3["stock"], o3["implied"], bool(o3["unresolved"])), (True, None, True))

# ── stock deals: what the first dry run got wrong ────────────────────────────

# Taubman's shareholders were paid cash; its operating partnership's unitholders
# could elect Simon units. Siliconware was paid cash; ASE's own shares moved
# into the holding company. Neither is stock in the target holders' package.
op = "Upon completion, holders of Taubman OP units who are not Taubman family members will be entitled to receive, at their election, the common stock merger consideration or 0.5703 Simon OP units for each Taubman OP unit."
eq("an operating partnership's unit election is not the shareholders' consideration", parse.stock_terms([op, op])["ratio"], None)
ase = "each ASE share, issued immediately prior to the Effective Time (including ASE’s treasury shares), will be transferred to HoldCo in consideration for the right to receive 0.5 HoldCo shares."
eq("an acquirer's own shares moving into a holding company are not the target's consideration", parse.stock_terms([ase, ase])["ratio"], None)

# William Lyon (Taylor Morrison stock): "the implied value of the Merger
# Consideration was $21.45 per share, based on the $23.69 closing price per
# share of Taylor Morrison common stock on November 5, 2019 ... represented an
# implied premium of approximately 16.6% over the closing price per share of
# William Lyon Homes Class A common stock on November 5, 2019". The $23.69 in
# the lead-in is the acquirer's price, not another bid.
wlh = ("the fact that the implied value of the Merger Consideration was $21.45 per share, based on the $23.69 closing price per share of Taylor Morrison common stock on November 5, 2019, "
       "the last full trading day before the announcement of the merger agreement, represented an implied premium of approximately 16.6% over the closing price per share of William Lyon Homes Class A common stock on November 5, 2019, the last full trading day before the announcement of the merger agreement")
k, a = parse.premium_statements(wlh, 2.5, "2019-11-05", cash_only=False, ties=[(21.45, "share")], tie_date="2019-11-05")
eq("William Lyon: a stock deal's lead-in naming the acquirer's price does not refuse its premium", [x["premium"] for x in k], [0.166])

# TWC (Comcast stock): "a premium of approximately 17% implied by the merger
# exchange ratio to the closing price of TWC common stock of $139.40 per share
# on February 11, 2014". $139.40 x 1.17 = $163.10 against the $158.82 the
# filing states for 12 February (Comcast's price moved a day): another day's
# value of the same package, so not held to it.
twc = "a premium of approximately 17% implied by the merger exchange ratio to the closing price of TWC common stock of $139.40 per share on February 11, 2014, the last trading day prior to the announcement"
k, a = parse.premium_statements(twc, 54.72, "2014-02-12", cash_only=False, ties=[(158.82, "share")], tie_date="2014-02-12")
eq("TWC: a stock package's premium measured on another day stands", [x["premium"] for x in k], [0.17])
k, a = parse.premium_statements(twc.replace("February 11", "February 12"), 54.72, "2014-02-12", cash_only=False, ties=[(158.82, "share")], tie_date="2014-02-12")
eq("TWC: on the day the value is stated, it is held to it ($163.10 is not $158.82)", ([x["premium"] for x in k], any(x["reason"].startswith("measures $163.10") for x in a)), ([], True))

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
