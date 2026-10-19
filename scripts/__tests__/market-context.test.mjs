/**
 * Market context from IEX's free historical captures: the reader, the
 * measures, the published file and the collector, offline.
 *
 *   node scripts/__tests__/market-context.test.mjs
 *
 * Four things are held here:
 *   1. the reader takes a close only from an eligible regular-session trade,
 *      undoes broken trades, and calls a day it did not finish unfinished;
 *   2. each measure is what its definition says, worked by hand;
 *   3. nothing published is, or can be turned back into, a price: every
 *      measure is unchanged when every price is multiplied by the same
 *      number, so no price level, dollar range, P/E, market value or upside
 *      to a target can be recovered from the file;
 *   4. the collector keeps its closes outside the working tree, writes
 *      nothing until a measure can be stated, and resumes from its state.
 */

import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { TopsCloseReader, readTopsCloses, eligibleCloses, IEX_ATTRIBUTION } from '../../lib/iex-tops.mjs';
import {
  adjustForSplits,
  buildContext,
  COLUMNS,
  drawdownBucket,
  emptyState,
  measuresFor,
  momentumBucket,
  pendingDays,
  pruneState,
  rangeBucket,
  readyToPublish,
  recordDay,
  recordFailure,
  roundVolatility,
  splitRatio,
  topsDays,
  volatilityBand,
} from '../../lib/market-context.mjs';
import { dayCapture, frame, nyMs, pcap, pcapng, systemMessage, tradeMessage } from './fixtures/iex-capture.mjs';

