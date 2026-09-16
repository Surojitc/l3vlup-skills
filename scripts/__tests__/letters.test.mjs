// Offline checks on the letters discovery selection. No network: the fixture
// is the shape of an EDGAR submissions index, cut to the columns read.
//
//   node scripts/__tests__/letters.test.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  activeSources,
  capAcrossFunds,
  orderWithinFund,
  entityMatches,
  filingUrls,
  formatOf,
  relevanceOf,
  selectCandidates,
} from '../../lib/letters.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

const NOW = new Date('2026-09-16T00:00:00Z');

function fixture(rows) {
  const recent = { form: [], filingDate: [], accessionNumber: [], primaryDocument: [], primaryDocDescription: [], reportDate: [] };
  for (const [form, date, acc, doc, desc] of rows) {
    recent.form.push(form);
    recent.filingDate.push(date);
    recent.accessionNumber.push(acc);
    recent.primaryDocument.push(doc);
    recent.primaryDocDescription.push(desc);
    recent.reportDate.push('');
  }
  return { name: 'STARBOARD VALUE LP', filings: { recent, files: [] } };
}

const SOURCE = {
  id: 'starboard-edgar', fund: 'starboard-value', cik: '0001517137', expectedName: 'STARBOARD VALUE',
  forms: ['DFAN14A', 'SC 13D', 'SC 13D/A'], retrievalMode: 'automated_sec', rightsJudgement: 'sec_public_record', status: 'active',
};

// ── URLs and formats ────────────────────────────────────────────────────────

test('filing urls drop the dashes from the folder and keep them in the index name', () => {
  const u = filingUrls('0001517137', '0000921895-26-001234', 'letter.pdf');
  assert.equal(u.documentUrl, 'https://www.sec.gov/Archives/edgar/data/1517137/000092189526001234/letter.pdf');
  assert.equal(u.indexUrl, 'https://www.sec.gov/Archives/edgar/data/1517137/000092189526001234/0000921895-26-001234-index.htm');
  assert.equal(filingUrls('0001517137', '0000921895-26-001234', null).documentUrl, null);
});

test('format is read off the primary document name', () => {
  assert.equal(formatOf('dfan14a.htm'), 'html');
  assert.equal(formatOf('deck.PDF'), 'pdf');
  assert.equal(formatOf('0001.txt'), 'text');
  assert.equal(formatOf(null), 'unknown');
});

// ── Relevance ───────────────────────────────────────────────────────────────

test('a shareholder report is always worth reading; a press release is not a letter', () => {
  assert.equal(relevanceOf('N-CSR', null), 'high');
  assert.equal(relevanceOf('N-CSRS', 'SEMI-ANNUAL REPORT'), 'high');
  assert.equal(relevanceOf('DFAN14A', 'LETTER TO SHAREHOLDERS'), 'high');
  assert.equal(relevanceOf('DFAN14A', 'INVESTOR PRESENTATION'), 'high');
  assert.equal(relevanceOf('DFAN14A', 'PRESS RELEASE'), 'medium');
  assert.equal(relevanceOf('DFAN14A', null), 'medium');
  assert.equal(relevanceOf('SC 13D', null), 'medium');
  assert.equal(relevanceOf('SC 13D/A', 'AMENDMENT NO. 3'), 'low');
  assert.equal(relevanceOf('SC 13D/A', 'LETTER TO THE BOARD'), 'medium');
  assert.equal(relevanceOf('13F-HR', null), 'low');
});

// ── Selection ───────────────────────────────────────────────────────────────

test('only wanted forms inside the window become candidates, each carrying its rights and key', () => {
  const sub = fixture([
    ['DFAN14A', '2026-05-01', '0000921895-26-000001', 'letter.htm', 'LETTER TO SHAREHOLDERS'],
    ['13F-HR', '2026-05-15', '0000921895-26-000002', 'form13f.xml', null],
    ['SC 13D', '2024-08-01', '0000921895-24-000003', 'sc13d.htm', null],
    ['SC 13D/A', '2025-01-10', '0000921895-25-000004', 'sc13da.htm', 'AMENDMENT NO. 2'],
  ]);
  const { candidates, since, recentTruncated } = selectCandidates(sub, SOURCE, { now: NOW, windowMonths: 24 });
  assert.equal(since, '2024-09-16');
  assert.equal(recentTruncated, false);
  assert.deepEqual(candidates.map((c) => c.accession), ['0000921895-26-000001', '0000921895-25-000004']);
  const c = candidates[0];
  assert.equal(c.fund, 'starboard-value');
  assert.equal(c.format, 'html');
  assert.equal(c.relevance, 'high');
  assert.equal(c.retrievalMode, 'automated_sec');
  assert.equal(c.rightsJudgement, 'sec_public_record');
  assert.equal(c.duplicateKey, c.accession);
  assert.equal(c.contentHash, null);
  assert.equal(c.exhibitsEnumerated, false);
  assert.equal(c.title, 'LETTER TO SHAREHOLDERS');
  assert.equal(candidates[1].title, 'AMENDMENT NO. 2');
});

