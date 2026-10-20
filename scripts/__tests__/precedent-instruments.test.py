#!/usr/bin/env python3
"""
A premium that prices another instrument is not the deal's.

    python3 scripts/__tests__/precedent-instruments.test.py

WHY THIS EXISTS
---------------
The offer reader (#185) left TESCO's premium at 75%. TESCO was bought by
Nabors for 0.68 of a Nabors share, and its proxy carries Nabors' own annual
report, where Nabors' exchangeable notes come with capped calls: "Such
reduction and/or offset is subject to a cap representing a price per share
of $31.45, an approximately 75.0% premium over our share price of $17.97".
That is the cap on Nabors' calls over Nabors' price. The deal's own premium
is in the board's reasons: "The Arrangement values the Common Shares at
$4.62 per share ... This represents a premium of 19% to TESCO's closing
share price on the NASDAQ Stock Market on the same date".

A cap, a convertible's conversion price, a warrant's exercise or strike
price: each is set "at a premium" to a share price, and none is the premium
a buyer pays. The premium reader (version 6) sets them aside with the reason
and reads the deal's own premium where the filing states it; where it states
none, there is none. On the dry run of October 2026 the rule changed 15
rows, every one a statement about notes, preferred stock, warrants or
options (listed in the pull request).

The fixture is the passages of TESCO's real proxy around the deal's premium,
the cap, the stated value and the exchange ratio, as EDGAR serves it; it reads
the same over the excerpt as over the whole 1.9-million-character document.
Every figure below is worked by hand from the filing's own words.
"""

from __future__ import annotations

import copy
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))

from precedent_transactions import filings, parse  # noqa: E402

FIX = {d["key"]: d for d in json.loads((ROOT / "scripts" / "__tests__" / "fixtures" / "precedent-instruments.json").read_text())}
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


INSTRUMENT = "the terms of another instrument (a cap, a conversion or exercise price), not the deal's premium"

# ── TESCO ────────────────────────────────────────────────────────────────────

t = read("TESCO")
stored = FIX["TESCO"]["stored"]
# The cap: $17.97 x 1.75 = $31.4475, the $31.45 the filing states. It is
# Nabors' share price and Nabors' cap; TESCO's own close was $3.90.
eq("TESCO: the offer reader left the 75% cap as the premium, over $17.97", (stored["premium1Day"], stored["unaffectedPriceStated"]), (0.75, 17.97))
eq("TESCO: every copy of the cap statement is set aside as another instrument's terms", sum(s["reason"] == INSTRUMENT for s in t["premiumsSetAside"]), 5)
eq("TESCO: and none is kept", any(s["premium"] == 0.75 for s in t["premiumStatements"]), False)
# The deal's own: "values the Common Shares at $4.62 per share based on
# Nabors' closing share price of $6.80" (0.68 x $6.80 = $4.624), and "TESCO's
# closing share price of $3.90 on August 11, 2017": $4.62 / $3.90 = 1.1846,
# the 19% the filing states "to TESCO's closing share price ... on the same date".
eq("TESCO: the premium is the deal's own 19%", t["premium1Day"], 0.19)
eq("TESCO: the 19% states no price of its own, so none is attached", t["unaffectedPriceStated"], None)
eq("TESCO: the 19% is the statement chosen", any("premium of 19% to TESCO" in b for b in t["premiumBasis"]), True)
# 0.68 of a Nabors share and no cash. The offer reader (version 4, #195) reads
# the all-stock package at the value the filing states, $4.62 on 11 August
# 2017, the day the 19% is measured on ("on the same date"): $4.62 / $3.90 =
# 1.1846, inside two points of 19%, so the premium ties to the whole offer.
# (Before #195 the package's value was not read and the 19% stood untied.)
eq("TESCO: the package is stock (0.68 of a Nabors share), read as before", any(c.get("exchangeRatio") == 0.68 for c in t["offerComponents"]), True)
eq("TESCO: the whole offer is the $4.62 stated for 11 August 2017, paid in stock", (t["offerImplied"], t["offerImpliedDate"], t["consideration"]), (4.62, "2017-08-11", "stock"))
eq("TESCO: the 19%, measured on the day the package is valued, ties to the whole offer", (t["unaffectedDate"], t["premiumTie"]), ("2017-08-11", "tied to the whole offer"))

