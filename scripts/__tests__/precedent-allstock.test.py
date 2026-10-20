#!/usr/bin/env python3
"""
The whole offer of a deal paid in stock.

    python3 scripts/__tests__/precedent-allstock.test.py

WHY THIS EXISTS
---------------
The offer reader (#185) valued a package with stock only where the row had a
cash price: resolve_offer returned before reading anything when offerPrice was
None. So an all-stock deal never had a whole offer (offerImplied), however
plainly its proxy stated what the acquirer's shares were worth, and Finance OS,
which now prices a deal on offerImplied, could not use it. TESCO was the other
side of it: its price read, $4.62, is not cash but the value the proxy states
for 0.68 of a Nabors share, so its package stood "unresolved".

The reader (OFFER_READER 3, parse.read_stock_offer) now reads such a deal by
the rules a package with stock already had: the value the filing states on the
last trading day before the announcement, as the agreed price, or on a date
near the agreement; else the filing's own sum or product of its parts. A value
stated only at the proxy's practicable date is a component and never the tie;
no ratio is assumed and no price is looked up. The premium of a stock package
is checked against the whole offer on the day the package is valued, and
stands untied, saying so, where nothing checks it.

Every figure below is worked by hand from the filing's own words, quoted in the
comment beside it. The fixtures are the passages of each deal's real filing
around every premium, offer, ratio and stated value, as EDGAR serves them; the
readings were checked to be the same over the excerpt as over the whole
document.
"""

from __future__ import annotations

import copy
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))

from precedent_transactions import filings, guard, parse  # noqa: E402

FIX = {d["key"]: d for d in json.loads((ROOT / "scripts" / "__tests__" / "fixtures" / "precedent-allstock.json").read_text())}
passed = failed = 0


def eq(name, got, want):
    global passed, failed
    ok = got == want
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + ("" if ok else f" — got {got!r}, want {want!r}"))
    if ok:
        passed += 1
    else:
        failed += 1


def read(key: str) -> dict:
    """The stored row (as the offer reader 2 left it) read again: the offer, then the premiums tied to it."""
    d = FIX[key]
    row = copy.deepcopy(d["stored"])
    urls = [x["url"] for x in d["documents"]]
    texts = [x["text"] for x in d["documents"]]
    filings.resolve_offer(row, urls, texts, reread=True)
    statements, aside = filings.tied_statements(row, urls, texts)
    filings.apply_premiums(row, statements, aside, texts)
    row["_statements"] = statements
    return row


rows = {k: read(k) for k in FIX}


def stated(row: dict) -> list[dict]:
    return [c for c in row.get("offerComponents") or [] if c["part"] == "stated value"]


# ── all stock, the value stated on the reference day ─────────────────────────

x = rows["XTO"]
# "Based on the closing price of $72.83 for ExxonMobil common stock on the New
# York Stock Exchange on December 11, 2009, the last trading day before the
# public announcement of the merger agreement, the merger consideration
# represented approximately $51.69 in value": 0.7098 x $72.83 = $51.6947.
eq("XTO: no cash price was read, as before", (FIX["XTO"]["stored"]["offerPrice"], x["offerPrice"]), (None, None))
eq("XTO: the whole offer is the $51.69 stated for 11 December 2009", (x["offerImplied"], x["offerImpliedMethod"], x["offerImpliedDate"]), (51.69, "stated", "2009-12-11"))
eq("XTO: 0.7098 x $72.83 = $51.6947 makes it up, and the basis says so", "0.7098 x $72.83 = $51.6947" in x["offerImpliedBasis"], True)
eq("XTO: the exchange ratio is kept as a component", any(c.get("exchangeRatio") == 0.7098 for c in x["offerComponents"]), True)
# "24.6% over the closing price of XTO Energy common stock of $41.49 per share on
# December 11, 2009": $51.69 / $41.49 = 1.2458.
eq("XTO: 24.6% over $41.49 on the same day ties to $51.69", (x["premium1Day"], x["unaffectedPriceStated"], x["unaffectedDate"], x["premiumTie"]), (0.246, 41.49, "2009-12-11", "tied to the whole offer"))
eq("XTO: the $45.14 of 14 May 2010, the proxy's practicable date, is a component only", any(c["value"] == 45.14 and c["day"] == "practicable" for c in stated(x)), True)

