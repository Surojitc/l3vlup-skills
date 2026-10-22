/**
 * IEX reference prices from IEX's free historical captures: the reader, the
 * quality gate, the 52-week figures, the published files and the collector,
 * offline.
 *
 *   node scripts/__tests__/market-reference.test.mjs
 *
 * What is held:
 *   1. the reader keeps the last eligible regular-session trade, undoes broken
 *      trades, counts the evidence (trades, late trades, dollar volume) and
 *      calls a day it did not finish unfinished;
 *   2. the quality gate: HIGH, USABLE or nothing, at its boundaries, and a
 *      thin or early-closing name gets no reference price;
 *   3. a stale observation, an unconfirmed jump, a split and a ratio-shaped
 *      collapse are each handled by rule, never by guessing;
 *   4. the 52-week high and low, the bases of the 1, 3, 6 and 12-month
 *      changes, the drawdown and the volatility, worked by hand;
 *   5. the files: dated, attributed, never called a close, and no daily
 *      database in them;
 *   6. the collector keeps its database outside the working tree, never reads
 *      a day twice, and publishes once five days are read.
 */

import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { TopsCloseReader, readTopsCloses, referenceObservations, gradeObservation, QUALITY_RULES, IEX_ATTRIBUTION, METHODOLOGY_VERSION } from '../../lib/iex-tops.mjs';
import {
  adjustForSplits,
  buildReference,
  COLUMNS,
  emptyState,
  maxDrawdown,
  pendingDays,
  pruneState,
  readyToPublish,
  realisedVolatility,
  recordDay,
  recordFailure,
  rowFor,
  splitRatio,
  topsDays,
  weekly,
} from '../../lib/market-reference.mjs';
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
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const near = (name, got, want, tol = 1e-9) => check(name, typeof got === 'number' && Math.abs(got - want) <= tol, `got ${got}, want ${want}`);

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
    // Both broken: no price, not a guess.
    frame([t('DDD', '15:45', 40, 9), t('DDD', '15:59', 41, 10), brk('DDD', '16:05', 41, 10), brk('DDD', '16:05', 40, 9)]),
    frame([t('EEE', '11:00', 50, 11)]),
    frame([t('ZZZ', '15:55', 1, 12)], { protocol: 0x8004 }),
    frame([systemMessage('M', nyMs(DAY, '16:00')), systemMessage('C', nyMs(DAY, '20:00'))]),
  ];
  const whole = read(pcapng(frames));
  eq('pcapng is recognised and the day complete', [whole.format, whole.complete], ['pcapng', true]);
  eq('the session boundaries are read', [new Date(whole.session.open).toISOString(), new Date(whole.session.close).toISOString()], ['2026-10-16T13:30:00.000Z', '2026-10-16T20:00:00.000Z']);
  eq('odd lots and extended hours set no price and count as no trade', [whole.symbols.AAA.price, whole.symbols.AAA.trades, whole.symbols.AAA.volume], [11.25, 2, 200]);
  eq('the final half hour holds one of its two trades', whole.symbols.AAA.lateTrades, 1);
  eq('an ISO and the closing cross set the price, through a VLAN tag', [whole.symbols.BBB.price, whole.symbols.BBB.lateTrades], [20.4, 2]);
  eq('a broken last trade gives way to the one before, and leaves the counts', [whole.symbols.CCC.price, whole.symbols.CCC.trades, whole.symbols.CCC.lateTrades, whole.symbols.CCC.volume], [30, 1, 1, 100]);
  eq('two broken trades leave no price', whole.symbols.DDD.price, null);
  eq('another protocol is skipped', [whole.symbols.ZZZ, whole.counts.otherProtocol], [undefined, 1]);
  eq('the same capture a byte at a time reads the same', read(pcapng(frames), 1), whole);
  eq('in odd-sized chunks, the same', read(pcapng(frames), 37), whole);
  eq('a classic pcap reads the same', { ...read(pcap(frames)), format: 'pcapng' }, whole);
  const noEnd = read(pcapng(frames.slice(0, -1)));
  eq('a capture without the end of the day is incomplete and has no observations', [noEnd.complete, referenceObservations(noEnd)], [false, null]);
  let threw = '';
  try {
    read(Buffer.from('not a capture at all, just text'));
  } catch (e) {
    threw = e.message;
  }
  check('a file that is not a capture is refused', /not a capture/.test(threw), threw);
}
{
  const buf = dayCapture(DAY, { AAA: 12.5 });
  const gz = gzipSync(buf);
  const full = await readTopsCloses(Readable.from([gz.subarray(0, 100), gz.subarray(100)]));
  eq('a gzip stream is read to the end', [full.complete, full.symbols.AAA.price, full.bytes], [true, 12.5, buf.length]);
  const cut = await readTopsCloses(Readable.from([gz.subarray(0, gz.length - 20)]));
  eq('a truncated download is incomplete, not an error', [cut.complete, typeof cut.error], [false, 'string']);
}

