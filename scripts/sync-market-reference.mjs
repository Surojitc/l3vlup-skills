#!/usr/bin/env node
/**
 * Read IEX's free historical TOPS captures, one trading day at a time, and
 * publish IEX reference prices: data/market-reference.auto.json and the weekly
 * series in data/market-history/<A-Z>.auto.json (lib/market-reference.mjs).
 *
 *   node scripts/sync-market-reference.mjs --state <file>
 *        [--out data/market-reference.auto.json] [--history-dir data/market-history]
 *        [--budget-minutes 300] [--max-days N] [--index <file>] [--capture <date>=<file>]
 *        [--evidence net|off|<fixture.json>] [--evidence-minutes 60]
 *
 * --state holds the daily observations between runs and must sit outside the
 * working tree: the workflow keeps it in the GitHub Actions cache, so the
 * daily database is never staged, committed or published.
 *
 * A day's capture is about 15 GB compressed. It is streamed (curl, then
 * gunzip, then the reader) and never written to disk; memory holds one small
 * record per symbol. A day already in the state is never downloaded again,
 * and the state is written after every day, so a run cut short keeps what it
 * read. The budget stops the run starting a day it could not finish.
 *
 * Exit codes: 0 when the run did what it could, including "nothing new yet";
 * 1 on a failure that should turn the run red (the index unreadable, a write
 * failing). A day IEX has not posted yet is not a failure.
 *
 * CORPORATE ACTIONS. After the days are read, each large overnight move not
 * yet classified is checked against the company's own SEC filings
 * (lib/corporate-action-evidence.mjs, lib/corporate-actions.mjs): split-shaped
 * moves first, then the most recent, within --evidence-minutes. Requests go
 * only to sec.gov, declare SEC_USER_AGENT and stay under ten a second; a 403
 * or 429 ends the stage for the run, and a candidate that could not be read
 * keeps its previous classification. --evidence off skips the stage (the
 * default with --index, so the offline tests never touch the network);
 * --evidence <file> answers every request from a fixture of URL to content.
 *
 * Nothing is logged that is a price: progress lines count bytes, symbols,
 * days and candidates. See docs/market-reference.md.
 */

import { spawn } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { CLOSE_WINDOW_MS, IEX_ATTRIBUTION, IEX_TERMS_URL, METHODOLOGY_VERSION, QUALITY_RULES, readTopsCloses, referenceObservations } from '../lib/iex-tops.mjs';
import { buildReference, CHANGE_WINDOWS, loadState, MIN_COVERAGE, pendingDays, pendingEvidence, pruneState, readyToPublish, recordDay, recordEvidence, recordFailure, topsDays, WINDOW_52W } from '../lib/market-reference.mjs';
import { gatherEvidence, SEC_HOSTS, tickerIndex } from '../lib/corporate-action-evidence.mjs';

const INDEX_URL = 'https://iextrading.com/api/1.0/hist';
/** Fewer graded observations than this means the capture or the reader went wrong, not a quiet market. */
const MIN_OBSERVATIONS = 1000;

const METHODOLOGY = {
  version: METHODOLOGY_VERSION,
  referencePrice: `The last eligible trade on IEX in the final ${CLOSE_WINDOW_MS / 60000} minutes of the regular session (measured back from the session-end event, so a half day is judged against its own close). Eligible: not an odd lot, not extended hours, not broken. Never interpolated.`,
  quality: {
    H: `HIGH: at least ${QUALITY_RULES.H.minTrades} eligible IEX trades and $${QUALITY_RULES.H.minDollarVolume.toLocaleString('en-US')} IEX dollar volume that day, ${QUALITY_RULES.H.minLateTrades} trades in the final half hour, the last within ${QUALITY_RULES.H.maxSecondsBeforeClose / 60} minutes of the close`,
    U: `USABLE: at least ${QUALITY_RULES.U.minTrades} eligible IEX trades and $${QUALITY_RULES.U.minDollarVolume.toLocaleString('en-US')}, ${QUALITY_RULES.U.minLateTrades} in the final half hour, the last inside it`,
    unavailable: 'Anything less, a latest observation more than 2 trading days old (stale), or an unconfirmed move of more than 40% on a USABLE day (discontinuity): no reference price',
  },
  week52: `High and low of the daily IEX reference prices over the last ${WINDOW_52W} trading days, adjusted for confirmed splits to the latest share basis, stated only when ${Math.round(MIN_COVERAGE * 100)}% of those days have one and the whole window lies on or after historyValidFrom`,
  changes: `Latest reference price over the one ${Object.entries(CHANGE_WINDOWS).map(([k, n]) => `${n} (${k})`).join(', ')} trading days earlier (nearest within 3 days), each base published with its date`,
  volatility: 'Sample standard deviation of daily log returns between consecutive trading days, times the square root of 252; 63 returns (3m) and 252 (12m), each with the count of returns behind it',
  drawdown: 'Largest fall from a running peak to a later trough within the 52 weeks, both published with their dates',
  splits: 'Confirmed only: an overnight change over 40% is a candidate, and earlier prices are rescaled only when the company\'s SEC filing states a split or reverse split whose ratio the move matches within 15% (and the cover share counts, where available, do not contradict it), at the filing\'s ratio',
  corporateActions: `Every candidate is classified ${['CONFIRMED_SPLIT', 'CONFIRMED_REVERSE_SPLIT', 'OTHER_CORPORATE_ACTION', 'UNRESOLVED', 'ORDINARY_PRICE_MOVE'].join(', ')} on the company's own SEC filings, with the form, accession and link published. A spin-off, distribution, special dividend, reclassification or reorganisation (OTHER), or a split-shaped move no filing explains (UNRESOLVED), is never rescaled: historyValidFrom is its date, and every figure whose window starts before it is withheld until enough history after it exists`,
};

