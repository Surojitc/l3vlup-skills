#!/usr/bin/env python3
"""
The target's revenue, EBIT and the company facts EDGAR does not have.

    python3 scripts/__tests__/precedent-financials.test.py

WHY THIS EXISTS
---------------
A fresh ingestion of every stored deal through the October 2026 collector
found three ways the financials reader still misread a target:

  Wheeler REIT   revenue of $0.7m, the fees it tags as contract revenue, in a
                 year of $65.3m: a REIT tags its rent as lease income, and the
                 total is tagged as Revenues for the same quarters
  Arena Pharma   revenue of 0.0, though it filed $37 thousand for the twelve
                 months: one decimal of $m rounded a filed figure to nothing
  Capri          no LTM EBIT, because operating income was kept only where
                 EBITDA could not be built

and 237 rows whose company facts EDGAR answers with a 404 (a target that
filed before XBRL, or not as itself) were asked again on every monthly run.

The fixtures are each target's own company facts as EDGAR serves them, cut to
the concepts the reader reads and the years before the deal. Every figure
below is worked by hand from the filed values in the comment.
"""

from __future__ import annotations

import json
import sys
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))

from precedent_transactions import database, filings  # noqa: E402

FIX = {f["key"]: f for f in json.loads((ROOT / "scripts" / "__tests__" / "fixtures" / "precedent-financials.json").read_text())}
BY = {f["cik"].zfill(10): f for f in FIX.values()}
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


OFFER = {"WHEELER": 25.0, "CAPRI": 57.0, "ARENA": 100.0}


def row(key: str) -> dict:
    f = FIX[key]
    fin = filings.financials_at(f["cik"], f["announced"])
    r = {"id": key, "status": "ok", "source": "DEFM14A", "target": {"name": f["name"], "cik": f["cik"]}, "offerPrice": OFFER[key], "consideration": "cash", "announced": f["announced"], "filed": f["announced"], "acquirerBasis": "x", "acquirer": None}
    r.update({k: v for k, v in fin.items() if k in filings.FINANCIAL_FIELDS})
    return database.finalize(r)


# ── 1. revenue is the total ─────────────────────────────────────────────────

# Wheeler, LTM to 30 September 2022. Revenues: FY2021 $61.310m - 9M 2021
# $45.726m + 9M 2022 $49.694m = $65.278m. Contract revenue alone: $0.942m -
# $0.780m + $0.552m = $0.714m.
w = row("WHEELER")
eq("Wheeler: revenue is the $65.3m the filing tags as Revenues, not the $0.7m of fees it tags as contract revenue", (w["ltmRevenue"], w["revenueTag"], w["ltmRevenueEnd"]), (65.3, "us-gaap:Revenues", "2022-09-30"))
eq("Wheeler: so EV / revenue is the EV over $65.3m", w["evLtmRev"], round(w["ev"] / 65.3, 2))

# Capri tags no Revenues total for the period, so its contract revenue stands.
c = row("CAPRI")
eq("Capri: no Revenues total beside it, so revenue stays the contract revenue it files", (c["ltmRevenue"], c["revenueTag"]), (5488.0, "us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax"))

# ── 2. a small figure is not rounded to nothing ─────────────────────────────

# Arena, LTM to 30 September 2021: FY2020 $0.319m - 9M 2020 $0.282m + 9M 2021
# $0 = $0.037m. Its Revenues tag stops at December 2020, so it is not the total.
a = row("ARENA")
eq("Arena: revenue is the $0.037m it filed for the twelve months, never 0.0", (a["ltmRevenue"], a["revenueTag"]), (0.037, "us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax"))
eq("Arena: a revenue multiple on $37 thousand is computed and flagged, not shown as clean", (a["evLtmRev"] > 60, "multiples" in a["doubt"]), (True, True))
eq("a flow of $1m or more keeps one decimal of $m", filings._millions(65_278_000), 65.3)
eq("below $1m it keeps thousands", filings._millions(37_000), 0.037)
eq("and a filed zero is zero", filings._millions(0), 0.0)

# ── 3. EBIT stands beside EBITDA ─────────────────────────────────────────────

