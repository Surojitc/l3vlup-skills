#!/usr/bin/env python3
"""
The premiums a merger filing states for its own deal, read from the filings
themselves.

    python3 scripts/__tests__/precedent-premiums.test.py

WHY THIS EXISTS
---------------
Until October 2026 the collector took the first "premium of N%" it met and
worked the unaffected price back from the rounded percentage. In the filings
that is often not the deal's premium at all:

  Juniper   Goldman's "illustrative premiums of 20% to 50%" read as 20%, and
            $40 / 1.2 = $33.33 stored as the unaffected price. The proxy
            states 32% over $30.22 on 8 January 2024.
  Roku      an earlier FOX proposal's 25% to the close of 26 May. The proxy
            states 34% over $119.64 on 11 June 2026.
  Walgreens 29% read, but $11.45 / 1.29 = $8.88 stored; the filing states
            $8.85 on 9 December 2024.
  Kellanova the 30-day VWAP premium (44%) was the only one read; the close
  Twitter   premium (33%, 38%) was missed and so was the price.
  Hess      an earlier exchange ratio's 10.2% to 29 September; the
            proxy's 4.9% is to 20 October, the last day before.

Those rows feed every premiums-paid median the site quotes. The fixtures here
are the passages around every "premium" in each deal's real filing, as EDGAR
serves them, so each case below is the filing's own words.
"""

from __future__ import annotations

import copy
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))

from precedent_transactions import database, filings, parse  # noqa: E402

FIX = json.loads((ROOT / "scripts" / "__tests__" / "fixtures" / "precedent-premiums.json").read_text())

passed = failed = 0


def eq(name, got, want):
    global passed, failed
    ok = got == want
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + ("" if ok else f" — got {got!r}, want {want!r}"))
    if ok:
        passed += 1
    else:
        failed += 1


def read(deal: dict) -> dict:
    """The deal read the way filings.read_documents reads it, then finalized."""
    agreed = deal["announced"]
    statements, texts = [], []
    for d in deal["documents"]:
        kept, _ = parse.premium_statements(d["text"], deal["offerPrice"], agreed, cash_only=deal["consideration"] == "cash")
        statements += kept
        texts.append(d["text"])
    c = parse.choose_premiums(statements, deal["offerPrice"], cash_only=deal["consideration"] == "cash", texts=texts)
    row = {"id": deal["id"], "status": "ok", "source": "DEFM14A", "dealType": "public merger", "target": {"name": deal["name"]}, "offerPrice": deal["offerPrice"], "announced": deal["announced"], "announcedBasis": "merger agreement", "filed": deal["announced"], "consideration": deal["consideration"], "acquirerBasis": "x", "acquirer": None}
    row.update(c)
    return database.finalize(row)


deals = {d["ticker"]: d for d in FIX}

# ── each deal, against the filing's own figures ──────────────────────────────

j = read(deals["JNPR"])
eq("Juniper: the premium to the unaffected close is the proxy's 32%, not Goldman's illustrative 20%", j["premium1Day"], 0.32)
eq("Juniper: the unaffected price is the $30.22 the proxy states, not $40 / 1.2 = $33.33", (j["unaffectedPrice"], j["unaffectedPriceMethod"], j["unaffectedDate"]), (30.22, "stated", "2024-01-08"))
eq("Juniper: $40.00 / $30.22 - 1 = 32.4%, which rounds to the stated 32%", round(40 / 30.22 - 1, 3), 0.324)
eq("Juniper: the 52-week-high premium is the list's second item, 16%", j["premium52WeekHigh"], 0.16)
eq("Juniper: a one-month VWAP is not a 30-day VWAP, so no 30-day figure is claimed", j["premium30DayVwap"], None)

r = read(deals["ROKU"])
eq("Roku: 34% to the unaffected close, not the May 26 proposal's 25%", r["premium1Day"], 0.34)
eq("Roku: the price is stated ($119.64 on 11 June 2026)", (r["unaffectedPrice"], r["unaffectedPriceMethod"], r["unaffectedDate"]), (119.64, "stated", "2026-06-11"))
eq("Roku: the unaffected 30-day VWAP premium is 26%, not an earlier proposal's 30%, 32% or 33%", r["premium30DayVwap"], 0.26)
eq("Roku: the LTM-high premium is 21%", r["premium52WeekHigh"], 0.21)
eq("Roku: cash and stock, so no reference price is worked back from the cash alone", (r.get("vwap30"), r.get("high52")), (None, None))