const SEC_TICKERS_URL = 'https://www.sec.gov/files/company_tickers_exchange.json';
const SEC_USER_AGENT = process.env.SEC_USER_AGENT || 'L3VLUP Research (contact: suro@l3vlup.com)';
/** Comfortably under the SEC's ten requests a second. */
const SEC_SPACING_MS = 125;

function args(argv) {
  const out = { out: 'data/market-reference.auto.json', historyDir: 'data/market-history', budgetMinutes: 300, maxDays: Infinity, captures: {}, evidence: null, evidenceMinutes: 60 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const v = () => argv[++i];
    if (a === '--state') out.state = v();
    else if (a === '--out') out.out = v();
    else if (a === '--history-dir') out.historyDir = v();
    else if (a === '--budget-minutes') out.budgetMinutes = Number(v());
    else if (a === '--max-days') out.maxDays = Number(v());
    else if (a === '--index') out.index = v();
    else if (a === '--evidence') out.evidence = v();
    else if (a === '--evidence-minutes') out.evidenceMinutes = Number(v());
    else if (a === '--capture') {
      const [date, file] = v().split('=');
      out.captures[date] = file;
    } else throw new Error(`unknown argument ${a}`);
  }
  if (!out.state) throw new Error('--state is required');
  out.evidence ??= out.index ? 'off' : 'net';
  if (resolve(out.state).startsWith(`${resolve('.')}/`)) {
    throw new Error('--state must live outside the working tree, so the daily database is never staged');
  }
  return out;
}

function writeAtomic(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, data);
  renameSync(`${path}.tmp`, path);
}

function readState(path) {
  if (!existsSync(path)) return loadState(null);
  try {
    return loadState(JSON.parse(gunzipSync(readFileSync(path)).toString('utf8')));
  } catch (e) {
    console.log(`the saved state could not be read (${e.message}); starting again`);
    return loadState(null);
  }
}

const saveState = (path, state) => writeAtomic(path, gzipSync(JSON.stringify(state)));

