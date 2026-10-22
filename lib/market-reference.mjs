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
 * PRICES ON ONE BASIS, AND THE EVENT BOUNDARY
 * --------------------------------------------
 * A large overnight move is a candidate corporate action, never an
 * adjustment on its own (lib/corporate-actions.mjs). Each candidate is
 * classified on the company's SEC filings: only a CONFIRMED_SPLIT or
 * CONFIRMED_REVERSE_SPLIT rescales earlier prices, at the ratio the filing
 * states, so every figure in a row is on today's share basis. An
 * OTHER_CORPORATE_ACTION (a spin-off, a special distribution, a
 * reorganisation) or an UNRESOLVED discontinuity is never rescaled at a
 * guessed ratio: it bounds the history instead. historyValidFrom is the date
 * of the latest such event, and every figure whose window, base date
 * included, starts before it is withheld; each returns on its own as
 * post-event history accumulates. An ORDINARY_PRICE_MOVE stands as it is. A
 * move of more than 40% on the latest day, observed only at USABLE grade and
 * not explained, withholds the latest price as a possible bad print
 * ('discontinuity') until a later day confirms or replaces it.
 *
 * Pure functions over plain data. scripts/sync-market-reference.mjs owns the
 * network and the files.
 */

import { ACTION, BIG_MOVE, classify, findCandidates, ordinaryReason, publishedAction, splitRatio } from './corporate-actions.mjs';

export { BIG_MOVE, splitRatio };

// The daily database's version. Corporate-action evidence was added beside the days without changing it, so the
// 261-day backfill in the Actions cache survives this change; a new version would discard it.
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
  'coverage', 'statsStatus', 'splits', 'corporateActions', 'historyValidFrom',
];

export function emptyState() {
  return { version: STATE_VERSION, calendar: [], days: {}, failed: {}, actions: {} };
}

/** A state from disk, or a fresh one if it is missing or from another version. */
export function loadState(raw) {
  if (!raw || raw.version !== STATE_VERSION || typeof raw.days !== 'object') return emptyState();
  const actions = raw.actions && typeof raw.actions === 'object' ? raw.actions : {};
  return { version: STATE_VERSION, calendar: raw.calendar ?? [], days: raw.days ?? {}, failed: raw.failed ?? {}, actions };
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
  for (const [sym, byDate] of Object.entries(state.actions ?? {})) {
    for (const d of Object.keys(byDate)) if (!keep.has(d)) delete byDate[d];
    if (!Object.keys(byDate).length) delete state.actions[sym];
  }
  return state;
}

// ── corporate actions ───────────────────────────────────────────────────

/**
 * The stored classification of a candidate, or what it is before any filing
 * has been read: a split-shaped move UNRESOLVED (pending), any other move an
 * ordinary one. A stored result is used only if its shape still matches the
 * candidate, so a classification can never be carried onto a different move.
 */
export function resolverFor(stored) {
  return (candidate, date) => {
    const s = stored?.[date];
    if (s && 'result' in s && (s.shape ?? null) === (candidate.splitShaped ?? null) && Math.abs((s.change ?? 0) - candidate.change) < 1e-9) return s.result;
    return classify(candidate, null);
  };
}

const ADJUSTS = new Set([ACTION.SPLIT, ACTION.REVERSE]);
const BOUNDS = new Set([ACTION.OTHER, ACTION.UNRESOLVED]);

/**
 * Observations in calendar order (null on days without one) to prices on
 * today's share basis. Only a confirmed split or reverse split rescales, at
 * its stated ratio; an action of any other class, or one this code does not
 * know, never rescales and bounds the history at its date. Returns { prices,
 * splits: [{ index, ratio }], actions: [{ index, action }], boundary: index |
 * null, latestJump: 'split' | 'action' | 'move' | 'suspect' | null }.
 */
