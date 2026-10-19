/**
 * IEX reference prices: one dated price per US-listed stock per trading day,
 * the trailing 52-week figures built from them, and the files the site reads.
 *
 * WHAT AN IEX REFERENCE PRICE IS
 * ------------------------------
 * The last eligible trade that printed on IEX in the final thirty minutes of
 * the regular session, on a day the symbol passed the quality gate
 * (lib/iex-tops.mjs: QUALITY_RULES, METHODOLOGY_VERSION). It is a
 * venue-specific price. It is not the official close, the consolidated close,
 * the NBBO or a real-time price, and nothing here calls it one. IEX publishes
 * its historical data free; IEX Market Data Policies §15 require no subscriber
 * agreement to receive, use or distribute it under the IEX Historical Data
 * Terms of Use, whose one condition on distribution is the attribution
 * carried in every file (docs/market-reference.md §1).
 *
 * WHAT IS PUBLISHED, AND WHAT IS NOT
 * ----------------------------------
 *   data/market-reference.auto.json   per symbol: the latest reference price,
 *                                     its date, grade and the time before the
 *                                     bell its trade printed; the 52-week high
 *                                     and low with their dates; the reference
 *                                     prices 1, 3, 6 and 12 months earlier;
 *                                     the peak and trough of the largest
 *                                     drawdown; realised volatility over 3 and
 *                                     12 months; coverage and any splits
 *   data/market-history/<A-Z>.auto.json  one reference price per week per
 *                                     symbol (the last of the week), for the
 *                                     range chart
 *
 * The daily database itself (every symbol, every day) stays in the
 * collector's working state in the Actions cache and is never published, so
 * there is nothing to download in bulk. Every derived number the site shows
 * is reproducible from the published inputs: a percentage change is two
 * published prices, a position in the range is three. Volatility is the one
 * figure that needs the daily series; its method and the number of returns
 * behind it are published, and the suite recomputes it from a known series.
 *
 * PRICES ON ONE BASIS
 * -------------------
 * A split halves the price overnight. Earlier reference prices are divided by
 * the ratio the split is inferred at, so every figure in a row is on today's
 * share basis, and the row lists each split with its date and ratio. A split
 * is inferred, because the free feed does not announce one for a stock IEX
 * does not list: an overnight change of more than 40% within 3% of a whole
 * ratio, on dollar volume no more than three times the twenty days before. A
 * ratio-shaped move on heavy volume is a collapse or a squeeze that happens to
 * look like a ratio; it is not adjusted, and the 52-week figures are withheld
 * while it is in the window ('unexplained-jump'). A move of more than 40% that
 * matches no ratio is a move, kept as it is, unless the day's observation is
 * only USABLE, in which case the latest price is withheld as a possible bad
 * print ('discontinuity') until a later day confirms or replaces it.
 *
 * Pure functions over plain data. scripts/sync-market-reference.mjs owns the
 * network and the files.
 */

export const STATE_VERSION = 2;
export const WINDOW_52W = 252;
export const LOOKBACK = WINDOW_52W + 10; // trading days kept in the state
export const MIN_COVERAGE = 0.8;
export const MAX_LAG = 2; // trading days the latest observation may trail the as-of date
export const MAX_ATTEMPTS = 3;
/** Days read before the first file is worth publishing: enough to check continuity. */
export const READY_DAYS = 5;
export const CHANGE_WINDOWS = { '1m': 21, '3m': 63, '6m': 126, '12m': 252 };

/** IEX's test symbols, which print trades every day and are not securities. */
export const TEST_SYMBOLS = new Set(['ZIEXT', 'ZXIET', 'ZVZZT', 'ZWZZT', 'ZXZZT', 'ZJZZT', 'ZBZX', 'ZVV', 'ZTEST', 'ZEXIT', 'ZTST', 'CBO', 'CBX']);

/** Common shares, share classes and exchange-traded funds; not warrants, units or rights. */
export const PUBLISHABLE_SYMBOL = /^[A-Z]{1,5}(\.[A-Z])?$/;

/** An observation in the state: [price, grade 'H'|'U', secondsBeforeClose, trades, lateTrades, dollarVolume]. */
const P = 0;
const GRADE = 1;
const SECONDS = 2;
const TRADES = 3;
const LATE = 4;
const DOLLARS = 5;

export const COLUMNS = [
  'price', 'date', 'grade', 'secondsBeforeClose', 'trades', 'lateTrades', 'dollarVolume', 'lag', 'status',
  'high52', 'high52Date', 'low52', 'low52Date',
  'base1m', 'base1mDate', 'base3m', 'base3mDate', 'base6m', 'base6mDate', 'base12m', 'base12mDate',
  'vol3m', 'vol3mReturns', 'vol12m', 'vol12mReturns',
  'drawdownPeak', 'drawdownPeakDate', 'drawdownTrough', 'drawdownTroughDate',
  'coverage', 'statsStatus', 'splits',
];