# ── other instruments, from the real filings the rule changed ────────────────

# Semler Scientific's proxy (Strive merger), its capped calls: $61.15 x 1.75
# = $107.01, the cap. Not the premium Strive paid.
semler = ("The strike price of the Capped Calls is $76.44, while the cap price of the Capped Calls is initially $107.01 per share, which represents a premium of 75% over "
          "the closing price of the Company’s common stock of $61.15 per share on January 23, 2025 and is subject to certain customary adjustments under the terms of the Capped Calls.")
k, a = parse.premium_statements(semler, 5.5, "2025-05-27", cash_only=False, ties=[])
eq("Semler: a capped call's cap price is another instrument's terms", ([x["premium"] for x in k], [x["reason"] for x in a]), ([], [INSTRUMENT]))
notes = "The initial conversion price of the 2030 Senior Notes represents a premium of approximately 25.0% over the last reported sale price of the Company’s common stock on the Nasdaq Capital Market on January 23, 2025."
k, a = parse.premium_statements(notes, 5.5, "2025-05-27", cash_only=False, ties=[])
eq("Semler: a convertible's conversion price is another instrument's terms", ([x["premium"] for x in k], [x["reason"] for x in a]), ([], [INSTRUMENT]))
# DevvStream: the warrants on its convertible debentures, a 20% premium on the
# 30-day VWAP. It stood as the deal's 30-day VWAP premium.
devv = ("• Each warrant will carry the right to purchase a share with an exercise price equal to the greater of (a) a 20% premium on the 30 -day VWAP and (b) the floor price of CAD$10.30. "
        "The warrants will expire 2 years after the conversion date.")
k, a = parse.premium_statements(devv, 0.5, "2026-06-01", cash_only=False, ties=[])
eq("DevvStream: a warrant's exercise price is another instrument's terms", ([x["premium"] for x in k], [x["reason"] for x in a]), ([], [INSTRUMENT]))

# ── what the rule leaves alone ───────────────────────────────────────────────

# Conversant (Alliance Data stock, with a collar on the exchange ratio): the
# collar bounds the deal's own consideration, and its premium is the deal's.
conv = ("• that the implied value of the merger consideration within the collar of $35.00 per share, represented a premium of approximately 31% to the closing price of "
        "Conversant common stock on September 10, 2014, the day prior to announcement and a 34% premium to the average closing price of Conversant’s stock for the 30 trading days ending on September 10, 2014;")
k, a = parse.premium_statements(conv, 35.0, "2014-09-11", cash_only=False, ties=[])
eq("Conversant: a collar on the deal's own consideration is not another instrument", [x["premium"] for x in k], [0.31, 0.34])
# Alcentra: "Crescent Cap Advisors" is an adviser's name, not a cap.
alc = ("the fact that the total Merger Consideration (including that portion of the Merger Consideration provided by Crescent Cap Advisors) represented a premium of approximately 36% "
       "based on the closing price of Alcentra Capital Common Stock on August 12, 2019 (which was the last full trading day before public announcement of the Transactions)")
k, a = parse.premium_statements(alc, 11.0, "2019-08-12", cash_only=False, ties=[])
eq("Alcentra: a name with Cap in it is not a cap", [x["premium"] for x in k], [0.36])

# ── the version ──────────────────────────────────────────────────────────────

eq("the premium reader is version 6", filings.PREMIUM_READER, 6)
eq("a row read under version 5 is due a re-read", filings.needs_premium_reread({"premiumReader": 5, "announcedReader": filings.ANNOUNCED_READER, "offerReader": filings.OFFER_READER, "documentsRead": ["x"], "status": "ok"}), True)

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
