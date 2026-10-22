#!/usr/bin/env python3
"""
Another company's share exchange into a holding company is not the target's consideration.

    python3 scripts/__tests__/precedent-holdco.test.py

WHY THIS EXISTS
---------------
ASE bought Siliconware (SPIL) through a holding company formed for the deal,
ASE Industrial Holding ("HoldCo"). Siliconware's holders were paid cash,
NT$51.2 a share and the US dollar equivalent of NT$256 an ADS of five shares;
ASE's own holders swapped each ASE share for 0.5 of a HoldCo share. The offer
reader took that 0.5 for stock in Siliconware's package: the 2016 row read as
"cash and stock", its offer unresolved and its premium untied.

The rule against it already passed over one wording ("each ASE share ...
(including ASE's treasury shares), will be transferred to HoldCo"), but the
13E-3 states the exchange three other ways: "each outstanding common share,
par value NT$10 per share, of ASE ... will be exchanged for the right to
receive 0.5 common shares ... of HoldCo", "Each ASE common share will be
exchanged for 0.5 HoldCo common share", and "all of ASE's issued and
outstanding shares to be exchanged for ... common shares of HoldCo at an
exchange ratio of each ASE common share for 0.5 HoldCo common share".

The offer reader (version 5) knows the target's name. A ratio paid in a
holding company's shares, for shares the sentence names as another company's
(not "the Company", the target's own name, a word of it or its initials),
is that company's share exchange and not the target holders' consideration.
A target whose own holders receive the holding company's shares keeps the
ratio. A re-read that finds no stock puts back the cash the offer reader had
called cash and stock, where no document says the consideration is mixed.

The fixture is the passages of Siliconware's real 13E-3 and its exhibit
(a)(1) around the offer, the ADS ratio, the premiums and every statement of
the HoldCo exchange, as EDGAR serves them; it reads the same over the excerpt
as over the whole 614,000 characters. Every figure is worked by hand.
"""

from __future__ import annotations

import copy
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))

from precedent_transactions import filings, parse  # noqa: E402

FIX = {d["key"]: d for d in json.loads((ROOT / "scripts" / "__tests__" / "fixtures" / "precedent-holdco.json").read_text())}
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
    """The stored row (as the offer reader left it) read again: the offer, then the premiums tied to it."""
    d = FIX[key]
    row = copy.deepcopy(d["stored"])
    urls = [x["url"] for x in d["documents"]]
    texts = [x["text"] for x in d["documents"]]
    filings.resolve_offer(row, urls, texts, reread=True)
    statements, aside = filings.tied_statements(row, urls, texts)
    filings.apply_premiums(row, statements, aside, texts)
    return row


TARGET = "SILICONWARE PRECISION INDUSTRIES CO LTD"

# ── Siliconware ──────────────────────────────────────────────────────────────

stored = FIX["SPIL"]["stored"]
s = read("SPIL")
texts = [x["text"] for x in FIX["SPIL"]["documents"]]
eq("Siliconware: the offer reader left the row as cash and stock", stored["consideration"], "cash and stock")
eq("Siliconware: no document says the consideration is mixed", any(parse.mixed_consideration(t) for t in texts), False)
eq("Siliconware: the 0.5 is ASE's exchange into HoldCo, not Siliconware's consideration", parse.stock_terms(texts, 51.2, TARGET)["ratio"], None)
eq("Siliconware: without the target's name the ratio is still read, as before", parse.stock_terms(texts, 51.2)["ratio"][0], 0.5)
eq("Siliconware: the row is cash again", s["consideration"], "cash")
eq("Siliconware: no stock part among the offer's components", any(c["part"] == "stock" for c in s["offerComponents"]), False)
# "the right to receive NT$51.2 per Share in cash", and each ADS "representing
# five Shares" the "equivalent of NT$256 (representing five times the Final
# Per Share Consideration)": NT$51.2 x 5 = NT$256.
eq("Siliconware: the offer is the NT$51.2 a share in cash, resolved", (s["offerPrice"], s["offerImplied"], s["offerImpliedMethod"], s.get("offerUnresolved")), (51.2, 51.2, "cash", None))
eq("Siliconware: five shares an ADS, NT$51.2 x 5 = NT$256 an ADS, as the filing states", (s["adsRatio"], s["offerPerAds"]), (5.0, 256.0))
# "the Original Per Share Consideration [NT$55] and the Original Per ADS
# Consideration represent a premium of 8.9% and 12.3%, respectively, over the
# closing price of NT$50.5 per Share and $7.52 per ADS": NT$55 / NT$50.5 =
# 1.089. The premium names the agreed consideration, so it stands, unchanged.
eq("Siliconware: the 8.9% premium is unchanged", (stored["premium1Day"], s["premium1Day"]), (0.089, 0.089))
eq("Siliconware: and is now tied to the whole offer", s["premiumTie"], "tied to the whole offer")

# ── whose shares, one wording at a time ──────────────────────────────────────