w = read(deals["WBA"])
eq("Walgreens: 29%, read past the $3.00 a DAP right beside the cash", w["premium1Day"], 0.29)
eq("Walgreens: $8.85 on 9 December 2024 as stated, not $11.45 / 1.29 = $8.88", (w["unaffectedPrice"], w["unaffectedPriceMethod"], w["unaffectedDate"]), (8.85, "stated", "2024-12-09"))
eq("Walgreens: $11.45 / $8.85 - 1 = 29.4%", round(11.45 / 8.85 - 1, 3), 0.294)

k = read(deals["K"])
eq("Kellanova: the close premium is read (33% over 2 August 2024), not only the VWAP's", k["premium1Day"], 0.33)
eq("Kellanova: the 30-trading-day VWAP premium stays separate, 44%", k["premium30DayVwap"], 0.44)
eq("Kellanova: the $62.98 close the filing states for the unaffected date", (k["unaffectedPrice"], k["unaffectedPriceMethod"], k["unaffectedDate"]), (62.98, "stated", "2024-08-02"))
eq("Kellanova: $83.50 / $62.98 - 1 = 32.6%, within two points of the stated 33%", round(83.5 / 62.98 - 1, 3), 0.326)

t = read(deals["TWTR"])
eq("Twitter: 38% to the 1 April 2022 close, not the 30-day VWAP's 51%", (t["premium1Day"], t["premium30DayVwap"]), (0.38, 0.51))
eq("Twitter: $39.31 on 1 April 2022, read where the filing states it", (t["unaffectedPrice"], t["unaffectedDate"]), (39.31, "2022-04-01"))
eq("Twitter: Mr Musk's 54% to the day before he began buying is not a close the proxy defines", t["premium1Day"] != 0.54, True)

a = read(deals["AGR"])
eq("Avangrid: 11.4% to the 6 March 2024 close, two months before the agreement", (a["premium1Day"], a["unaffectedPrice"], a["unaffectedDate"]), (0.114, 32.08, "2024-03-06"))
eq("Avangrid: 15.2% to the thirty (30) trading day VWAP", a["premium30DayVwap"], 0.152)

h = read(deals["HES"])
eq("Hess: 4.9% to the 20 October 2023 close, the last day before the agreement, not the 10.2% the background quotes for 29 September", (h["premium1Day"], h["unaffectedDate"]), (0.049, "2023-10-20"))
eq("Hess: all stock, so no price is taken from elsewhere in the filing ($166.83 is Chevron's close that day)", (h.get("unaffectedPrice"), h.get("unaffectedPriceMethod")), (None, None))
eq("Hess: the 10.3% to the 20-day average stays out of the one-day figure", h["premium1Day"] != 0.103, True)

g = read(deals["KLG"])
eq("WK Kellogg: 36.0% to $16.91 on 8 July 2025, and 40% to the 30-day VWAP", (g["premium1Day"], g["unaffectedPrice"], g["premium30DayVwap"]), (0.36, 16.91, 0.40))

b = read(deals["BWMN"])
eq("Bowman: 58% to the $27.23 close of 7 August 2026, read past the VWAP list that follows it", (b["premium1Day"], b["unaffectedPrice"], b["unaffectedDate"]), (0.58, 27.23, "2026-08-07"))
eq("Bowman: '57%, 48% and 44% ... the 30-, 60- and 90-day, respectively': 57% is the 30-day VWAP", b["premium30DayVwap"], 0.57)
eq("Bowman: $43.00 / $27.23 - 1 = 57.9%", round(43 / 27.23 - 1, 3), 0.579)

mm = read(deals["MMLP"])
eq("Martin Midstream: 34% to the $3.00 close before Parent's initial offer of 24 May 2024, four months before the agreement", (mm["premium1Day"], mm["unaffectedPrice"], mm["unaffectedDate"]), (0.34, 3.0, "2024-05-24"))
eq("Martin Midstream: $4.02 / $3.00 - 1 = 34.0%", round(4.02 / 3.00 - 1, 3), 0.34)

cb = read(deals["CBMG"])
eq("Cellular Biomedicine: 4% to the 52-week high, not the 79.9% to the 52-week low beside it", cb["premium52WeekHigh"], 0.04)

