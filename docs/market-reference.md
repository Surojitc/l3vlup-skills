# IEX reference prices (October 2026)

One dated price per US-listed stock per trading day, from IEX's free historical data, with the trailing 52-week figures built from them. The L3VLUP site uses them for market value, trading multiples, the 52-week range and the comparison of an intrinsic value with the market.

Code:

- `lib/iex-tops.mjs`: the capture reader and the quality gate
- `lib/market-reference.mjs`: the daily database, the event boundary, the 52-week figures and the published files
- `lib/corporate-actions.mjs`: candidates, what a filing says, and the classification (pure)
- `lib/corporate-action-evidence.mjs`: the SEC filings and share counts read for one candidate
- `scripts/sync-market-reference.mjs`: the collector
- `.github/workflows/market-reference.yml`

Tests: `scripts/__tests__/market-reference.test.mjs`.

## 1. Rights

Read on 19 October 2026 from IEX's own documents, and approved the same day. The conclusion:

> IEX Historical Data Terms expressly permit distribution of IEX Historical Data subject to the required attribution. The HIST product is provided free on a T+1 basis. The terms do not state a separate commercial-use restriction for HIST.

**IEX Historical Data Terms of Use** (<https://www.iex.io/legal/hist-data-terms>), clause 01:

> "If you distribute, sell, lease, furnish, or otherwise permit or provide access to Investors' Exchange LLC ("IEX") historical data, you must cite IEX as the source with the following text and link: "Data provided for free by IEX. By accessing or using IEX Historical Data, you agree to the IEX Historical Data Terms of Use.""

The other clauses cover:

- ownership (03): IEX keeps its rights in the data;
- no warranty and no liability (04–06, 09);
- indemnity (07);
- illegal use (02);
- the data reflects IEX trading only and is a reference point, not a view of the broader market or a basis for trading (08, 10). This is why the price is named an IEX reference price and every file carries the disclaimer in §2.

**IEX Market Data Policies, September 2026, §15:**

> "IEX does not require an IEX Data Subscriber Agreement from any Person who receives, uses, or distributes IEX Historical Data in accordance with the IEX Historical Data Terms of Use."

§1 of the Policies defines IEX Historical Data as the T+1 files at `iextrading.com/stats/#historical-stats`. The fee schedule charges nothing for HIST.

**HIST is not the real-time feeds.** Everything above is about HIST, the free T+1 historical files. IEX's real-time TOPS and DEEP feeds are distributed under a separate regime: a Data Subscriber Agreement, the Policies and the fee schedule. The Policies also say that real-time or delayed data someone stores does not become Historical Data. The HIST files are captures in the TOPS message format, but reading them is not receiving the real-time TOPS feed. Nothing here reads a real-time IEX feed, and nothing here implies these rights extend to one.

| Question | Answer |
|---|---|
| A. May a business download HIST? | Yes. HIST is free, T+1, and §15 requires no subscriber agreement of any Person |
| B. Store daily observations? | The terms set no separate storage restriction for HIST. The daily database stays private, in the Actions cache (§5) |
| C. Display a trade-derived reference price? | Yes. Clause 01 expressly contemplates distributing or providing access, with the attribution |
| D. Display a trailing high and low? | Yes, as C |
| E. Use the price in market cap, P/E, EV and multiples? | The terms state no separate restriction on it. The figures are shown with the attribution and the clause 08 reference-point disclaimer |
| F. Attribution | The clause 01 text above, with a link to the terms, wherever the data is shown |
| G. Registration or agreement? | None for HIST (§15). The real-time feeds are a different matter |
| H. Raw trade vs reference price vs ratios? | The terms draw no distinction. Only the daily reference price and figures built from it are published; no raw trades or intraday history |

Written confirmation from IEX is not required to proceed. It is worth having on record. The message to send to IEX Market Data (`marketops@iextrading.com`):

> We use IEX HIST/TOPS historical trade files to calculate one end-of-day IEX reference price per US equity. We would display that dated IEX reference price, its trailing 52-week high/low, and valuation ratios calculated from it inside a web-based financial-analysis application. We do not provide the raw feed or intraday trade history. Is this permitted, and what attribution or agreement is required?

## 2. The IEX reference price

**Methodology `iex-ref-2`** (`iex-ref-1` until 22 October 2026, which inferred splits from the price alone; see section 4a): the last eligible trade that printed on IEX in the final 30 minutes of the regular session.

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
- **Discontinuity:** a move of more than 40% into the latest day, on a USABLE day, that no filing explains as a corporate action. The price is withheld until a later day confirms or replaces it. The same move on a HIGH day stands.
- **A corporate action or an unresolved move** keeps the price and withholds the trailing figures that span it (section 4a).

**On 16 October 2026** (the full capture, 62.8 GB decompressed):

- 8,492 symbols traded on IEX.
- 3,994 have a reference price: 2,242 HIGH and 1,752 USABLE.
- AAPL, MSFT, NVDA, JPM, ANET, PLTR and RDDT are HIGH, with the last trade 0–13 seconds before the close. PAYO and BEAM are USABLE.
- Of the 2,416 symbols that traded late but failed the gate:
  - 1,539 had too few trades;
  - 774 had too little dollar volume;
  - 103 had too few late trades.

## 4. The 52-week figures

All are on daily reference prices, adjusted for confirmed splits to today's share basis. A figure is stated only when 80% of the trading days in its window have a graded price, and only when its whole window, base date included, lies on or after any `historyValidFrom` (section 4a).

| Field | Definition |
|---|---|
| `high52`, `low52` | Highest and lowest daily reference price over the last 252 trading days, each with its date. "Based on daily IEX reference prices", never the consolidated 52-week high or low |
| `base1m` … `base12m` | The reference price 21, 63, 126 and 252 trading days earlier (nearest within 3 days), with its date. Each change is the latest price over its base, recomputed on the site |
| `drawdownPeak`, `drawdownTrough` | The largest fall from a running peak to a later trough within the 52 weeks, both with their dates |
| `vol3m`, `vol12m` | Sample standard deviation of daily log returns between consecutive trading days × √252, over 63 and 252 returns, with the count behind each |

Position in the range, % below the high and % above the low are recomputed on the site from the price, the high and the low. Every figure is reproducible from published inputs except volatility, which needs the daily series. Its method and return count are published, and the suite recomputes it by hand.

## 4a. Corporate actions and the event boundary

A move of more than 40% overnight may be a split, a reverse split, a spin-off, a special distribution, a reorganisation, a share-class change or an ordinary price move. The price series cannot tell them apart: Corteva's 1 October 2026 separation of its seed business left a price one sixth of the day before, exactly the shape of a 6-for-1 split, and `iex-ref-1` adjusted it as one. So the price test now only proposes **candidates**, and each is classified on the company's own SEC filings.

**Evidence, in order:**

1. **The filing.** The 8-K, 6-K, 10-Q, 10-K, registration and proxy filings within 120 days before and 45 after the date (current reports only for a move not shaped like a split), with an 8-K's EX-99 press release. A stated split ratio (`four-for-one stock split`, `at a ratio of one-for-ten`, `every five shares ... reclassified into one`) that the move matches within 15% confirms a split. A spin-off, separation, pro rata distribution, special dividend, reclassification or holding-company reorganisation described in a current report within 45 days before and 15 after makes it another action. An exchange ratio counts only behind a split-shaped move.
2. **The share count** on the filing covers (`dei:EntityCommonStockSharesOutstanding`) either side of the date: corroboration only. A count that moves as a stated split would is cited; one that plainly does not (more than 25% off) makes the split UNRESOLVED. A count that did not move across the date rules a split out, but it does not explain the price (a spin-off, distribution, reorganisation or class change can leave the common share count unchanged), so the move stays UNRESOLVED. A count never confirms a split, sets a ratio, or makes a move ordinary on its own.

| Class | When | Prices | Published |
|---|---|---|---|
| `CONFIRMED_SPLIT`, `CONFIRMED_REVERSE_SPLIT` | a filing states the split and the move matches it | earlier prices multiplied by the filing's ratio, never a rounded inferred one | the ratio, the reason, the form, accession and link |
| `OTHER_CORPORATE_ACTION` | a current report describes a non-split action | never rescaled | no ratio; `historyValidFrom` is the date |
| `UNRESOLVED` | the default for a split-shaped move: no filing explains it, the evidence conflicts, the share count rules out a split but nothing explains the move, or no filing has been read yet | never rescaled | `historyValidFrom` is the date |
| `ORDINARY_PRICE_MOVE` | a move with no split shape and no action a current report describes; never a split-shaped move on the share count alone | as they are | nothing |

**The event boundary.** With an OTHER or UNRESOLVED action, `historyValidFrom` is the date of the latest one. A figure is stated only when its whole window lies on or after it: the 1-month change from 21 trading days after, the 3-month change and volatility from 63, the 6-month change from 126, and the 52-week high, low, drawdown, 12-month change and volatility from 252. Each returns on its own as post-event history accumulates. The price itself stands. The weekly chart starts at the boundary. The row carries `corporateActions` (`corporate_action_type`, `corporate_action_effective_date`, `action_ratio`, `action_confirmed`, `corporate_action_reason`, `evidence_source`, `evidence_filing`, `evidence_url`) and `historyValidFrom`, which the site reads (L3vlup `lib/finance-os/providers/market-reference.ts`).

**Safety.** A split-shaped move stored as ordinary under the first `iex-ref-2` rule (an unchanged share count) is not trusted and is read again. Only a confirmed split with a finite ratio pointing the right way rescales; anything else, including a class the code does not know or a malformed record, is treated as UNRESOLVED. A stored classification applies only to the exact move it was made for. A symbol whose record cannot be read is left out of the file without touching another. `evidence_url` is published only for a document in EDGAR's archive.

**The evidence stage** runs after the days are read, within 60 minutes: split-shaped candidates first, then the most recent, for symbols priced in the last three days. Requests go to sec.gov only, with `SEC_USER_AGENT` (default `L3VLUP Research (contact: suro@l3vlup.com)`), at most eight a second; a 403 or 429 ends the stage for that run. A company's submissions and share counts are fetched once a run. An UNRESOLVED candidate is read again weekly, six times at most, since filings can lag the move; an unreadable one keeps whatever it had. The classifications live in the daily database beside the days, under the same state version, so the year already read is kept. The published file is rewritten whenever any figure or classification changes, not only when a new day arrives.

On the filings themselves (22 October 2026): CrowdStrike 4-for-1 (8-K 3 June 2026), Netflix 10-for-1, ServiceNow 5-for-1, Carvana 5-for-1, Texas Pacific Land 3-for-1 and StoneX 3-for-2 confirm as splits; Tilray 1-for-10, Service Properties 1-for-5, Amcor 1-for-5 and DuPont 1-for-3 as reverse splits; Corteva and Liberty Latin America as other actions; Sarepta's, ZoomInfo's and Rackspace's 3:2-shaped falls stand UNRESOLVED (no filing explains them; their share counts rule out a split but do not explain the move), as do AstraZeneca's ADS-to-share change (no stated split) and every ETF (no SEC company registrant in the ticker map).

## 5. What is published, and what is not

| File | Holds |
|---|---|
| `data/market-reference.auto.json` | Per symbol: price, date, grade, seconds before the close, trades, late trades, IEX dollar volume, lag, status; the 52-week figures above; coverage; confirmed splits; corporate actions with their SEC provenance; `historyValidFrom`. Dates are indexes into the file's `calendar`. About 725 KB for 4,000 symbols |
| `data/market-history/<A-Z>.auto.json` | One reference price per week per symbol (the last of the week), adjusted for confirmed splits and starting after any other corporate action, for the range chart. 26 shards, about 3 MB in all, the largest about 120 KB |

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

`--index <file>` and `--capture <date>=<file.gz>` read local files. `--evidence off` skips the SEC stage (the default with `--index`), `--evidence <file.json>` answers it from a fixture of URL to content, and `--evidence-minutes` bounds it.

## 7. Not covered

- Consolidated prices, the official close, intraday prices or anything sooner than the next morning.
- Dividends: prices are split-adjusted only, so a 12-month change is a price change, not a total return.
- Ticker changes: a renamed company starts a new history.
- ETF and fund splits: funds are not in SEC's company ticker map, so a fund's split stands UNRESOLVED and its 52-week figures return a year after it.
- A split the filings state in words the reader does not know stays UNRESOLVED, never adjusted.
- Markets outside the United States.