p = rows["PXD"]
# "Based on the closing price of a share of ExxonMobil common stock on the NYSE
# of $108.99 on October 5, 2023, the last trading day prior to media reports
# that Pioneer and ExxonMobil were in merger discussions, the Merger
# Consideration represented approximately $253.23 in implied value":
# 2.3234 x $108.99 = $253.2274. The agreement is of 10 October, five days on.
eq("Pioneer: the $253.23 of 5 October 2023, the day before the media reports", (p["offerImplied"], p["offerImpliedMethod"], p["offerImpliedDate"]), (253.23, "stated", "2023-10-05"))
eq("Pioneer: the $238.45 of 5 January 2024 (2.3234 x $102.63) is never the offer", p["offerImplied"] != 238.45 and any(c["value"] == 238.45 for c in stated(p)), True)
# "an approximately 19.9% premium to Pioneer's unaffected closing price as of
# October 5, 2023": measured on the day the package is valued.
eq("Pioneer: the 19.9% is measured on the day the package is valued, so it is tied", (p["premium1Day"], p["unaffectedDate"], p["premiumTie"]), (0.199, "2023-10-05", "tied to the whole offer"))

g = rows["GATO"]
# "The consideration implies a total offer value of $13.49 per share of Gatos
# common stock based on the closing price of First Majestic's common shares on
# the NYSE on September 4, 2024, the last trading day immediately preceding the
# announcement of the transaction"; elsewhere "the closing price of First
# Majestic common shares of $5.29": 2.55 x $5.29 = $13.4895.
eq("Gatos: the whole offer is the $13.49 of 4 September 2024", (g["offerImplied"], g["offerImpliedDate"]), (13.49, "2024-09-04"))
eq("Gatos: a stated value carries the close it rests on, $5.29, and 2.55 x $5.29 makes it up", any(c["value"] == 13.49 and c.get("price") == 5.29 for c in stated(g)) and abs(2.55 * 5.29 - 13.49) < 0.006, True)
# "The transaction share price of $13.49 represented a premium of approximately
# 16.1% to Gatos' share price of $11.62": $13.49 / $11.62 = 1.1609.
eq("Gatos: 16.1% over $11.62 ties to $13.49", (g["premium1Day"], g["unaffectedPriceStated"], g["premiumTie"]), (0.161, 11.62, "tied to the whole offer"))

h = rows["HESB"]
# "Based on the $53.30 closing price of shares of Hess common stock on July 27,
# 2010, the last trading day prior to the announcement of the merger, the offer
# would represent a value to American stockholders of approximately $7.32 per
# share, representing a premium of 9.4% over the closing price of $6.69":
# 0.1373 x $53.30 = $7.3181; $7.32 / $6.69 = 1.0942.
eq("American Oil & Gas: the $7.32 stated for 27 July 2010", (h["offerImplied"], h["offerImpliedMethod"], h["offerImpliedDate"]), (7.32, "stated", "2010-07-27"))
eq("American Oil & Gas: the close the value rests on is Hess's $53.30, not American's $6.69", [c.get("price") for c in stated(h) if c["value"] == 7.32], [53.3])
eq("American Oil & Gas: 9.4% over $6.69 ties", (h["premium1Day"], h["unaffectedPriceStated"], h["premiumTie"]), (0.094, 6.69, "tied to the whole offer"))
# The fairness table's own product is read too, a component and second to the
# value stated on the reference day: "total consideration was calculated based
# on the closing price of Hess common stock of $52.78 on July 26, 2010,
# multiplied by the exchange ratio of 0.1373": 0.1373 x $52.78 = $7.2467.
texts = [d["text"] for d in FIX["HESB"]["documents"]]
eq("American Oil & Gas: the filing's product, 0.1373 x $52.78 = $7.2467 on 26 July 2010", [(v["value"], v["date"], v["price"]) for v in parse.priced_values(texts, 0.1373)], [(7.2467, "2010-07-26", 52.78)])
unstated = [re.sub(r"would\s+represent\s+a\s+value\s+to\s+American\s+stockholders\s+of\s+approximately\s+\$7\.32\s+per\s+share", "would represent a value", t) for t in texts]
eq("and with no value stated, that product would be the whole offer, computed from the stated parts", (lambda o: (o["implied"], o["method"], o["date"]))(parse.read_stock_offer(unstated, "2010-07-27")), (7.2467, "computed from stated components", "2010-07-26"))

