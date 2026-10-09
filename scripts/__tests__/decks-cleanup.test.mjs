// Offline checks on the historical adviser-credit correction
// (scripts/decks-adviser-cleanup.mjs, data/decks.adviser-cleanup-2026-10.json)
// and on the index it leaves behind. No network.
//
//   node scripts/__tests__/decks-cleanup.test.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADVISERS } from '../../lib/decks.mjs';
import { applyCleanup } from '../decks-adviser-cleanup.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const index = JSON.parse(readFileSync(join(ROOT, 'data/decks.auto.json'), 'utf8'));
const record = JSON.parse(readFileSync(join(ROOT, 'data/decks.adviser-cleanup-2026-10.json'), 'utf8'));

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

const exhibits = (url) => [...index.transactions.flatMap((t) => t.decks), ...index.filings.flatMap((f) => f.decks)].filter((d) => d.url === url);
const sameSet = (a, b) => JSON.stringify([...new Set(a)].sort()) === JSON.stringify([...new Set(b)].sort());

// ── The record ──────────────────────────────────────────────────────────────

test('the record lists removals and review cases only, and no addition', () => {
  assert.equal(record.counts.removals, record.removals.length);
  assert.equal(record.counts.review, record.review.length);
  assert.equal(record.counts.additions, 0);
  for (const r of record.removals) {
    assert.ok(r.before.includes(r.bank), `${r.url} ${r.bank}`);
    assert.ok(!r.after.includes(r.bank), `${r.url} ${r.bank}`);
    assert.ok(r.after.every((b) => r.before.includes(b)), `${r.url} gains a bank`);
    assert.ok(['opposing-side adviser', 'quoted research', 'estimate or price-target source', 'other'].includes(r.category), r.category);
    assert.ok(['high', 'medium'].includes(r.confidence), `${r.url}: a low-confidence case is a review case`);
  }
});

test('no exhibit and bank is both removed and left for review', () => {
  const removed = new Set(record.removals.map((r) => `${r.url}|${r.bank}`));
  assert.ok(record.review.every((r) => !removed.has(`${r.url}|${r.bank}`)));
});

// ── The index after it ──────────────────────────────────────────────────────

test('every listed removal is applied, in the transactions and the filings alike', () => {
  for (const r of record.removals) {
    const found = exhibits(r.url);
    assert.equal(found.length, 2, `${r.url} appears once under its transaction and once under its filing`);
    for (const d of found) assert.ok(!d.advisers.includes(r.bank), `${r.url} still credits ${r.bank}`);
  }
});

test('every review case is left as it was', () => {
  for (const r of record.review) {
    for (const d of exhibits(r.url)) {
      // One case the collector fix corrects on its own (Personalis (c)(4)); the cleanup does not touch it.
      if (r.note?.startsWith('Corrected by the collector fix')) assert.ok(!d.advisers.includes(r.bank));
      else assert.ok(d.advisers.includes(r.bank), `${r.url} lost ${r.bank}, a review case`);
    }
  }
});

test('filing and transaction adviser lists are exactly the banks credited on their decks', () => {
  for (const f of index.filings) assert.ok(sameSet(f.advisers, f.decks.flatMap((d) => d.advisers)), f.accession);
  for (const t of index.transactions) assert.ok(sameSet(t.advisers, t.decks.flatMap((d) => d.advisers)), t.id);
});

test('every credited bank is one the collector knows', () => {
  const known = new Set(ADVISERS.map((a) => a.name));
  for (const t of index.transactions) for (const d of t.decks) for (const b of d.advisers) assert.ok(known.has(b), b);
});

test('the cleanup is applied in full: running it again changes nothing', () => {
  const copy = structuredClone(index);
  assert.deepEqual(applyCleanup(copy, record), { decksChanged: 0, creditsRemoved: 0, filingsChanged: 0, transactionsChanged: 0 });
});