// ── 2. the quality gate ──────────────────────────────────────────────────
{
  const H = QUALITY_RULES.H;
  const U = QUALITY_RULES.U;
  const at = (o) => gradeObservation({ trades: H.minTrades, dollarVolume: H.minDollarVolume, lateTrades: H.minLateTrades, secondsBeforeClose: H.maxSecondsBeforeClose, ...o });
  eq('HIGH exactly at every threshold', at({}), 'H');
  eq('one trade short of HIGH is USABLE', at({ trades: H.minTrades - 1 }), 'U');
  eq('a dollar short of HIGH is USABLE', at({ dollarVolume: H.minDollarVolume - 1 }), 'U');
  eq('a late trade short of HIGH is USABLE', at({ lateTrades: H.minLateTrades - 1 }), 'U');
  eq('a second too early for HIGH is USABLE', at({ secondsBeforeClose: H.maxSecondsBeforeClose + 1 }), 'U');
  eq('USABLE exactly at its thresholds', gradeObservation({ trades: U.minTrades, dollarVolume: U.minDollarVolume, lateTrades: U.minLateTrades, secondsBeforeClose: U.maxSecondsBeforeClose }), 'U');
  eq('below USABLE on trades: nothing', gradeObservation({ trades: U.minTrades - 1, dollarVolume: 1e9, lateTrades: 99, secondsBeforeClose: 0 }), null);
  eq('below USABLE on dollar volume: nothing', gradeObservation({ trades: 999, dollarVolume: U.minDollarVolume - 1, lateTrades: 99, secondsBeforeClose: 0 }), null);
  eq('below USABLE on late trades: nothing', gradeObservation({ trades: 999, dollarVolume: 1e9, lateTrades: U.minLateTrades - 1, secondsBeforeClose: 0 }), null);

  const day = read(dayCapture(DAY, {
    LIQ: { price: 50, trades: 150, late: 12, lastAt: '15:59' }, // HIGH: 150 x 1,000 x $50
    MID: 25, // USABLE: 25 x 1,000 x $25 = $625,000, 4 late, last 15:58
    THIN: { price: 25, trades: 10 }, // too few trades
    TINY: { price: 2, trades: 30 }, // $60,000: too little traded
    EARLY: { price: 25, lastAt: '15:20' }, // last trade before the window
    'ABC+': 25, // a warrant: not a reference symbol
  }));
  const obs = referenceObservations(day);
  eq('a liquid name is HIGH, a moderate one USABLE, and thin ones have nothing', Object.fromEntries(Object.entries(obs).map(([k, v]) => [k, v[1]])), { LIQ: 'H', MID: 'U', 'ABC+': 'U' });
  eq('an observation carries price, grade, seconds before the bell, trades, late trades and dollar volume', obs.LIQ, [50, 'H', 60, 150, 12, 7500000]);
  const half = read(dayCapture(DAY, { HALF: { price: 30, lastAt: '12:58' }, LATE: { price: 30, lastAt: '12:20' } }, { close: '13:00' }));
  eq('a half day is judged against its own one-o\'clock close', Object.keys(referenceObservations(half)), ['HALF']);
}