for name, sentence in (
    ("each outstanding common share ... of ASE",
     "each outstanding common share, par value NT$10 per share, of ASE (the “ASE Common Shares”), including ASE Common Shares represented by American Depositary Shares, will be exchanged for the right to receive 0.5 common shares, par value NT$10 per share, of HoldCo."),
    ("Each ASE common share",
     "Therefore, its net book value per common share was NT$19.956. Each ASE common share will be exchanged for 0.5 HoldCo common share resulting in 3,959,136,448 HoldCo common shares as of the share exchange record date."),
    ("all of ASE's issued and outstanding shares",
     "it shall be fair and reasonable for all of ASE’s issued and outstanding shares to be exchanged for and in consideration of newly issued common shares of HoldCo at an exchange ratio of each ASE common share for 0.5 HoldCo common share resulting in ASE to become a wholly-owned subsidiary of HoldCo."),
):
    eq(f"ASE's exchange ({name}) is not Siliconware's consideration", parse.stock_terms([sentence, sentence], 51.2, TARGET)["ratio"], None)
# "holding company" in words is a holding company too. (The pattern is
# _HOLDCO_SHARES: the buyer-type pattern of the same old name, _HOLDCO,
# shadowed it, reads Holdco but not "holding company".)
hc = "each ordinary share of Alpha Group will be exchanged for the right to receive 0.5 ordinary shares of the new holding company."
eq("another company's exchange into 'the new holding company' is not the target's consideration", parse.stock_terms([hc, hc], None, "Beta Corp")["ratio"], None)

# ── the all-stock reading (#195) passes over the same exchange ──────────────

# With no cash price the offer reader reads the deal as one paid in stock
# (parse.read_stock_offer). ASE's 0.5 HoldCo share must never become that
# reading's consideration: with Siliconware's name there is no stock at all,
# and the row is left with no offer, as before; without it the 0.5 would be
# read as an all-stock package.
o = parse.read_offer(texts, None, None, "2016-06-30", None, TARGET)
eq("all-stock reading: ASE's exchange gives Siliconware no stock", (o["stock"], o["allStock"], [c for c in o["components"] if c["part"] == "stock"]), (False, False, []))
eq("all-stock reading: without the target's name the 0.5 would be read", [c.get("exchangeRatio") for c in parse.read_offer(texts, None, None, "2016-06-30", None, None)["components"] if c["part"] == "stock"], [0.5])
nocash = copy.deepcopy(stored)
nocash["offerPrice"], nocash["offerBasis"], nocash["consideration"] = None, None, None
filings.resolve_offer(nocash, [x["url"] for x in FIX["SPIL"]["documents"]], texts)
eq("all-stock reading: a row with no cash price is not made stock by ASE's exchange", (nocash.get("consideration"), nocash.get("offerImplied"), nocash.get("offerComponents")), (None, None, None))

# The target's own holders paid in the holding company's shares keep the
# ratio, however the filing names the target: as the Company, by its name, by
# a word of it or by its initials.
for name, sentence in (
    ("the Company", "each outstanding common share of the Company will be converted into the right to receive 0.75 HoldCo common shares."),
    ("its initials", "Each SPIL common share will be exchanged for the right to receive 0.75 HoldCo common shares."),
    ("a word of its name", "Each Siliconware common share will be exchanged for the right to receive 0.75 HoldCo common shares."),
):
    eq(f"the target's holders paid in HoldCo shares ({name}) keep the ratio", parse.stock_terms([sentence, sentence], 10.0, TARGET)["ratio"][0], 0.75)
# And a ratio in the acquirer's own shares, with no holding company, is read as before.
plain = "each share of Company common stock will be converted into the right to receive $10.00 in cash and 0.5000 of a share of Acquirer common stock."
eq("a ratio in the acquirer's shares, with no holding company, is read as before", parse.stock_terms([plain, plain], 10.0, TARGET)["ratio"][0], 0.5)

# ── the re-read puts the cash back only where nothing says mixed ─────────────

row = {"offerPrice": 10.0, "offerBasis": "$10.00 in cash", "consideration": "cash and stock", "announced": "2020-01-01", "announcedBasis": "merger agreement", "target": {"name": "Target Inc."}}
filings.resolve_offer(row, ["u"], ["holders will receive $10.00 in cash per share. holders will receive $10.00 in cash per share."], reread=True)
eq("a re-read that finds no stock and no mixed wording reads cash", row["consideration"], "cash")
# The document's own words for a mixed package (the "Stock Consideration"
# beside the "Cash Consideration"): the row stays cash and stock.
mixed = "$10.00 in cash (the “Cash Consideration”) and a number of shares (the “Stock Consideration”). The “Stock Consideration” is paid in Acquirer shares."
row = {"offerPrice": 10.0, "offerBasis": "$10.00 in cash", "consideration": "cash and stock", "announced": "2020-01-01", "announcedBasis": "merger agreement", "target": {"name": "Target Inc."}}
filings.resolve_offer(row, ["u"], [mixed], reread=True)
eq("one whose document says the package is mixed keeps cash and stock", (parse.mixed_consideration(mixed), row["consideration"]), (True, "cash and stock"))

# ── the version ──────────────────────────────────────────────────────────────

# 3 and 4 are #189's and #195's readers; this rule is 5 (6 adds the price
# read where the holders are paid), so a row read under either is read again.
eq("the offer reader is version 5 or later", filings.OFFER_READER >= 5, True)
eq("a row read under version 4 is due a re-read", filings.needs_premium_reread({"premiumReader": filings.PREMIUM_READER, "announcedReader": filings.ANNOUNCED_READER, "offerReader": 4, "documentsRead": ["x"], "status": "ok"}), True)
eq("a row read under version 2 is due a re-read", filings.needs_premium_reread({"premiumReader": filings.PREMIUM_READER, "announcedReader": filings.ANNOUNCED_READER, "offerReader": 2, "documentsRead": ["x"], "status": "ok"}), True)

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
