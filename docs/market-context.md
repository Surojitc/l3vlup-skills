# Market context from IEX (October 2026)

`data/market-context.auto.json` describes how each US-listed stock has traded, as categories:

- where it sits in its twelve-month range;
- how far it is below its twelve-month high;
- how it has moved over three and twelve months;
- how volatile it has been, against its own year.

No price is published.

Code:

- `lib/iex-tops.mjs`: the capture reader
- `lib/market-context.mjs`: the measures
- `scripts/sync-market-context.mjs`: the collector
- `.github/workflows/market-context.yml`

Tests: `scripts/__tests__/market-context.test.mjs`.

## 1. Why IEX, and what it costs

The brief was market data for calculations, at no cost, on terms a business may use. The candidates, as checked on 19 October 2026:

| Source | Cheapest plan a business may use | Verdict |
|---|---|---|
| Tiingo | Commercial, $50/month or $499/year | Over budget |
| Marketstack | Basic, $9.99/month | Terms silent on display; US data resold from Tiingo |
| Twelve Data | Free tier forbids commercial use; business plans from $149/month | Over budget |
| EODHD | Commercial, $399/month | Over budget |
| Massive (formerly Polygon) | Individual plans exclude businesses; business from $2,499/month | Over budget |
| Finnhub | Free and paid plans for personal use only | Not permitted |
| **IEX Historical Data** | **Free** | **Used** |

IEX publishes every trading day's market data feed as a packet capture, the morning after, at no charge. The IEX Historical Data Terms of Use govern it. Wherever anything built from it is shown, the one condition is this attribution, which the file carries in `source.attribution`:

> Data provided for free by IEX. By accessing or using IEX Historical Data, you agree to the IEX Historical Data Terms of Use.

The running cost is GitHub Actions minutes on a public repository, which are free.

## 2. What a close is here

IEX is one US exchange among many, not the consolidated tape. The close used is the last trade that printed **on IEX** in the regular session, with two exclusions:

- odd lots and extended-hours trades are excluded, as they do not set the last sale on the tape either;
- intermarket sweeps, trade-through exempt trades and the closing cross all count.

A broken trade is undone. If the last trade is broken, the one before stands; if both are, there is no close that day.

**A close counts only if it printed in the final thirty minutes of the session.** The session's own end is used, so a half day is judged against 1pm. For a liquid stock this lands within cents of the official close. A thin stock whose last IEX trade was at 11am has no close that day, rather than a stale one.

A day is read only if the capture reached IEX's end-of-messages event and at least 1,000 symbols closed. Otherwise it is retried on a later run, up to three times.

## 3. The measures

Each measure is stated only when **four in five trading days** in its window have a close. Otherwise the field is `null`.

| Column | Values | Definition |
|---|---|---|
| `range12m` | near-low, lower, middle, upper, near-high | The latest close between the 252-day low and high, in fifths |
| `drawdown12m` | within-5, 5-15, 15-30, 30-50, over-50 | Percent below the 252-day high |
| `momentum3m`, `momentum12m` | strong-down, down, flat, up, strong-up | Change over 63 and 252 trading days; cut at −20%, −5%, +5%, +20% |
| `volatilityPct` | a multiple of 5 | Annualised standard deviation of daily log returns over 63 days (62 returns), rounded to 5 points |
| `volatilityBand` | low, moderate, high, very-high | Below 20%, 35%, 60%, and above |
| `volatilityVsOwn12m` | calm, typical, elevated | 3-month against 12-month volatility: below 0.75×, above 1.33× |
| `lag` | 0–2 | Trading days the symbol's last close trails `asOf` |
| `coverage` | 0–1 | Share of the last 252 trading days with a close |

**Which symbols are listed:**

- A symbol with no close in the last three trading days is not listed.
- Only common shares, share classes and funds are listed (`BRK.B`, not `BRK-B`; no warrants, units or rights). IEX's test symbols are excluded.

**Splits.** Nothing in the free feed announces a split for a stock IEX does not list, so splits are inferred. A split is taken where the overnight change is:

- larger than 40% either way;
- within 3% of a whole ratio (2, 3, 4, 5, 10, 1.5 and the rest in `SPLIT_RATIOS`, either way round);
- on dollar volume no more than three times the median of the twenty days before.

A collapse trades heavily; a split trades as usual, in more shares. Earlier closes are then divided by the ratio.

A move that matches a ratio but not the volume pattern is neither adjusted nor trusted. The symbol is withheld (counted in `withheld`) until the move leaves the window.

**Not adjusted:**

- Dividends: a few per cent a year, inside every bucket's width.
- Ticker changes: a renamed company starts a new history.

## 4. Why categories, and why no price can be recovered

The site uses this as context beside a company's filings, never as a quote. Every published measure is a ratio of one price to another, a rounded volatility or a count. So multiplying every price in the history by the same number leaves the file byte-for-byte the same; the suite proves this at 0.01×, 1.37× and 250×.

The file therefore cannot tell a $10 stock from a $1,000 one. Nothing that needs a price level can be computed from it:

- no price, and no 52-week dollar range;
- no P/E (price over public EPS);
- no market value (price times public shares);
- no exact upside to a price target.

The suite also checks:

- no close appears in the file, in full or to the cent;
- no key is named for a price;
- every number is a lag, a coverage share or a multiple of five.

## 5. Where the closes live

The measures need a year of closes per symbol. That working history, about 260 trading days, lives only in the GitHub Actions cache:

- Each run restores the newest state and reads the days it lacks, newest first. It saves the state after every day and again at the end, including when the step fails or runs out of time.
- The collector refuses a state path inside the working tree.
- The publication contract refuses any staged path but `data/market-context.auto.json`.
- Nothing a run logs is a price.

Two things to know about the cache:

- **Eviction.** An entry unused for seven days is evicted. The next run then starts again from nothing and rebuilds the year in about two days. Nothing is published until three months are back, so the published file stays as it was meanwhile.
- **Fork pull requests.** A pull request from a fork can restore caches made on the default branch, if a maintainer approves its workflow run. The closes would then be visible to that run. They are IEX's free public data, whose terms permit redistribution with the attribution; keeping them unpublished is a product choice, not a licence requirement.

## 6. Running it

| What | How |
|---|---|
| Schedule | Every six hours (`20 */6 * * *`) |
| A day's capture | About 15 GB compressed (65 GB of packets), streamed through curl and decompressed in memory, never written to disk |
| Time per day | About 4 minutes of decoding at 265 MB/s, plus the download |
| Budget | 300 minutes, so a backfill run reads about thirty days |
| First publication | When 63 trading days are read; the twelve-month measures fill in as the backfill reaches a year |
| Once caught up | A run reads the index, finds nothing new and stops |

Publication goes through `publish-data.yml` with `merge: false`. The data pull request opens and waits for a human, until the two proofs `collect.yml` describes have been seen for this producer too.

**Locally:**

```
node scripts/sync-market-context.mjs --state /tmp/mc/state.json.gz --max-days 1
```

`--index <file>` and `--capture <date>=<file.gz>` read local files instead of the network.

## 7. Not covered

- A price of any kind, on any page or in any export. The site's exact-price paths stay on the price the person enters.
- Intraday data, or anything sooner than the next morning.
- Markets outside the United States.
- Adjusting for dividends.
