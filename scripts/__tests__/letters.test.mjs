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



// ── Exhibit enumeration ─────────────────────────────────────────────────────

import {
  CONTENT_RELEVANCE,
  campaignKey,
  classifyDocument,
  groupCampaigns,
  parseFilingIndex,
  planIndexes,
  recommendTen,
  sizeHint,
} from '../../lib/letters.mjs';

const FIXTURES = join(ROOT, 'scripts', '__tests__', 'fixtures');

test('a solicitation index yields its documents, the subject company and the filer', () => {
  const idx = parseFilingIndex(readFileSync(join(FIXTURES, 'index-dfan14a-fragment.htm'), 'utf8'));
  assert.equal(idx.documents.length, 3);
  assert.deepEqual(idx.documents.map((d) => d.type), ['DFAN14A', 'DFAN14A', '']);
  assert.equal(idx.documents[1].description, 'LETTER TO STOCKHOLDERS');
  assert.equal(idx.documents[1].filename, 'ex1todfan14a06297347_031925.pdf');
  assert.equal(idx.documents[1].size, 648284);
  assert.equal(idx.documents[1].href, '/Archives/edgar/data/769397/000092189525000816/ex1todfan14a06297347_031925.pdf');
  assert.equal(idx.subject.name, 'Autodesk, Inc.');
  assert.equal(idx.subject.cik, '0000769397');
  assert.equal(idx.filer.name, 'Starboard Value LP');
  assert.equal(idx.filingDate, '2025-03-19');
  assert.equal(idx.periodOfReport, null);
});

test('a shareholder report index yields the inline primary document and its period', () => {
  const idx = parseFilingIndex(readFileSync(join(FIXTURES, 'index-ncsr-fragment.htm'), 'utf8'));
  const primary = idx.documents[0];
  assert.equal(primary.type, 'N-CSR');
  assert.equal(primary.filename, 'longleaf_ncsr.htm', 'the iXBRL badge is not part of the filename');
  assert.equal(primary.inline, true);
  assert.equal(idx.documents[1].type, 'EX-99.CERT');
  assert.equal(idx.subject, null);
  assert.equal(idx.filer.name, 'LONGLEAF PARTNERS FUNDS TRUST');
  assert.equal(idx.periodOfReport, '2025-12-31');
});

test('documents are classified by declared type and description, never by filename', () => {
  const cover = { seq: '1', type: 'DFAN14A', description: '', filename: 'dfan14a10168303_03042025.htm', size: 39262 };
  const deck = { seq: '2', type: 'DFAN14A', description: '', filename: 'ex991todfan10168003_030425.pdf', size: 9794322 };
  const gif = { seq: '3', type: 'GRAPHIC', description: 'GRAPHIC', filename: 'image_001.gif', size: 4148 };
  const full = { seq: '', type: '', description: 'Complete submission text file', filename: 'x.txt', size: 1 };
  const docs = [cover, deck, gif, full];
  assert.equal(classifyDocument(cover, 'DFAN14A', { siblings: docs }), 'solicitation_cover');
  assert.equal(classifyDocument(deck, 'DFAN14A', { siblings: docs }), 'unclassified');
  assert.equal(classifyDocument(gif, 'DFAN14A', { siblings: docs }), 'routine');
  assert.equal(classifyDocument(full, 'DFAN14A', { siblings: docs }), 'routine');
  assert.equal(classifyDocument(cover, 'DFAN14A', { siblings: [cover, full] }), 'unclassified', 'a lone primary document is the content');
  assert.equal(classifyDocument({ seq: '2', type: 'DFAN14A', description: 'LETTER TO STOCKHOLDERS', filename: 'a.pdf' }, 'DFAN14A'), 'letter');
  assert.equal(classifyDocument({ seq: '2', type: 'EX-99.1', description: 'INVESTOR PRESENTATION', filename: 'a.pdf' }, 'SC 13D'), 'presentation');
  assert.equal(classifyDocument({ seq: '2', type: 'EX-99.1', description: 'JOINT FILING AGREEMENT', filename: 'a.htm' }, 'SC 13D'), 'routine');
  assert.equal(classifyDocument({ seq: '1', type: 'SC 13D', description: 'THE SCHEDULE 13D', filename: 'a.htm' }, 'SC 13D'), 'schedule_13d');
  assert.equal(classifyDocument({ seq: '1', type: 'N-CSR', description: '', filename: 'r.htm' }, 'N-CSR'), 'shareholder_report');
  assert.equal(classifyDocument({ seq: '4', type: 'EX-99.IND PUB ACCT', description: '', filename: 'e.htm' }, 'N-CSR'), 'routine');
  assert.equal(CONTENT_RELEVANCE.solicitation_cover, 'low');
  assert.equal(sizeHint(deck), 'a PDF this large is usually a presentation');
  assert.equal(sizeHint({ filename: 'a.pdf', size: 648284 }), 'a PDF this size is usually a letter');
});

