// The letters review queue (lib/letters-queue.mjs, scripts/letters-queue.mjs):
// how a discovered filing is classified, recognised as one the site already
// holds, and drafted as a record a person finishes. No network.
//
//   node scripts/__tests__/letters-queue.test.mjs
//
// What is held:
//   - a filing the catalogue holds, published, held back or excluded, is never
//     queued again, whether it is matched by accession or only by a URL;
//   - a shareholder report is a likely letter only where its registrant was
//     checked to carry one; a tailored report is a fund report, an amendment
//     is other;
//   - an activist filing is a letter or a deck only when a document's label
//     says so (high) or an unlabelled PDF's size suggests it (low), and a
//     "letter agreement" or an exhibit that is the 13D amendment itself is
//     never a letter;
//   - with no index read, a solicitation is proxy material and a 13D is
//     other, both low and flagged for the index;
//   - the skeleton carries the filing's facts and nothing a person writes:
//     no title, why, intro, note or quotation, grounded false, never
//     publishable, and no label copied from the filing;
//   - one filing is one entry, the day it was first seen survives a re-run,
//     suggested ids never collide with the catalogue, and a letter filed twice
//     is marked as a repeat;
//   - the committed registry, keys and queue keep those rules, and the weekly
//     workflow runs the queue without any write permission.

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  QUEUE_CLASSES,
  accessionFromUrl,
  buildQueue,
  decisionIndex,
  canonicalUrl,
  catalogueKeys,
  classifyCandidate,
  findDuplicate,
  keyIndex,
  markRepeats,
  namesAnInstrument,
  queueMarkdown,
  recordSkeleton,
  reportingPeriodFor,
  suggestedId,
} from '../../lib/letters-queue.mjs';
import { activeSources, relevanceOf } from '../../lib/letters.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

const ACTIVIST = { id: 'starboard-edgar', fund: 'starboard-value', fundSlug: 'starboard-value', organisation: 'Starboard Value', manager: 'Starboard Value LP', sourceType: 'sec_exhibit' };
const CLOSED_END = { id: 'gab', fund: 'gamco', fundSlug: 'gamco-investors', organisation: 'Gabelli Funds', manager: 'Gabelli Funds, LLC', registrant: 'The Gabelli Equity Trust Inc.', sourceType: 'sec_shareholder_report', reportCarriesLetter: true, verifiedOn: '2026-11-07' };
const OPEN_END = { ...CLOSED_END, id: 'seq', fund: 'ruane-cunniff', registrant: 'Sequoia Fund, Inc.', reportCarriesLetter: false };

const cand = (over) => ({
  fund: 'starboard-value',
  sourceId: 'starboard-edgar',
  form: 'DFAN14A',
  accession: '0000921895-26-000436',
  filingDate: '2026-02-17',
  reportDate: null,
  title: 'DFAN14A filed 2026-02-17',
  primaryDocument: 'dfan14a06297373_02172026.htm',
  documentUrl: null,
  indexUrl: 'https://www.sec.gov/Archives/edgar/data/1517137/000092189526000436/0000921895-26-000436-index.htm',
  ...over,
});
const doc = (seq, type, description, filename, size) => ({ seq, type, description, filename, size, url: `https://www.sec.gov/Archives/edgar/data/1517137/000092189526000436/${filename}` });

// ── Keys and duplicates ─────────────────────────────────────────────────────

test('an accession is read off an Archives URL, and a URL is compared without www., query or fragment', () => {
  assert.equal(accessionFromUrl('https://www.sec.gov/Archives/edgar/data/1170010/000092189526000666/ex1.pdf'), '0000921895-26-000666');
  assert.equal(accessionFromUrl('https://www.sec.gov/Archives/edgar/data/89043/000008904302000001/n30d.txt'), '0000089043-02-000001');
  assert.equal(accessionFromUrl('https://stripe.com/annual-updates/2025'), null);
  assert.equal(canonicalUrl('https://www.sec.gov/Archives/x.htm#page=3'), 'https://sec.gov/Archives/x.htm');
  assert.equal(canonicalUrl('http://WWW.Example.com/a/?q=1'), 'https://example.com/a');
  assert.equal(canonicalUrl('not a url'), null);
});

