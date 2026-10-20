#!/usr/bin/env python3
"""
Equity value is a price times a count in the same unit.

    python3 scripts/__tests__/precedent-ads-units.test.py

WHY THIS EXISTS
---------------
An ADS issuer's filing quotes its offer twice, per share and per ADS, and
its share count once. Equity value is offerPrice x sharesOut, so the two must
be in one unit. Before the offer reader, LAIX's price was its US$1.90 an ADS
and its count 50,173,363 Ordinary Shares: $95.3m, fourteen times too much.
After it, the price is US$0.1357 an Ordinary Share and the count still the
Ordinary Shares: $6.8m. That is right, and the filing says so twice: the
count is "50,173,363 Ordinary Shares issued and outstanding ... including (i)
30,497,689 Class A Ordinary Shares and (ii) 19,675,674 Class B Ordinary
Shares", and the cash the buyers need for the shares they do not hold is
"approximately US$1.92 million".

The count is never one of ADSs: the company facts' cover count is of shares,
and the transaction statement's count (parse_shares) is read only from a
count of ordinary or common shares. So the price must be per share, and
finalize now says which price times which count (equityValueBasis). One row
was mixed: Zhangmen, whose ADS ratio is written "seventy-two", which the
offer reader did not read; its price stayed $0.56 an ADS and its equity value
was $0.56 x 1,440m shares = $806.6m against a fee-table value of $9m. The
offer reader (version 3) reads a compound ratio, keeps a price per ADS over
the ratio to eight significant figures, keeps a per-share price the filing
states only where it comes back to the price per ADS, and takes the price
per ADS the filing states rather than a product of rounded figures. Where an
offer is quoted per ADS and no ratio is stated, there is no equity value,
and the row says why.

The fixtures are the passages of each filing around its offer, ratio, count
and premiums, as EDGAR serves them; each reads the same over the excerpt as
over the whole document. Every figure below is worked by hand.
"""

from __future__ import annotations

import copy
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))

from precedent_transactions import database, filings, parse  # noqa: E402

FIX = {d["key"]: d for d in json.loads((ROOT / "scripts" / "__tests__" / "fixtures" / "precedent-ads-units.json").read_text())}
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
    """The stored row (as the offer reader left it) read again and finalized: the offer, the premiums, the equity value."""
    d = FIX[key]
    row = copy.deepcopy(d["stored"])
    urls = [x["url"] for x in d["documents"]]
    texts = [x["text"] for x in d["documents"]]
    filings.resolve_offer(row, urls, texts, reread=True)
    statements, aside = filings.tied_statements(row, urls, texts)
    filings.apply_premiums(row, statements, aside, texts)
    return database.finalize(row)


# ── LAIX: the count is of Ordinary Shares, and so is the price ───────────────

x = read("LAIX")
text = FIX["LAIX"]["documents"][0]["text"]
eq("LAIX: the count the statement gives is of Ordinary Shares", (x["sharesOut"], x["sharesBasis"]["phrase"]), (50.173, "50,173,363 Ordinary Shares issued and outstanding"))
# 30,497,689 + 19,675,674 = 50,173,363, the two classes of Ordinary Share.
eq("LAIX: 30,497,689 Class A and 19,675,674 Class B Ordinary Shares make the 50,173,363", 30_497_689 + 19_675_674, 50_173_363)
eq("LAIX: and the filing states both classes in Ordinary Shares", "30,497,689 Class A Ordinary Shares and 19,675,674 Class B Ordinary Shares" in text, True)
# "US$0.1357 in cash per Ordinary Share" and "US$1.90 in cash per ADS", with
# "each representing fourteen Class A Ordinary Shares".
eq("LAIX: the price is US$0.1357 an Ordinary Share, as stated", (x["offerPrice"], x["offerImplied"], x["adsRatio"]), (0.1357, 0.1357, 14.0))
# $0.1357 x 14 = $1.8998, a figure the filing never gives; it states $1.90.
eq("LAIX: the offer per ADS is the US$1.90 the filing states, not $0.1357 x 14 = $1.8998", (FIX["LAIX"]["stored"]["offerPerAds"], x["offerPerAds"]), (1.8998, 1.9))
# $0.1357 x 50.173363m = $6.808m.
eq("LAIX: equity value $0.1357 x 50.173m shares = $6.8m", x["equityValue"], 6.8)
eq("LAIX: and the row says which price times which count", x["equityValueBasis"], "$0.1357 a share x 50.173m shares (stated in the transaction statement)")
# The cross-check: Merger Sub holds 16,273,054 Class A and 19,675,674 Class B;
# 50,173,363 - 35,948,728 = 14,224,635 shares, x $0.1357 = $1.930m, the
# "approximately US$1.92 million" the buyers need. In ADS terms the same:
# 14,224,635 / 14 x $1.90 = $1.930m. A count of ADSs would have needed
# 50,173,363 x $1.90 = $95.3m for the company and $27.0m for the minority.
eq("LAIX: the filing's funding need is the minority's shares at $0.1357", "approximately US$1.92 million" in text and "16,273,054 Class A Ordinary Shares and 19,675,674 Class B Ordinary Shares" in text, True)
eq("LAIX: 14,224,635 shares x $0.1357 = $1.93m, against the filing's US$1.92m", round((50_173_363 - 16_273_054 - 19_675_674) * 0.1357 / 1e6, 2), 1.93)
# $1.90 / $1.21 = 1.570: 57% over the ADS close, unchanged.
eq("LAIX: the 57% premium over the US$1.21 ADS close still ties", (x["premium1Day"], x["unaffectedPriceStated"], x["unaffectedPricePer"]), (0.57, 1.21, "ADS"))

