#!/usr/bin/env node
/**
 * Read IEX's free historical TOPS captures, one trading day at a time, and
 * publish IEX reference prices: data/market-reference.auto.json and the weekly
 * series in data/market-history/<A-Z>.auto.json (lib/market-reference.mjs).
 *
 *   node scripts/sync-market-reference.mjs --state <file>
 *        [--out data/market-reference.auto.json] [--history-dir data/market-history]
 *        [--budget-minutes 300] [--max-days N] [--index <file>] [--capture <date>=<file>]
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
 * Nothing is logged that is a price: progress lines count bytes, symbols and
 * days. See docs/market-reference.md.
 */

import { spawn } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { CLOSE_WINDOW_MS, IEX_ATTRIBUTION, IEX_TERMS_URL, METHODOLOGY_VERSION, QUALITY_RULES, readTopsCloses, referenceObservations } from '../lib/iex-tops.mjs';
import { buildReference, CHANGE_WINDOWS, loadState, MIN_COVERAGE, pendingDays, pruneState, readyToPublish, recordDay, recordFailure, topsDays, WINDOW_52W } from '../lib/market-reference.mjs';

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
  week52: `High and low of the daily IEX reference prices over the last ${WINDOW_52W} trading days, split-adjusted to the latest share basis, stated only when ${Math.round(MIN_COVERAGE * 100)}% of those days have one`,
  changes: `Latest reference price over the one ${Object.entries(CHANGE_WINDOWS).map(([k, n]) => `${n} (${k})`).join(', ')} trading days earlier (nearest within 3 days), each base published with its date`,
  volatility: 'Sample standard deviation of daily log returns between consecutive trading days, times the square root of 252; 63 returns (3m) and 252 (12m), each with the count of returns behind it',
  drawdown: 'Largest fall from a running peak to a later trough within the 52 weeks, both published with their dates',
  splits: 'Inferred: an overnight change over 40% within 3% of a whole ratio, on dollar volume no more than three times the 20 days before; earlier prices divided by the ratio',
};

function args(argv) {
  const out = { out: 'data/market-reference.auto.json', historyDir: 'data/market-history', budgetMinutes: 300, maxDays: Infinity, captures: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const v = () => argv[++i];
    if (a === '--state') out.state = v();
    else if (a === '--out') out.out = v();
    else if (a === '--history-dir') out.historyDir = v();
    else if (a === '--budget-minutes') out.budgetMinutes = Number(v());
    else if (a === '--max-days') out.maxDays = Number(v());
    else if (a === '--index') out.index = v();
    else if (a === '--capture') {
      const [date, file] = v().split('=');
      out.captures[date] = file;
    } else throw new Error(`unknown argument ${a}`);
  }
  if (!out.state) throw new Error('--state is required');
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

function publish(state, opts) {
  const { reference, history } = buildReference(state, { attribution: IEX_ATTRIBUTION, termsUrl: IEX_TERMS_URL, methodology: METHODOLOGY });
  const outPath = resolve(opts.out);
  if (existsSync(outPath)) {
    try {
      const prev = JSON.parse(readFileSync(outPath, 'utf8'));
      if (prev.asOf === reference.asOf && prev.days?.read === reference.days.read && prev.methodology?.version === METHODOLOGY.version) {
        console.log(`the published file is already as of ${reference.asOf} on the same days; left as it is`);
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
  publish(state, opts);
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