async function readIndex(opts) {
  if (opts.index) return JSON.parse(readFileSync(opts.index, 'utf8'));
  for (let attempt = 1; ; attempt += 1) {
    try {
      const res = await fetch(INDEX_URL, { headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (attempt >= 4) throw new Error(`the IEX HIST index could not be read: ${e.message}`);
      await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
    }
  }
}

function openCapture(day, opts) {
  const local = opts.captures[day.date];
  if (local) return { stream: createReadStream(local), done: Promise.resolve(0) };
  const curl = spawn('curl', ['-sSfL', '--retry', '5', '--retry-delay', '10', '--connect-timeout', '30', day.link], { stdio: ['ignore', 'pipe', 'inherit'] });
  const done = new Promise((r) => curl.on('close', (code) => r(code ?? 1)));
  return { stream: curl.stdout, done };
}

const gb = (b) => `${(b / 1e9).toFixed(1)} GB`;

async function readDay(day, opts) {
  const { stream, done } = openCapture(day, opts);
  let next = 10e9;
  const result = await readTopsCloses(stream, {
    onProgress: (bytes) => {
      if (bytes >= next) {
        console.log(`  ${day.date}: ${gb(bytes)} read`);
        next += 10e9;
      }
    },
  });
  const code = await done;
  if (code !== 0) return { ok: false, reason: `download exited ${code}` };
  if (!result.complete) return { ok: false, reason: result.error ?? 'capture ended before IEX closed the day' };
  const sessionDay = new Date(result.session.close).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  if (sessionDay !== day.date) return { ok: false, reason: `capture is for ${sessionDay}, not ${day.date}` };
  const obs = referenceObservations(result);
  const n = Object.keys(obs).length;
  if (n < MIN_OBSERVATIONS) return { ok: false, reason: `only ${n} symbols passed the quality gate` };
  const high = Object.values(obs).filter((o) => o[1] === 'H').length;
  return { ok: true, obs, session: result.session, symbols: Object.keys(result.symbols).length, bytes: result.bytes, n, high };
}

class StopEvidence extends Error {
  get stop() {
    return true;
  }
}

/** The SEC fetcher: sec.gov only, a declared User-Agent, spaced requests, retries on a server error, a stop on 403/429. */
function secFetcher() {
  let next = 0;
  let requests = 0;
  const get = async (url, kind) => {
    if (!SEC_HOSTS.test(url)) throw new Error('refusing a non-SEC URL');
    for (let attempt = 1; ; attempt += 1) {
      const wait = next - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      next = Date.now() + SEC_SPACING_MS;
      requests += 1;
      let res;
      try {
        res = await fetch(url, { headers: { 'user-agent': SEC_USER_AGENT, accept: kind === 'json' ? 'application/json' : 'text/html,text/plain' }, signal: AbortSignal.timeout(30_000) });
      } catch (e) {
        if (attempt >= 3) throw new Error(`network: ${e.name}`);
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
        continue;
      }
      if (res.status === 403 || res.status === 429) throw new StopEvidence(`SEC answered ${res.status}`);
      if (res.status >= 500 && attempt < 3) {
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return kind === 'json' ? res.json() : res.text();
    }
  };
  return { get, count: () => requests };
}

/** A fetcher over a fixture { url: content }, for running the stage offline. */
function fixtureFetcher(file) {
  const answers = JSON.parse(readFileSync(file, 'utf8'));
  let requests = 0;
  const get = async (url) => {
    if (!SEC_HOSTS.test(url)) throw new Error('refusing a non-SEC URL');
    requests += 1;
    if (!(url in answers)) throw new Error('HTTP 404');
    if (answers[url] === 429) throw new StopEvidence('SEC answered 429');
    return answers[url];
  };
  return { get, count: () => requests };
}

/**
 * Classify the candidates that need it, inside the time allowed. A candidate
 * whose evidence cannot be read keeps what it had; one company's failure
 * never stops another's. Saves the state as it goes.
 */
async function evidenceStage(state, opts, started) {
  if (opts.evidence === 'off') {
    console.log('corporate-action evidence: not read on this run (--evidence off)');
    return;
  }
  const queue = pendingEvidence(state);
  if (!queue.length) {
    console.log('corporate-action evidence: every candidate is classified');
    return;
  }
  const fetcher = opts.evidence === 'net' ? secFetcher() : fixtureFetcher(opts.evidence);
  // Inside what is left of the run's budget (five minutes at least), so a long backfill still saves and publishes.
  const left = opts.budgetMinutes - (Date.now() - started) / 60_000;
  const stopAt = Date.now() + Math.min(opts.evidenceMinutes, Math.max(5, left)) * 60_000;
  const tally = { checked: 0, unread: 0, CONFIRMED_SPLIT: 0, CONFIRMED_REVERSE_SPLIT: 0, OTHER_CORPORATE_ACTION: 0, UNRESOLVED: 0, ORDINARY_PRICE_MOVE: 0 };
  let tickers;
  try {
    tickers = tickerIndex(await fetcher.get(SEC_TICKERS_URL, 'json'));
  } catch (e) {
    console.log(`corporate-action evidence: the SEC ticker map could not be read (${e.message}); ${queue.length} candidates wait for the next run`);
    return;
  }
  const cache = {};
  let stopped = null;
  for (const item of queue) {
    if (Date.now() > stopAt) break;
    let evidence;
    try {
      evidence = await gatherEvidence({ symbol: item.symbol, date: item.date, tickers, get: fetcher.get, splitShaped: item.candidate.splitShaped !== null, cache });
    } catch (e) {
      evidence = { checked: false, error: e.message };
    }
    if (!evidence.checked && evidence.stop) {
      stopped = evidence.error;
      break;
    }
    const result = recordEvidence(state, item.symbol, item.date, item.candidate, evidence);
    if (!evidence.checked) tally.unread += 1;
    else {
      tally.checked += 1;
      tally[result?.type ?? 'ORDINARY_PRICE_MOVE'] += 1;
    }
    if ((tally.checked + tally.unread) % 25 === 0) saveState(opts.state, state);
  }
  saveState(opts.state, state);
  const later = queue.length - tally.checked - tally.unread;
  console.log(`corporate-action evidence: ${tally.checked} candidates classified (${tally.CONFIRMED_SPLIT} splits, ${tally.CONFIRMED_REVERSE_SPLIT} reverse splits, ${tally.OTHER_CORPORATE_ACTION} other actions, ${tally.UNRESOLVED} unresolved, ${tally.ORDINARY_PRICE_MOVE} ordinary moves), ${tally.unread} unreadable, ${later} left for later; ${fetcher.count()} SEC requests${stopped ? `; stopped: ${stopped}` : ''}`);
}

function publish(state, opts) {
  const { reference, history } = buildReference(state, { attribution: IEX_ATTRIBUTION, termsUrl: IEX_TERMS_URL, methodology: METHODOLOGY });
  const outPath = resolve(opts.out);
  if (existsSync(outPath)) {
    try {
      const prev = JSON.parse(readFileSync(outPath, 'utf8'));
      // Unchanged means every figure, classification and boundary the same, not only the date: a corporate action
      // classified since the last run must replace figures computed before it.
      const same = (x) => JSON.stringify({ ...x, generatedAt: null });
      if (same(prev) === same(reference)) {
        console.log(`the published file is already as of ${reference.asOf} with the same figures; left as it is`);
        return;
      }
    } catch {
      // unreadable: replace it
    }
  }
  writeAtomic(outPath, `${JSON.stringify(reference)}\n`);
  const dir = resolve(opts.historyDir);
  mkdirSync(dir, { recursive: true });
  const keep = new Set(Object.keys(history).map((k) => `${k}.auto.json`));
  for (const f of readdirSync(dir)) if (/^[A-Z]\.auto\.json$/.test(f) && !keep.has(f)) unlinkSync(join(dir, f));
  for (const [k, shard] of Object.entries(history)) writeAtomic(join(dir, `${k}.auto.json`), `${JSON.stringify(shard)}\n`);
  const c = reference.counts;
  console.log(`wrote ${opts.out} as of ${reference.asOf}: ${c.listed} symbols, ${c.priced} with a reference price (${c.high} high quality, ${c.usable} usable), ${c.stale} stale, ${c.discontinuity} withheld, ${c.fullYear} with a full 52 weeks; ${Object.keys(history).length} history shards`);
  console.log(`corporate actions: ${c.confirmedSplits} confirmed splits, ${c.otherActions} other actions, ${c.unresolved} unresolved, ${c.bounded} symbols bounded; ${c.skipped} skipped`);
}

async function main() {
  const opts = args(process.argv.slice(2));
  const started = Date.now();
  const state = readState(opts.state);
  const days = topsDays(await readIndex(opts));
  if (!days.length) throw new Error('the IEX HIST index lists no TOPS captures');
  pruneState(state, days);

  const pending = pendingDays(days, state);
  console.log(`${days.length} trading days on IEX HIST; ${pending.length} of the last ${state.calendar.length} still to read`);

  let read = 0;
  let failed = 0;
  let slowest = 0;
  for (const day of pending) {
    if (read + failed >= opts.maxDays) break;
    const elapsed = (Date.now() - started) / 60000;
    if (elapsed + Math.max(slowest, 12) > opts.budgetMinutes) {
      console.log(`stopping with ${pending.length - read - failed} days left: the budget would not cover another`);
      break;
    }
    const t0 = Date.now();
    const got = await readDay(day, opts);
    const minutes = (Date.now() - t0) / 60000;
    slowest = Math.max(slowest, minutes);
    if (got.ok) {
      recordDay(state, day.date, got.obs, got.session);
      read += 1;
      console.log(`${day.date}: ${got.n} of ${got.symbols} symbols passed the quality gate, ${got.high} high quality (${gb(got.bytes)}, ${minutes.toFixed(1)} min)`);
    } else {
      recordFailure(state, day.date, got.reason);
      failed += 1;
      console.log(`${day.date}: not read (${got.reason}); attempt ${state.failed[day.date].attempts}`);
    }
    saveState(opts.state, state);
  }
  saveState(opts.state, state);

  const have = state.calendar.filter((d) => state.days[d]).length;
  console.log(`read ${read}, failed ${failed}; the state holds ${have} of ${state.calendar.length} days`);
  if (!readyToPublish(state)) {
    console.log('too few days read to check a price against the days before it; nothing written');
    return;
  }
  await evidenceStage(state, opts, started);
  publish(state, opts);
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
