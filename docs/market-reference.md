# IEX reference prices (October 2026)

One dated price per US-listed stock per trading day, from IEX's free historical data, with the trailing 52-week figures built from them. The L3VLUP site uses them for market value, trading multiples, the 52-week range and the comparison of an intrinsic value with the market.

Code:

- `lib/iex-tops.mjs`: the capture reader and the quality gate
- `lib/market-reference.mjs`: the daily database, splits, the 52-week figures and the published files
- `scripts/sync-market-reference.mjs`: the collector
- `.github/workflows/market-reference.yml`

Tests: `scripts/__tests__/market-reference.test.mjs`.

## 1. Rights

Read on 19 October 2026 from IEX's own documents.

**IEX Market Data Policies, September 2026, §15:**

> "IEX does not require an IEX Data Subscriber Agreement from any Person who receives, uses, or distributes IEX Historical Data in accordance with the IEX Historical Data Terms of Use."

§1 defines IEX Historical Data as the T+1 files at `iextrading.com/stats/#historical-stats`. The same note says real-time or delayed data that someone stores is *not* Historical Data. What this collector reads is the HIST files themselves.

**IEX Historical Data Terms of Use** (<https://www.iex.io/legal/hist-data-terms>), clause 01:

> "If you distribute, sell, lease, furnish, or otherwise permit or provide access to Investors' Exchange LLC ("IEX") historical data, you must cite IEX as the source with the following text and link: "Data provided for free by IEX. By accessing or using IEX Historical Data, you agree to the IEX Historical Data Terms of Use.""

The other clauses cover:

- ownership (03): IEX keeps its rights;
- no warranty and no liability (04–06, 09);
- indemnity (07);
- illegal use (02);
- a reminder that the data reflects IEX trading only and is a reference point, not a basis for trading (08, 10).

No clause restricts business use, storage or derived calculations. The only fee on the fee schedule is for real-time feeds, and IEX charges nothing for HIST.

| Question | Answer |
|---|---|
| A. May a business download HIST/TOPS? | Yes. No restriction to personal use; §15 contemplates any Person |
| B. Store daily observations? | Not addressed by the terms; nothing prohibits it |
| C. Display a trade-derived reference price? | Yes, with the attribution. Clause 01 covers any distribution or provision of access |
| D. Display a trailing high and low? | Yes, as C |
| E. Use the price in market cap, P/E, EV and multiples? | Not addressed; nothing prohibits it. §11 of the Policies, written for subscribers, lets derived data be distributed free of charge |
| F. Attribution | The clause 01 text above, with a link to the terms, wherever the data is shown |
| G. Registration or agreement? | None. §15 says so expressly |
| H. Raw trade vs reference price vs ratios? | The terms draw no distinction. All are IEX historical data or built from it. Clause 08 asks that it be understood as IEX-only trading |

Written confirmation is not required to proceed. It is worth having on record for storage and derived use, which the terms leave unaddressed. The message to send to IEX Market Data (`marketops@iextrading.com`):

> We use IEX HIST/TOPS historical trade files to calculate one end-of-day IEX reference price per US equity. We would display that dated IEX reference price, its trailing 52-week high/low, and valuation ratios calculated from it inside a web-based financial-analysis application. We do not provide the raw feed or intraday trade history. Is this permitted, and what attribution or agreement is required?

## 2. The IEX reference price

**Methodology `iex-ref-1`:** the last eligible trade that printed on IEX in the final 30 minutes of the regular session.

- **Eligible:** not an odd lot, not extended hours, not broken. A broken last trade gives way to the one before; two broken leave no price.
- **The window** is measured back from the session-end event in the capture, so a half day is judged against 1pm.
- **Prices** are fixed-point to four decimals as IEX prints them. Never interpolated.

It is a **venue-specific** price. It is never called the official close, the consolidated close, the market close, the NBBO, the SIP close or a real-time price. Every file carries:

> Venue-specific IEX reference price; not a consolidated closing price.

## 3. The quality gate

Graded on IEX's own trading in the symbol that day:

| Grade | Eligible trades | IEX dollar volume | Trades in the final 30 min | Last trade before the bell |
|---|---|---|---|---|
| HIGH | ≥ 100 | ≥ $1,000,000 | ≥ 10 | ≤ 5 min |
| USABLE | ≥ 20 | ≥ $100,000 | ≥ 3 | ≤ 30 min |
| none | anything less | | | |

**After grading:**

- **Stale:** the latest graded day is more than 2 trading days before the as-of date. The price is withheld (`status: stale`).
- **Discontinuity:** a move of more than 40% into the latest day, on a USABLE day, that is not an inferred split. The price is withheld until a later day confirms or replaces it. The same move on a HIGH day stands.
- **Unexplained jump:** a move shaped like a split ratio on dollar volume over three times the 20-day median. The price stands if graded, but the 52-week figures are withheld while it is in the window.

**On 16 October 2026** (the full capture, 62.8 GB decompressed):

- 8,492 symbols traded on IEX.
- 3,994 have a reference price: 2,242 HIGH and 1,752 USABLE.
- AAPL, MSFT, NVDA, JPM, ANET, PLTR and RDDT are HIGH, with the last trade 0–13 seconds before the close. PAYO and BEAM are USABLE.
- Of the 2,416 symbols that traded late but failed the gate:
  - 1,539 had too few trades;
  - 774 had too little dollar volume;
  - 103 had too few late trades.

## 4. The 52-week figures

All are on daily reference prices, split-adjusted to today's share basis. A figure is stated only when 80% of the trading days in its window have a graded price.

| Field | Definition |
|---|---|
| `high52`, `low52` | Highest and lowest daily reference price over the last 252 trading days, each with its date. "Based on daily IEX reference prices", never the consolidated 52-week high or low |
| `base1m` … `base12m` | The reference price 21, 63, 126 and 252 trading days earlier (nearest within 3 days), with its date. Each change is the latest price over its base, recomputed on the site |
| `drawdownPeak`, `drawdownTrough` | The largest fall from a running peak to a later trough within the 52 weeks, both with their dates |
| `vol3m`, `vol12m` | Sample standard deviation of daily log returns between consecutive trading days × √252, over 63 and 252 returns, with the count behind each |

Position in the range, % below the high and % above the low are recomputed on the site from the price, the high and the low. Every figure is reproducible from published inputs except volatility, which needs the daily series. Its method and return count are published, and the suite recomputes it by hand.

**Splits** are inferred, because the free feed announces none for stocks IEX does not list. The test is an overnight change over 40%, within 3% of a whole ratio, on ordinary dollar volume. Earlier prices are divided by the ratio, and the row lists each split with its date.

## 5. What is published, and what is not

| File | Holds |
|---|---|
| `data/market-reference.auto.json` | Per symbol: price, date, grade, seconds before the close, trades, late trades, IEX dollar volume, lag, status; the 52-week figures above; coverage; splits. Dates are indexes into the file's `calendar`. About 725 KB for 4,000 symbols |
| `data/market-history/<A-Z>.auto.json` | One reference price per week per symbol (the last of the week), split-adjusted, for the range chart. 26 shards, about 3 MB in all, the largest about 120 KB |

**Never published:** the daily database (every symbol, every day, about 17 MB compressed for a year). It lives only in the GitHub Actions cache. The collector refuses a state path inside the working tree, and the publication contract refuses any other path. The 15 GB captures are streamed and never written to disk.

## 6. Running it, and what it costs

| | |
|---|---|
| Schedule | 11:40 UTC Tuesday to Saturday (IEX posts about 10:20 UTC), and a retry at 17:40 UTC that exits in about a minute when the day is already read |
| A day | About 14.6 GB compressed (63 GB of packets); 3.6 min of CPU, 6–10 min with the download |
| Backfill | 252 trading days, newest first, about 30 per run in a 300-minute budget: complete within about five working days, faster with manual dispatches. A day once read is never downloaded again; a failed day is retried up to three times |
| Backfill bandwidth | About 3.7 TB downloaded from IEX's public bucket, once |
| Backfill runner time | About 25–42 hours across 9 runs |
| Steady state | About 21 runs a month, about 307 GB and 3 runner-hours, plus about 21 one-minute retries |
| Cache | One entry of about 17 MB, replaced each run |
| Cost | $0. Standard GitHub-hosted runners are free on a public repository, IEX charges nothing for HIST, and the download is from IEX's bucket |

**If the cache is evicted** (7 days unused, which daily runs prevent), the next runs rebuild the year. The published files stay as they were meanwhile.

Publication goes through `publish-data.yml` with `merge: false` until the two-run proof `collect.yml` describes has been seen for this producer.

**Locally:**

```
node scripts/sync-market-reference.mjs --state /tmp/mr/state.json.gz --max-days 1
```

`--index <file>` and `--capture <date>=<file.gz>` read local files.

## 7. Not covered

- Consolidated prices, the official close, intraday prices or anything sooner than the next morning.
- Dividends: prices are split-adjusted only, so a 12-month change is a price change, not a total return.
- Ticker changes: a renamed company starts a new history.
- Markets outside the United States.