test('a catalogue record without an accession field still yields one from its URL, and held and excluded records count', () => {
  const keys = [
    ...catalogueKeys([{ id: 'a', sourceUrl: 'https://www.sec.gov/Archives/edgar/data/1/000119312526074946/d.htm' }, { id: 'b', accession: '0000921895-26-000666', sourceUrl: 'https://www.sec.gov/x.pdf' }], 'published'),
    ...catalogueKeys([{ id: 'h', sourceUrl: 'https://www.sec.gov/Archives/edgar/data/2/000095012906002330/l.htm' }], 'held'),
    ...catalogueKeys([{ id: 'x', sourceUrl: null }], 'excluded'),
  ];
  assert.deepEqual(keys.map((k) => [k.id, k.status, k.accession]), [['a', 'published', '0001193125-26-074946'], ['b', 'published', '0000921895-26-000666'], ['h', 'held', '0000950129-06-002330'], ['x', 'excluded', null]]);
  const idx = keyIndex(keys);
  assert.equal(findDuplicate({ accession: '0000921895-26-000666' }, idx).id, 'b');
  assert.equal(findDuplicate({ accession: '0000950129-06-002330' }, idx).status, 'held', 'a held document is already decided');
  const byUrl = findDuplicate({ accession: '9999999999-99-999999', documentUrl: 'https://sec.gov/x.pdf#page=2' }, idx);
  assert.deepEqual([byUrl.id, byUrl.matchedBy], ['b', 'url']);
  assert.equal(findDuplicate({ accession: '1111111111-11-111111' }, idx), null);
});

// ── Periods ─────────────────────────────────────────────────────────────────

test('periods are the site\'s: the fiscal year, the calendar half, the fiscal half, or the filing date for an event', () => {
  assert.equal(reportingPeriodFor('N-CSR', '2025-12-31', '2026-03-09'), 'FY2025');
  assert.equal(reportingPeriodFor('N-CSR', '2025-09-30', '2025-12-02'), 'FY2025');
  assert.equal(reportingPeriodFor('N-CSRS', '2026-06-30', '2026-09-08'), '2026H1');
  assert.equal(reportingPeriodFor('N-CSRS', '2025-03-31', '2025-05-29'), 'FY2025H1', "Oakmark's March report is H1 of the year to September");
  assert.equal(reportingPeriodFor('N-CSRS', '2025-12-31', '2026-02-27'), 'FY2026H1');
  assert.equal(reportingPeriodFor('N-CSR/A', '2024-12-31', '2025-03-26'), 'FY2024');
  assert.equal(reportingPeriodFor('DFAN14A', null, '2026-02-17'), '2026-02-17');
});

// ── Classification ──────────────────────────────────────────────────────────

test('a shareholder report is a letter only where its registrant was checked to carry one', () => {
  const r = cand({ form: 'N-CSR', sourceId: 'gab', fund: 'gamco', reportDate: '2025-12-31' });
  const yes = classifyCandidate(r, CLOSED_END);
  assert.deepEqual([yes.classification, yes.confidence, yes.suggestedContentType], ['investor-letter', 'high', 'manager-letter']);
  const no = classifyCandidate(r, OPEN_END);
  assert.deepEqual([no.classification, no.confidence, no.suggestedContentType], ['other', 'high', 'fund-report']);
  assert.ok(no.reasons.some((x) => /tailored shareholder report/.test(x)));
  const unchecked = classifyCandidate(r, { ...CLOSED_END, reportCarriesLetter: undefined });
  assert.deepEqual([unchecked.classification, unchecked.confidence], ['investor-letter', 'low']);
  const amended = classifyCandidate({ ...r, form: 'N-CSR/A' }, CLOSED_END);
  assert.deepEqual([amended.classification, amended.suggestedContentType], ['other', null]);
});