// ── 3. stale, jumps and splits ───────────────────────────────────────────
const o = (p, grade = 'H', dollars = p * 100000) => [p, grade, 60, 200, 15, dollars];
const flatYear = (p = 100, n = 253) => Array.from({ length: n }, () => o(p));
{
  const stale = [...flatYear().slice(0, 250), null, null, null];
  const r = rowFor(stale);
  eq('three trading days without an observation: stale, no price', [r.status, r.price, r.lag], ['stale', null, 3]);
  eq('two days behind is still priced, and says how far', [rowFor([...flatYear().slice(0, 251), null, null]).status, rowFor([...flatYear().slice(0, 251), null, null]).lag], ['ok', 2]);

  const jumpU = [...flatYear(100, 252), o(160, 'U')];
  eq('a 60% jump on a USABLE day is withheld until confirmed', [rowFor(jumpU).status, rowFor(jumpU).price], ['discontinuity', null]);
  const jumpH = [...flatYear(100, 252), o(160, 'H', 5e8)];
  eq('the same jump on a HIGH day stands', [rowFor(jumpH).status, rowFor(jumpH).price], ['ok', 160]);

  eq('split ratios: 2-for-1, 1-for-10, 3-for-2, and a fall that is no ratio', [splitRatio(0.5), splitRatio(10.1), splitRatio(1 / 1.5), splitRatio(0.43)], [0.5, 10, 1 / 1.5, null]);
  const split = Array.from({ length: 253 }, (_, i) => (i < 200 ? o(200, 'H', 2e7) : o(100, 'H', 2e7)));
  const adj = adjustForSplits(split);
  eq('a 2-for-1 split on ordinary dollar volume divides the earlier prices', [adj.splits, adj.prices[0], adj.prices[252], adj.latestJump], [[{ index: 200, ratio: 0.5 }], 100, 100, null]);
  const rs = rowFor(split);
  eq('so the year is flat on today\'s basis: high and low 100, no drawdown, the split listed', [rs.high52, rs.low52, rs.drawdownPeak, rs.splits], [100, 100, null, [[200, 0.5]]]);
  const crash = Array.from({ length: 253 }, (_, i) => (i < 200 ? o(200, 'H', 2e7) : i === 200 ? o(100, 'H', 2e8) : o(100, 'H', 2e7)));
  const rc = rowFor(crash);
  eq('a ratio-shaped halving on ten times the dollar volume: priced, 52-week figures withheld', [rc.price, rc.statsStatus, rc.high52], [100, 'unexplained-jump', null]);
  const fall = Array.from({ length: 253 }, (_, i) => (i < 240 ? o(100) : o(43)));
  const rf = rowFor(fall);
  eq('a 57% fall that matches no ratio is a fall', [rf.price, rf.high52, rf.low52], [43, 100, 43]);
}

