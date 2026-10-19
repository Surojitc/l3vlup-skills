/**
 * Market context from IEX closes: where a stock sits in its twelve-month
 * range, how volatile it has been, how it has moved, and how far it is below
 * its high. Published as categories, never as prices.
 *
 * WHY CATEGORIES AND NOT PRICES
 * -----------------------------
 * The site uses this as context beside a company's filings, not as a quote.
 * An IEX close is the last trade on one venue, which is a fair basis for
 * "near its twelve-month high" and a poor one for "$214.37". So what leaves
 * this repository is a set of labels and one rounded volatility figure, from
 * which no price, range or return can be recovered:
 *
 *   range12m      near-low | lower | middle | upper | near-high
 *                 (the latest close's place between the 12-month low and high,
 *                 in fifths)
 *   drawdown12m   within-5 | 5-15 | 15-30 | 30-50 | over-50
 *                 (percent below the 12-month high)
 *   momentum3m,
 *   momentum12m   strong-down | down | flat | up | strong-up
 *                 (price change over 63 and 252 trading days; the cut points
 *                 are -20%, -5%, +5% and +20%)
 *   volatility    annualised standard deviation of daily log returns over 63
 *                 trading days, rounded to the nearest 5 percentage points,
 *                 with a band (low | moderate | high | very-high) and how it
 *                 compares with the stock's own 12-month figure
 *                 (calm | typical | elevated)
 *
 * The raw closes live only in the collector's working state, which is kept in
 * the GitHub Actions cache and never committed (docs/market-context.md).
 *
 * WHAT A MEASURE NEEDS BEFORE IT IS STATED
 * ----------------------------------------
 * A measure is published only when the closes behind it are there: four in
 * five of the trading days in its window must have an IEX close (see
 * eligibleCloses in lib/iex-tops.mjs for what counts as one). Below that the
 * field is null, which the site shows as not available. A symbol with no
 * close in the last three trading days is not published at all.
 *
 * SPLITS
 * ------
 * A 2-for-1 split halves the price overnight and would read as a 50% fall.
 * Nothing in the free feed announces splits for stocks IEX does not list, so
 * they are inferred: an overnight change within 3% of a whole split ratio,
 * on a day whose dollar volume is not out of line with the weeks before
 * (a real collapse trades heavily; a split trades as usual, in more shares).
 * The earlier closes are then divided by the ratio. A move that matches a
 * ratio but not the volume pattern is neither adjusted nor trusted: the
 * symbol's measures are withheld until the move leaves the window, because a
 * wrong guess either way would mislabel the stock for a year.
 *
 * Pure functions over plain data. The collector (scripts/sync-market-context.mjs)
 * owns the network and the files.
 */

export const STATE_VERSION = 1;
export const WINDOW_12M = 252;
export const WINDOW_3M = 63;
export const LOOKBACK = WINDOW_12M + 8; // trading days kept in the state
export const MIN_COVERAGE = 0.8;
export const MAX_LAG = 2; // trading days a symbol's last close may trail the as-of date
export const MAX_ATTEMPTS = 3;

/** IEX's test symbols, which print trades every day and are not securities. */
export const TEST_SYMBOLS = new Set(['ZIEXT', 'ZXIET', 'ZVZZT', 'ZWZZT', 'ZXZZT', 'ZJZZT', 'ZBZX', 'ZVV', 'ZTEST', 'ZEXIT', 'ZTST', 'CBO', 'CBX']);

/** Common shares, share classes and exchange-traded funds; not warrants, units or rights. */
export const PUBLISHABLE_SYMBOL = /^[A-Z]{1,5}(\.[A-Z])?$/;

export const COLUMNS = ['lag', 'coverage', 'range12m', 'drawdown12m', 'momentum3m', 'momentum12m', 'volatilityPct', 'volatilityBand', 'volatilityVsOwn12m'];

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
 * The trading days IEX has published a TOPS capture for, newest last,
 * from the HIST index (`{ "20261016": [{ feed, version, link, size }] }`
 * or the per-date array form).
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
 * and not given up on. Newest first so the current measures arrive on the
 * first run and the twelve-month ones fill in behind them.
 */
export function pendingDays(days, state, lookback = LOOKBACK) {
  return days
    .slice(-lookback)
    .filter((d) => !state.days[d.date] && (state.failed[d.date]?.attempts ?? 0) < MAX_ATTEMPTS)
    .reverse();
}

