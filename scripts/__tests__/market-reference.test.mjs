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
 *   3b. corporate actions: a large move is a candidate, classified on SEC
 *      filing evidence; only a confirmed split rescales, at the filing's
 *      ratio; any other action bounds the history, each window returning on
 *      its own; malformed or unknown classifications never rescale;
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
  loadState,
  maxDrawdown,
  pendingEvidence,
  pendingDays,
  pruneState,
  readyToPublish,
  realisedVolatility,
  recordDay,
  recordEvidence,
  resolverFor,
  STATE_VERSION,
  recordFailure,
  rowFor,
  splitRatio,
  topsDays,
  weekly,
} from '../../lib/market-reference.mjs';
import { ACTION, classify, publishedAction, readFilingText } from '../../lib/corporate-actions.mjs';
import { gatherEvidence, tickerIndex } from '../../lib/corporate-action-evidence.mjs';
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
  // A halving shaped exactly like a 2-for-1 split. On its shape alone it is a candidate, never an adjustment.
  const split = Array.from({ length: 253 }, (_, i) => (i < 200 ? o(200, 'H', 2e7) : o(100, 'H', 2e7)));
  const unread = adjustForSplits(split);
  eq('a split-shaped halving no filing has confirmed rescales nothing and bounds the history at its date', [unread.splits, unread.prices[0], unread.boundary, unread.actions.map((a) => [a.action.type, a.action.ratio, a.action.pending])], [[], 200, 200, [['UNRESOLVED', null, true]]]);
  const ru = rowFor(split);
  eq('so no 52-week figure spans it, and the price stands', [ru.price, ru.high52, ru.low52, ru.statsStatus, ru.splits], [100, null, null, 'history', []]);
  // The same move with the company's 8-K stating the split, and the cover share count doubling.
  const cal253 = calendarOf(253);
  const splitEvidence = { date: cal253[200], cik: 1, filings: [{ form: '8-K', filed: cal253[190], accession: '0000000001-26-000001', url: 'https://www.sec.gov/Archives/edgar/data/1/000000000126000001/split8k.htm', text: '<p>The Board approved a two-for-one stock split of the Company&#8217;s common stock.</p>' }], shares: [{ end: cal253[150], val: 50e6 }, { end: cal253[230], val: 100e6 }] };
  const confirmed = (c) => classify(c, splitEvidence);
  const adj = adjustForSplits(split, confirmed, cal253);
  eq('a 2-for-1 split its 8-K states divides the earlier prices at the filing\'s ratio', [adj.splits, adj.prices[0], adj.prices[252], adj.latestJump, adj.boundary], [[{ index: 200, ratio: 0.5 }], 100, 100, null, null]);
  const rs = rowFor(split, confirmed, cal253);
  eq('so the year is flat on today\'s basis: high and low 100, no drawdown, the split listed', [rs.high52, rs.low52, rs.drawdownPeak, rs.splits, rs.historyValidFrom], [100, 100, null, [[200, 0.5]], null]);
  eq('and the row carries the classification with its SEC provenance', rs.corporateActions, [{ corporate_action_type: 'CONFIRMED_SPLIT', corporate_action_effective_date: cal253[200], action_ratio: 0.5, action_confirmed: true, corporate_action_reason: `2-for-1 stock split, stated in the 8-K filed ${cal253[190]}; share count 50m on ${cal253[150]} and 100m on ${cal253[230]}`, evidence_source: '8-K', evidence_filing: '0000000001-26-000001', evidence_url: 'https://www.sec.gov/Archives/edgar/data/1/000000000126000001/split8k.htm' }]);
  const crash = Array.from({ length: 253 }, (_, i) => (i < 200 ? o(200, 'H', 2e7) : i === 200 ? o(100, 'H', 2e8) : o(100, 'H', 2e7)));
  const rc = rowFor(crash);
  eq('a ratio-shaped halving on ten times the dollar volume: priced, 52-week figures withheld behind the boundary', [rc.price, rc.statsStatus, rc.high52, rc.splits.length], [100, 'history', null, 0]);
  const fall = Array.from({ length: 253 }, (_, i) => (i < 240 ? o(100) : o(43)));
  const rf = rowFor(fall);
  eq('a 57% fall that matches no ratio is a fall', [rf.price, rf.high52, rf.low52], [43, 100, 43]);
}

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