// ── 4. the 52-week figures, by hand ──────────────────────────────────────
{
  // Index i (0..252) priced 100 + i, except a peak of 450 at index 100 and a dip to 80 at index 150.
  // Neither move is within 3% of a split ratio (450 / 199 = 2.26, 201 / 450 = 0.447, 80 / 249 = 0.321,
  // 251 / 80 = 3.14), so both are moves on HIGH days and stand as they are.
  const series = Array.from({ length: 253 }, (_, i) => o(i === 100 ? 450 : i === 150 ? 80 : 100 + i));
  const r = rowFor(series);
  eq('the price is the latest observation', [r.price, r.date, r.grade, r.lag, r.status], [352, 252, 'H', 0, 'ok']);
  eq('high 450 on index 100, low 80 on index 150', [r.high52, r.high52Date, r.low52, r.low52Date], [450, 100, 80, 150]);
  eq('bases: 21, 63, 126 and 252 days back', [r.base1m, r.base1mDate, r.base3m, r.base3mDate, r.base6m, r.base6mDate, r.base12m, r.base12mDate], [331, 231, 289, 189, 226, 126, 100, 0]);
  eq('the largest drawdown runs from the 450 peak to the 80 dip', [r.drawdownPeak, r.drawdownPeakDate, r.drawdownTrough, r.drawdownTroughDate], [450, 100, 80, 150]);
  eq('full coverage', [r.coverage, r.statsStatus], [1, 'ok']);

  // Volatility, by hand: log returns alternating +r and -r over n returns.
  const rr = 0.02;
  const zig = Array.from({ length: 253 }, (_, i) => o(100 * Math.exp(i % 2 ? rr : 0)));
  const z = rowFor(zig);
  const n3 = 63;
  const mean3 = (n3 % 2 ? rr : 0) / n3; // 63 returns: 32 of one sign, 31 of the other
  const plus = Math.ceil(n3 / 2);
  const v3 = Math.sqrt(((plus * (rr - mean3) ** 2) + ((n3 - plus) * (-rr - mean3) ** 2)) / (n3 - 1)) * Math.sqrt(252);
  near('3-month volatility is the annualised sample deviation of 63 daily log returns', z.vol3m, Math.round(v3 * 1e4) / 1e4, 1e-4);
  eq('with the count of returns behind it', [z.vol3mReturns, z.vol12mReturns], [63, 252]);
  const direct = realisedVolatility(zig.map((x) => x[0]), 252 - 63, 252);
  near('the published figure is the function\'s, rounded to four places', z.vol3m, Math.round(direct.annualised * 1e4) / 1e4);
  eq('a series that only rises has no drawdown', maxDrawdown([1, 2, 3], 0, 2), null);

  const sparse = series.map((x, i) => (i % 3 === 0 && i < 250 ? null : x));
  const sp = rowFor(sparse);
  eq('two days in three is too few for the 52-week figures', [sp.statsStatus, sp.high52, sp.low52, sp.base12m], ['history', null, null, null]);
  const young = series.map((x, i) => (i < 150 ? null : x));
  const yg = rowFor(young);
  eq('a recent listing gets its price, its 1 and 3-month bases and volatility, and no 52-week range', [yg.price !== null, yg.base1m !== null, yg.base3m !== null, yg.vol3m !== null, yg.base6m, yg.high52], [true, true, true, true, null, null]);
}