ch = read(deals["CHYR"])
eq("ChyronHego: 4% to the 14 November 2014 close, the Merger Consideration's own, not 230% to a close twenty months before", (ch["premium1Day"], ch["unaffectedDate"]), (0.04, "2014-11-14"))
eq("ChyronHego: $2.71 stated; $2.82 / $2.71 - 1 = 4.1%", (ch["unaffectedPrice"], round(2.82 / 2.71 - 1, 3)), (2.71, 0.041))

# A revised deal, read the way the collector re-reads a stored row: dated by
# the filing, re-dated by the agreement whose terms it records.
ad = deals["ADSW"]
stored = {"id": ad["id"], "status": "ok", "source": "DEFM14A", "dealType": "public merger", "target": {"name": ad["name"]}, "offerPrice": ad["offerPrice"],
          "announced": ad["filed"], "announcedBasis": "filing date", "filed": ad["filed"], "consideration": ad["consideration"], "acquirerBasis": "x", "acquirer": None,
          "documentsRead": [d["url"] for d in ad["documents"]], "financialsReader": 2}
texts = {d["url"]: d["text"] for d in ad["documents"]}
real_fetch, real_text = filings.fetch, filings.to_text
filings.fetch, filings.to_text = (lambda url, **kw: texts[url]), (lambda raw: raw)
adsw = database.finalize(filings.reread_premiums(copy.deepcopy(stored)))
filings.fetch, filings.to_text = real_fetch, real_text
eq("Advanced Disposal: the $30.30 is Amendment No. 1's of 24 June 2020, not the filing date's 24 July", (adsw["announced"], adsw["announcedBasis"]), ("2020-06-24", "amended merger agreement"))
eq("Advanced Disposal: the first agreement, at $33.15, is kept as announcedOriginal (14 April 2019)", adsw["announcedOriginal"], "2019-04-14")
eq("Advanced Disposal: the filing's unaffected day stays the record: 12 April 2019, 11.6%", (adsw["unaffectedDate"], adsw["premium1Day"]), ("2019-04-12", 0.116))
eq("Advanced Disposal: 24 June 2020 - 12 April 2019 = 439 days", adsw["unaffectedGapDays"], 439)
eq("Advanced Disposal: flagged long-unaffected-window, its premiums in doubt", (any(f.startswith("long-unaffected-window") for f in adsw["flags"]), "premiums" in adsw["doubt"]), (True, True))
eq("Advanced Disposal: re-dated, so its financials are due to be read at the new date", "financialsReader" in adsw, False)

# The gap and the flag on their own.
row = database.finalize({"id": "g", "status": "ok", "source": "DEFM14A", "target": {"name": "G"}, "offerPrice": 20.0, "consideration": "cash", "premium1Day": 0.25, "unaffectedDate": "2024-01-02", "announced": "2024-04-05", "announcedBasis": "merger agreement", "filed": "2024-05-01", "acquirerBasis": "x", "acquirer": None})
eq("gap: 5 April 2024 - 2 January 2024 = 94 days, over 90, so flagged", (row["unaffectedGapDays"], any(f.startswith("long-unaffected-window") for f in row["flags"])), (94, True))
row = database.finalize({"id": "h", "status": "ok", "source": "DEFM14A", "target": {"name": "H"}, "offerPrice": 20.0, "consideration": "cash", "premium1Day": 0.25, "unaffectedDate": "2024-01-06", "announced": "2024-04-05", "announcedBasis": "merger agreement", "filed": "2024-05-01", "acquirerBasis": "x", "acquirer": None})
eq("gap: 90 days exactly is not flagged, and nothing is put in doubt", (row["unaffectedGapDays"], row["flags"], row["doubt"]), (90, [], []))

# The premium to the last close before the announcement, kept as its own basis.
text = ("The Merger Consideration represents a premium of approximately 45% over the unaffected closing price on January 5, 2024, the last trading day prior to the public disclosure of Parent's initial proposal. "
        "The Merger Consideration represents a premium of approximately 12% over the closing price on April 4, 2024, the last trading day before the announcement of the merger agreement.")
kept, _ = parse.premium_statements(text, 20.0, "2024-04-05")
c = parse.choose_premiums(kept, 20.0, cash_only=True)
eq("the unaffected premium stays the filing's own (45% to 5 January); 12% to 4 April is premiumPreAnnouncement", (c["premium1Day"], c["unaffectedDate"], c["premiumPreAnnouncement"], c["premiumPreAnnouncementDate"]), (0.45, "2024-01-05", 0.12, "2024-04-04"))

# ── the rules, one sentence at a time ────────────────────────────────────────