test('a recent block that stops inside the window is reported as truncated, never read further', () => {
  const sub = fixture([['DFAN14A', '2026-05-01', '0000921895-26-000001', 'letter.htm', 'LETTER']]);
  sub.filings.files = [{ name: 'CIK0001517137-submissions-001.json' }];
  assert.equal(selectCandidates(sub, SOURCE, { now: NOW }).recentTruncated, true);
  sub.filings.files = [];
  assert.equal(selectCandidates(sub, SOURCE, { now: NOW }).recentTruncated, false);
});

test('the entity name check catches a mistyped CIK', () => {
  assert.equal(entityMatches({ name: 'Starboard Value LP' }, 'STARBOARD VALUE'), true);
  assert.equal(entityMatches({ name: 'SOME OTHER FILER INC' }, 'STARBOARD VALUE'), false);
  assert.equal(entityMatches({}, 'STARBOARD VALUE'), false);
});

// ── The cap ─────────────────────────────────────────────────────────────────

test('the cap takes a round from each fund so one prolific filer cannot crowd the rest out', () => {
  const mk = (fund, n, relevance) =>
    Array.from({ length: n }, (_, i) => ({ fund, accession: `${fund}-${i}`, filingDate: `2026-0${(i % 9) + 1}-01`, relevance }));
  const out = capAcrossFunds({ a: mk('a', 20, 'medium'), b: mk('b', 3, 'high'), c: mk('c', 1, 'low') }, 10);
  assert.equal(out.length, 10);
  assert.equal(out.filter((c) => c.fund === 'b').length, 3);
  assert.equal(out.filter((c) => c.fund === 'c').length, 1);
  assert.equal(out.filter((c) => c.fund === 'a').length, 6);
  // Within a fund, relevance first.
  const a = capAcrossFunds({ a: [...mk('a', 3, 'low'), ...mk('a', 2, 'high')] }, 2);
  assert.deepEqual(a.map((c) => c.relevance), ['high', 'high']);
});

test('within a fund the picks spread across filing months before returning to a busy one', () => {
  const c = (date, relevance = 'medium') => ({ fund: 'e', accession: date, filingDate: date, relevance });
  const list = [c('2025-05-20'), c('2025-05-19'), c('2025-05-18'), c('2025-05-17'), c('2026-03-11'), c('2024-11-08'), c('2025-05-01', 'high')];
  const out = orderWithinFund(list).map((x) => x.filingDate);
  assert.equal(out[0], '2025-05-01', 'high relevance first');
  assert.deepEqual(out.slice(1, 4), ['2026-03-11', '2025-05-20', '2024-11-08'], 'one per month, newest month first');
  assert.deepEqual(out.slice(4), ['2025-05-19', '2025-05-18', '2025-05-17'], 'then back to the busy month');
});

// ── The registry ────────────────────────────────────────────────────────────

test('the committed registry has only SEC-hosted, public-record sources active', () => {
  const registry = JSON.parse(readFileSync(join(ROOT, 'data', 'letters.sources.json'), 'utf8'));
  const { active, problems } = activeSources(registry);
  assert.deepEqual(problems, []);
  assert.equal(active.length, 5);
  for (const s of active) {
    assert.equal(s.discovery, 'edgar_submissions');
    assert.ok(s.forms.length > 0);
    assert.ok(!s.forms.some((f) => /^13F/.test(f)), 'a 13F carries no writing');
  }
  assert.ok(registry.excluded.some((e) => e.domain === 'pershingsquareholdings.com'));
  assert.equal(registry.maxCandidates, 30);
});

test('a source that is not an SEC public record cannot be active', () => {
  const bad = { sources: [{ ...SOURCE, retrievalMode: 'manual_only' }, { ...SOURCE, id: 'x', rightsJudgement: 'restricted' }, { ...SOURCE, id: 'y', cik: '123' }] };
  const { active, problems } = activeSources(bad);
  assert.equal(active.length, 0);
  assert.equal(problems.length, 3);
});

console.log(`${passed} passed`);