# ── the consideration says it is stock ───────────────────────────────────────

r = rows["RMP"]
# "each RMP common unit ... will be converted into the right to receive 0.3319
# EQM common units"; stored as "cash", the label a row with no price is given.
# "the merger consideration represented approximately $20.66 in value for each
# RMP common unit" (25 April 2018, the last trading day before the announcement).
eq("Rice Midstream: stored as cash, read as stock", (FIX["RMP"]["stored"]["consideration"], r["consideration"]), ("cash", "stock"))
eq("Rice Midstream: $20.66 on 25 April 2018", (r["offerImplied"], r["offerImpliedDate"]), (20.66, "2018-04-25"))
# "a 9.8% premium to the closing price of RMP common units of $18.82 on such
# date": $20.66 / $18.82 = 1.0978.
eq("Rice Midstream: 9.8% over $18.82 ties", (r["premium1Day"], r["unaffectedPriceStated"], r["premiumTie"]), (0.098, 18.82, "tied to the whole offer"))

# ── a price read that is the package's value (TESCO) ─────────────────────────

t = rows["TESCO"]
# "each Common Share ... will be exchanged for 0.68 of a common share of
# Nabors"; "The Arrangement values the Common Shares at $4.62 per share based on
# Nabors' closing share price of $6.80 on the New York Stock Exchange on August
# 11, 2017 (the last trading day on the NYSE prior to execution of the
# Arrangement Agreement)": 0.68 x $6.80 = $4.624. The $4.62 read as the price
# ("the implied offer price of $4.62") is that value, not cash.
eq("TESCO: the $4.62 read stays the row's price", t["offerPrice"], 4.62)
eq("TESCO: and is the value the filing states for 11 August 2017", (t["offerImplied"], t["offerImpliedMethod"], t["offerImpliedDate"]), (4.62, "stated", "2017-08-11"))
eq("TESCO: 0.68 x $6.80 = $4.624, so the stock alone makes it up: paid in stock", (t["consideration"], "0.68 x $6.80 = $4.6240" in t["offerImpliedBasis"]), ("stock", True))
eq("TESCO: the price read is labelled as the package's value, not cash", [c["part"] for c in t["offerComponents"]][:1], ["price read"])
eq("TESCO: no longer unresolved", t.get("offerUnresolved"), None)
# "This represents a premium of 19% to TESCO's closing share price on the NASDAQ
# Stock Market on the same date": the date the sentence before gives, the day
# the package is valued. The proxy's table states TESCO's close that day,
# $3.90: $4.62 / $3.90 = 1.1846, inside two points of 19%.
nineteen = [s for s in t["_statements"] if s["premium"] == 0.19]
eq("TESCO: the 19% is kept, measured on 11 August 2017, the day the package is valued", [(s["basis"], s["date"]) for s in nineteen], [("close", "2017-08-11")])
# The proxy also carries Nabors' capped calls, "an approximately 75.0% premium
# over our share price of $17.97": another instrument's terms, which #187 sets
# aside. With the deal's own statement alone, the 19% ties.
own = copy.deepcopy(FIX["TESCO"]["stored"])
filings.resolve_offer(own, [d["url"] for d in FIX["TESCO"]["documents"]], [d["text"] for d in FIX["TESCO"]["documents"]], reread=True)
filings.apply_premiums(own, nineteen, [], [d["text"] for d in FIX["TESCO"]["documents"]])
eq("TESCO: its own 19% premium ties to the whole offer", (own["premium1Day"], own["unaffectedDate"], own["premiumTie"]), (0.19, "2017-08-11", "tied to the whole offer"))
eq("TESCO: the capped call's 75%, measured on no stated day, cannot tie and says so", (t["premium1Day"], (t["premiumTie"] or "").startswith("untied: the premium is measured to no stated day")), (0.75, True))