# Capri, LTM to 1 July 2023: operating income FY to 1 April 2023 $679m - Q1
# FY2023 $231m + Q1 FY2024 $80m = $528m; EBITDA $707m adds D&A of $179m.
eq("Capri: LTM EBIT of $528m is kept although EBITDA was built", (c["ltmEbit"], c["ltmEbitEnd"], c["ltmEbitda"]), (528.0, "2023-07-01", 707.0))
eq("Capri: EV / EBIT is the EV over $528m", c["evLtmEbit"], round(c["ev"] / 528.0, 2))
eq("Wheeler: EBIT of $19.0m beside EBITDA of $35.0m, to the same quarter end", (w["ltmEbit"], w["ltmEbitda"], w["ltmEbitEnd"], w["ltmEbitdaEnd"]), (19.0, 35.0, "2022-09-30", "2022-09-30"))

# ── 4. a period is labelled by its own dates, not its filing's ──────────────

eq("the prior-year comparative in a Q3 2022 10-Q is nine months to September 2021", filings.Filings._period({"start": "2021-01-01", "end": "2021-09-30", "fy": 2022, "fp": "Q3", "form": "10-Q"}), "3Q to 2021-09-30")
eq("a quarter is its quarter", filings.Filings._period({"start": "2022-07-01", "end": "2022-09-30", "fy": 2022, "fp": "Q3", "form": "10-Q"}), "Q3 2022")
eq("a fiscal year filed as that year is FY", filings.Filings._period({"start": "2021-01-01", "end": "2021-12-31", "fy": 2021, "fp": "FY", "form": "10-K"}), "FY2021")
eq("a prior year carried in a later 10-K is the year to its end", filings.Filings._period({"start": "2020-01-01", "end": "2020-12-31", "fy": 2021, "fp": "FY", "form": "10-K"}), "year to 2020-12-31")

# ── 5. company facts EDGAR does not have ────────────────────────────────────

today = date.today()
held = {"id": "x", "status": "ok", "offerPrice": 10.0, "announced": "2009-06-01", "target": {"cik": "0000000404", "name": "Old Co"}, "ltmRevenue": 120.5, "financialsReader": 2, "readErrors": ["company facts: HTTP Error 404: Not Found"]}


def missing(url):
    raise RuntimeError("HTTP Error 404: Not Found")


real = filings.fetch_json
filings.fetch_json = missing
try:
    filings.reread_financials(held)
finally:
    filings.fetch_json = real
eq("a 404 is recorded with the day it was asked", held.get("companyFactsMissing"), today.isoformat())
eq("the financials the row already had are kept", held["ltmRevenue"], 120.5)
eq("the 404 is listed once, not once a month", sum("404" in e for e in held["readErrors"]), 1)
eq("it is not asked again next month", filings.needs_financials_reread(held, today + timedelta(days=31)), False)
eq("it is asked again after six months", filings.needs_financials_reread(held, today + timedelta(days=filings.FACTS_404_RETRY_DAYS)), True)

flaky = {"id": "y", "status": "ok", "offerPrice": 10.0, "announced": "2019-06-01", "target": {"cik": "0000000500", "name": "New Co"}, "financialsReader": 2}
filings.fetch_json = lambda url: (_ for _ in ()).throw(RuntimeError("HTTP Error 503: Service Unavailable"))
try:
    filings.reread_financials(flaky)
finally:
    filings.fetch_json = real
eq("any other failure is no 404: nothing is recorded and the next run asks again", (flaky.get("companyFactsMissing"), filings.needs_financials_reread(flaky)), (None, True))

eq("the share count is read at this version all the same: the marker, not the version, brings the facts back", held.get("financialsReader"), filings.FINANCIALS_READER)

# Six months on, the facts are asked for again.
found = dict(held, target={"cik": FIX["CAPRI"]["cik"], "name": "Capri Holdings Ltd"}, announced=FIX["CAPRI"]["announced"], companyFactsMissing=(today - timedelta(days=filings.FACTS_404_RETRY_DAYS)).isoformat())
filings.reread_financials(found)
eq("once EDGAR has the facts, the marker goes and the row is read at this version", (found.get("companyFactsMissing"), found.get("financialsReader"), found.get("ltmEbit")), (None, filings.FINANCIALS_READER, 528.0))

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