test('campaigns group by the filer agent matter number, and a stray filing joins the campaign around it', () => {
  const c = (filingDate, primaryDocument, form = 'DFAN14A') => ({ filingDate, primaryDocument, form, accession: `${filingDate}-${primaryDocument}` });
  assert.equal(campaignKey(c('2025-03-04', 'dfan14a10168303_03042025.htm')), 'matter:10168303');
  assert.equal(campaignKey(c('2024-11-14', 'sc13da406297282_11142024.htm', 'SC 13D/A')), 'matter:06297282');
  assert.equal(campaignKey(c('2025-04-09', 'e664374_dfan14a-phillips66.htm')), 'date:2025-04');
  const groups = groupCampaigns([
    c('2025-03-04', 'dfan14a10168303_03042025.htm'),
    c('2025-05-20', 'dfan14a10168303_05202025.htm'),
    c('2025-04-09', 'e664374_dfan14a-phillips66.htm'),
    c('2024-09-24', 'dfan14a10168307_09242024.htm'),
    c('2024-10-15', 'p24-2934sc13da.htm', 'SC 13D/A'),
    c('2026-03-11', 'dfan14a06297384_03112026.htm'),
  ]);
  assert.deepEqual(groups.map((g) => [g.key, g.filings.length]), [['matter:10168303', 3], ['matter:10168307', 2], ['matter:06297384', 1]], 'engagements before one-offs, newest first');
});

test('the index plan takes one filing per campaign and the two annual reports plus the newest semi-annual', () => {
  const src = { activist: { sourceType: 'sec_exhibit' }, fund: { sourceType: 'sec_shareholder_report' } };
  const c = (filingDate, primaryDocument, form, sourceId) => ({ filingDate, primaryDocument, form, sourceId, accession: `${filingDate}-${form}` });
  const plan = planIndexes(
    {
      e: [c('2025-03-04', 'dfan14a10168303_1.htm', 'DFAN14A', 'activist'), c('2025-05-20', 'dfan14a10168303_2.htm', 'DFAN14A', 'activist'), c('2025-04-09', 'e664374_x.htm', 'DFAN14A', 'activist'), c('2024-09-24', 'dfan14a10168307_1.htm', 'DFAN14A', 'activist')],
      f: [c('2025-03-11', 'a.htm', 'N-CSR', 'fund'), c('2025-08-29', 'b.htm', 'N-CSRS', 'fund'), c('2026-03-10', 'c.htm', 'N-CSR', 'fund'), c('2026-09-04', 'd.htm', 'N-CSRS', 'fund')],
    },
    src,
    3
  );
  const e = plan.filter((p) => p.fund === 'e').map((p) => p.filingDate);
  assert.deepEqual(e, ['2025-03-04', '2024-09-24', '2025-04-09'], 'first of each campaign, then the other agent\'s filing in the largest');
  const f = plan.filter((p) => p.fund === 'f').map((p) => `${p.form} ${p.filingDate}`);
  assert.deepEqual(f, ['N-CSR 2026-03-10', 'N-CSR 2025-03-11', 'N-CSRS 2026-09-04']);
});

test('the recommendation takes two campaigns for an activist and the newest plus the earliest period for a fund', () => {
  const src = { a: { sourceType: 'sec_exhibit' }, r: { sourceType: 'sec_shareholder_report' } };
  const row = (fund, sourceId, filingDate, extra) => ({ fund, sourceId, filingDate, eligible: 'yes', thesisRelevance: 'high', ...extra });
  const rec = recommendTen(
    [
      row('act', 'a', '2025-03-19', { campaign: 'm1', thesisRelevance: 'high' }),
      row('act', 'a', '2025-03-19', { campaign: 'm1', thesisRelevance: 'low' }),
      row('act', 'a', '2024-11-07', { campaign: 'm2', thesisRelevance: 'review', eligible: 'review' }),
      row('act', 'a', '2024-11-26', { campaign: 'm3', thesisRelevance: 'medium' }),
      row('fund', 'r', '2026-03-10', { reportingPeriod: '2025-12-31' }),
      row('fund', 'r', '2025-03-11', { reportingPeriod: '2024-12-31' }),
      row('fund', 'r', '2026-09-04', { reportingPeriod: '2026-06-30' }),
    ],
    src
  );
  const act = rec.find((x) => x.fund === 'act');
  assert.deepEqual(act.picks.map((p) => p.campaign), ['m1', 'm2'], 'a labelled letter, then an unlabelled document from another campaign, before a schedule');
  assert.equal(act.shortfall, null);
  const fund = rec.find((x) => x.fund === 'fund');
  assert.deepEqual(fund.picks.map((p) => p.reportingPeriod), ['2024-12-31', '2026-06-30']);
  const short = recommendTen([row('one', 'a', '2025-01-01', { campaign: 'only' })], src).find((x) => x.fund === 'one');
  assert.match(short.shortfall, /only 1 suitable campaign/);
});

console.log(`${passed} passed`);