// ── 3b. corporate actions: candidates, evidence, the boundary ────────────
{
  // What a filing says, on real filings' sentences (CrowdStrike, Tilray, Service Properties, Carvana, Corteva).
  const splitsIn = (t) => readFilingText(t).splits.map((x) => x.ratio);
  eq('a stated split ratio is read in figures and in words', [splitsIn('approved a four-for-one stock split'), splitsIn('a 3-for-2 stock split'), splitsIn('a 1:20 reverse split'), splitsIn('a five-for-one forward stock split of the Class A common stock')], [[0.25], [2 / 3], [20], [0.2]]);
  eq('a reverse split stated after a par value: "$0.0001 per share ..., at a ratio of one-for-ten"', splitsIn('approved a reverse stock split of the Company\'s outstanding shares of common stock, par value $0.0001 per share ("Common Stock"), at a ratio of one-for-ten (the "Reverse Stock Split")'), [10]);
  eq('"every five of our common shares ... converted and reclassified into one" is 1-for-5', splitsIn('Pursuant to the Reverse Share Split, every five of our common shares of beneficial interest, par value $.01 per share, issued and outstanding as of the Share Split Time were converted and reclassified into one common share of beneficial interest'), [5]);
  eq('"each share ... subdivided and reclassified into five shares" is 5-for-1', splitsIn('to effect a stock split. At the Effective Time, each share of the Company\'s Class A common stock issued and outstanding immediately prior to the Effective Time will be automatically subdivided and reclassified into five shares of the Class A common stock'), [0.2]);
  eq('figures that only sit near the word split are not a ratio', [splitsIn('the Stock Split and an increase in authorised shares from 7,756,156 to 52,000,000'), splitsIn('none-for-one split'), splitsIn('every two shares of preferred stock were converted into one share')], [[], [], []]);
  const corteva = readFilingText('<p>On October 1, 2026, Corteva, Inc. completed the previously announced separation of its seed business through a pro rata distribution of all of the outstanding shares of NewCo to Corteva stockholders.</p>');
  eq('a separation by distribution is a corporate action, with no split ratio', [corteva.splits, corteva.other.map((x) => x.kind)], [[], ['separation', 'distribution']]);

  const D = '2026-10-01';
  const url = (n) => `https://www.sec.gov/Archives/edgar/data/1/0000000001260000${String(n).padStart(2, '0')}/doc${n}.htm`;
  const filing = (form, filed, text, n = 1) => ({ form, filed, accession: `0000000001-26-0000${String(n).padStart(2, '0')}`, url: url(n), text });
  const cand = (change) => ({ index: 10, change, splitShaped: splitRatio(change), ordinaryVolume: true, grade: 'H' });
  const ev = (filings, shares = []) => ({ date: D, cik: 1, filings, shares });

  const r1 = classify(cand(0.25), ev([filing('8-K', '2026-09-10', 'a four-for-one stock split')], [{ end: '2026-08-01', val: 250e6 }, { end: '2026-11-01', val: 1000e6 }]));
  eq('a normal split: CONFIRMED_SPLIT at the 8-K\'s ratio, with the filing named', [r1.type, r1.ratio, r1.confirmed, r1.evidenceSource, r1.evidenceUrl], [ACTION.SPLIT, 0.25, true, '8-K', url(1)]);
  const r2 = classify(cand(10.2), ev([filing('8-K', '2026-09-28', 'a one-for-ten reverse stock split')]));
  eq('a reverse split: CONFIRMED_REVERSE_SPLIT at the stated 10, not the day\'s 10.2', [r2.type, r2.ratio], [ACTION.REVERSE, 10]);
  const r3 = classify(cand(1 / 6), ev([filing('8-K', D, 'completed the separation of its seed business; the spin-off was effected by a pro rata distribution')]));
  eq('Corteva: a 6-for-1-shaped move a spin-off explains is OTHER_CORPORATE_ACTION, never a guessed 6-for-1', [r3.type, r3.ratio, r3.confirmed, r3.reason], [ACTION.OTHER, null, true, `spin-off described in the 8-K filed ${D}`]);
  const r4 = classify(cand(0.5), ev([filing('8-K', '2026-09-30', 'reported third quarter results')]));
  eq('a split-shaped move no filing explains, with no share counts: UNRESOLVED', [r4.type, r4.ratio, r4.confirmed], [ACTION.UNRESOLVED, null, false]);
  eq('a large move that is no ratio, with no action behind it: an ordinary price move', classify(cand(0.43), ev([filing('8-K', '2026-09-30', 'announced topline results; the merger agreement was terminated')])), null);
  const flatShares = classify(cand(2 / 3), ev([], [{ end: '2026-08-01', val: 104.8e6 }, { end: '2026-11-15', val: 105e6 }]));
  eq('a split-shaped fall whose share count did not move, with nothing filed: UNRESOLVED, never ordinary on the count alone', [flatShares.type, flatShares.ratio, /rules out a split but does not explain the move/.test(flatShares.reason)], [ACTION.UNRESOLVED, null, true]);
  eq('only affirmative filing evidence classifies a split-shaped move that has been read: it is never ordinary', [[], [filing('8-K', '2026-09-30', 'reported results')]].map((f) => classify(cand(0.5), ev(f, [{ end: '2026-08-01', val: 100e6 }, { end: '2026-11-01', val: 100e6 }]))?.type), [ACTION.UNRESOLVED, ACTION.UNRESOLVED]);
  const r5 = classify(cand(0.5), ev([filing('8-K', '2026-09-10', 'a two-for-one stock split')], [{ end: '2026-08-01', val: 100e6 }, { end: '2026-11-01', val: 101e6 }]));
  eq('a stated split the share count contradicts: UNRESOLVED, not confirmed', [r5.type, r5.ratio, /do not move as it would/.test(r5.reason)], [ACTION.UNRESOLVED, null, true]);
  eq('a stated ratio the move does not match is not this move\'s split', classify(cand(0.5), ev([filing('8-K', '2026-09-10', 'a three-for-one stock split')])).type, ACTION.UNRESOLVED);
  eq('a split mentioned only in an annual report months before is not confirmed on its own', classify(cand(0.5), ev([filing('10-K', '2026-05-01', 'the two-for-one stock split effected in 2024')])).type, ACTION.UNRESOLVED);
  eq('a spin-off mentioned in a 10-K or a proxy establishes nothing', classify(cand(0.5), ev([filing('10-K', '2026-09-01', 'risks related to the spin-off'), filing('DEF 14A', '2026-09-15', 'a special dividend', 2)])).type, ACTION.UNRESOLVED);
  eq('an exchange ratio counts only behind a split-shaped move', [classify(cand(0.5), ev([filing('8-K', D, 'at the exchange ratio of 0.5 shares')])).type, classify(cand(0.55), ev([filing('8-K', D, 'at the exchange ratio of 0.5 shares')]))], [ACTION.OTHER, null]);
  eq('no evidence read yet: split-shaped is UNRESOLVED and pending, anything else ordinary', [classify(cand(0.5), null).type, classify(cand(0.5), null).pending, classify(cand(0.43), null)], [ACTION.UNRESOLVED, true, null]);

  // What is published.
  const pub = publishedAction({ type: ACTION.OTHER, ratio: 0.5, confirmed: true, reason: 'x', evidenceSource: '8-K', evidenceFiling: 'a', evidenceUrl: 'https://evil.example/doc.htm' }, D);
  eq('a non-split action never carries a ratio, and only an EDGAR document is published as evidence', [pub.action_ratio, pub.evidence_url], [null, null]);
  eq('a split\'s ratio is published as the filing states it, never rounded', publishedAction({ type: ACTION.SPLIT, ratio: 1 / 3, confirmed: true }, D).action_ratio, 1 / 3);

  // A confirmed split needs evidence and a ratio; nothing else, and nothing malformed, rescales.
  const halving = Array.from({ length: 253 }, (_, i) => o(i < 240 ? 200 : 100));
  const bad = [
    ['a split with no ratio', { type: ACTION.SPLIT, ratio: null, confirmed: true }],
    ['an unconfirmed split', { type: ACTION.SPLIT, ratio: 0.5, confirmed: false }],
    ['a split whose ratio points the wrong way', { type: ACTION.SPLIT, ratio: 2, confirmed: true }],
    ['a reverse split below one', { type: ACTION.REVERSE, ratio: 0.5, confirmed: true }],
    ['an OTHER action carrying a ratio', { type: ACTION.OTHER, ratio: 0.5, confirmed: true }],
    ['a class this code does not know', { type: 'STOCK_DIVIDEND', ratio: 0.5, confirmed: true }],
    ['a bare string', 'CONFIRMED_SPLIT'],
    ['a ratio of Infinity', { type: ACTION.SPLIT, ratio: Infinity, confirmed: true }],
  ];
  for (const [name, action] of bad) {
    const a = adjustForSplits(halving, () => action);
    check(`${name} rescales nothing and bounds the history`, a.splits.length === 0 && a.prices[0] === 200 && a.boundary === 240 && [ACTION.OTHER, ACTION.UNRESOLVED].includes(a.actions[0]?.action.type), JSON.stringify(a.actions));
  }
  const rowBad = rowFor(halving, () => ({ type: ACTION.OTHER, ratio: 0.5, confirmed: true }), calendarOf(253));
  eq('and the published row of an OTHER action carries no ratio', [rowBad.corporateActions[0].action_ratio, rowBad.splits], [null, []]);

  // A stored classification is used only for the move it was made for.
  const stored = { [D]: { shape: 0.5, change: 0.5, result: { type: ACTION.SPLIT, ratio: 0.5, confirmed: true } } };
  const res = resolverFor(stored);
  eq('a stored result applies to its own move, and never to a different one on the same date', [res(cand(0.5), D)?.type, res(cand(0.51), D)?.type, res(cand(0.5), '2026-10-02')?.type], [ACTION.SPLIT, ACTION.UNRESOLVED, ACTION.UNRESOLVED]);
  // A split-shaped move stored as ordinary under the earlier rule (an unchanged share count) is not used, and is read again.
  const legacy = { [D]: { shape: 2 / 3, change: 2 / 3, result: null, checkedAt: '2026-10-22T16:00:00Z', checks: 1 } };
  eq('a split-shaped move stored as ordinary is not trusted: it stands UNRESOLVED until read again', resolverFor(legacy)(cand(2 / 3), D)?.type, ACTION.UNRESOLVED);
  eq('a move with no split shape stored as ordinary stays ordinary', resolverFor({ [D]: { shape: null, change: 0.43, result: null } })(cand(0.43), D), null);
  const ls = emptyState();
  ls.calendar = calendarOf(30, '2026-09-01');
  ls.calendar.forEach((d, i) => recordDay(ls, d, { SRPT: o(i < 20 ? 150 : 100) }, {}));
  ls.actions = { SRPT: { [ls.calendar[20]]: { shape: 2 / 3, change: 100 / 150, result: null, checkedAt: '2026-10-22T16:00:00Z', checks: 1 } } };
  eq('and it is queued to be read again on the next run', pendingEvidence(ls, { now: new Date('2026-10-22T17:00:00Z') }).map((q) => q.symbol), ['SRPT']);

  // The event boundary, window by window. 253 days of 100 + i/10, the action between index b-1 and b (a 1/6 move).
  const cal = calendarOf(253);
  const other = () => ({ type: ACTION.OTHER, ratio: null, confirmed: true, reason: 'spin-off described in the 8-K', evidenceSource: '8-K', evidenceFiling: null, evidenceUrl: null });
  const bounded = (b) => rowFor(Array.from({ length: 253 }, (_, i) => o(i < b ? 600 + i : 100 + i / 10)), other, cal);
  const late = bounded(240);
  eq('12 days after a spin-off: the price stands, every trailing window crossing it is withheld', [late.price, late.historyValidFrom, late.statsStatus, late.base1m, late.base3m, late.vol3m, late.high52, late.low52, late.vol12m, late.drawdownPeak], [125.2, cal[240], 'history', null, null, null, null, null, null, null]);
  const mid = bounded(200);
  eq('52 days after: the 1-month change returns, its base after the event; 3, 6 and 12 months and the 52 weeks stay withheld', [mid.base1m, mid.base1mDate, mid.base3m, mid.base6m, mid.base12m, mid.vol3m, mid.high52], [123.1, 231, null, null, null, null, null]);
  const old = bounded(150);
  eq('102 days after: the 3-month change and 3-month volatility return; 6 and 12 months and the 52 weeks do not', [old.base3m, old.base3mDate, typeof old.vol3m, old.vol3mReturns, old.base6m, old.base12m, old.high52, old.vol12m], [118.9, 189, 'number', 63, null, null, null, null]);
  const just = bounded(189);
  eq('a window starting on the event day lies after it: the 3-month change and its 63 returns come back exactly then', [just.base3m, just.base3mDate, typeof just.vol3m, just.vol3mReturns], [118.9, 189, 'number', 63]);
  const oneShort = bounded(190);
  eq('one day later and neither does: the base would sit before the event', [oneShort.base3m, oneShort.vol3m], [null, null]);
  eq('a year after the event every figure is back', [bounded(0).historyValidFrom, typeof bounded(0).high52], [null, 'number']);

  // State: classifications persist beside the days, under the same version; the backfill survives.
  const s = emptyState();
  s.calendar = calendarOf(30, '2026-09-01');
  s.calendar.forEach((d, i) => recordDay(s, d, { SPLT: o(i < 20 ? 200 : 100), MOVE: o(i < 25 ? 100 : 43), QUIET: o(50), GONE: i < 10 ? o(i < 5 ? 100 : 50) : undefined }, {}));
  for (const d of s.calendar) if (!s.days[d].obs.GONE) delete s.days[d].obs.GONE;
  const queue = pendingEvidence(s);
  eq('the candidates to read: split-shaped first, then the most recent; a symbol no longer priced waits', queue.map((q) => [q.symbol, q.date]), [['SPLT', s.calendar[20]], ['MOVE', s.calendar[25]]]);
  const evSplit = { checked: true, date: s.calendar[20], cik: 1, filings: [filing('8-K', s.calendar[15], 'a two-for-one stock split')], shares: [] };
  recordEvidence(s, 'SPLT', queue[0].date, queue[0].candidate, evSplit, new Date('2026-10-14T12:00:00Z'));
  recordEvidence(s, 'MOVE', queue[1].date, queue[1].candidate, { checked: false, error: 'HTTP 503' }, new Date('2026-10-14T12:00:00Z'));
  eq('a classified candidate is not read again; an unreadable one is, a few times', pendingEvidence(s, { now: new Date('2026-10-14T13:00:00Z') }).map((q) => q.symbol), ['MOVE']);
  recordEvidence(s, 'SPLT', queue[0].date, queue[0].candidate, { checked: false, error: 'HTTP 503' }, new Date('2026-10-14T14:00:00Z'));
  eq('evidence that cannot be read keeps the classification already held', s.actions.SPLT[queue[0].date].result.type, ACTION.SPLIT);
  const round = loadState(JSON.parse(JSON.stringify(s)));
  eq('the state keeps its version and carries the classifications through a save', [STATE_VERSION, round.version, round.actions.SPLT[queue[0].date].result.ratio, Object.keys(round.days).length], [2, 2, 0.5, 30]);
  eq('a state saved before classifications existed loads with none, its days intact', [Object.keys(loadState({ version: 2, calendar: s.calendar, days: s.days, failed: {} }).actions).length, Object.keys(loadState({ version: 2, calendar: s.calendar, days: s.days, failed: {} }).days).length], [0, 30]);
  pruneState(s, s.calendar.slice(25).map((date) => ({ date, link: 'x' })), 5);
  eq('a classification leaves the state with its day', Object.keys(s.actions), ['MOVE']);

  // One symbol's bad record never touches another, or the file.
  const s2 = stateFrom(calendarOf(260), { ABCD: (i) => 100 + i, HALF: (i) => (i < 250 ? 200 : 100) });
  const halfDate = s2.calendar[250];
  s2.actions = { HALF: { [halfDate]: { shape: 0.5, change: 0.5, get result() { throw new Error('corrupt'); } } } };
  const built = buildReference(s2, { generatedAt: 'x', attribution: IEX_ATTRIBUTION, termsUrl: 'x', methodology: { version: METHODOLOGY_VERSION } });
  eq('a symbol whose record cannot be read is skipped, and the others publish as before', [Object.keys(built.reference.symbols), built.reference.counts.skipped, built.reference.symbols.ABCD[built.reference.columns.indexOf('high52')]], [['ABCD'], 1, 359]);
  s2.actions = { HALF: { [halfDate]: { shape: 0.5, change: 0.5, result: { type: ACTION.OTHER, ratio: null, confirmed: true, reason: 'spin-off', evidenceSource: '8-K', evidenceFiling: null, evidenceUrl: null } } } };
  const b2 = buildReference(s2, { generatedAt: 'x', attribution: IEX_ATTRIBUTION, termsUrl: 'x', methodology: { version: METHODOLOGY_VERSION } });
  const half = Object.fromEntries(b2.reference.columns.map((c, i) => [c, b2.reference.symbols.HALF[i]]));
  eq('a bounded symbol publishes its boundary and its action; the counts say so', [half.historyValidFrom, half.corporateActions[0].corporate_action_type, half.high52, b2.reference.counts.otherActions, b2.reference.counts.bounded], [halfDate, ACTION.OTHER, null, 1, 1]);
  check('and its weekly chart starts after the action: no week before it on the same line', b2.history.H.symbols.HALF.every(([d]) => d >= 250), JSON.stringify(b2.history.H.symbols.HALF.slice(0, 2)));
}