kept, aside = parse.premium_statements("Using this analysis, Goldman Sachs applied a reference range of illustrative premiums of 20% to 50% to the undisturbed closing price per share of $30.22.", 40.0, "2024-01-09")
eq("an adviser's illustrative range is set aside and says why", ([s["premium"] for s in kept], [x["reason"] for x in aside]), ([], ["a range", "a range"]))

kept, aside = parse.premium_statements("The premiums paid in such transactions represented a median of 43% with respect to one-day premiums to unaffected prices.", 11.45, "2025-03-06")
eq("a median of comparable deals is an adviser's analysis, not this deal's premium", ([s["premium"] for s in kept], [x["reason"] for x in aside]), ([], ["a financial adviser's analysis"]))

text = ("The May 15 Proposal implied a premium of approximately 22% to the closing stock price on May 14, 2026. "
        "The Merger Consideration represented a premium of approximately 34% to the unaffected closing price of $119.64 as of June 11, 2026 (the last trading day prior to the publication of a press report).")
kept, _ = parse.premium_statements(text, None, "2026-06-14")
c = parse.choose_premiums(kept, None, cash_only=False)
eq("an earlier proposal's premium ranks below the statement the proxy calls unaffected", (c["premium1Day"], c["unaffectedPriceStated"]), (0.34, 119.64))

kept, aside = parse.premium_statements("The September 23 Proposal represented a 43% premium to the $9.46 closing price on November 1, 2024.", 11.45, "2025-03-06")
eq("a premium to a close months before the agreement is another bid's, and set aside", ([s["premium"] for s in kept], len(aside)), ([], 1))

kept, _ = parse.premium_statements("The $25.00 per share represents a premium of approximately 30% over the closing price of $20.00 on May 1, 2024.", 25.0, "2024-05-02")
c = parse.choose_premiums(kept, 25.0, cash_only=True)
eq("a stated price that does not reproduce the stated premium is not used: $25.00 / $20.00 - 1 = 25%, five points from the stated 30%", c["unaffectedPriceStated"], None)
eq("and the run says why it was not used", "does not reproduce the stated premium" in (c["unaffectedPriceBasis"] or ""), True)

kept, _ = parse.premium_statements("The $26.00 per share represents a premium of approximately 30% over the closing price of $20.00 on May 1, 2024.", 26.0, "2024-05-02")
c = parse.choose_premiums(kept, 26.0, cash_only=True)
eq("$26.00 / $20.00 - 1 = 30%: the stated price is read", (c["premium1Day"], c["unaffectedPriceStated"], c["unaffectedDate"]), (0.3, 20.0, "2024-05-01"))

text = ("The Merger Consideration represents a premium of approximately 4% over the 52-week intraday high for the period ending on August 10, 2020, "
        "and a premium of approximately 79.9% over the 52-week intraday low for the period ending on August 10, 2020.")
kept, _ = parse.premium_statements(text, 19.75, "2020-08-12")
c = parse.choose_premiums(kept, 19.75, cash_only=True)
eq("Cellular Biomedicine: a premium to the 52-week low is not a premium to the high (4%, not 79.9%)", (c["premium52WeekHigh"], [s["basis"] for s in kept]), (0.04, ["high", "other"]))

row = database.finalize({"id": "x", "status": "ok", "source": "DEFM14A", "target": {"name": "X"}, "offerPrice": 13.0, "consideration": "cash", "premium1Day": 0.30, "acquirerBasis": "x", "acquirer": None, "announced": "2024-05-02", "filed": "2024-05-02"})
eq("a cash deal whose filing states only the percentage: $13.00 / 1.30 = $10.00, labelled as worked back", (row["unaffectedPrice"], row["unaffectedPriceMethod"]), (10.0, "computed from the offer and the stated premium"))
row = database.finalize({"id": "x", "status": "ok", "source": "DEFM14A", "target": {"name": "X"}, "offerPrice": 13.0, "consideration": "cash and stock", "premium1Day": 0.30, "acquirerBasis": "x", "acquirer": None, "announced": "2024-05-02", "filed": "2024-05-02"})
eq("a cash-and-stock deal: nothing is worked back from the cash alone", (row.get("unaffectedPrice"), row.get("unaffectedPriceMethod")), (None, None))

kept, _ = parse.premium_statements("Interest will accrue at 5% over the Federal Reserve discount rate. Total view time rose 20% over fiscal 2025.", 10.0, None)
eq("a percentage that is not a premium is not read", kept, [])

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