// The decks of the hand-reviewed benchmark whose stored credit the review
// corrected: the published index must carry exactly the reviewed credit.
const REVIEWED = [
  ['Distribution Solutions Group, Inc. EX-99.(C)(IV)', 'https://www.sec.gov/Archives/edgar/data/703604/000119312526377697/d75849dex99civ.htm', ['William Blair']],
  ['Distribution Solutions Group, Inc. EX-99.(C)(VI)', 'https://www.sec.gov/Archives/edgar/data/703604/000119312526377697/d75849dex99cvi.htm', ['William Blair']],
  ['Distribution Solutions Group, Inc. EX-99.(C)(VII)', 'https://www.sec.gov/Archives/edgar/data/703604/000119312526377697/d75849dex99cvii.htm', ['William Blair']],
  ['Personalis, Inc. EX-99.(C)(4)', 'https://www.sec.gov/Archives/edgar/data/1527753/000119312526377066/d81410dex99c4.htm', []],
  ['Select Medical Holdings EX-99.(C)(V)', 'https://www.sec.gov/Archives/edgar/data/1320414/000110465926043531/tm2611660d2_ex99-cv.htm', ['Goldman Sachs']],
  ['Kennedy-Wilson Holdings, Inc. EX-99.(C)(3)', 'https://www.sec.gov/Archives/edgar/data/1408100/000114036126010587/ny20065855x4_ex-c3.htm', ['Moelis']],
  ['European Wax Center, Inc. EX-99.(C)(II)', 'https://www.sec.gov/Archives/edgar/data/1856236/000119312526102445/d51338dex99cii.htm', ['Moelis']],
  ['AvidXchange Holdings, Inc. EX-99.(C)(21)', 'https://www.sec.gov/Archives/edgar/data/1858257/000114036125022856/ny20049415x2_exc21.htm', []],
  ['AvidXchange Holdings, Inc. EX-99.(C)(18)', 'https://www.sec.gov/Archives/edgar/data/1858257/000114036125029188/ny20049415x7_ex-c18.htm', []],
  ['Martin Midstream Partners L.P. EX-99.(C)(8)', 'https://www.sec.gov/Archives/edgar/data/1176334/000119312524244241/d895435dex99c8.htm', ['Houlihan Lokey']],
  ['Manitex International, Inc. EX-99.(C)(2)', 'https://www.sec.gov/Archives/edgar/data/1302028/000119312524230214/d852618dex99c2.htm', []],
  ['Manitex International, Inc. EX-99.(C)(2), amendment', 'https://www.sec.gov/Archives/edgar/data/1302028/000119312524250624/d852618dex99c2.htm', []],
  ['Avangrid, Inc. EX-99.(C)(6)', 'https://www.sec.gov/Archives/edgar/data/1360587/000119312524165806/d842696dex99c6.htm', ['Moelis']],
  ['Astra Space, Inc. EX-99.(C)(4)', 'https://www.sec.gov/Archives/edgar/data/1814329/000119312524133385/d681503dex99c4.htm', []],
  ['Astra Space, Inc. EX-99.(C)(6)', 'https://www.sec.gov/Archives/edgar/data/1814329/000119312524133385/d681503dex99c6.htm', ['Houlihan Lokey']],
];

test('the hand-reviewed benchmark decks carry exactly their reviewed credit', () => {
  for (const [label, url, want] of REVIEWED) {
    const found = exhibits(url);
    assert.equal(found.length, 2, label);
    for (const d of found) assert.deepEqual([...d.advisers].sort(), [...want].sort(), label);
  }
});

// ── The script on a fixture ─────────────────────────────────────────────────

test('it removes only the listed bank, rebuilds the lists, and touches nothing else', () => {
  const deck = (url, advisers) => ({ id: url, url, exhibit: 'EX-99.(C)(1)', advisers, analyses: ['dcf'] });
  const fixture = {
    transactions: [{ id: 'T', target: { name: 'Alpha' }, advisers: ['Lazard', 'RBC Capital Markets'], decks: [deck('u1', ['Lazard', 'RBC Capital Markets']), deck('u2', ['Lazard'])] }],
    filings: [{ accession: 'T', advisers: ['Lazard', 'RBC Capital Markets'], decks: [deck('u1', ['Lazard', 'RBC Capital Markets']), deck('u2', ['Lazard'])] }],
  };
  const before = structuredClone(fixture);
  const result = applyCleanup(fixture, { removals: [{ url: 'u1', bank: 'RBC Capital Markets' }] });
  assert.deepEqual(result, { decksChanged: 1, creditsRemoved: 1, filingsChanged: 1, transactionsChanged: 1 });
  assert.deepEqual(fixture.transactions[0].decks[0].advisers, ['Lazard']);
  assert.deepEqual(fixture.filings[0].decks[0].advisers, ['Lazard']);
  assert.deepEqual(fixture.transactions[0].advisers, ['Lazard']);
  assert.deepEqual(fixture.filings[0].advisers, ['Lazard']);
  const strip = (o) => JSON.stringify(o, (k, v) => (k === 'advisers' ? undefined : v));
  assert.equal(strip(fixture), strip(before));
});

test('a bank still credited on another of the filing\'s decks stays on the filing', () => {
  const fixture = {
    transactions: [{ id: 'T', advisers: ['Lazard'], decks: [{ url: 'u1', advisers: ['Lazard'] }, { url: 'u2', advisers: ['Lazard'] }] }],
    filings: [{ accession: 'T', advisers: ['Lazard'], decks: [{ url: 'u1', advisers: ['Lazard'] }, { url: 'u2', advisers: ['Lazard'] }] }],
  };
  applyCleanup(fixture, { removals: [{ url: 'u1', bank: 'Lazard' }] });
  assert.deepEqual(fixture.transactions[0].advisers, ['Lazard']);
  assert.deepEqual(fixture.filings[0].advisers, ['Lazard']);
});

test('a listed exhibit missing from the index stops the run', () => {
  assert.throws(() => applyCleanup({ transactions: [], filings: [] }, { removals: [{ url: 'nowhere', bank: 'Lazard' }] }), /not in the index/);
});

console.log(`\n${passed} passed`);