export function emptyState() {
  return { version: STATE_VERSION, calendar: [], days: {}, failed: {} };
}

/** A state from disk, or a fresh one if it is missing or from another version. */
export function loadState(raw) {
  if (!raw || raw.version !== STATE_VERSION || typeof raw.days !== 'object') return emptyState();
  return { version: STATE_VERSION, calendar: raw.calendar ?? [], days: raw.days ?? {}, failed: raw.failed ?? {} };
}

/** 20261016 -> 2026-10-16 */
export const isoDate = (d) => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;

/**
 * The trading days IEX has published a TOPS capture for, oldest first, from
 * the HIST index (`{ "20261016": [{ feed, version, link, size }] }`).
 */
export function topsDays(index) {
  const out = [];
  for (const [date, entries] of Object.entries(index ?? {})) {
    if (!/^\d{8}$/.test(date) || !Array.isArray(entries)) continue;
    const tops = entries.find((e) => e?.feed === 'TOPS' && typeof e.link === 'string');
    if (tops) out.push({ date: isoDate(date), link: tops.link, size: Number(tops.size) || null, version: tops.version ?? null });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * The days still to read, newest first: within the lookback, not yet read,
 * and not given up on. A day read once is never downloaded again.
 */
export function pendingDays(days, state, lookback = LOOKBACK) {
  return days
    .slice(-lookback)
    .filter((d) => !state.days[d.date] && (state.failed[d.date]?.attempts ?? 0) < MAX_ATTEMPTS)
    .reverse();
}

export function recordDay(state, date, obs, session) {
  state.days[date] = { session, obs };
  delete state.failed[date];
}

export function recordFailure(state, date, reason) {
  const prev = state.failed[date]?.attempts ?? 0;
  state.failed[date] = { attempts: prev + 1, reason: String(reason).slice(0, 200) };
}

/** Keep the calendar to the lookback and drop days that fell out of it. */
export function pruneState(state, days, lookback = LOOKBACK) {
  state.calendar = days.slice(-lookback).map((d) => d.date);
  const keep = new Set(state.calendar);
  for (const d of Object.keys(state.days)) if (!keep.has(d)) delete state.days[d];
  for (const d of Object.keys(state.failed)) if (!keep.has(d)) delete state.failed[d];
  return state;
}

// ── splits ────────────────────────────────────────────────────────────────

const SPLIT_RATIOS = [2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 30, 40, 50, 1.5, 2.5];
const SPLIT_TOLERANCE = 0.03;
export const BIG_MOVE = Math.log(1.4);

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** The whole split ratio an overnight change matches, as price-after / price-before, or null. */
export function splitRatio(change) {
  for (const k of SPLIT_RATIOS) {
    if (Math.abs(change * k - 1) < SPLIT_TOLERANCE) return 1 / k; // k-for-1 split
    if (Math.abs(change / k - 1) < SPLIT_TOLERANCE) return k; // 1-for-k reverse split
  }
  return null;
}

/**
 * Observations in calendar order (null on days without one) to prices on
 * today's share basis. Returns { prices, splits: [{ index, ratio }],
 * unresolved: index | null, latestJump: 'split' | 'move' | 'suspect' | null }.
 * `latestJump` describes the move into the latest observation.
 */
export function adjustForSplits(entries) {
  const prices = entries.map((e) => (e ? e[P] : null));
  const splits = [];
  let unresolved = null;
  let latestJump = null;
  let prevIdx = -1;
  let last = -1;
  for (let i = entries.length - 1; i >= 0; i -= 1) if (entries[i]) { last = i; break; }
  for (let i = 0; i < entries.length; i += 1) {
    if (!entries[i]) continue;
    if (prevIdx >= 0 && i - prevIdx <= 5) {
      const change = entries[i][P] / entries[prevIdx][P];
      if (Math.abs(Math.log(change)) > BIG_MOVE) {
        const ratio = splitRatio(change);
        const usual = median(entries.slice(Math.max(0, prevIdx - 20), prevIdx + 1).filter(Boolean).map((e) => e[DOLLARS]));
        const ordinary = usual !== null && usual > 0 && entries[i][DOLLARS] <= usual * 3;
        let kind;
        if (ratio !== null && ordinary) {
          for (let j = 0; j < i; j += 1) if (prices[j] !== null) prices[j] *= ratio;
          splits.push({ index: i, ratio });
          kind = 'split';
        } else if (ratio !== null) {
          unresolved = i;
          kind = 'suspect';
        } else {
          kind = entries[i][GRADE] === 'H' ? 'move' : 'suspect';
        }
        if (i === last) latestJump = kind;
      }
    }
    prevIdx = i;
  }
  return { prices, splits, unresolved, latestJump };
}

// ── the measures ─────────────────────────────────────────────────────────

const round4 = (x) => (x === null || x === undefined ? null : Math.round(x * 1e4) / 1e4);

/** The observation nearest `target` (an index) within `slack` days, preferring earlier: [price, index] or null. */
function nearest(prices, target, slack, upTo) {
  for (let d = 0; d <= slack; d += 1) {
    if (target - d >= 0 && prices[target - d] !== null) return [prices[target - d], target - d];
    if (d && target + d < upTo && prices[target + d] !== null) return [prices[target + d], target + d];
  }
  return null;
}

/** Sample standard deviation of daily log returns between consecutive trading days in (from, to]. */
export function realisedVolatility(prices, from, to) {
  const r = [];
  for (let i = Math.max(from + 1, 1); i <= to; i += 1) {
    if (prices[i] !== null && prices[i - 1] !== null) r.push(Math.log(prices[i] / prices[i - 1]));
  }
  if (r.length < 2) return { annualised: null, returns: r.length };
  const mean = r.reduce((a, b) => a + b, 0) / r.length;
  const v = r.reduce((a, b) => a + (b - mean) ** 2, 0) / (r.length - 1);
  return { annualised: Math.sqrt(v) * Math.sqrt(252), returns: r.length };
}

/** The largest peak-to-trough fall in [from, to]: { peak: [price, i], trough: [price, i] } or null when prices only rose. */
export function maxDrawdown(prices, from, to) {
  let peak = null;
  let best = null;
  for (let i = Math.max(0, from); i <= to; i += 1) {
    const p = prices[i];
    if (p === null) continue;
    if (!peak || p > peak[0]) peak = [p, i];
    const dd = 1 - p / peak[0];
    if (dd > 0 && (!best || dd > best.dd)) best = { dd, peak: [...peak], trough: [p, i] };
  }
  return best;
}

/**
 * One symbol's row, from its observations over the calendar (oldest first,
 * the last entry being the as-of date). Null when the symbol has no
 * observation in the window at all.
 */
export function rowFor(entries) {
  const n = entries.length;
  let last = -1;
  for (let i = n - 1; i >= 0; i -= 1) if (entries[i]) { last = i; break; }
  if (last < 0) return null;
  const lag = n - 1 - last;
  const { prices, splits, unresolved, latestJump } = adjustForSplits(entries);
  const o = entries[last];
  const status = lag > MAX_LAG ? 'stale' : latestJump === 'suspect' && o[GRADE] !== 'H' ? 'discontinuity' : 'ok';
  const row = Object.fromEntries(COLUMNS.map((c) => [c, null]));
  row.lag = lag;
  row.status = status;
  row.date = last;
  row.grade = o[GRADE];
  row.secondsBeforeClose = o[SECONDS];
  row.trades = o[TRADES];
  row.lateTrades = o[LATE];
  row.dollarVolume = o[DOLLARS];
  row.price = status === 'ok' ? round4(o[P]) : null;
  row.splits = splits.map((s) => [s.index, round4(s.ratio)]);

  // The 52-week figures need a year of observations, four days in five.
  const from = last - WINDOW_52W + 1;
  const inYear = prices.slice(Math.max(0, from), last + 1).filter((p) => p !== null).length;
  row.coverage = Math.round((inYear / WINDOW_52W) * 100) / 100;
  const fullYear = from >= 0 && inYear >= Math.ceil(WINDOW_52W * MIN_COVERAGE);
  row.statsStatus = unresolved !== null && unresolved >= from ? 'unexplained-jump' : fullYear ? 'ok' : 'history';
  if (status !== 'ok' || row.statsStatus === 'unexplained-jump') return row;

  // Changes over shorter windows need their own coverage, not a full year.
  for (const [k, len] of Object.entries(CHANGE_WINDOWS)) {
    const start = last - len;
    if (start < 0) continue;
    const got = prices.slice(start, last + 1).filter((p) => p !== null).length;
    if (got < Math.ceil((len + 1) * MIN_COVERAGE)) continue;
    const base = nearest(prices, start, 3, last);
    if (base) {
      row[`base${k}`] = round4(base[0]);
      row[`base${k}Date`] = base[1];
    }
  }
  const v3 = realisedVolatility(prices, last - CHANGE_WINDOWS['3m'], last);
  if (v3.returns >= Math.ceil(CHANGE_WINDOWS['3m'] * MIN_COVERAGE)) {
    row.vol3m = round4(v3.annualised);
    row.vol3mReturns = v3.returns;
  }
  if (row.statsStatus !== 'ok') return row;

  let hi = null;
  let lo = null;
  for (let i = from; i <= last; i += 1) {
    const p = prices[i];
    if (p === null) continue;
    if (!hi || p > hi[0]) hi = [p, i];
    if (!lo || p < lo[0]) lo = [p, i];
  }
  row.high52 = round4(hi[0]);
  row.high52Date = hi[1];
  row.low52 = round4(lo[0]);
  row.low52Date = lo[1];
  const v12 = realisedVolatility(prices, from - 1, last);
  if (v12.returns >= Math.ceil((WINDOW_52W - 1) * MIN_COVERAGE)) {
    row.vol12m = round4(v12.annualised);
    row.vol12mReturns = v12.returns;
  }
  const dd = maxDrawdown(prices, from, last);
  if (dd) {
    row.drawdownPeak = round4(dd.peak[0]);
    row.drawdownPeakDate = dd.peak[1];
    row.drawdownTrough = round4(dd.trough[0]);
    row.drawdownTroughDate = dd.trough[1];
  }
  return row;
}

/** The last observation of each calendar week, on today's share basis: [[dateIndex, price], ...]. */
export function weekly(prices, calendar, from) {
  const out = [];
  const week = (iso) => {
    const d = new Date(`${iso}T00:00:00Z`);
    const monday = new Date(d);
    monday.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    return monday.toISOString().slice(0, 10);
  };
  for (let i = Math.max(0, from); i < prices.length; i += 1) {
    if (prices[i] === null) continue;
    const w = week(calendar[i]);
    if (out.length && week(calendar[out.at(-1)[0]]) === w) out[out.length - 1] = [i, round4(prices[i])];
    else out.push([i, round4(prices[i])]);
  }
  return out;
}

const DATE_COLUMNS = new Set(COLUMNS.filter((c) => c === 'date' || c.endsWith('Date')));

/**
 * The published files: the reference file and the weekly history shards.
 * Dates in rows are indexes into the file's `calendar`, which keeps six
 * thousand rows inside the size the site can cache.
 */
export function buildReference(state, { generatedAt = new Date().toISOString(), attribution, termsUrl, methodology } = {}) {
  const read = state.calendar.filter((d) => state.days[d]);
  const asOf = read.at(-1) ?? null;
  const calendar = asOf ? state.calendar.slice(0, state.calendar.indexOf(asOf) + 1) : [];
  const all = new Set();
  for (const d of calendar) for (const s of Object.keys(state.days[d]?.obs ?? {})) all.add(s);

  const symbols = {};
  const shards = {};
  const counts = { listed: 0, priced: 0, high: 0, usable: 0, stale: 0, discontinuity: 0, fullYear: 0 };
  for (const symbol of [...all].sort()) {
    if (TEST_SYMBOLS.has(symbol) || !PUBLISHABLE_SYMBOL.test(symbol)) continue;
    const entries = calendar.map((d) => state.days[d]?.obs?.[symbol] ?? null);
    const row = rowFor(entries);
    if (!row) continue;
    symbols[symbol] = COLUMNS.map((c) => row[c]);
    counts.listed += 1;
    if (row.price !== null) {
      counts.priced += 1;
      counts[row.grade === 'H' ? 'high' : 'usable'] += 1;
    }
    if (row.status === 'stale') counts.stale += 1;
    if (row.status === 'discontinuity') counts.discontinuity += 1;
    if (row.high52 !== null) counts.fullYear += 1;
    if (row.status === 'ok' && row.statsStatus !== 'unexplained-jump') {
      const { prices } = adjustForSplits(entries);
      const shard = symbol[0];
      (shards[shard] ??= {})[symbol] = weekly(prices, calendar, calendar.length - WINDOW_52W);
    }
  }
  const source = {
    name: 'IEX Historical Data (TOPS)',
    price: 'IEX reference price',
    disclaimer: 'Venue-specific IEX reference price; not a consolidated closing price.',
    attribution,
    termsUrl,
  };
  const reference = {
    generatedAt,
    asOf,
    source,
    methodology,
    days: { inWindow: calendar.length, read: calendar.filter((d) => state.days[d]).length },
    counts,
    calendar,
    columns: COLUMNS,
    dateColumns: [...DATE_COLUMNS],
    symbols,
  };
  const history = Object.fromEntries(
    Object.entries(shards).map(([k, syms]) => [k, { generatedAt, asOf, source, basis: 'last IEX reference price of each week, split-adjusted to the latest share basis', calendar, symbols: syms }]),
  );
  return { reference, history };
}

export function readyToPublish(state) {
  return state.calendar.filter((d) => state.days[d]).length >= READY_DAYS;
}