# ── Zhangmen: the ratio written out, so the price can be per share ───────────

z = read("ZHANGMEN")
zs = FIX["ZHANGMEN"]["stored"]
# As the offer reader left it: $0.56 an ADS, no ratio, so no price per share,
# and finalize multiplied the ADS price by the count of shares.
eq("Zhangmen: the offer reader left $0.56 an ADS with no ratio", (zs["offerPrice"], zs["adsRatio"], zs["offerPerAds"], zs["offerImplied"]), (0.56, None, 0.56, None))
before = database.finalize(copy.deepcopy(zs))
eq("Zhangmen: such a row has no equity value, rather than $0.56 x 1,440.383m = $806.6m", before.get("equityValue"), None)
eq("Zhangmen: and says why", any(f.startswith("the offer is quoted per ADS and the filing states no ADS ratio") for f in before["flags"]), True)
# "American Depositary Shares, each representing seventy-two Class A Ordinary
# Shares"; "each representing seventy -two ordinary shares", as the cover
# reads once converted to text.
eq("Zhangmen: the ratio is the seventy-two the filing writes out", z["adsRatio"], 72.0)
# "$0.0077778 (representing $0.56 divided by seventy-two) per Ordinary Share":
# $0.56 / 72 = $0.00777777..., to eight significant figures $0.0077777778.
# Four decimal places would have made it $0.0078, and $0.5616 an ADS.
eq("Zhangmen: the price is $0.56 / 72 = $0.0077777778 a share", (z["offerPrice"], z["offerImplied"]), (0.0077777778, 0.0077777778))
eq("Zhangmen: the offer per ADS stays the $0.56 read", z["offerPerAds"], 0.56)
# 1,245,504,866 Class A + 194,878,011 Class B = 1,440,382,877 shares;
# x $0.0077777778 = $11.203m, beside the $9m the fee table charges on the
# shares the buyers do not already hold.
eq("Zhangmen: 1,245,504,866 Class A + 194,878,011 Class B = 1,440,382,877 shares", 1_245_504_866 + 194_878_011, 1_440_382_877)
eq("Zhangmen: equity value $0.0077777778 x 1,440.383m = $11.2m, not $806.6m", z["equityValue"], 11.2)
eq("Zhangmen: no longer flagged against the fee-table value", any(f.startswith("equity value") for f in z["flags"]), False)
# The 178% is to the ADS close of 25 May 2023: the Per ADS Merger
# Consideration is what it measures, and stays.
eq("Zhangmen: the 178% and 115% premiums stand", (z["premium1Day"], z["premium30DayVwap"]), (1.78, 1.15))

# ── the rules, one at a time ─────────────────────────────────────────────────

eq("a ratio written 'seventy -two', as text conversion leaves it", parse.ads_ratio(["ADSs, each representing seventy -two ordinary shares"])[0], 72.0)
eq("and 'twenty-five' and 'fourteen' still", (parse.ads_ratio(["each ADS represents twenty-five Shares"])[0], parse.ads_ratio(["ADSs, each representing fourteen Class A ordinary shares"])[0]), (25.0, 14.0))
# Youku: "$27.60 in cash per ADS", "each representing 18 Class A Ordinary
# Shares", "one eighteenth of the Per ADS Merger Consideration" a share; the
# fee table rounds that to "$1.53 per share merger consideration", and
# $1.53 x 18 = $27.54, not $27.60. The price is $27.60 / 18 = $1.5333333.
youku = [
    "each ADS ... will be cancelled in exchange for the right to receive $27.60 in cash per ADS without interest (the \"Per ADS Merger Consideration\"). "
    "American Depositary Shares, each representing 18 Class A Ordinary Shares. $27.60 in cash per ADS.",
    "the difference between the $1.53 per share merger consideration and the weighted average exercise price of $0.71 per share",
]
o = parse.read_offer(youku, 27.6, "$27.60 in cash per ADS")
eq("Youku: a rounded per-share figure that does not come back to the ADS price is not the price", (o["perShare"][0], o["perAds"]), (1.5333333, 27.6))
# A row the offer reader has not read is judged by its own phrase.
eq("a row not yet read by the offer reader, priced per ADS, has no equity value", database.finalize({"status": "ok", "offerPrice": 1.9, "offerBasis": "US$1.90 in cash per ADS", "sharesOut": 50.173, "flags": []}).get("equityValue"), None)
eq("and one priced per share keeps it", database.finalize({"status": "ok", "offerPrice": 0.1357, "offerBasis": "US$0.1357 in cash per Ordinary Share", "sharesOut": 50.173, "flags": []}).get("equityValue"), 6.8)

# ── the version ──────────────────────────────────────────────────────────────

# Version 3 is this rule; 4 adds the all-stock offer (#195) and 5 the
# holding company's share exchange (#188), so a row read under 3 is read
# again too.
eq("the offer reader is version 5", filings.OFFER_READER, 5)
eq("a row read under version 3 is due a re-read", filings.needs_premium_reread({"premiumReader": filings.PREMIUM_READER, "announcedReader": filings.ANNOUNCED_READER, "offerReader": 3, "documentsRead": ["x"], "status": "ok"}), True)
eq("a row read under version 2 is due a re-read", filings.needs_premium_reread({"premiumReader": filings.PREMIUM_READER, "announcedReader": filings.ANNOUNCED_READER, "offerReader": 2, "documentsRead": ["x"], "status": "ok"}), True)

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
