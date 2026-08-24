"""
XBRL tag preference lists.

Filers tag the same economic line differently — "Revenues" versus
"RevenueFromContractWithCustomerExcludingAssessedTax" versus a segment-specific
extension. Each entry below is an ordered preference list: take the first tag the
filer actually reports. Never sum across two tags in the same list, because that
double-counts a filer who reports both.

Where no tag in a list is present, the line is left empty. An empty line in an
L3VLUP workbook means "the filer did not tag it", not "zero" — that distinction is
the whole point of sourcing from filings.
"""

INCOME = {
    "revenue": [
        "RevenueFromContractWithCustomerExcludingAssessedTax",
        "RevenueFromContractWithCustomerIncludingAssessedTax",
        "Revenues",
        "SalesRevenueNet",
        "SalesRevenueGoodsNet",
    ],
    "cogs": [
        "CostOfGoodsAndServicesSold",
        "CostOfRevenue",
        "CostOfGoodsSold",
        "CostOfServices",
    ],
    "gross_profit": ["GrossProfit"],
    "rnd": ["ResearchAndDevelopmentExpense"],
    "sgna": [
        "SellingGeneralAndAdministrativeExpense",
        "GeneralAndAdministrativeExpense",
    ],
    "opex": ["OperatingExpenses", "CostsAndExpenses"],
    "operating_income": ["OperatingIncomeLoss"],
    "interest_expense": [
        "InterestExpense",
        "InterestIncomeExpenseNet",
        "InterestExpenseDebt",
    ],
    "pretax_income": [
        "IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest",
        "IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments",
    ],
    "tax": ["IncomeTaxExpenseBenefit"],
    "net_income": ["NetIncomeLoss", "ProfitLoss"],
    "eps_diluted": ["EarningsPerShareDiluted", "EarningsPerShareBasicAndDiluted"],
    "eps_basic": ["EarningsPerShareBasic"],
    "shares_diluted": [
        "WeightedAverageNumberOfDilutedSharesOutstanding",
        "WeightedAverageNumberOfSharesOutstandingBasicAndDiluted",
    ],
    "shares_basic": ["WeightedAverageNumberOfSharesOutstandingBasic"],
    "d_and_a": [
        "DepreciationDepletionAndAmortization",
        "DepreciationAmortizationAndAccretionNet",
        "DepreciationAndAmortization",
    ],
    "sbc": ["ShareBasedCompensation", "AllocatedShareBasedCompensationExpense"],
}

BALANCE = {
    "cash": [
        "CashAndCashEquivalentsAtCarryingValue",
        "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents",
    ],
    "short_term_investments": [
        "ShortTermInvestments",
        "AvailableForSaleSecuritiesDebtSecuritiesCurrent",
        "MarketableSecuritiesCurrent",
    ],
    "receivables": [
        "AccountsReceivableNetCurrent",
        "ReceivablesNetCurrent",
    ],
    "inventory": ["InventoryNet"],
    "current_assets": ["AssetsCurrent"],
    "ppe": ["PropertyPlantAndEquipmentNet"],
    "goodwill": ["Goodwill"],
    "intangibles": [
        "FiniteLivedIntangibleAssetsNet",
        "IntangibleAssetsNetExcludingGoodwill",
    ],
    "total_assets": ["Assets"],
    "payables": ["AccountsPayableCurrent", "AccountsPayableAndAccruedLiabilitiesCurrent"],
    "current_liabilities": ["LiabilitiesCurrent"],
    "short_term_debt": [
        "LongTermDebtCurrent",
        "DebtCurrent",
        "ShortTermBorrowings",
    ],
    "long_term_debt": [
        "LongTermDebtNoncurrent",
        "LongTermDebt",
        "DebtInstrumentCarryingAmount",
    ],
    "operating_lease_liability": [
        "OperatingLeaseLiabilityNoncurrent",
        "OperatingLeaseLiability",
    ],
    "total_liabilities": ["Liabilities"],
    "equity": [
        "StockholdersEquity",
        "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest",
    ],
    "minority_interest": ["MinorityInterest"],
    "liabilities_and_equity": ["LiabilitiesAndStockholdersEquity"],
    "shares_outstanding": [
        "CommonStockSharesOutstanding",
        "CommonStockSharesIssued",
        "EntityCommonStockSharesOutstanding",
    ],
}