test('an exhibit labelled as a letter makes the filing a letter; a deck a presentation', () => {
  const docs = [doc('1', 'DFAN14A', '', 'dfan14a.htm', 20000), doc('2', 'DFAN14A', 'LETTER TO THE ISSUER, DATED FEBRUARY 17, 2026', 'ex1.pdf', 456694)];
  const v = classifyCandidate(cand(), ACTIVIST, { documents: docs });
  assert.deepEqual([v.classification, v.confidence, v.suggestedContentType, v.letterDocument.filename], ['investor-letter', 'high', 'activist-letter', 'ex1.pdf']);
  const deck = classifyCandidate(cand(), ACTIVIST, { documents: [docs[0], doc('2', 'DFAN14A', 'INVESTOR PRESENTATION', 'ex1.pdf', 9000000)] });
  assert.deepEqual([deck.classification, deck.confidence, deck.suggestedContentType], ['presentation', 'high', null]);
  const thirteen = classifyCandidate(cand({ form: 'SCHEDULE 13D/A' }), ACTIVIST, { documents: [doc('1', 'SCHEDULE 13D/A', '', 'primary_doc.xml', 9000), doc('2', 'EX-99.4', 'JANUARY 27, 2025 LETTER', 'exhibit99_4.htm', 17979)] });
  assert.deepEqual([thirteen.classification, thirteen.confidence], ['investor-letter', 'high']);
});

test('a letter agreement, a joint filing agreement or the 13D amendment itself is never a letter or a deck', () => {
  assert.equal(namesAnInstrument('REGISTRATION RIGHTS LETTER AGREEMENT, DATED AUGUST 2025'), true);
  assert.equal(namesAnInstrument('EX 1 - AMENDMENT NO. 1 TO THE SCHEDULE 13D'), true);
  assert.equal(namesAnInstrument('LETTER TO THE BOARD REGARDING THE COOPERATION AGREEMENT'), false, 'a letter addressed to someone is writing');
  const v = classifyCandidate(cand({ form: 'SCHEDULE 13D' }), ACTIVIST, { documents: [doc('1', 'SCHEDULE 13D', '', 'primary_doc.xml', 9000), doc('2', 'EX-4', 'REGISTRATION RIGHTS LETTER AGREEMENT', 'exh_4.htm', 11449)] });
  assert.equal(v.classification, 'other');
  const amendment = classifyCandidate(cand(), ACTIVIST, { documents: [doc('1', 'DFAN14A', '', 'c.htm', 20000), doc('2', 'DFAN14A', 'EX 1 - AMENDMENT NO. 1 TO THE SCHEDULE 13D', 'ex1.pdf', 1526499)] });
  assert.notEqual(amendment.classification, 'investor-letter');
  assert.notEqual(amendment.classification, 'presentation');
});

test('an unlabelled PDF is judged by its size, at low confidence; a press release is other', () => {
  const cover = doc('1', 'DFAN14A', '', 'c.htm', 20000);
  const small = classifyCandidate(cand(), ACTIVIST, { documents: [cover, doc('2', 'DFAN14A', 'EXHIBIT 99.1', 'ex991.pdf', 342394)] });
  assert.deepEqual([small.classification, small.confidence], ['investor-letter', 'low']);
  const large = classifyCandidate(cand(), ACTIVIST, { documents: [cover, doc('2', 'DFAN14A', '', 'ex991.pdf', 19909588)] });
  assert.deepEqual([large.classification, large.confidence], ['presentation', 'low']);
  const release = classifyCandidate(cand(), ACTIVIST, { documents: [cover, doc('2', 'DFAN14A', 'PRESS RELEASE', 'ex1.htm', 15000)] });
  assert.deepEqual([release.classification, release.confidence], ['other', 'medium']);
});

test('with no index read, a solicitation is proxy material and a 13D is other, both low and flagged', () => {
  const s = classifyCandidate(cand(), ACTIVIST);
  assert.deepEqual([s.classification, s.confidence, s.needsIndex], ['proxy-material', 'low', true]);
  const d = classifyCandidate(cand({ form: 'SC 13D/A', title: 'SC 13D/A filed 2024-11-14' }), ACTIVIST);
  assert.deepEqual([d.classification, d.confidence, d.needsIndex], ['other', 'low', true]);
  const labelled = classifyCandidate(cand({ title: 'LETTER TO STOCKHOLDERS' }), ACTIVIST);
  assert.deepEqual([labelled.classification, labelled.confidence], ['investor-letter', 'medium'], "the submissions index's own description counts");
  for (const v of [s, d, labelled]) assert.ok(QUEUE_CLASSES.includes(v.classification));
});

test('the new EDGAR spelling of Schedule 13D ranks like the old one', () => {
  assert.equal(relevanceOf('SCHEDULE 13D', null), relevanceOf('SC 13D', null));
  assert.equal(relevanceOf('SCHEDULE 13D/A', 'AMENDMENT NO. 3'), 'low');
  assert.equal(relevanceOf('SCHEDULE 13D/A', 'LETTER TO THE BOARD'), 'medium');
});

