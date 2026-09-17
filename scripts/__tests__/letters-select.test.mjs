// Offline checks on the final selection rules and the head classifiers.
// No network, no real document: every fixture below is a synthetic string.
//
//   node scripts/__tests__/letters-select.test.mjs

import assert from 'node:assert/strict';
import { bestPerGroup, candidateRows, classifyHtmlHead, classifyPdfHead, selectFinal } from '../../lib/letters-select.mjs';

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

const SRC = { ex: { sourceType: 'sec_exhibit' }, rep: { sourceType: 'sec_shareholder_report' } };
const row = (o) => ({ eligible: 'yes', format: 'pdf', size: 1000, overFetchCap: false, thesisRelevance: 'high', ...o });

test('covers, schedules, proxy cards, certifications and the submission text file are never candidates', () => {
  const rows = [
    row({ likelyContent: 'letter' }),
    row({ likelyContent: 'solicitation_cover' }),
    row({ likelyContent: 'schedule_13d' }),
    row({ likelyContent: 'proxy_material' }),
    row({ likelyContent: 'routine' }),
    row({ likelyContent: 'unclassified', format: 'text' }),
    row({ likelyContent: 'unclassified' }),
  ];
  assert.deepEqual(candidateRows(rows).map((r) => r.likelyContent), ['letter', 'unclassified']);
});

test('within a campaign a labelled letter beats an unlabelled document, and under-cap beats over-cap', () => {
  const groups = bestPerGroup(
    [
      row({ campaign: 'c', filingDate: '2025-01-01', likelyContent: 'unclassified', filename: 'u.pdf' }),
      row({ campaign: 'c', filingDate: '2024-01-01', likelyContent: 'letter', filename: 'l.pdf' }),
      row({ campaign: 'c', filingDate: '2026-01-01', likelyContent: 'letter', filename: 'big.pdf', overFetchCap: true }),
    ],
    (r) => r.campaign
  );
  assert.equal(groups[0].best.filename, 'l.pdf');
  assert.deepEqual(groups[0].alternatives.map((a) => a.filename), ['big.pdf', 'u.pdf']);
});

test('an activist gets two campaigns; an unlabelled document counts only once validation confirms it', () => {
  const rows = [
    row({ fund: 'a', sourceId: 'ex', campaign: 'c1', filingDate: '2025-03-19', likelyContent: 'letter', filename: 'l.pdf' }),
    row({ fund: 'a', sourceId: 'ex', campaign: 'c2', filingDate: '2024-11-07', likelyContent: 'unclassified', filename: 'u.htm', format: 'html' }),
  ];
  let out = selectFinal(rows, SRC)[0];
  assert.equal(out.picks.length, 1);
  assert.match(out.shortfall, /only 1 acceptable campaign/);
  assert.deepEqual(out.needsValidation.map((r) => r.filename), ['u.htm']);
  rows[1].validation = { classification: 'press_release', confidence: 'firm' };
  out = selectFinal(rows, SRC)[0];
  assert.equal(out.picks.length, 1, 'a release is not a letter');
  rows[1].validation = { classification: 'letter', confidence: 'firm' };
  out = selectFinal(rows, SRC)[0];
  assert.deepEqual(out.picks.map((p) => p.key), ['c1', 'c2']);
  assert.equal(out.shortfall, null);
});

test('an over-cap document is taken only as an explicit exception when no under-cap one gives the second group', () => {
  const rows = [
    row({ fund: 'e', sourceId: 'ex', campaign: 'p66', filingDate: '2025-04-09', likelyContent: 'unclassified', validation: { classification: 'letter' }, filename: 'p.htm', format: 'html' }),
    row({ fund: 'e', sourceId: 'ex', campaign: 'luv', filingDate: '2024-09-24', likelyContent: 'unclassified', validation: { classification: 'presentation', confidence: 'firm' }, filename: 'big.pdf', size: 22286670, overFetchCap: true }),
  ];
  let out = selectFinal(rows, SRC)[0];
  assert.deepEqual(out.picks.map((p) => p.key), ['p66', 'luv']);
  assert.equal(out.picks[0].exception, null);
  assert.match(out.picks[1].exception, /21\.3 MB against the 15 MB cap/);
  rows[1].validation = { classification: 'letter', confidence: 'weak', evidence: '1 portrait page boxes seen' };
  out = selectFinal(rows, SRC)[0];
  assert.match(out.picks[1].exception, /content only weakly validated \(1 portrait page boxes seen\)/, 'a weak read is offered only as an exception that says so');
  rows[1].overFetchCap = false;
  out = selectFinal(rows, SRC)[0];
  assert.equal(out.picks.length, 1, 'under the cap, a weak read does not confirm a document');
});