CASHFLOW = {
    "cfo": [
        "NetCashProvidedByUsedInOperatingActivities",
        "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations",
    ],
    "capex": [
        "PaymentsToAcquirePropertyPlantAndEquipment",
        "PaymentsToAcquireProductiveAssets",
    ],
    "cfi": ["NetCashProvidedByUsedInInvestingActivities"],
    "cff": ["NetCashProvidedByUsedInFinancingActivities"],
    "buybacks": [
        "PaymentsForRepurchaseOfCommonStock",
        "TreasuryStockValueAcquiredCostMethod",
    ],
    "dividends": ["PaymentsOfDividendsCommonStock", "PaymentsOfDividends"],
    "acquisitions": ["PaymentsToAcquireBusinessesNetOfCashAcquired"],
}

#: Lines shown on the standard income-statement block, in order.
#: (label, key, format marker, bold, indent)
INCOME_LAYOUT = [
    ("Revenue", "revenue", "D", True, False),
    ("Cost of revenue", "cogs", "D", False, False),
    ("Gross profit", "gross_profit", "D", True, False),
    ("Research and development", "rnd", "D", False, False),
    ("Selling, general and administrative", "sgna", "D", False, False),
    ("Operating income", "operating_income", "D", True, False),
    ("Interest expense", "interest_expense", "D", False, False),
    ("Pre-tax income", "pretax_income", "D", False, False),
    ("Income tax expense", "tax", "D", False, False),
    ("Net income", "net_income", "D", True, False),
]

BALANCE_LAYOUT = [
    ("Cash and equivalents", "cash", "D", False, False),
    ("Short-term investments", "short_term_investments", "D", False, False),
    ("Accounts receivable", "receivables", "D", False, False),
    ("Inventory", "inventory", "D", False, False),
    ("Total current assets", "current_assets", "D", True, False),
    ("Property, plant and equipment, net", "ppe", "D", False, False),
    ("Goodwill", "goodwill", "D", False, False),
    ("Total assets", "total_assets", "D", True, False),
    ("Accounts payable", "payables", "D", False, False),
    ("Total current liabilities", "current_liabilities", "D", True, False),
    ("Short-term debt", "short_term_debt", "D", False, False),
    ("Long-term debt", "long_term_debt", "D", False, False),
    ("Total liabilities", "total_liabilities", "D", True, False),
    ("Total shareholders' equity", "equity", "D", True, False),
]

CASHFLOW_LAYOUT = [
    ("Cash from operations", "cfo", "D", True, False),
    ("Capital expenditure", "capex", "D", False, False),
    ("Cash from investing", "cfi", "D", False, False),
    ("Cash from financing", "cff", "D", False, False),
    ("Share repurchases", "buybacks", "D", False, False),
    ("Dividends paid", "dividends", "D", False, False),
]

#: Balance-sheet keys are point-in-time; everything else spans a period.
STOCK_KEYS = set(BALANCE) | {"shares_outstanding"}

#: Keys reported per share rather than in currency units.
PER_SHARE_KEYS = {"eps_diluted", "eps_basic"}

#: Keys reported in share counts.
SHARE_COUNT_KEYS = {"shares_diluted", "shares_basic", "shares_outstanding"}


def unit_kind_for(key: str) -> str:
    if key in PER_SHARE_KEYS:
        return "USD/shares"
    if key in SHARE_COUNT_KEYS:
        return "shares"
    return "USD"


def is_flow(key: str) -> bool:
    return key not in STOCK_KEYS