// ── The skeleton ────────────────────────────────────────────────────────────

test('the skeleton carries the filing\'s facts and nothing a person writes, and cannot be published', () => {
  const docs = [doc('1', 'DFAN14A', '', 'c.htm', 20000), doc('2', 'DFAN14A', 'LETTER TO THE ISSUER, DATED FEBRUARY 17, 2026', 'ex1.pdf', 456694)];
  const v = classifyCandidate(cand(), ACTIVIST, { documents: docs });
  const entry = { ...cand(), period: '2026-02-17', subject: { name: 'TripAdvisor, Inc.', cik: '0001526520' }, letterDocument: v.letterDocument, suggestedContentType: v.suggestedContentType };
  const s = recordSkeleton(entry, ACTIVIST);
  assert.equal(s.id, 'starboard-tripadvisor-2026-02');
  assert.deepEqual([s.title, s.why, s.intro, s.quote, s.sector, s.grounded, s.publishable], [null, null, null, null, null, false, false]);
  assert.deepEqual([s.notice, s.topics, s.writerIds], [[], [], []]);
  assert.deepEqual([s.rights, s.sourceRights, s.origin, s.sourceHost, s.containerType], ['link-only', 'sec-public', 'sec-pipeline', 'www.sec.gov', 'sec-exhibit']);
  assert.equal(s.sourceUrl, docs[1].url, 'the letter itself, never the index');
  assert.equal(s.fundSlug, 'starboard-value');
  assert.deepEqual(s.companies, [{ name: 'TripAdvisor, Inc.', ticker: null, role: 'subject' }]);
  assert.ok(!JSON.stringify(s).includes('DATED FEBRUARY'), "the filer's label stays in the reasons, out of the record");
  assert.ok(s.toWrite.includes('why') && s.toWrite.includes('notice'));
  const report = recordSkeleton({ ...cand({ form: 'N-CSRS', accession: '0001829126-26-009842', filingDate: '2026-09-08', documentUrl: 'https://www.sec.gov/Archives/edgar/data/794685/000182912626009842/gab_ncsrs.htm' }), period: '2026H1', subject: null, letterDocument: null, suggestedContentType: 'manager-letter' }, CLOSED_END);
  assert.deepEqual([report.id, report.containerType, report.contentType, report.sourceUrl.endsWith('gab_ncsrs.htm')], ['gamco-gabelli-equity-trust-h1-2026', 'sec-n-csr', 'manager-letter', true]);
  assert.equal(suggestedId({ form: 'N-CSR', period: 'FY2025', filingDate: '2026-03-01' }, { fund: 'pershing-square', registrant: 'Pershing Square USA, Ltd.' }), 'pershing-square-usa-fy2025', 'the prefix is not repeated');
});

// ── The queue ───────────────────────────────────────────────────────────────