# ── a premium the filing measures on another value of the package ────────────

s = rows["SCTY"]
# "Based on the closing price of Tesla Common Stock on NASDAQ on June 21, 2016,
# the last full trading day before public announcement of the proposed Merger,
# the 0.110 Exchange Ratio represented approximately $24.16 in value". The
# proxy's "premium of approximately 20% based on the unaffected closing price
# per share of SolarCity Common Stock of $21.19 on June 21, 2016" measures
# $21.19 x 1.20 = $25.43, the package at the agreement, not the $24.16 of that
# day ($24.16 / $21.19 = 1.1402). The filing's own unaffected premium stands,
# untied, and the row says why; it is not withdrawn.
eq("SolarCity: $24.16 on 21 June 2016", (s["offerImplied"], s["offerImpliedDate"]), (24.16, "2016-06-21"))
eq("SolarCity: the 20% unaffected premium stands", (s["premium1Day"], s["unaffectedDate"]), (0.2, "2016-06-21"))
eq("SolarCity: untied, and the row says it measures $25.43, not $24.16", (s["premiumTie"] or "").startswith("untied: the premium measures $25.43 a share ($21.19 plus 20.0%), not the offer of $24.16"), True)
eq("SolarCity: the stated price that does not reproduce is not kept as the unaffected price", s["unaffectedPriceStated"], None)

# ── a mixed package: the stock's value is not the whole ──────────────────────

y = rows["TAYC"]
# "the per share stock consideration to be issued at the 0.64318 exchange ratio
# represented approximately $18.12 in value ..., which, when added to the $4.08
# per share cash merger consideration, equated to approximately $22.20 in value
# for each share": $4.08 + $18.12 = $22.20, the filing's own sum.
eq("Taylor Capital: the $18.12 is the stock part, kept as such", [(c["value"], c.get("of")) for c in stated(y) if c["value"] == 18.12], [(18.12, "stock")])
eq("Taylor Capital: the whole offer is the $22.20 the filing adds up", (y["offerImplied"], y["offerImpliedDate"], y["consideration"]), (22.2, "2013-07-12", "cash and stock"))
# "represented a premium of approximately 24.6% over the $17.81 closing price of
# Taylor Capital common stock on July 12, 2013": $22.20 / $17.81 = 1.2465.
eq("Taylor Capital: 24.6% over $17.81 now ties", (y["premium1Day"], y["unaffectedPriceStated"], y["premiumTie"]), (0.246, 17.81, "tied to the whole offer"))

# ── unresolved: nothing made up ──────────────────────────────────────────────

c = rows["CTRA"]
# "Based on the closing price of Devon Common Stock on the New York Stock
# Exchange on March 27, 2026, the last practicable trading day before the date
# of this joint proxy statement/prospectus, ..." $36.45: the proxy's own day,
# seven weeks after the agreement of 1 February 2026, never the offer.
eq("Coterra: a value stated only at the practicable date gives no whole offer", c.get("offerImplied"), None)
eq("Coterra: the row says so, naming it", "only at 2026-03-27: $36.45" in (c.get("offerUnresolved") or ""), True)
eq("Coterra: the exchange ratio of 0.70 is kept", any(x.get("exchangeRatio") == 0.7 for x in c["offerComponents"]), True)
eq("Coterra: its premium stands as the filing states it, untied", (c["premium1Day"], (c["premiumTie"] or "").startswith("untied: the offer is unresolved")), (0.12, True))

