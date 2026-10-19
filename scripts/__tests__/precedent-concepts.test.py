#!/usr/bin/env python3
"""
The target's financials at announcement, from the concepts it actually filed.

    python3 scripts/__tests__/precedent-concepts.test.py

WHY THIS EXISTS
---------------
Five real deals had no revenue multiple, or no EBITDA multiple, because the
collector's concept list missed the lines their targets filed under:

  WGL, Delta Natural Gas     RegulatedAndUnregulatedOperatingRevenue
  Snyder's-Lance, Mead       SalesRevenueGoodsNet (net sales, before 2018)
  Johnson
  El Paso Electric, WGL      UtilitiesOperatingExpenseDepreciationAndAmortization

and WGL's EBITDA added operating income to the quarter to D&A to the fiscal
year, three months apart. The fixtures are each target's own company facts as
EDGAR serves them, cut to the concepts read and the three years before the
deal. Every multiple below is worked by hand from the figures in the comment.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))

from precedent_transactions import database, filings  # noqa: E402

FIX = json.loads((ROOT / "scripts" / "__tests__" / "fixtures" / "precedent-concepts.json").read_text())
BY = {f["cik"].zfill(10): f for f in FIX}
filings.fetch_json = lambda url: BY[url.split("CIK")[1].split(".json")[0]]["companyfacts"]  # no network

passed = failed = 0


def eq(name, got, want):
    global passed, failed
    ok = got == want
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + ("" if ok else f" — got {got!r}, want {want!r}"))
    if ok:
        passed += 1
    else:
        failed += 1


OFFER = {"EL PASO ELECTRIC": 68.25, "SNYDER": 50.0, "DELTA NATURAL": 30.5, "MEAD JOHNSON": 90.0, "WGL": 88.25}


def row(key: str) -> dict:
    f = next(x for x in FIX if x["key"] == key)
    fin = filings.financials_at(f["cik"], f["announced"])
    r = {"id": f["id"], "status": "ok", "source": "DEFM14A", "target": {"name": f["name"], "cik": f["cik"]}, "offerPrice": OFFER[key], "consideration": "cash", "announced": f["announced"], "filed": f["announced"], "acquirerBasis": "x", "acquirer": None}
    r.update({k: v for k, v in fin.items() if k in filings.FINANCIAL_FIELDS})
    return database.finalize(r)


# El Paso Electric: $68.25 x 40.738m = $2,780.4m; + net debt $1,314.2m = EV $4,094.6m.
# LTM to Q1 2019: total operating revenue (Revenues) $902.3m, of which $898.1m
# is contract revenue; operating income + utility D&A = $270.2m.
e = row("EL PASO ELECTRIC")
eq("El Paso Electric: EBITDA from the utility D&A concept, the same twelve months as operating income", (e["ltmEbitda"], e["ltmEbitdaEnd"]), (270.2, "2019-03-31"))
eq("El Paso Electric: revenue is the $902.3m total the filing tags as Revenues, not the $898.1m of it from contracts", (e["ltmRevenue"], e["revenueTag"]), (902.3, "us-gaap:Revenues"))
eq("El Paso Electric: EV $4,094.6m / revenue $902.3m = 4.54x; / EBITDA $270.2m = 15.15x", (e["ev"], e["evLtmRev"], e["evLtmEbitda"]), (4094.6, 4.54, 15.15))

# Snyder's-Lance: $50.00 x 97.455m = $4,872.8m; + $1,096.5m = EV $5,969.3m.
# Net sales (SalesRevenueGoodsNet) LTM to Q3 2017 $2,123.4m; EBITDA $136.0m after
# a tagged impairment of $116.2m in the same twelve months.
s = row("SNYDER")
eq("Snyder's-Lance: revenue read from SalesRevenueGoodsNet", (s["ltmRevenue"], s["revenueTag"]), (2123.4, "us-gaap:SalesRevenueGoodsNet"))
eq("Snyder's-Lance: EV $5,969.3m / $2,123.4m = 2.81x", (s["ev"], s["evLtmRev"]), (5969.3, 2.81))
eq("Snyder's-Lance: $5,969.3m / EBITDA $136.0m = 43.89x, on EBITDA after $116.2m of tagged impairments", (s["evLtmEbitda"], s["ltmImpairment"]), (43.89, 116.2))
eq("Snyder's-Lance: the impairment is 85% of EBITDA, so the row says so and the EBITDA multiple is in doubt", (any("tagged impairment of 116.2 (85%)" in x for x in s["flags"]), "ebitda" in s["doubt"], "multiples" in s["doubt"]), (True, True, False))

# Delta Natural Gas: $30.50 x 7.124m = $217.3m; + $41.6m = EV $258.9m.
d = row("DELTA NATURAL")
eq("Delta Natural Gas: regulated and unregulated operating revenue, $66.5m", (d["ltmRevenue"], d["revenueTag"]), (66.5, "us-gaap:RegulatedAndUnregulatedOperatingRevenue"))
eq("Delta Natural Gas: EV $258.9m / $66.5m = 3.89x; / EBITDA $19.0m = 13.63x", (d["ev"], d["evLtmRev"], d["evLtmEbitda"]), (258.9, 3.89, 13.63))

# Mead Johnson: $90.00 x 184.723m = $16,625.1m; + $1,184.7m = EV $17,809.8m.
m = row("MEAD JOHNSON")
eq("Mead Johnson: net sales for FY2016, $3,742.7m", (m["ltmRevenue"], m["ltmRevenueEnd"]), (3742.7, "2016-12-31"))
eq("Mead Johnson: EV $17,809.8m / $3,742.7m = 4.76x", (m["ev"], m["evLtmRev"]), (17809.8, 4.76))
eq("Mead Johnson: no operating income tagged in the window, so no EBITDA is made up", (m.get("ltmEbitda"), m.get("evLtmEbitda")), (None, None))

# WGL: $88.25 x 51.187m = $4,517.3m; + $1,422.4m = EV $5,939.7m.
# Operating income to December 2016 + utility D&A to December 2016 = $423.9m.
# The earlier reading added total D&A to September 2016 and got $420.1m.
w = row("WGL")
eq("WGL: revenue $2,345.7m from the regulated and unregulated concept", w["ltmRevenue"], 2345.7)
eq("WGL: EBITDA $423.9m, both pieces to 31 December 2016", (w["ltmEbitda"], w["ltmEbitdaEnd"], "UtilitiesOperatingExpenseDepreciationAndAmortization" in w["ebitdaBasis"]), (423.9, "2016-12-31", True))
eq("WGL: EV $5,939.7m / $2,345.7m = 2.53x; / $423.9m = 14.01x", (w["ev"], w["evLtmRev"], w["evLtmEbitda"]), (5939.7, 2.53, 14.01))

# The fallback is a fallback: a company that tags its total under a usual
# concept is never read from a part of it.
fake = {"entityName": "Both Inc", "facts": {"us-gaap": {
    "Revenues": {"units": {"USD": [{"start": "2023-01-01", "end": "2023-12-31", "val": 1000e6, "form": "10-K", "filed": "2024-02-01", "fy": 2023, "fp": "FY", "accn": "a"}]}},
    "SalesRevenueGoodsNet": {"units": {"USD": [{"start": "2023-01-01", "end": "2023-12-31", "val": 600e6, "form": "10-K", "filed": "2024-02-01", "fy": 2023, "fp": "FY", "accn": "a"}]}},
}}}
filings.fetch_json = lambda url: fake
f = filings.financials_at("0000000099", "2024-03-01")
eq("a company tagging total revenue and goods sales is read at its total, $1,000m, never the $600m part", (f["ltmRevenue"], f["revenueTag"]), (1000.0, "us-gaap:Revenues"))

# A year-to-date period ending 29 February (Lennar's quarter, 2016) is matched
# to the prior year's without a calendar error.
leap = {"entityName": "Leap Inc", "facts": {"us-gaap": {
    "Revenues": {"units": {"USD": [
        {"start": "2014-12-01", "end": "2015-11-30", "val": 1000e6, "form": "10-K", "filed": "2016-01-20", "fy": 2015, "fp": "FY", "accn": "a"},
        {"start": "2014-12-01", "end": "2015-02-28", "val": 200e6, "form": "10-Q", "filed": "2016-04-01", "fy": 2016, "fp": "Q1", "accn": "b"},
        {"start": "2015-12-01", "end": "2016-02-29", "val": 260e6, "form": "10-Q", "filed": "2016-04-01", "fy": 2016, "fp": "Q1", "accn": "b"},
    ]}},
}}}
filings.fetch_json = lambda url: leap
f = filings.financials_at("0000000098", "2016-05-01")
eq("a quarter ending 29 February: LTM revenue $1,000m + $260m - $200m = $1,060m", (f["ltmRevenue"], f["ltmRevenueEnd"]), (1060.0, "2016-02-29"))

# A stored row read again: what the reader owns is replaced, a withdrawn
# EBITDA included, and a share count stated in the transaction statement stands.
stored = {"id": "s", "status": "ok", "offerPrice": 10.0, "announced": "2024-03-01", "target": {"cik": "0000000099"},
          "ltmEbitda": 55.0, "ebitdaBasis": "operating income to 2023-09-30 + D&A to 2023-12-31", "sharesOut": 12.0, "statedShares": 12.0, "statedSharesBasis": "12,000,000 shares outstanding on the record date"}
original = filings.financials_at
filings.financials_at = lambda cik, asof: {"ltmRevenue": 1000.0, "revenueTag": "us-gaap:Revenues", "ltmRevenueEnd": "2023-12-31", "sharesOut": None, "forms": ["10-K"]}
again = filings.reread_financials(dict(stored))
filings.financials_at = original
eq("re-read: the revenue is the new reader's", (again["ltmRevenue"], again["revenueTag"]), (1000.0, "us-gaap:Revenues"))
eq("re-read: an EBITDA the new reader cannot support is withdrawn, not left standing", (again["ltmEbitda"], again["ebitdaBasis"]), (None, None))
eq("re-read: the share count the transaction statement gives stands where the facts carry none", (again["sharesOut"], again["sharesBasis"]["tag"]), (12.0, "stated in the transaction statement"))
eq("re-read: the row records the reader and is not due again", (again["financialsReader"], filings.needs_financials_reread(again)), (filings.FINANCIALS_READER, False))

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