// ── 5. the published files ──────────────────────────────────────────────
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
    const obs = {};
    for (const [sym, f] of Object.entries(priceOf)) {
      const p = f(i);
      if (p !== null) obs[sym] = o(p);
    }
    recordDay(s, date, obs, { open: 0, close: 0 });
  });
  return s;
};
{
  const cal = calendarOf(260);
  const s = stateFrom(cal, {
    ABCD: (i) => 100 + i,
    'BRK.B': (i) => 500 + (i % 7),
    THIN: (i) => (i > 255 ? 20 : null),
    GONE: (i) => (i < 200 ? 30 : null),
    ZVZZT: (i) => 10 + i,
    'ABCD+': () => 1.5,
  });
  const { reference, history } = buildReference(s, { generatedAt: '2026-10-17T12:00:00Z', attribution: IEX_ATTRIBUTION, termsUrl: 'https://www.iex.io/legal/hist-data-terms', methodology: { version: METHODOLOGY_VERSION } });
  eq('real securities only: test symbols and warrants are left out', Object.keys(reference.symbols), ['ABCD', 'BRK.B', 'GONE', 'THIN']);
  eq('rows follow the published columns, dates as calendar indexes', [reference.symbols.ABCD.length, reference.columns, reference.calendar.length], [COLUMNS.length, COLUMNS, 260]);
  const row = Object.fromEntries(reference.columns.map((c, i) => [c, reference.symbols.ABCD[i]]));
  eq('the latest price and its date', [row.price, reference.calendar[row.date], row.grade], [359, cal.at(-1), 'H']);
  eq('the 52-week high and low with their dates', [row.high52, reference.calendar[row.high52Date], row.low52, reference.calendar[row.low52Date]], [359, cal[259], 108, cal[8]]);
  const gone = Object.fromEntries(reference.columns.map((c, i) => [c, reference.symbols.GONE[i]]));
  eq('a symbol that stopped trading is listed as stale, with no price', [gone.status, gone.price], ['stale', null]);
  eq('the counts say how many are priced', reference.counts, { listed: 4, priced: 3, high: 3, usable: 0, stale: 1, discontinuity: 0, fullYear: 2 });
  eq('the source names the price for what it is', [reference.source.price, reference.source.disclaimer], ['IEX reference price', 'Venue-specific IEX reference price; not a consolidated closing price.']);
  check('the attribution IEX requires travels with the data', reference.source.attribution === IEX_ATTRIBUTION && history.A.source.attribution === IEX_ATTRIBUTION);
  check('nothing calls it a close', !/"(close|closingPrice|officialClose|nbbo)"/i.test(JSON.stringify(reference)) && !/consolidated close"/i.test(JSON.stringify(reference)));
  eq('one shard per first letter, priced symbols only', Object.keys(history).sort(), ['A', 'B', 'T']);
  const weeks = history.A.symbols.ABCD;
  check('the history is weekly: at most 54 points for a year, each the last day of its week', weeks.length <= 54 && weeks.length >= 50, String(weeks.length));
  eq('the last point is the latest price', weeks.at(-1), [259, 359]);
  eq('weekly sampling picks Friday when Friday has a price', weekly([1, 2, 3, 4, 5, 6], ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-19'], 0), [[4, 5], [5, 6]]);
  check('no daily series is published anywhere: rows hold no arrays of prices', Object.values(reference.symbols).every((r) => r.every((v) => !Array.isArray(v) || v.every((x) => Array.isArray(x) && x.length === 2 && x[1] < 100))));
}

// State bookkeeping.
{
  const index = {
    20261014: [{ feed: 'DEEP', link: 'd' }, { feed: 'TOPS', version: '1.6', link: 'a', size: '10' }],
    20261015: [{ feed: 'TOPS', version: '1.6', link: 'b', size: '11' }],
    20261016: [{ feed: 'TOPS', version: '1.6', link: 'c', size: '12' }],
    20261017: [{ feed: 'DEEP', link: 'only-deep' }],
    junk: [],
  };
  const days = topsDays(index);
  eq('one TOPS capture per trading day, oldest first', days.map((d) => [d.date, d.link]), [['2026-10-14', 'a'], ['2026-10-15', 'b'], ['2026-10-16', 'c']]);
  const s = emptyState();
  pruneState(s, days, 3);
  recordDay(s, '2026-10-15', { X: o(1) }, {});
  eq('pending is newest first and never a day already read', pendingDays(days, s, 3).map((d) => d.date), ['2026-10-16', '2026-10-14']);
  for (let i = 0; i < 3; i += 1) recordFailure(s, '2026-10-14', 'download exited 22');
  eq('a day that failed three times is not tried again', pendingDays(days, s, 3).map((d) => d.date), ['2026-10-16']);
  pruneState(s, days, 1);
  eq('days that leave the lookback leave the state', [s.calendar, Object.keys(s.days), Object.keys(s.failed)], [['2026-10-16'], [], []]);
  check('readyToPublish needs five days', readyToPublish(emptyState()) === false);
}

// ── 6. the collector, end to end on local captures ──────────────────────
{
  const work = mkdtempSync(join(tmpdir(), 'market-reference-'));
  const cal = calendarOf(8, '2026-07-01');
  const filler = Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`F${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + Math.floor(i / 26) % 26)}${String.fromCharCode(65 + Math.floor(i / 676))}`, 0]));
  const index = {};
  const captures = [];
  cal.forEach((date, i) => {
    const prices = { ACME: { price: 41.2345 + i * 0.1, trades: 150, late: 12, lastAt: '15:59' } };
    for (const k of Object.keys(filler)) prices[k] = 10 + (i % 5) * 0.5;
    const file = join(work, `${date}.pcap.gz`);
    writeFileSync(file, gzipSync(dayCapture(date, prices)));
    const key = date.replaceAll('-', '');
    index[key] = [{ feed: 'TOPS', version: '1.6', link: `https://example.invalid/${key}`, size: '1' }];
    captures.push('--capture', `${date}=${file}`);
  });
  writeFileSync(join(work, 'index.json'), JSON.stringify(index));
  const out = join(work, 'market-reference.auto.json');
  const hist = join(work, 'market-history');
  const state = join(work, 'state.json.gz');
  const run = (...extra) => spawnSync(process.execPath, ['scripts/sync-market-reference.mjs', '--state', state, '--out', out, '--history-dir', hist, '--index', join(work, 'index.json'), ...captures, ...extra], { encoding: 'utf8' });

  const inTree = spawnSync(process.execPath, ['scripts/sync-market-reference.mjs', '--state', 'data/state.json.gz'], { encoding: 'utf8' });
  check('a state inside the working tree is refused', inTree.status !== 0 && /outside the working tree/.test(inTree.stderr), inTree.stderr);

  const first = run('--max-days', '3');
  check('the first run reads three days', first.status === 0 && /read 3, failed 0/.test(first.stdout), first.stdout + first.stderr);
  eq('with fewer than five days, nothing is written', existsSync(out), false);

  const second = run();
  check('the second run reads the other five and no day twice', second.status === 0 && /read 5, failed 0/.test(second.stdout) && /5 of the last 8 still to read/.test(second.stdout), second.stdout + second.stderr);
  const ref = JSON.parse(readFileSync(out, 'utf8'));
  const acme = Object.fromEntries(ref.columns.map((c, i) => [c, ref.symbols.ACME[i]]));
  eq('the file is as of the last day, ACME priced at its last trade, HIGH', [ref.asOf, ref.calendar[acme.date], acme.price, acme.grade, acme.secondsBeforeClose], [cal.at(-1), cal.at(-1), 41.9345, 'H', 60]);
  eq('with the day\'s IEX evidence: 150 trades, 12 late, 150,000 shares at 41.9345', [acme.trades, acme.lateTrades, acme.dollarVolume], [150, 12, Math.round(150000 * 41.9345)]);
  eq('the fillers are USABLE', ref.symbols.FAAA[ref.columns.indexOf('grade')], 'U');
  eq('the methodology names its version', ref.methodology.version, METHODOLOGY_VERSION);
  eq('history shards are written, one per first letter', readdirSync(hist).sort(), ['A.auto.json', 'F.auto.json']);
  check('the log names no price', !/41\.\d|10\.\d\d?\b/.test(second.stdout + first.stdout), second.stdout);

  const third = run();
  check('a run with nothing new reads nothing and leaves the file alone', third.status === 0 && /0 of the last 8 still to read/.test(third.stdout) && /left as it is/.test(third.stdout), third.stdout);

  const broken = join(work, 'broken.pcap.gz');
  writeFileSync(broken, gzipSync(dayCapture('2026-10-01', { ACME: 1 })).subarray(0, 60));
  index['20261001'] = [{ feed: 'TOPS', version: '1.6', link: 'x', size: '1' }];
  writeFileSync(join(work, 'index.json'), JSON.stringify(index));
  const fourth = run('--capture', `2026-10-01=${broken}`);
  check('a day IEX has not finished posting is recorded and retried later, and the run is not red', fourth.status === 0 && /2026-10-01: not read .*attempt 1/.test(fourth.stdout), fourth.stdout);
  rmSync(work, { recursive: true, force: true });
}

// The workflow: one run a day after the backfill, the database in the cache.
{
  const wf = readFileSync('.github/workflows/market-reference.yml', 'utf8');
  check('the state lives in the runner temp directory', /--state "\$RUNNER_TEMP\/market-reference\/state\.json\.gz"/.test(wf));
  check('and in the Actions cache, never in a commit', /actions\/cache\/restore@/.test(wf) && /actions\/cache\/save@/.test(wf));
  check('it publishes through the shared publisher as market-reference, and validated data publication is merged automatically', /uses: \.\/\.github\/workflows\/publish-data\.yml/.test(wf) && /producer: market-reference/.test(wf) && /merge: true/.test(wf) && !/merge: false/.test(wf));
  eq('one daily run and one retry, weekday sessions only; no six-hourly polling', [...wf.matchAll(/cron: '([^']+)'/g)].map((m) => m[1]), ['40 11 * * 2-6', '40 17 * * 2-6']);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