let pass = 0;
let fail = 0;
const check = (name, cond, detail) => {
  if (cond) {
    pass += 1;
    console.log(`PASS  ${name}`);
  } else {
    fail += 1;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
};
const eq = (name, got, want) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const near = (name, got, want, tol = 1e-9) => check(name, Math.abs(got - want) <= tol, `got ${got}, want ${want}`);

const DAY = '2026-10-16';
const read = (buf, chunk = buf.length) => {
  const r = new TopsCloseReader();
  for (let i = 0; i < buf.length; i += chunk) r.push(buf.subarray(i, i + chunk));
  return r.result();
};

// ── 1. the reader ────────────────────────────────────────────────────────
{
  const t = (sym, hhmm, price, id, flags = 0, size = 100) => tradeMessage({ atMs: nyMs(DAY, hhmm), symbol: sym, price, id, flags, size });
  const brk = (sym, hhmm, price, id, size = 100) => tradeMessage({ type: 'B', atMs: nyMs(DAY, hhmm), symbol: sym, price, id, size });
  const frames = [
    frame([systemMessage('R', nyMs(DAY, '09:30'))]),
    frame([t('AAA', '10:00', 10.5, 1), t('AAA', '15:50', 11.25, 2)]),
    // An odd lot and an extended-hours print after it: neither is a last sale.
    frame([t('AAA', '15:58', 99, 3, 0x20), t('AAA', '16:30', 98, 4, 0x40)]),
    // An intermarket sweep and a closing cross both are.
    frame([t('BBB', '15:40', 20, 5, 0x80), t('BBB', '16:00', 20.4, 6, 0x08)], { vlan: true }),
    // The last trade broken: the one before it stands.
    frame([t('CCC', '15:45', 30, 7), t('CCC', '15:59', 31, 8), brk('CCC', '16:05', 31, 8)]),
    // Both broken: the close is unknown, not guessed.
    frame([t('DDD', '15:45', 40, 9), t('DDD', '15:59', 41, 10), brk('DDD', '16:05', 41, 10), brk('DDD', '16:05', 40, 9)]),
    // A thin name whose last IEX trade was at eleven.
    frame([t('EEE', '11:00', 50, 11)]),
    // Another protocol on the wire is counted and skipped.
    frame([t('ZZZ', '15:55', 1, 12)], { protocol: 0x8004 }),
    frame([systemMessage('M', nyMs(DAY, '16:00')), systemMessage('C', nyMs(DAY, '20:00'))]),
  ];
  const whole = read(pcapng(frames));
  eq('pcapng is recognised', whole.format, 'pcapng');
  eq('a day that reached the end-of-messages event is complete', whole.complete, true);
  eq('the session boundaries are read', [new Date(whole.session.open).toISOString(), new Date(whole.session.close).toISOString()], ['2026-10-16T13:30:00.000Z', '2026-10-16T20:00:00.000Z']);
  eq('odd lots and extended hours do not set the last price', whole.symbols.AAA.price, 11.25);
  eq('nor count as volume', whole.symbols.AAA.volume, 200);
  eq('an ISO and the closing cross do, through a VLAN tag', whole.symbols.BBB.price, 20.4);
  eq('a broken last trade gives way to the one before', [whole.symbols.CCC.price, whole.symbols.CCC.volume], [30, 100]);
  eq('two broken trades leave no price', whole.symbols.DDD.price, null);
  eq('another protocol is skipped', [whole.symbols.ZZZ, whole.counts.otherProtocol], [undefined, 1]);
  eq('trades and breaks are counted', [whole.counts.trades, whole.counts.ineligible, whole.counts.breaks], [11, 2, 3]);

  eq('the same capture fed a byte at a time reads the same', read(pcapng(frames), 1), whole);
  eq('fed in odd-sized chunks, the same', read(pcapng(frames), 37), whole);
  const classic = read(pcap(frames));
  eq('a classic pcap reads the same', { ...classic, format: 'pcapng' }, whole);

  const closes = eligibleCloses(whole);
  eq('closes are kept only from the final half hour, with a price', Object.keys(closes).sort(), ['AAA', 'BBB', 'CCC']);
  eq('a close carries price, volume and dollar volume', closes.AAA, [11.25, 200, 2175]);

  const noEnd = read(pcapng(frames.slice(0, -1)));
  eq('a capture without the end of the day is not complete', noEnd.complete, false);
  eq('and yields no closes', eligibleCloses(noEnd), null);

  // A half day ends at one o'clock: a 12:45 trade closes it, 12:15 does not.
  const half = read(pcapng([
    frame([systemMessage('R', nyMs(DAY, '09:30'))]),
    frame([t('HHH', '12:45', 5, 1), t('JJJ', '12:15', 6, 2)]),
    frame([systemMessage('M', nyMs(DAY, '13:00')), systemMessage('C', nyMs(DAY, '17:00'))]),
  ]));
  eq('a half day is judged against its own close', Object.keys(eligibleCloses(half)), ['HHH']);

  let threw = '';
  try {
    read(Buffer.from('not a capture at all, just text'));
  } catch (e) {
    threw = e.message;
  }
  check('a file that is not a capture is refused', /not a capture/.test(threw), threw);
}

// The streaming path, gzip and all, and a download cut off half way.
{
  const buf = dayCapture(DAY, { AAA: 12.5, BBB: 7 });
  const gz = gzipSync(buf);
  const full = await readTopsCloses(Readable.from([gz.subarray(0, 100), gz.subarray(100)]));
  eq('a gzip stream is read to the end', [full.complete, full.symbols.AAA.price, full.bytes], [true, 12.5, buf.length]);
  const cut = await readTopsCloses(Readable.from([gz.subarray(0, gz.length - 20)]));
  eq('a truncated download is incomplete, not an error', [cut.complete, typeof cut.error], [false, 'string']);
}

// ── 2. the measures ──────────────────────────────────────────────────────
{
  eq('range in fifths', [0, 0.19, 0.2, 0.5, 0.79, 0.8, 1].map(rangeBucket), ['near-low', 'near-low', 'lower', 'middle', 'upper', 'near-high', 'near-high']);
  eq('drawdown bands', [0, 0.049, 0.05, 0.2, 0.3, 0.49, 0.5].map(drawdownBucket), ['within-5', 'within-5', '5-15', '15-30', '30-50', '30-50', 'over-50']);
  eq('momentum bands', [-0.3, -0.2, -0.1, 0, 0.05, 0.1, 0.2, 0.21].map(momentumBucket), ['strong-down', 'down', 'down', 'flat', 'flat', 'up', 'up', 'strong-up']);
  eq('volatility to the nearest five points', [0.2249, 0.2251, 0.31, 0.6].map(roundVolatility), [20, 25, 30, 60]);
  eq('volatility bands', [0.1, 0.2, 0.34, 0.35, 0.6].map(volatilityBand), ['low', 'moderate', 'moderate', 'high', 'very-high']);
  eq('split ratios: 2-for-1, 1-for-10, 3-for-2, and a fall that is no ratio', [splitRatio(0.5), splitRatio(10.1), splitRatio(1 / 1.5), splitRatio(0.43)], [0.5, 10, 1 / 1.5, null]);

  const e = (p, v = 1000) => [p, v, p * v];

  // A steady climb from 100 to 151 over 253 days: at its high, up strongly.
  const climb = Array.from({ length: 253 }, (_, i) => e(100 + i * (51 / 252)));
  const m = measuresFor(climb);
  eq('a steady climb sits at its high', [m.range12m, m.drawdown12m], ['near-high', 'within-5']);
  eq('and is up over three months and a year', [m.momentum3m, m.momentum12m], ['up', 'strong-up']);
  eq('with full coverage and no lag', [m.coverage, m.lag], [1, 0]);

  // Volatility, by hand: log returns alternating +r and -r have a sample
  // standard deviation of r * sqrt(n / (n - 1)) over n returns.
  const r = 0.02;
  const zig = Array.from({ length: 253 }, (_, i) => e(100 * Math.exp(i % 2 ? r : 0)));
  const vz = measuresFor(zig);
  const n3 = 62;
  const sd3 = r * Math.sqrt(n3 / (n3 - 1));
  eq('volatility is the annualised deviation of daily returns, rounded', vz.volatilityPct, roundVolatility(sd3 * Math.sqrt(252)));
  eq('a steady regime reads typical against its own year', vz.volatilityVsOwn12m, 'typical');
  eq('and is banded', vz.volatilityBand, volatilityBand(sd3 * Math.sqrt(252)));

  // Quiet for nine months, then a turbulent quarter.
  const turbulent = Array.from({ length: 253 }, (_, i) => e(100 * Math.exp(i % 2 ? (i > 190 ? 0.05 : 0.005) : 0)));
  eq('a turbulent quarter reads elevated', measuresFor(turbulent).volatilityVsOwn12m, 'elevated');

  // Coverage below four days in five: the twelve-month measures are withheld.
  const sparse = climb.map((x, i) => (i % 3 === 0 ? null : x));
  const ms = measuresFor(sparse);
  eq('two closes in three is too few for a twelve-month measure', [ms.range12m, ms.drawdown12m, ms.momentum12m], [null, null, null]);
  const recentOnly = climb.map((x, i) => (i < 150 ? null : x));
  const mr = measuresFor(recentOnly);
  eq('a recent listing gets its three-month measures and nothing longer', [mr.momentum3m !== null, mr.volatilityPct !== null, mr.range12m], [true, true, null]);

  const stale = [...climb.slice(0, 250), null, null, null];
  eq('no close in the last three trading days: nothing at all', measuresFor(stale), null);
  const lagged = [...climb.slice(0, 251), null, null];
  eq('two days behind is still stated, and says so', measuresFor(lagged)?.lag, 2);

  // A 2-for-1 split on ordinary dollar volume: adjusted, so no false collapse.
  const split = Array.from({ length: 253 }, (_, i) => (i < 200 ? e(200, 1000) : e(100, 2000)));
  const adj = adjustForSplits(split);
  eq('a split on ordinary dollar volume is adjusted', [adj.splits.length, adj.prices[0], adj.prices[252]], [1, 100, 100]);
  const msplit = measuresFor(split);
  eq('and the stock reads as flat, not halved', [msplit.drawdown12m, msplit.momentum12m], ['within-5', 'flat']);

  // The same halving on ten times the usual dollar volume is a collapse that
  // happens to match a ratio: neither adjusted nor trusted.
  const crash = Array.from({ length: 253 }, (_, i) => (i < 200 ? e(200, 1000) : i === 200 ? e(100, 20000) : e(100, 1000)));
  eq('a ratio-shaped collapse on heavy volume is withheld', measuresFor(crash), { withheld: 'unexplained-jump' });

  // A 57% fall is no split ratio, so it is simply a fall.
  const fall = Array.from({ length: 253 }, (_, i) => (i < 240 ? e(100) : e(43)));
  eq('a fall that matches no ratio is a fall', [measuresFor(fall).drawdown12m, measuresFor(fall).range12m], ['over-50', 'near-low']);
}

// ── 3. the published file holds no price, and no price can be recovered ──
const calendarOf = (n, from = '2025-10-01') => {
  const out = [];
  const d = new Date(`${from}T00:00:00Z`);
  while (out.length < n) {
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
};
const stateFrom = (calendar, priceOf) => {
  const s = emptyState();
  s.calendar = calendar;
  calendar.forEach((date, i) => {
    const closes = {};
    for (const [sym, f] of Object.entries(priceOf)) {
      const p = f(i);
      if (p !== null) closes[sym] = [p, 1000, p * 1000];
    }
    recordDay(s, date, closes, { open: 0, close: 0 });
  });
  return s;
};
{
  const cal = calendarOf(260);
  const series = {
    ABCD: (i) => 123.4567 + i * 0.37,
    WXYZ: (i) => 88.8123 - i * 0.11 + (i % 2) * 1.3,
    'BRK.B': (i) => 512.3456 + Math.sin(i / 9) * 20,
    ZVZZT: (i) => 10 + i, // an IEX test symbol
    'ABCD+': (i) => 1.2345, // a warrant
  };
  const s = stateFrom(cal, series);
  const ctx = buildContext(s, { generatedAt: '2026-10-17T12:00:00Z', attribution: IEX_ATTRIBUTION, termsUrl: 'x' });
  eq('the file lists real securities only', Object.keys(ctx.symbols), ['ABCD', 'BRK.B', 'WXYZ']);
  eq('each row follows the published columns', ctx.symbols.ABCD.length, COLUMNS.length);
  eq('the as-of date is the last day read', ctx.asOf, cal.at(-1));
  check('the attribution IEX asks for travels with the data', ctx.source.attribution === IEX_ATTRIBUTION);

  // No number in the file is a price: each is a lag, a coverage share or a
  // volatility in whole multiples of five.
  const numbers = [];
  for (const row of Object.values(ctx.symbols)) row.forEach((v, i) => typeof v === 'number' && numbers.push([COLUMNS[i], v]));
  check('every number is a lag, a coverage share or a rounded volatility', numbers.every(([c, v]) =>
    (c === 'lag' && Number.isInteger(v) && v <= 2) || (c === 'coverage' && v >= 0 && v <= 1) || (c === 'volatilityPct' && v % 5 === 0)), JSON.stringify(numbers));
  const text = JSON.stringify(ctx);
  const published = new Set(Object.keys(ctx.symbols));
  const prices = Object.values(s.days).flatMap((d) => Object.entries(d.closes).filter(([sym]) => published.has(sym)).map(([, c]) => c[0]));
  const leaked = prices.filter((p) => text.includes(String(p)) || text.includes(p.toFixed(2)));
  eq('no close appears in the file, to the cent or in full', leaked.slice(0, 3), []);
  const keys = [];
  const walk = (o) => {
    if (o && typeof o === 'object' && !Array.isArray(o)) for (const [k, v] of Object.entries(o)) { keys.push(k); walk(v); }
  };
  walk({ ...ctx, symbols: {} });
  eq('no field is named for a price', keys.filter((k) => /^(price|close|high|low|open|last|marketCap|pe|eps|range)$/i.test(k)), []);

  // The decisive test. Multiply every price by the same number and every
  // published measure is unchanged. So the file cannot distinguish a $10
  // stock from a $1,000 one, and no price, 52-week dollar range, P/E (price
  // over public EPS), market value (price times public shares) or exact
  // upside to a price target can be computed from it.
  for (const k of [0.01, 1.37, 250]) {
    const scaled = stateFrom(cal, Object.fromEntries(Object.entries(series).map(([sym, f]) => [sym, (i) => f(i) * k])));
    const other = buildContext(scaled, { generatedAt: '2026-10-17T12:00:00Z', attribution: IEX_ATTRIBUTION, termsUrl: 'x' });
    eq(`prices multiplied by ${k} publish the identical file`, other, ctx);
  }

  // P/E needs a price: the file offers none to divide by public EPS.
  const eps = 6.17;
  const candidates = Object.values(ctx.symbols.ABCD).filter((v) => typeof v === 'number');
  check('no number in a row divided by public EPS gives the P/E', candidates.every((v) => Math.abs(v / eps - series.ABCD(259) / eps) > 1), JSON.stringify(candidates));
  // Market value needs a price times shares; target upside needs a price.
  const shares = 1_000_000;
  check('no number in a row times public shares gives the market value', candidates.every((v) => Math.abs(v * shares - series.ABCD(259) * shares) > shares));
  const target = 250;
  check('no number in a row gives the exact upside to a $250 target', candidates.every((v) => Math.abs(target / v - 1 - (target / series.ABCD(259) - 1)) > 0.01));
  // A 52-week dollar range needs the high and low: the file states a fifth.
  check('the range is a fifth of the range, never its dollar ends', ['near-low', 'lower', 'middle', 'upper', 'near-high'].includes(ctx.symbols.ABCD[COLUMNS.indexOf('range12m')]));
}

// State bookkeeping: what is pending, newest first, and what is given up on.
{
  const index = {
    20261014: [{ feed: 'DEEP', link: 'd' }, { feed: 'TOPS', version: '1.6', link: 'a', size: '10' }],
    20261015: [{ feed: 'TOPS', version: '1.6', link: 'b', size: '11' }],
    20261016: [{ feed: 'TOPS', version: '1.6', link: 'c', size: '12' }],
    20261017: [{ feed: 'DEEP', link: 'only-deep' }],
    junk: [],
  };
  const days = topsDays(index);
  eq('the index gives one TOPS capture per trading day, oldest first', days.map((d) => [d.date, d.link]), [['2026-10-14', 'a'], ['2026-10-15', 'b'], ['2026-10-16', 'c']]);
  const s = emptyState();
  pruneState(s, days, 3);
  recordDay(s, '2026-10-15', { X: [1, 1, 1] }, {});
  eq('pending is newest first and skips what was read', pendingDays(days, s, 3).map((d) => d.date), ['2026-10-16', '2026-10-14']);
  for (let i = 0; i < 3; i += 1) recordFailure(s, '2026-10-14', 'download exited 22');
  eq('a day that failed three times is not tried again', pendingDays(days, s, 3).map((d) => d.date), ['2026-10-16']);
  pruneState(s, days, 1);
  eq('days that leave the lookback leave the state', [s.calendar, Object.keys(s.days), Object.keys(s.failed)], [['2026-10-16'], [], []]);
}

// ── 4. the collector, end to end on local captures ──────────────────────
{
  const work = mkdtempSync(join(tmpdir(), 'market-context-'));
  const cal = calendarOf(66, '2026-07-01');
  const filler = Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`F${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + Math.floor(i / 26) % 26)}${String.fromCharCode(65 + Math.floor(i / 676))}`, 0]));
  const index = {};
  const captures = [];
  cal.forEach((date, i) => {
    const prices = { ACME: 41.2345 + i * 0.1 };
    for (const k of Object.keys(filler)) prices[k] = 10 + (i % 5) * 0.5;
    const file = join(work, `${date}.pcap.gz`);
    writeFileSync(file, gzipSync(dayCapture(date, prices)));
    const key = date.replaceAll('-', '');
    index[key] = [{ feed: 'TOPS', version: '1.6', link: `https://example.invalid/${key}`, size: '1' }];
    captures.push('--capture', `${date}=${file}`);
  });
  writeFileSync(join(work, 'index.json'), JSON.stringify(index));
  const out = join(work, 'market-context.auto.json');
  const state = join(work, 'state.json.gz');
  const run = (...extra) => spawnSync(process.execPath, ['scripts/sync-market-context.mjs', '--state', state, '--out', out, '--index', join(work, 'index.json'), ...captures, ...extra], { encoding: 'utf8' });

  const inTree = spawnSync(process.execPath, ['scripts/sync-market-context.mjs', '--state', 'data/state.json.gz'], { encoding: 'utf8' });
  check('a state inside the working tree is refused', inTree.status !== 0 && /outside the working tree/.test(inTree.stderr), inTree.stderr);

  const first = run('--max-days', '40');
  check('the first run reads forty days', first.status === 0 && /read 40, failed 0/.test(first.stdout), first.stdout + first.stderr);
  eq('with three months not yet read, nothing is written', existsSync(out), false);
  check('and it says why', /not enough history yet/.test(first.stdout));

  const second = run();
  check('the second run resumes from the state and reads the rest', second.status === 0 && /read 26, failed 0/.test(second.stdout), second.stdout + second.stderr);
  const ctx = JSON.parse(readFileSync(out, 'utf8'));
  eq('the file is as of the last trading day', ctx.asOf, cal.at(-1));
  eq('a full three months gives the three-month measures', [ctx.symbols.ACME[COLUMNS.indexOf('momentum3m')], ctx.symbols.ACME[COLUMNS.indexOf('range12m')]], ['up', null]);
  check('the log names no price', !/41\.\d|4[0-9]\.\d{2}/.test(second.stdout + first.stdout));
  check('nor does the file', !JSON.stringify(ctx).includes('41.23'));

  const third = run();
  check('a run with nothing new leaves the file alone', third.status === 0 && /left as it is/.test(third.stdout), third.stdout);

  // A day IEX has not finished publishing: recorded as a failure, retried later.
  const broken = join(work, 'broken.pcap.gz');
  writeFileSync(broken, gzipSync(dayCapture('2026-10-01', { ACME: 1 })).subarray(0, 60));
  index['20261001'] = [{ feed: 'TOPS', version: '1.6', link: 'x', size: '1' }];
  writeFileSync(join(work, 'index.json'), JSON.stringify(index));
  const fourth = run('--capture', `2026-10-01=${broken}`);
  check('a truncated capture is not read and is retried later', fourth.status === 0 && /2026-10-01: not read .*attempt 1/.test(fourth.stdout), fourth.stdout);
  rmSync(work, { recursive: true, force: true });
}

// The collector's state is never inside the repository, and the publication
// carries only the derived file. See the workflow test for the other half.
{
  const wf = readFileSync('.github/workflows/market-context.yml', 'utf8');
  check('the workflow keeps the state in the runner temp directory', /--state "\$RUNNER_TEMP\/market-context\/state\.json\.gz"/.test(wf));
  check('and in the Actions cache, never in a commit', /actions\/cache\/restore@/.test(wf) && /actions\/cache\/save@/.test(wf));
  check('the workflow publishes through the shared publisher as market-context', /producer: market-context/.test(wf));
}

check('readyToPublish needs a full three-month window', readyToPublish(emptyState()) === false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