test('a registered fund gets the newest under-cap report and the earliest other period, over-cap only as an exception', () => {
  const rep = (period, filingDate, size) => row({ fund: 'f', sourceId: 'rep', reportingPeriod: period, filingDate, likelyContent: 'shareholder_report', format: 'inline_html', size, overFetchCap: size > 15 * 1024 * 1024, filename: `${period}.htm` });
  let out = selectFinal([rep('2024-12-31', '2025-03-11', 1_500_000), rep('2025-12-31', '2026-03-10', 1_800_000), rep('2026-06-30', '2026-09-04', 1_400_000)], SRC)[0];
  assert.deepEqual(out.picks.map((p) => p.key), ['2026-06-30', '2024-12-31']);
  out = selectFinal([rep('2024-09-30', '2024-12-04', 13_674_170), rep('2025-09-30', '2025-12-02', 16_984_969), rep('2026-03-31', '2026-05-22', 16_776_637)], SRC)[0];
  assert.deepEqual(out.picks.map((p) => p.key), ['2024-09-30', '2026-03-31']);
  assert.equal(out.picks[0].exception, null);
  assert.match(out.picks[1].exception, /16\.0 MB against the 15 MB cap/);
});

test('an HTML head is classified by its opening markers and title, and a short page is a cover', () => {
  const letter = '<html><head><title>Starboard Delivers Letter to Stockholders</title></head><body><p>Dear Fellow Stockholders,</p>' + '<p>word </p>'.repeat(400) + '</body></html>';
  const r1 = classifyHtmlHead(letter);
  assert.equal(r1.classification, 'letter');
  assert.equal(r1.title, 'Starboard Delivers Letter to Stockholders');
  assert.ok(r1.words > 150);
  const release = '<html><body><p>FOR IMMEDIATE RELEASE</p>' + '<p>word </p>'.repeat(400) + '</body></html>';
  assert.equal(classifyHtmlHead(release).classification, 'press_release');
  const wrapped = '<html><body><p>FOR IMMEDIATE RELEASE</p><p>The full text of the letter follows: Dear Members of the Board,</p>' + '<p>word </p>'.repeat(400) + '</body></html>';
  assert.equal(classifyHtmlHead(wrapped).classification, 'letter');
  const cover = '<html><body><p>Filed by Starboard Value LP pursuant to Rule 14a-12 under the Securities Exchange Act of 1934. This filing consists of a press release.</p></body></html>';
  assert.equal(classifyHtmlHead(cover).classification, 'cover');
  assert.equal(classifyHtmlHead('<html><body><p>nothing much</p></body></html>').classification, 'cover');
});

test('a PDF head is classified by page geometry: landscape boxes are slides, portrait boxes a letter', () => {
  const slides = '%PDF-1.7\n1 0 obj << /Type /Pages /Count 48 >> endobj\n' + '2 0 obj << /Type /Page /MediaBox [0 0 792 612] >> endobj\n'.repeat(5) + '/Title (Stronger Airline)';
  const r = classifyPdfHead(Buffer.from(slides, 'latin1'));
  assert.equal(r.classification, 'presentation');
  assert.equal(r.confidence, 'firm');
  assert.equal(r.pages, 48);
  assert.equal(r.title, 'Stronger Airline');
  const letter = '%PDF-1.7\n1 0 obj << /Type /Pages /Count 6 >> endobj\n' + '2 0 obj << /Type /Page /MediaBox [0 0 612 792] >> endobj\n'.repeat(3);
  assert.equal(classifyPdfHead(Buffer.from(letter, 'latin1')).classification, 'letter');
  const oneBox = '%PDF-1.7\n2 0 obj << /Type /Page /MediaBox [0 0 612 792] >> endobj\n';
  assert.equal(classifyPdfHead(Buffer.from(oneBox, 'latin1')).confidence, 'weak', 'one page box settles nothing');
  assert.equal(classifyPdfHead(Buffer.from('%PDF-1.4 nothing useful', 'latin1')).classification, 'unclear');
});

console.log(`${passed} passed`);