export function recordDay(state, date, closes, session) {
  state.days[date] = { session, closes };
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

// ── the measures ──────────────────────────────────────────────────────────

const SPLIT_RATIOS = [2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 30, 40, 50, 1.5, 2.5];
const SPLIT_TOLERANCE = 0.03;
const BIG_MOVE = Math.log(1.4);

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
 * Closes adjusted for inferred splits, oldest first, with `null` on days with
 * no close. `entries` is [[price, volume, dollarVolume] | null] in calendar
 * order. Returns { prices, splits, unresolved }.
 */
export function adjustForSplits(entries) {
  const prices = entries.map((e) => (e ? e[0] : null));
  const splits = [];
  let unresolved = null;
  let prevIdx = -1;
  for (let i = 0; i < entries.length; i += 1) {
    if (!entries[i]) continue;
    if (prevIdx >= 0 && i - prevIdx <= 5) {
      const change = entries[i][0] / entries[prevIdx][0];
      if (Math.abs(Math.log(change)) > BIG_MOVE) {
        const ratio = splitRatio(change);
        if (ratio !== null) {
          const before = entries
            .slice(Math.max(0, prevIdx - 20), prevIdx + 1)
            .filter(Boolean)
            .map((e) => e[2]);
          const usual = median(before);
          const dollarVolume = entries[i][2];
          const ordinary = usual !== null && usual > 0 && dollarVolume <= usual * 3;
          if (ordinary) {
            for (let j = 0; j < i; j += 1) if (prices[j] !== null) prices[j] *= ratio;
            splits.push({ index: i, ratio });
          } else {
            unresolved = i;
          }
        }
      }
    }
    prevIdx = i;
  }
  return { prices, splits, unresolved };
}

/** The close nearest `target` (an index) within `slack` days either side, preferring earlier. */
function closeNear(prices, target, slack) {
  for (let d = 0; d <= slack; d += 1) {
    if (target - d >= 0 && prices[target - d] !== null) return prices[target - d];
    if (d && target + d < prices.length && prices[target + d] !== null) return prices[target + d];
  }
  return null;
}

function stdevOfReturns(prices, from, to) {
  const r = [];
  for (let i = Math.max(from, 1); i <= to; i += 1) {
    if (prices[i] !== null && prices[i - 1] !== null) r.push(Math.log(prices[i] / prices[i - 1]));
  }
  if (r.length < 2) return { sd: null, n: r.length };
  const mean = r.reduce((a, b) => a + b, 0) / r.length;
  const v = r.reduce((a, b) => a + (b - mean) ** 2, 0) / (r.length - 1);
  return { sd: Math.sqrt(v), n: r.length };
}

export const rangeBucket = (pos) => (pos < 0.2 ? 'near-low' : pos < 0.4 ? 'lower' : pos < 0.6 ? 'middle' : pos < 0.8 ? 'upper' : 'near-high');
export const drawdownBucket = (dd) => (dd < 0.05 ? 'within-5' : dd < 0.15 ? '5-15' : dd < 0.3 ? '15-30' : dd < 0.5 ? '30-50' : 'over-50');
export const momentumBucket = (r) => (r < -0.2 ? 'strong-down' : r < -0.05 ? 'down' : r <= 0.05 ? 'flat' : r <= 0.2 ? 'up' : 'strong-up');
export const volatilityBand = (v) => (v < 0.2 ? 'low' : v < 0.35 ? 'moderate' : v < 0.6 ? 'high' : 'very-high');
export const volatilityVsOwn = (ratio) => (ratio < 0.75 ? 'calm' : ratio > 1.33 ? 'elevated' : 'typical');
export const roundVolatility = (v) => Math.round((v * 100) / 5) * 5;

/**
 * One symbol's measures, from its entries over the calendar (oldest first,
 * the last entry being the as-of date). Null when the symbol has no recent
 * close, or when an unexplained jump sits inside the window.
 */
export function measuresFor(entries) {
  const n = entries.length;
  let last = -1;
  for (let i = n - 1; i >= 0; i -= 1) if (entries[i]) { last = i; break; }
  if (last < 0 || n - 1 - last > MAX_LAG) return null;

  const { prices, splits, unresolved } = adjustForSplits(entries);
  if (unresolved !== null) return { withheld: 'unexplained-jump' };

  const window = (len) => {
    const from = Math.max(0, last - len + 1);
    const got = prices.slice(from, last + 1).filter((p) => p !== null).length;
    return { from, enough: last - len + 1 >= 0 && got >= Math.ceil(len * MIN_COVERAGE) };
  };
  const p = prices[last];
  const w12 = window(WINDOW_12M);
  const w3 = window(WINDOW_3M);

  let range12m = null;
  let drawdown12m = null;
  if (w12.enough) {
    const inWindow = prices.slice(w12.from, last + 1).filter((x) => x !== null);
    const hi = Math.max(...inWindow);
    const lo = Math.min(...inWindow);
    if (hi > lo) range12m = rangeBucket((p - lo) / (hi - lo));
    drawdown12m = drawdownBucket(1 - p / hi);
  }

  const momentum = (len, enough) => {
    if (!enough) return null;
    const base = closeNear(prices, last - len, 3);
    return base ? momentumBucket(p / base - 1) : null;
  };

  let volatilityPct = null;
  let band = null;
  let vsOwn = null;
  // A window of n closes holds n - 1 daily returns.
  const v3 = stdevOfReturns(prices, last - WINDOW_3M + 2, last);
  if (w3.enough && v3.sd !== null && v3.n >= Math.ceil((WINDOW_3M - 1) * MIN_COVERAGE)) {
    const annual = v3.sd * Math.sqrt(252);
    volatilityPct = roundVolatility(annual);
    band = volatilityBand(annual);
    const v12 = stdevOfReturns(prices, last - WINDOW_12M + 2, last);
    if (w12.enough && v12.sd && v12.n >= Math.ceil((WINDOW_12M - 1) * MIN_COVERAGE)) {
      vsOwn = volatilityVsOwn(v3.sd / v12.sd);
    }
  }

  const coverageWindow = prices.slice(Math.max(0, last - WINDOW_12M + 1), last + 1);
  const coverage = Math.round((coverageWindow.filter((x) => x !== null).length / WINDOW_12M) * 100) / 100;

  return {
    lag: n - 1 - last,
    coverage,
    range12m,
    drawdown12m,
    momentum3m: momentum(WINDOW_3M, w3.enough),
    momentum12m: momentum(WINDOW_12M, w12.enough),
    volatilityPct,
    volatilityBand: band,
    volatilityVsOwn12m: vsOwn,
    splits: splits.length,
  };
}

/**
 * The published file. `symbols` maps a ticker (IEX's notation: BRK.B, not
 * BRK-B) to a row in COLUMNS order. A symbol is listed only if at least one
 * measure is stated for it.
 */
export function buildContext(state, { generatedAt = new Date().toISOString(), attribution, termsUrl } = {}) {
  const calendar = state.calendar;
  const read = calendar.filter((d) => state.days[d]);
  const asOf = read.at(-1) ?? null;
  const upto = asOf ? calendar.slice(0, calendar.indexOf(asOf) + 1) : [];

  const all = new Set();
  for (const d of upto) for (const s of Object.keys(state.days[d]?.closes ?? {})) all.add(s);

  const symbols = {};
  let withheld = 0;
  for (const symbol of [...all].sort()) {
    if (TEST_SYMBOLS.has(symbol) || !PUBLISHABLE_SYMBOL.test(symbol)) continue;
    const entries = upto.map((d) => state.days[d]?.closes?.[symbol] ?? null);
    const m = measuresFor(entries);
    if (!m) continue;
    if (m.withheld) {
      withheld += 1;
      continue;
    }
    const stated = [m.range12m, m.drawdown12m, m.momentum3m, m.momentum12m, m.volatilityPct].some((x) => x !== null);
    if (!stated) continue;
    symbols[symbol] = COLUMNS.map((c) => m[c]);
  }

  return {
    generatedAt,
    asOf,
    source: {
      name: 'IEX Historical Data (TOPS)',
      venue: 'IEX only, not the consolidated tape',
      timing: 'end of day, published by IEX the next day',
      attribution,
      termsUrl,
    },
    method: {
      eachClose: 'last regular-session IEX trade, excluding odd lots and extended hours, printed in the final 30 minutes of the session',
      coverage: `a measure is stated only when ${Math.round(MIN_COVERAGE * 100)}% of the trading days in its window have a close`,
      windows: { '3m': WINDOW_3M, '12m': WINDOW_12M },
      splits: 'inferred from the price and volume pattern; earlier closes divided by the ratio',
    },
    days: { inWindow: upto.length, read: upto.filter((d) => state.days[d]).length },
    columns: COLUMNS,
    withheld,
    symbols,
  };
}

/** Days of history needed before the file is worth publishing: one full 3-month window. */
export function readyToPublish(state) {
  const read = state.calendar.filter((d) => state.days[d]);
  return read.length >= WINDOW_3M;
}