// The SEC evidence reader, over a fake EDGAR.
{
  const tickers = tickerIndex({ fields: ['cik', 'name', 'ticker', 'exchange'], data: [[1, 'Split Co', 'SPLT', 'Nasdaq'], [2, 'Class Co', 'BRK-B', 'NYSE'], ['x', 'Bad', 'BAD', 'NYSE']] });
  eq('the ticker map: integer CIKs only, a class written with a dash', tickers, { SPLT: 1, 'BRK-B': 2 });
  const sub = { filings: { recent: { form: ['8-K', '8-K', '10-K', '8-K', 'S-8'], filingDate: ['2026-09-20', '2026-09-25', '2026-03-01', '2026-09-26', '2026-09-27'], accessionNumber: ['0000000001-26-000001', '0000000001-26-000002', '0000000001-26-000003', '0000000001-26-000004', '0000000001-26-000005'], primaryDocument: ['a.htm', '../../evil.htm', 'k.htm', 'c.htm', 's8.htm'] } } };
  const seen = [];
  const site = {
    'https://data.sec.gov/submissions/CIK0000000001.json': sub,
    'https://www.sec.gov/Archives/edgar/data/1/000000000126000001/a.htm': 'a two-for-one stock split',
    'https://www.sec.gov/Archives/edgar/data/1/000000000126000001/index.json': { directory: { item: [{ name: 'ex99-1.htm' }, { name: 'https://evil.example/x.htm' }] } },
    'https://www.sec.gov/Archives/edgar/data/1/000000000126000001/ex99-1.htm': 'press release',
    'https://www.sec.gov/Archives/edgar/data/1/000000000126000004/c.htm': 'results',
    'https://www.sec.gov/Archives/edgar/data/1/000000000126000004/index.json': { directory: { item: [] } },
    'https://data.sec.gov/api/xbrl/companyconcept/CIK0000000001/dei/EntityCommonStockSharesOutstanding.json': { units: { shares: [{ end: '2026-08-01', val: 1e6, form: '10-Q', accn: 'x' }] } },
  };
  const get = async (u) => {
    seen.push(u);
    if (!(u in site)) throw new Error('HTTP 404');
    return site[u];
  };
  const e = await gatherEvidence({ symbol: 'SPLT', date: '2026-10-01', tickers, get, splitShaped: false });
  eq('a move not shaped like a split reads current reports only, nearest first, with their press releases', e.filings.map((f) => [f.form, f.filed, /press release/.test(f.text)]), [['8-K', '2026-09-26', false], ['8-K', '2026-09-20', true]]);
  check('every request is on sec.gov, and no path a filing supplied is followed', seen.every((u) => /^https:\/\/(www|data)\.sec\.gov\//.test(u)) && !seen.some((u) => /evil/.test(u)), seen.join(' '));
  eq('the cover share counts come with it', e.shares, [{ end: '2026-08-01', val: 1e6, form: '10-Q', accession: 'x' }]);
  eq('a symbol with no SEC registrant has nothing to read, and says so', await gatherEvidence({ symbol: 'XLK', date: '2026-10-01', tickers, get }), { checked: true, date: '2026-10-01', cik: null, filings: [], shares: [] });
  const limited = await gatherEvidence({ symbol: 'SPLT', date: '2026-10-01', tickers, get: async (u) => { if (/c\.htm$/.test(u)) { const err = new Error('SEC answered 429'); err.stop = true; throw err; } return get(u); }, splitShaped: false });
  eq('a rate limit is never swallowed: the read stops and nothing is concluded', [limited.checked, limited.stop], [false, true]);
  const down = await gatherEvidence({ symbol: 'SPLT', date: '2026-10-01', tickers, get: async () => { throw new Error('HTTP 503'); } });
  eq('EDGAR down is not evidence', [down.checked, down.stop], [false, false]);
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
  eq('the counts say how many are priced, and how many carry a corporate action', reference.counts, { listed: 4, priced: 3, high: 3, usable: 0, stale: 1, discontinuity: 0, fullYear: 2, confirmedSplits: 0, otherActions: 0, unresolved: 0, bounded: 0, skipped: 0 });
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

// The corporate-action stage, end to end on a fake EDGAR.
{
  const work = mkdtempSync(join(tmpdir(), 'market-reference-ca-'));
  const cal = calendarOf(30, '2026-08-03');
  const ev = 20;
  const s = emptyState();
  const index = {};
  for (const [i, date] of cal.entries()) {
    recordDay(s, date, { SPLT: o(i < ev ? 200 : 100), SPIN: o(i < ev ? 600 : 100), UNRS: o(i < ev ? 80 : 40), NORM: o(50) }, { open: 0, close: 0 });
    index[date.replaceAll('-', '')] = [{ feed: 'TOPS', version: '1.6', link: `https://example.invalid/${date}`, size: '1' }];
  }
  s.calendar = [...cal];
  const statePath = join(work, 'state.json.gz');
  const fresh = gzipSync(JSON.stringify(s));
  writeFileSync(statePath, fresh);
  writeFileSync(join(work, 'index.json'), JSON.stringify(index));
  const acc = (cik, n) => `${String(cik).padStart(10, '0')}-26-${String(n).padStart(6, '0')}`;
  const doc = (cik, n, name) => `https://www.sec.gov/Archives/edgar/data/${cik}/${acc(cik, n).replaceAll('-', '')}/${name}`;
  const recent = (cik, rows) => ({ filings: { recent: { form: rows.map((r) => r[0]), filingDate: rows.map((r) => r[1]), accessionNumber: rows.map((_, n) => acc(cik, n + 1)), primaryDocument: rows.map((r) => r[2]) } } });
  const site = {
    'https://www.sec.gov/files/company_tickers_exchange.json': { fields: ['cik', 'name', 'ticker', 'exchange'], data: [[1, 'Split Co', 'SPLT', 'Nasdaq'], [2, 'Spin Co', 'SPIN', 'NYSE'], [3, 'Unr Co', 'UNRS', 'NYSE'], [4, 'Norm Co', 'NORM', 'NYSE']] },
    'https://data.sec.gov/submissions/CIK0000000001.json': recent(1, [['8-K', cal[ev - 5], 'split.htm']]),
    [doc(1, 1, 'split.htm')]: '<p>The Board declared a two-for-one stock split.</p>',
    'https://data.sec.gov/submissions/CIK0000000002.json': recent(2, [['8-K', cal[ev], 'spin.htm']]),
    [doc(2, 1, 'spin.htm')]: '<p>The Company completed the separation of its seed business through a pro rata distribution.</p>',
    'https://data.sec.gov/submissions/CIK0000000003.json': recent(3, []),
  };
  const fixture = join(work, 'sec.json');
  writeFileSync(fixture, JSON.stringify(site));
  const out = join(work, 'market-reference.auto.json');
  const hist = join(work, 'market-history');
  const run = (...extra) => spawnSync(process.execPath, ['scripts/sync-market-reference.mjs', '--state', statePath, '--out', out, '--history-dir', hist, '--index', join(work, 'index.json'), ...extra], { encoding: 'utf8' });
  const rowOf = (sym) => {
    const ref = JSON.parse(readFileSync(out, 'utf8'));
    return Object.fromEntries(ref.columns.map((c, i) => [c, ref.symbols[sym][i]]));
  };

  const off = run();
  check('with --index the stage is off by default: offline runs never reach the network', off.status === 0 && /not read on this run/.test(off.stdout), off.stdout + off.stderr);
  eq('unread, a split-shaped move is unresolved and bounded, never rescaled', [rowOf('SPLT').corporateActions[0].corporate_action_type, rowOf('SPLT').historyValidFrom, rowOf('SPLT').splits], ['UNRESOLVED', cal[ev], []]);

  const on = run('--evidence', fixture);
  check('the stage classifies every candidate and logs counts, never a price', on.status === 0 && /3 candidates classified \(1 splits, 0 reverse splits, 1 other actions, 1 unresolved, 0 ordinary moves\)/.test(on.stdout) && !/\b(200|100|600|80|40)\b(?!\s*(candidates|SEC|symbols))/.test(on.stdout.replace(/[\d-]{10}/g, '')), on.stdout + on.stderr);
  check('a classification made after the file was written replaces it, though the date has not moved', !/left as it is/.test(on.stdout) && /wrote /.test(on.stdout), on.stdout);
  const sp = rowOf('SPLT');
  eq('the confirmed split rescales at the 8-K\'s ratio, with its provenance', [sp.splits, sp.historyValidFrom, sp.corporateActions[0].action_ratio, sp.corporateActions[0].evidence_url], [[[ev, 0.5]], null, 0.5, doc(1, 1, 'split.htm')]);
  const sn = rowOf('SPIN');
  eq('the spin-off is OTHER: no ratio, no rescale, bounded at its date', [sn.corporateActions[0].corporate_action_type, sn.corporateActions[0].action_ratio, sn.splits, sn.historyValidFrom, sn.price], ['OTHER_CORPORATE_ACTION', null, [], cal[ev], 100]);
  eq('the unexplained halving stays UNRESOLVED; the quiet name carries nothing', [rowOf('UNRS').corporateActions[0].corporate_action_type, rowOf('NORM').corporateActions, rowOf('NORM').historyValidFrom], ['UNRESOLVED', [], null]);
  eq('the methodology is the new version', JSON.parse(readFileSync(out, 'utf8')).methodology.version, 'iex-ref-2');

  const again = run('--evidence', fixture);
  check('a run with nothing new to classify leaves the file alone', again.status === 0 && /every candidate is classified/.test(again.stdout) && /left as it is/.test(again.stdout), again.stdout);

  writeFileSync(statePath, fresh);
  writeFileSync(fixture, JSON.stringify({ ...site, 'https://data.sec.gov/submissions/CIK0000000001.json': 429 }));
  const limited = run('--evidence', fixture);
  check('a 429 stops the stage for the run, the run stays green, and nothing unread is concluded', limited.status === 0 && /stopped: SEC answered 429/.test(limited.stdout) && rowOf('SPLT').corporateActions[0].corporate_action_type === 'UNRESOLVED' && rowOf('SPLT').splits.length === 0, limited.stdout + limited.stderr);
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