export function adjustForSplits(entries, resolve = (c) => classify(c, null), calendar = null) {
  const prices = entries.map((e) => (e ? e[P] : null));
  const splits = [];
  const actions = [];
  let boundary = null;
  let latestJump = null;
  let last = -1;
  for (let i = entries.length - 1; i >= 0; i -= 1) if (entries[i]) { last = i; break; }
  for (const c of findCandidates(entries)) {
    const action = resolve(c, calendar ? calendar[c.index] : null);
    let kind;
    if (action && ADJUSTS.has(action.type) && action.confirmed === true && Number.isFinite(action.ratio) && action.ratio > 0 && action.ratio !== 1 && (action.type === ACTION.SPLIT) === action.ratio < 1) {
      for (let j = 0; j < c.index; j += 1) if (prices[j] !== null) prices[j] *= action.ratio;
      splits.push({ index: c.index, ratio: action.ratio });
      actions.push({ index: c.index, action });
      kind = 'split';
    } else if (action) {
      // OTHER, UNRESOLVED, a malformed split, or a class this code does not know: never rescaled, always a boundary.
      const safe = typeof action === 'object' && BOUNDS.has(action.type) ? action : { evidenceSource: null, evidenceFiling: null, evidenceUrl: null, type: ACTION.UNRESOLVED, ratio: null, confirmed: false, reason: `a malformed or unrecognised classification (${String(action?.type).slice(0, 40)}) treated as unresolved` };
      actions.push({ index: c.index, action: safe });
      boundary = boundary === null ? c.index : Math.max(boundary, c.index);
      kind = safe.type === ACTION.OTHER ? 'action' : 'suspect';
    } else {
      kind = c.grade === 'H' ? 'move' : 'suspect';
    }
    if (c.index === last) latestJump = kind;
  }
  return { prices, splits, actions, boundary, latestJump };
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
 * observation in the window at all. `resolve` classifies each candidate
 * (resolverFor); `calendar` gives each index its date, for the published
 * actions and boundary.
 *
 * The event boundary: with a bounding action at index b, a figure is stated
 * only when its whole window, base included, starts at or after b; the
 * 52-week figures, 12-month volatility and the drawdown need the full year
 * after it.
 */
export function rowFor(entries, resolve, calendar = null) {
  const n = entries.length;
  let last = -1;
  for (let i = n - 1; i >= 0; i -= 1) if (entries[i]) { last = i; break; }
  if (last < 0) return null;
  const lag = n - 1 - last;
  const { prices, splits, actions, boundary, latestJump } = adjustForSplits(entries, resolve, calendar);
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
  row.splits = splits.map((s) => [s.index, s.ratio]); // the filing's ratio, never rounded or inferred
  row.corporateActions = calendar ? actions.map((a) => publishedAction(a.action, calendar[a.index])) : actions.map((a) => publishedAction(a.action, null));
  row.historyValidFrom = boundary !== null && calendar ? calendar[boundary] : null;
  const after = (i) => boundary === null || i >= boundary;

  // The 52-week figures need a year of observations, four days in five.
  const from = last - WINDOW_52W + 1;
  const inYear = prices.slice(Math.max(0, from), last + 1).filter((p) => p !== null).length;
  row.coverage = Math.round((inYear / WINDOW_52W) * 100) / 100;
  const fullYear = from >= 0 && after(from) && inYear >= Math.ceil(WINDOW_52W * MIN_COVERAGE);
  row.statsStatus = fullYear ? 'ok' : 'history';
  if (status !== 'ok') return row;

  // Changes over shorter windows need their own coverage, not a full year.
  for (const [k, len] of Object.entries(CHANGE_WINDOWS)) {
    const start = last - len;
    if (start < 0 || !after(start)) continue;
    const got = prices.slice(start, last + 1).filter((p) => p !== null).length;
    if (got < Math.ceil((len + 1) * MIN_COVERAGE)) continue;
    const base = nearest(prices, start, 3, last);
    if (base && after(base[1])) {
      row[`base${k}`] = round4(base[0]);
      row[`base${k}Date`] = base[1];
    }
  }
  const v3 = after(last - CHANGE_WINDOWS['3m']) ? realisedVolatility(prices, last - CHANGE_WINDOWS['3m'], last) : { returns: 0 };
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
  // The first 12-month return runs from the day before the window: it too must lie after any boundary.
  const v12 = after(from - 1) ? realisedVolatility(prices, from - 1, last) : { returns: 0 };
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
  const counts = { listed: 0, priced: 0, high: 0, usable: 0, stale: 0, discontinuity: 0, fullYear: 0, confirmedSplits: 0, otherActions: 0, unresolved: 0, bounded: 0, skipped: 0 };
  for (const symbol of [...all].sort()) {
    if (TEST_SYMBOLS.has(symbol) || !PUBLISHABLE_SYMBOL.test(symbol)) continue;
    const entries = calendar.map((d) => state.days[d]?.obs?.[symbol] ?? null);
    const resolve = resolverFor(state.actions?.[symbol]);
    let row;
    let adjusted;
    try {
      row = rowFor(entries, resolve, calendar);
      adjusted = row && row.status === 'ok' ? adjustForSplits(entries, resolve, calendar) : null;
    } catch {
      // One symbol's bad evidence or data never stops the file or touches another symbol: it is left out.
      counts.skipped += 1;
      continue;
    }
    if (!row) continue;
    for (const a of row.corporateActions) {
      if (a.corporate_action_type === ACTION.SPLIT || a.corporate_action_type === ACTION.REVERSE) counts.confirmedSplits += 1;
      else if (a.corporate_action_type === ACTION.OTHER) counts.otherActions += 1;
      else counts.unresolved += 1;
    }
    if (row.historyValidFrom) counts.bounded += 1;
    symbols[symbol] = COLUMNS.map((c) => row[c]);
    counts.listed += 1;
    if (row.price !== null) {
      counts.priced += 1;
      counts[row.grade === 'H' ? 'high' : 'usable'] += 1;
    }
    if (row.status === 'stale') counts.stale += 1;
    if (row.status === 'discontinuity') counts.discontinuity += 1;
    if (row.high52 !== null) counts.fullYear += 1;
    if (adjusted) {
      // The weekly chart starts at the boundary: no week before a corporate action sits on the same line as one after it.
      const start = Math.max(calendar.length - WINDOW_52W, adjusted.boundary ?? 0);
      const shard = symbol[0];
      (shards[shard] ??= {})[symbol] = weekly(adjusted.prices, calendar, start);
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
    Object.entries(shards).map(([k, syms]) => [k, { generatedAt, asOf, source, basis: 'last IEX reference price of each week, adjusted for confirmed splits only, starting after any other corporate action', calendar, symbols: syms }]),
  );
  return { reference, history };
}

// ── which candidates need evidence ──────────────────────────────────────

/** An UNRESOLVED or unread candidate is asked again after this long, this many times at most: filings can lag. */
export const RECHECK_DAYS = 7;
export const MAX_CHECKS = 6;

/**
 * The candidates whose SEC evidence should be read on this run, most useful
 * first: split-shaped moves (they otherwise stand UNRESOLVED), then the most
 * recent. Only symbols priced in the last three days. Each is { symbol, date,
 * candidate }.
 */
export function pendingEvidence(state, { now = new Date(), limit = Infinity } = {}) {
  const read = state.calendar.filter((d) => state.days[d]);
  const asOf = read.at(-1) ?? null;
  if (!asOf) return [];
  const calendar = state.calendar.slice(0, state.calendar.indexOf(asOf) + 1);
  const all = new Set();
  for (const d of calendar) for (const s of Object.keys(state.days[d]?.obs ?? {})) all.add(s);
  const out = [];
  for (const symbol of all) {
    if (TEST_SYMBOLS.has(symbol) || !PUBLISHABLE_SYMBOL.test(symbol)) continue;
    const entries = calendar.map((d) => state.days[d]?.obs?.[symbol] ?? null);
    // A symbol with no price lately publishes no trailing figure, so its candidates wait until it trades again.
    if (!(entries.at(-1) || entries.at(-2) || entries.at(-3))) continue;
    for (const c of findCandidates(entries)) {
      const date = calendar[c.index];
      const s = state.actions?.[symbol]?.[date];
      const sameMove = s && (s.shape ?? null) === (c.splitShaped ?? null) && Math.abs((s.change ?? 0) - c.change) < 1e-9;
      // Never read: due. Read and UNRESOLVED: again a week later, a few times, since filings can lag the move.
      // Unreadable so far: again on each run, a few times, then weekly.
      const recheck = (n, at) => n < MAX_CHECKS && now.getTime() - Date.parse(at ?? 0) > RECHECK_DAYS * 86_400_000;
      const due = !s || !sameMove
        || (!('result' in s) && ((s.attempts ?? 0) < MAX_CHECKS || recheck(0, s.attemptedAt)))
        || (s.result?.type === ACTION.UNRESOLVED && recheck(s.checks ?? 0, [s.checkedAt, s.attemptedAt].filter(Boolean).sort().at(-1)));
      if (due) out.push({ symbol, date, candidate: c });
    }
  }
  // Split-shaped first (they stand UNRESOLVED until read), then the most recent; the symbol breaks ties, so the order is stable.
  out.sort((a, b) => Number(b.candidate.splitShaped !== null) - Number(a.candidate.splitShaped !== null) || b.date.localeCompare(a.date) || a.symbol.localeCompare(b.symbol));
  return out.slice(0, limit).map(({ symbol, date, candidate }) => ({ symbol, date, candidate }));
}

/**
 * Store what the evidence says about one candidate. Evidence that could not
 * be read changes nothing but the attempt count; a classification is stored
 * with the move it belongs to, so it can never attach to another.
 */
export function recordEvidence(state, symbol, date, candidate, evidence, now = new Date()) {
  state.actions ??= {};
  const byDate = (state.actions[symbol] ??= {});
  const prev = byDate[date];
  const base = { shape: candidate.splitShaped ?? null, change: candidate.change };
  if (!evidence?.checked) {
    const same = prev && prev.shape === base.shape && Math.abs((prev.change ?? 0) - base.change) < 1e-9;
    byDate[date] = { ...(same ? prev : base), attempts: (same ? prev.attempts ?? 0 : 0) + 1, attemptedAt: now.toISOString(), lastError: String(evidence?.error ?? 'unread').slice(0, 120) };
    return null;
  }
  const result = classify(candidate, evidence);
  byDate[date] = { ...base, result, checkedAt: now.toISOString(), checks: (prev?.checks ?? 0) + 1 };
  if (result === null && candidate.splitShaped !== null) byDate[date].note = ordinaryReason(candidate, evidence);
  return result;
}

export function readyToPublish(state) {
  return state.calendar.filter((d) => state.days[d]).length >= READY_DAYS;
}
