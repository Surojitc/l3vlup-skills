#!/usr/bin/env python3
"""Throwaway: which free market-data sources actually work, and in what shape."""
import json, urllib.request

UA = {"User-Agent": "Mozilla/5.0 (compatible; L3VLUP/1.0; contact@l3vlup.com)"}

def get(url, label, show=420):
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=30) as r:
            d = r.read()
        print(f"\n### {label}\n  OK  {url}\n  {len(d)/1024:.1f} KB")
        print("  " + d[:show].decode("utf-8", "replace").replace("\n", "\n  "))
        return d
    except Exception as e:
        print(f"\n### {label}\n  --  {url}\n  {type(e).__name__}: {e}")
        return None

# 1. Stooq — free daily OHLC as CSV, no key, no auth. Covers US, UK, DE and indices.
get("https://stooq.com/q/d/l/?s=aapl.us&i=d&d1=20260101", "Stooq daily OHLC (AAPL)")
get("https://stooq.com/q/d/l/?s=^spx&i=d&d1=20260101", "Stooq index (S&P 500)")
get("https://stooq.com/q/d/l/?s=azn.uk&i=d&d1=20260601", "Stooq UK listing")

# 2. Yahoo chart — unofficial but widely used, no key.
get("https://query1.finance.yahoo.com/v8/finance/chart/AAPL?range=1mo&interval=1d",
    "Yahoo chart v8")
get("https://query1.finance.yahoo.com/v10/finance/quoteSummary/AAPL"
    "?modules=defaultKeyStatistics,summaryDetail,price", "Yahoo quoteSummary v10 (beta, EV)")

# 3. Frankfurter — ECB FX reference rates, free, no key. For cross-currency work.
get("https://api.frankfurter.dev/v1/latest?base=USD&symbols=GBP,EUR,JPY", "Frankfurter FX")

# 4. SEC company facts already covers fundamentals; check the submissions endpoint
#    for the cover-page share count, which is more current than the statements.
get("https://data.sec.gov/api/xbrl/companyconcept/CIK0000320193/dei/EntityCommonStockSharesOutstanding.json",
    "SEC cover-page share count", 300)