a = rows["ARCH"]
# "will be converted into the right to receive 1.326 shares of CONSOL common
# stock". The only close of CONSOL the proxy states is in Moelis' has/gets
# analysis ("the closing trading price of the CONSOL common stock of $95.81 per
# share on August 19, 2024"), and no value for the package: 1.326 x $95.81 =
# $127.04 is never worked here.
eq("Arch: the ratio is stated", [x.get("exchangeRatio") for x in a["offerComponents"] if x.get("exchangeRatio")], [1.326])
eq("Arch: no value stated, nothing computed from an adviser's price", (a.get("offerImplied"), "nor multiplies the exchange ratio" in (a.get("offerUnresolved") or "")), (None, True))
eq("Arch: the premium on file stands, untied", (a["premium1Day"], (a["premiumTie"] or "").startswith("untied: the offer is unresolved")), (0.103, True))

# ── the pure reader, on wordings ─────────────────────────────────────────────

eq("a deal with no cash price and no stock is left with nothing", parse.read_stock_offer(["The holders will be paid in full at closing."]), {**parse.read_stock_offer([]), "components": []})
cash = {"offerPrice": None, "consideration": "cash", "status": "no-offer"}
filings.resolve_offer(cash, ["u"], ["The holders will be paid in full at closing."])
eq("and its row gains no offer fields", sorted(k for k in cash if k.startswith("offer")), ["offerPrice", "offerReader"])
ratio_only = "each share will be converted into the right to receive 0.5000 of a share of Acquirer common stock. each share will be converted into the right to receive 0.5000 of a share of Acquirer common stock."
o = parse.read_stock_offer([ratio_only], "2026-01-10")
eq("an exchange ratio with no value and no close stated: no offer, and why", (o["stock"], o["implied"], o["unresolved"]), (True, None, "the consideration is stock and the filing states its value on no day near the agreement, nor multiplies the exchange ratio by the acquirer's close"))
eq("a close multiplied with cash added is the filing's sum, not a stock product", parse.priced_values(["the closing price of XING's ordinary shares of $1.68 as of September 7, 2010, multiplied by 1.9, plus $0.80"], 1.9), [])
eq("a close in another currency is never multiplied", parse.priced_values(["the closing price of Enerflex common shares of C$7.90 on January 21, 2022, multiplied by 1.021"], 1.021), [])
eq("a product whose ratio is not the consideration's is not this deal's", parse.priced_values(["the closing price of Hess common stock of $52.78 on July 26, 2010, multiplied by the exchange ratio of 0.1500"], 0.1373), [])
msg = ("Based on the closing price of MSGE Class A common stock on the NYSE on March 10, 2021, the last full trading day before a press report speculated on a potential transaction, "
       "the exchange ratio represents approximately $19.95 in value for each share of MSGN common stock, and based on the closing price on March 25, 2021, the last full trading day "
       "before the public announcement of the signing of the merger agreement, the exchange ratio represents approximately $16.16 in value for each share of MSGN common stock. Next")