test('one filing is one entry, the catalogue is never queued again, first-seen survives and ids never collide', () => {
  const sourcesById = { 'starboard-edgar': ACTIVIST, 'other-edgar': { ...ACTIVIST, id: 'other-edgar', fund: 'other' }, gab: CLOSED_END };
  const candidates = [
    cand({ accession: '0000921895-26-000666', filingDate: '2026-03-11' }),
    cand(),
    cand({ sourceId: 'other-edgar', fund: 'other' }),
    cand({ sourceId: 'gab', fund: 'gamco', form: 'N-CSR', accession: '0001829126-26-002087', filingDate: '2026-03-09', reportDate: '2025-12-31' }),
    cand({ form: 'SCHEDULE 13D/A', accession: '0000921895-26-000479' }),
  ];
  const keys = catalogueKeys([{ id: 'starboard-carmax-2026-03', accession: '0000921895-26-000666', sourceUrl: 'https://www.sec.gov/a.pdf' }, { id: 'starboard-tripadvisor-2026-02', sourceUrl: 'https://stripe.com/x' }], 'published');
  const letter = doc('2', 'DFAN14A', 'LETTER TO THE ISSUER', 'ex1.pdf', 456694);
  const indexes = new Map([
    ['0000921895-26-000436', { documents: [doc('1', 'DFAN14A', '', 'c.htm', 2000), letter], subject: { name: 'TripAdvisor, Inc.', cik: '1' }, indexUrl: 'https://www.sec.gov/Archives/edgar/data/1526520/000092189526000436/0000921895-26-000436-index.htm' }],
    ['0000921895-26-000479', { documents: [doc('1', 'SCHEDULE 13D/A', '', 'p.xml', 2000), { ...letter, type: 'EX-99.1', filename: 'ex991.pdf' }], subject: { name: 'TripAdvisor, Inc.', cik: '1' }, indexUrl: null }],
  ]);
  const previous = { entries: [{ accession: '0000921895-26-000436', firstSeen: '2026-10-01' }] };
  const q = buildQueue({ candidates, sourcesById, keys, indexes, previous, now: new Date('2026-11-07T00:00:00Z') });
  assert.equal(q.counts.duplicates, 1);
  assert.deepEqual(q.duplicates.map((d) => d.catalogueId), ['starboard-carmax-2026-03']);
  assert.equal(q.entries.length, 3, 'the joint filing is one entry');
  const trip = q.entries.find((e) => e.accession === '0000921895-26-000436');
  assert.deepEqual(trip.alsoFiledBy, ['other']);
  assert.equal(trip.firstSeen, '2026-10-01');
  assert.equal(trip.indexUrl.includes('/1526520/'), true, 'the folder the index page names');
  assert.equal(q.entries.find((e) => e.form === 'N-CSR').firstSeen, '2026-11-07');
  assert.equal(q.counts.newSinceLastQueue, 2);
  const ids = q.entries.map((e) => e.skeleton.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(!ids.includes('starboard-tripadvisor-2026-02'), 'the catalogue already uses that id');
  const repeat = q.entries.find((e) => e.accession === '0000921895-26-000479');
  assert.equal(repeat.repeatOf, '0000921895-26-000436', 'the 13D copy of the same letter');
  assert.deepEqual(q.entries.map((e) => e.classification), ['investor-letter', 'investor-letter', 'investor-letter']);
  assert.ok(q.entries.every((e) => e.status === 'review' && e.skeleton.publishable === false));
  const md = queueMarkdown({ ...q, generatedAt: 'x', sources: 3, since: '2024-11-07' });
  assert.ok(!/—/.test(md), 'no em dash');
  assert.match(md, /Nothing here is published/);
  assert.match(md, /Already in the catalogue \(1\)/);
});

test('repeats need the same subject, label and size', () => {
  const e = (accession, filingDate, form, size, label = 'LETTER') => ({ accession, filingDate, form, subject: { name: 'X' }, letterDocument: { label, size } });
  const list = markRepeats([e('b', '2026-02-17', 'SCHEDULE 13D/A', 10), e('a', '2026-02-17', 'DFAN14A', 10), e('c', '2026-02-18', 'DFAN14A', 11)]);
  assert.deepEqual(list.map((x) => [x.accession, x.repeatOf ?? null]), [['b', 'a'], ['a', null], ['c', null]]);
});

// ── What is committed ───────────────────────────────────────────────────────

const registry = JSON.parse(readFileSync(join(ROOT, 'data', 'letters.sources.json'), 'utf8'));
const universe = new Set(JSON.parse(readFileSync(join(ROOT, 'data', 'funds.universe.json'), 'utf8')).managers.map((m) => m.id));

test('every active source is fit for the queue: the new 13D spellings, a checked report, a real 13F page', () => {
  const { active, problems } = activeSources(registry);
  assert.deepEqual(problems, []);
  for (const s of active) {
    assert.ok(s.organisation && s.manager, `${s.id} names its organisation and manager`);
    if (s.fundSlug !== undefined) assert.ok(universe.has(s.fundSlug), `${s.id}: fundSlug ${s.fundSlug} is a manager in funds.universe.json`);
    if (s.sourceType === 'sec_exhibit') for (const f of ['SC 13D', 'SC 13D/A', 'SCHEDULE 13D', 'SCHEDULE 13D/A']) assert.ok(s.forms.includes(f), `${s.id} lists ${f}`);
    if (s.sourceType === 'sec_shareholder_report') {
      assert.equal(typeof s.reportCarriesLetter, 'boolean', `${s.id} says whether its report carries a letter`);
      assert.match(s.reportCheck || '', /checked \d{4}-\d{2}-\d{2}/, `${s.id} says which filing was checked, and when`);
    }
    if (s.verifiedOn) assert.match(s.verifiedOn, /^\d{4}-\d{2}-\d{2}$/);
  }
  const ciks = active.map((s) => s.cik);
  assert.equal(new Set(ciks).size, ciks.length, 'no CIK is listed twice');
  assert.ok(registry.excluded.some((e) => e.domain === 'pershingsquareholdings.com'), 'the excluded domain stays excluded beside its SEC route');
});

test('the committed keys and queue: nothing queued that the catalogue holds, nothing publishable, nothing off sec.gov', () => {
  const keysPath = join(ROOT, 'data', 'letters.catalogue-keys.json');
  assert.ok(existsSync(keysPath), 'data/letters.catalogue-keys.json is committed');
  const keys = JSON.parse(readFileSync(keysPath, 'utf8'));
  assert.ok(keys.keys.length >= 85, 'every published record at least');
  for (const k of keys.keys) assert.deepEqual(Object.keys(k).sort(), ['accession', 'id', 'status', 'urls'], 'ids, statuses, accessions and URLs only');
  const queuePath = join(ROOT, 'data', 'letters.review-queue.json');
  if (!existsSync(queuePath)) return;
  const q = JSON.parse(readFileSync(queuePath, 'utf8'));
  const idx = keyIndex(keys.keys);
  for (const e of q.entries) {
    assert.equal(findDuplicate(e, idx), null, `${e.accession} is already in the catalogue`);
    assert.ok(['review', 'rejected'].includes(e.status), `${e.accession} has status ${e.status}`);
    if (e.status === 'rejected') assert.ok(e.decisionReason, `${e.accession} is rejected with no reason`);
    assert.ok(QUEUE_CLASSES.includes(e.classification));
    assert.equal(e.skeleton.publishable, false);
    assert.equal(e.skeleton.why, null);
    assert.deepEqual(e.skeleton.notice, []);
    for (const u of [e.indexUrl, e.letterDocument?.url, e.skeleton.sourceUrl].filter(Boolean)) assert.match(u, /^https:\/\/www\.sec\.gov\//);
  }
  const accs = q.entries.map((e) => e.accession);
  assert.equal(new Set(accs).size, accs.length, 'one filing, one entry');
  assert.ok(!/—/.test(readFileSync(join(ROOT, 'data', 'letters.review-queue.md'), 'utf8')), 'no em dash in the page a reviewer reads');
});

test('the weekly workflow runs the queue, keeps it as an artifact, and can only read', () => {
  const wf = readFileSync(join(ROOT, '.github', 'workflows', 'letters-discover.yml'), 'utf8');
  assert.match(wf, /run: node scripts\/letters-queue\.mjs/);
  assert.match(wf, /data\/letters\.review-queue\.json/);
  assert.ok(!/:\s*write\b/.test(wf), 'no write permission anywhere in the file');
  assert.ok(!/git (push|commit)|gh pr|pull-requests/.test(wf), 'it neither commits nor opens a pull request');
});

test('a decision travels with its filing: rejected stays rejected, with its reason', () => {
  const src = { id: 's', fund: 'f', manager: 'M', forms: ['DFAN14A'] };
  const c = (accession) => ({ accession, fund: 'f', sourceId: 's', form: 'DFAN14A', filingDate: '2025-05-01', indexUrl: `https://www.sec.gov/Archives/edgar/data/1/${accession}-index.htm` });
  const decisions = decisionIndex({ decisions: [
    { accession: 'A-1', decision: 'rejected', reason: 'a press release, not a letter', decidedOn: '2026-11-08' },
    { accession: 'A-3', decision: 'published', reason: 'not a queue state' },
  ] });
  const q = buildQueue({ candidates: [c('A-1'), c('A-2'), c('A-3')], sourcesById: { s: src }, keys: [], decisions });
  const by = Object.fromEntries(q.entries.map((e) => [e.accession, e]));
  assert.equal(by['A-1'].status, 'rejected');
  assert.equal(by['A-1'].decisionReason, 'a press release, not a letter');
  assert.equal(by['A-2'].status, 'review');
  assert.equal(by['A-3'].status, 'review', 'only rejected and review are queue decisions; publication is the catalogue');
  assert.equal(q.counts.rejected, 1);
  assert.equal(q.counts.toReview, 2);
});

console.log(`${passed} passed`);
