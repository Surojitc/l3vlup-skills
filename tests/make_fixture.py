"""Synthetic companyfacts payload so the builders can be tested without EDGAR."""
from __future__ import annotations

TAGS_FLOW = {
    "RevenueFromContractWithCustomerExcludingAssessedTax": 100e9,
    "CostOfGoodsAndServicesSold": 55e9,
    "GrossProfit": 45e9,
    "ResearchAndDevelopmentExpense": 12e9,
    "SellingGeneralAndAdministrativeExpense": 9e9,
    "OperatingIncomeLoss": 24e9,
    "InterestExpense": 1.1e9,
    "IncomeTaxExpenseBenefit": 3.4e9,
    "NetIncomeLoss": 19.5e9,
    "NetCashProvidedByUsedInOperatingActivities": 26e9,
    "PaymentsToAcquirePropertyPlantAndEquipment": 6.2e9,
    "NetCashProvidedByUsedInInvestingActivities": -8e9,
    "NetCashProvidedByUsedInFinancingActivities": -14e9,
    "PaymentsForRepurchaseOfCommonStock": 11e9,
    "PaymentsOfDividendsCommonStock": 3.1e9,
    "ShareBasedCompensation": 2.4e9,
    "DepreciationDepletionAndAmortization": 4.8e9,
}
TAGS_STOCK = {
    "CashAndCashEquivalentsAtCarryingValue": 21e9,
    "ShortTermInvestments": 14e9,
    "AccountsReceivableNetCurrent": 18e9,
    "InventoryNet": 6e9,
    "AssetsCurrent": 62e9,
    "PropertyPlantAndEquipmentNet": 34e9,
    "Goodwill": 9e9,
    "Assets": 160e9,
    "AccountsPayableCurrent": 21e9,
    "LiabilitiesCurrent": 44e9,
    "LongTermDebtCurrent": 5e9,
    "LongTermDebtNoncurrent": 48e9,
    "Liabilities": 104e9,
    "StockholdersEquity": 56e9,
    "LiabilitiesAndStockholdersEquity": 160e9,
}
TAGS_PS = {"EarningsPerShareDiluted": 4.12}
TAGS_SH = {"WeightedAverageNumberOfDilutedSharesOutstanding": 4.7e9,
           "CommonStockSharesOutstanding": 4.65e9}

YEARS = [2021, 2022, 2023, 2024, 2025]


def _rows(base, unit, flow, growth=1.09):
    """
    Emit rows the way EDGAR actually does: each 10-K carries THREE fiscal years,
    and all three are tagged with the FILING's fiscal year, not the period's.

    This is the shape that mislabels a whole sheet if you key on `fy` — the FY2023
    10-K reports FY2021, FY2022 and FY2023 all as fy=2023. The builders must key
    on the period end date and resolve the label from the original filing.
    """
    out = []
    for i, y in enumerate(YEARS):
        v = round(base * (growth ** (i - len(YEARS) + 1)), 2)
        # the original 10-K for year y, filed the following February
        for filing_year in (y, y + 1, y + 2):
            if filing_year not in YEARS:
                continue
            row = {
                "end": f"{y}-12-31", "val": v,
                "fy": filing_year, "fp": "FY", "form": "10-K",
                "filed": f"{filing_year + 1}-02-14",
                "accn": f"0000000000-{str(filing_year + 1)[2:]}-000001",
            }
            if flow:
                row["start"] = f"{y}-01-01"
            out.append(row)
    return {unit: out}


#: A tag the filer abandoned three years ago. It is FIRST in the revenue
#: preference list, so a naive first-match returns stale history and the whole
#: sheet silently shows the company as it was in 2022.
STALE_TAG = "RevenueFromContractWithCustomerExcludingAssessedTax"
LIVE_TAG = "Revenues"


def companyfacts(name="Fixture Industries Inc"):
    us = {}
    for tag, base in TAGS_FLOW.items():
        us[tag] = {"units": _rows(base, "USD", True)}

    # Model a real tag switch: revenue moves from STALE_TAG to LIVE_TAG in 2023.
    rev_base = TAGS_FLOW[STALE_TAG]
    all_rows = _rows(rev_base, "USD", True)["USD"]
    us[STALE_TAG] = {"units": {"USD": [r for r in all_rows if r["end"][:4] <= "2022"]}}
    us[LIVE_TAG] = {"units": {"USD": all_rows}}
    for tag, base in TAGS_STOCK.items():
        us[tag] = {"units": _rows(base, "USD", False, growth=1.06)}
    for tag, base in TAGS_PS.items():
        us[tag] = {"units": _rows(base, "USD/shares", True, growth=1.11)}
    for tag, base in TAGS_SH.items():
        us[tag] = {"units": _rows(base, "shares", tag.startswith("Weighted"), growth=0.985)}
    return {"cik": 1, "entityName": name, "facts": {"us-gaap": us}}