eq("two values in one sentence each take their own clause's date (MSG Networks)", sorted((v["value"], v["date"], v["day"]) for v in parse.implied_values([msg])), [(16.16, "2021-03-25", "reference"), (19.95, "2021-03-10", "dated")])
eq("a proposal's value is not the package's (Udemy)", parse.implied_values(["Based on the trading price of Coursera Common Stock as of the close of trading on November 10, 2025, the total proposed consideration implied a value of approximately $6.80 per share of Udemy Common Stock. Next"]), [])
eq("nor a bid recited in the background (Virgin Media)", parse.implied_values(["Specifically, he explained that Liberty Global was offering $12.68 in cash and a blend of 0.484 shares, which based on the closing prices of $62.96 and $58.75 as of December 31, 2012, resulted in an implied value of approximately $42.25 per share of Virgin Media common stock. Next"]), [])
# A stock package's statement "on the same date" takes the date of the sentence
# before only where that is the day the package is valued: a background
# proposal "on that date" is left as it was.
k, _ = parse.premium_statements("Based on Nabors' closing share price of $6.80 on August 11, 2017. This represents a premium of 19% to TESCO's closing share price on the same date.", None, "2017-08-13", cash_only=False, ties=[(4.62, "share")], tie_date="2017-08-11")
eq("'on the same date' is the valuation day where the sentence before names it", [x["date"] for x in k], ["2017-08-11"])
k, _ = parse.premium_statements("Based on Nabors' closing share price of $6.80 on August 10, 2017. This represents a premium of 19% to TESCO's closing share price on the same date.", None, "2017-08-13", cash_only=False, ties=[(4.62, "share")], tie_date="2017-08-11")
eq("and is left undated where it names another day", [x["date"] for x in k], [None])
# Jarden: the analysts' price target of $60.21 beside the $60.03 package is
# another figure, not the offer named.
jarden = "the average of analyst stock price targets in such research analyst reports was approximately $60.21 per share of Jarden common stock, representing a 25.5% premium to the closing price per share of Jarden common stock on the undisturbed date"
k, _ = parse.premium_statements(jarden, 21.0, "2015-12-13", cash_only=False, ties=[(60.03, "share")], tie_date="2015-12-11")
eq("a figure 0.3% from a package's value is not the package named (Jarden)", [x["namesOffer"] for x in k], [False])

# ── provenance, versions and the guard ───────────────────────────────────────

eq("every row read carries the offer reader's version", {k: r["offerReader"] for k, r in rows.items()}, {k: filings.OFFER_READER for k in rows})
eq("every component names the document it came from and the reader", all(c.get("document") in [d["url"] for d in FIX[k]["documents"]] and c.get("reader") == filings.OFFER_READER for k, r in rows.items() for c in r.get("offerComponents") or []), True)
eq("every whole offer says how it was found", all(r.get("offerImpliedBasis") for r in rows.values() if r.get("offerImplied") is not None), True)
eq("a row read by offer reader 2 is due a re-read", filings.needs_premium_reread({"premiumReader": filings.PREMIUM_READER, "announcedReader": filings.ANNOUNCED_READER, "offerReader": 2, "documentsRead": ["x"], "status": "no-offer"}), True)

base = {"TESCO": {**FIX["TESCO"]["stored"], "status": "ok", "premiumReader": 5, "announcedReader": 2}}
cur = {"TESCO": {**{k: v for k, v in rows["TESCO"].items() if not k.startswith("_")}, "status": "ok", "premiumReader": 5, "announcedReader": 2}}
guard.protect(base, cur)
rev = {x["field"]: (x["from"], x["to"], x["cause"]) for x in cur["TESCO"].get("revisions") or []}
eq("guard: TESCO's consideration moving to stock is recorded, caused by the offer reader", rev.get("consideration"), ("cash and stock", "stock", f"offerReader 2 to {filings.OFFER_READER}"))
eq("guard: and its whole offer, gained", rev.get("offerImplied"), (None, 4.62, f"offerReader 2 to {filings.OFFER_READER}"))
lost = {"XTO": {**FIX["XTO"]["stored"], "status": "no-offer", "offerImplied": 51.69, "offerReader": filings.OFFER_READER}}
now = {"XTO": {**lost["XTO"], "offerImplied": None}}
guard.protect(lost, now)
eq("guard: a whole offer lost with no reader moving is put back", now["XTO"]["offerImplied"], 51.69)

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
