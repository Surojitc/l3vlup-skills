#!/usr/bin/env node
/**
 * Read IEX's free historical TOPS captures, one trading day at a time, and
 * write data/market-context.auto.json: categories describing each stock's
 * twelve-month range, momentum, drawdown and volatility. No price leaves.
 *
 *   node scripts/sync-market-context.mjs --state <file> [--out data/market-context.auto.json]
 *        [--budget-minutes 300] [--max-days N] [--index <file>] [--capture <date>=<file>]
 *
 * --state is where the working history of closes lives between runs. It must
 * sit outside the working tree: the workflow keeps it in the GitHub Actions
 * cache, so the closes themselves are never staged, committed or published.
 *
 * A day's capture is about 15 GB compressed and is streamed, never stored:
 * curl's output is decompressed and read as it arrives, so the runner's disk
 * is not touched and memory holds one small record per symbol. A day takes
 * five to ten minutes on a hosted runner. The budget stops the run starting a
 * day it could not finish, and the state is written after every day, so a run
 * that is cut short keeps what it read.
 *
 * --index and --capture read local files instead of the network, for testing.
 *
 * Nothing is logged that is a price: progress lines count bytes, symbols and
 * days. See docs/market-context.md.
 */

import { spawn } from 'node:child_process';
import { createReadStream, existsSync, readFileSync, renameSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { readTopsCloses, eligibleCloses, IEX_ATTRIBUTION, IEX_TERMS_URL } from '../lib/iex-tops.mjs';
import {
  buildContext,
  loadState,
  pendingDays,
  pruneState,
  readyToPublish,
  recordDay,
  recordFailure,
  topsDays,
} from '../lib/market-context.mjs';

const INDEX_URL = 'https://iextrading.com/api/1.0/hist';
/** Fewer closes than this means the capture or the reader went wrong, not that the market was quiet. */
const MIN_CLOSES = 1000;

function args(argv) {
  const out = { out: 'data/market-context.auto.json', budgetMinutes: 300, maxDays: Infinity, captures: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const v = () => argv[++i];
    if (a === '--state') out.state = v();
    else if (a === '--out') out.out = v();
    else if (a === '--budget-minutes') out.budgetMinutes = Number(v());
    else if (a === '--max-days') out.maxDays = Number(v());
    else if (a === '--index') out.index = v();
    else if (a === '--capture') {
      const [date, file] = v().split('=');
      out.captures[date] = file;
    } else throw new Error(`unknown argument ${a}`);
  }
  if (!out.state) throw new Error('--state is required');
  const tree = resolve('.');
  if (resolve(out.state).startsWith(`${tree}/`)) {
    throw new Error('--state must live outside the working tree, so the closes are never staged');
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

/** The capture as a stream, and a promise of whether the download finished cleanly. */
function openCapture(day, opts) {
  const local = opts.captures[day.date];
  if (local) return { stream: createReadStream(local), done: Promise.resolve(0) };
  const curl = spawn('curl', ['-sSfL', '--retry', '5', '--retry-delay', '10', '--connect-timeout', '30', day.link], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
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
  const closes = eligibleCloses(result);
  const n = Object.keys(closes).length;
  if (n < MIN_CLOSES) return { ok: false, reason: `only ${n} symbols closed on IEX in the final half hour` };
  return { ok: true, closes, session: result.session, symbols: Object.keys(result.symbols).length, bytes: result.bytes, n };
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
    const estimate = Math.max(slowest, 12);
    if (elapsed + estimate > opts.budgetMinutes) {
      console.log(`stopping with ${pending.length - read - failed} days left: the budget would not cover another`);
      break;
    }
    const t0 = Date.now();
    const got = await readDay(day, opts);
    const minutes = (Date.now() - t0) / 60000;
    slowest = Math.max(slowest, minutes);
    if (got.ok) {
      recordDay(state, day.date, got.closes, got.session);
      read += 1;
      console.log(`${day.date}: ${got.n} of ${got.symbols} symbols closed on IEX (${gb(got.bytes)}, ${minutes.toFixed(1)} min)`);
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
    console.log('not enough history yet to state any measure; nothing written');
    return;
  }
  const context = buildContext(state, { attribution: IEX_ATTRIBUTION, termsUrl: IEX_TERMS_URL });
  const outPath = resolve(opts.out);
  if (existsSync(outPath)) {
    try {
      const prev = JSON.parse(readFileSync(outPath, 'utf8'));
      if (prev.asOf === context.asOf && prev.days?.read === context.days.read) {
        console.log(`the published file is already as of ${context.asOf} on the same days; left as it is`);
        return;
      }
    } catch {
      // unreadable: replace it
    }
  }
  writeAtomic(outPath, `${JSON.stringify(context)}\n`);
  console.log(`wrote ${opts.out}: ${Object.keys(context.symbols).length} symbols as of ${context.asOf} (${context.withheld} withheld)`);
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
