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
  assert.deepEqual(candidateRows(rows, {}).map((r) => r.likelyContent), ['letter', 'unclassified']);
});

test('within a campaign a labelled letter beats an unlabelled document, and an over-cap one never gets that far', () => {
  const rows = [
    row({ campaign: 'c', filingDate: '2025-01-01', likelyContent: 'unclassified', filename: 'u.pdf' }),
    row({ campaign: 'c', filingDate: '2024-01-01', likelyContent: 'letter', filename: 'l.pdf' }),
    row({ campaign: 'c', filingDate: '2026-01-01', likelyContent: 'letter', filename: 'big.pdf', overFetchCap: true }),
  ];
  assert.deepEqual(candidateRows(rows, {}).map((r) => r.filename), ['u.pdf', 'l.pdf'], 'the over-cap letter is not a candidate at all');
  const groups = bestPerGroup(candidateRows(rows, {}), (r) => r.campaign);
  assert.equal(groups[0].best.filename, 'l.pdf');
  assert.deepEqual(groups[0].alternatives.map((a) => a.filename), ['u.pdf']);
});

test('an activist gets two campaigns; an unlabelled document counts only once validation confirms it', () => {
  const rows = [
    row({ fund: 'a', sourceId: 'ex', campaign: 'c1', filingDate: '2025-03-19', likelyContent: 'letter', filename: 'l.pdf' }),
    row({ fund: 'a', sourceId: 'ex', campaign: 'c2', filingDate: '2024-11-07', likelyContent: 'unclassified', filename: 'u.htm', format: 'html' }),
  ];
  let out = selectFinal(rows, SRC, {})[0];
  assert.equal(out.picks.length, 1);
  assert.match(out.shortfall, /only 1 acceptable campaign/);
  assert.deepEqual(out.needsValidation.map((r) => r.filename), ['u.htm']);
  rows[1].validation = { classification: 'press_release', confidence: 'firm' };
  out = selectFinal(rows, SRC, {})[0];
  assert.equal(out.picks.length, 1, 'a release is not a letter');
  rows[1].validation = { classification: 'letter', confidence: 'firm' };
  out = selectFinal(rows, SRC, {})[0];
  assert.deepEqual(out.picks.map((p) => p.key), ['c1', 'c2']);
  assert.equal(out.shortfall, null);
});

test('an over-cap document is never selected, and a weakly validated one does not confirm', () => {
  const rows = [
    row({ fund: 'e', sourceId: 'ex', campaign: 'p66', filingDate: '2025-04-09', likelyContent: 'unclassified', validation: { classification: 'letter', confidence: 'firm' }, filename: 'p.htm', format: 'html' }),
    row({ fund: 'e', sourceId: 'ex', campaign: 'luv', filingDate: '2024-09-24', likelyContent: 'unclassified', validation: { classification: 'presentation', confidence: 'firm' }, filename: 'big.pdf', size: 22286670, overFetchCap: true }),
  ];
  let out = selectFinal(rows, SRC, {})[0];
  assert.deepEqual(out.picks.map((p) => p.key), ['p66'], 'the over-cap document is out, so one campaign remains');
  assert.match(out.shortfall, /only 1 acceptable campaign/);
  rows[1].overFetchCap = false;
  out = selectFinal(rows, SRC, {})[0];
  assert.deepEqual(out.picks.map((p) => p.key), ['p66', 'luv'], 'under the cap it is selected on its firm validation');
  rows[1].validation = { classification: 'letter', confidence: 'weak', evidence: '1 portrait page boxes seen' };
  out = selectFinal(rows, SRC, {})[0];
  assert.equal(out.picks.length, 1, 'a weak read confirms nothing, cap or no cap');
});

test('a registered fund gets the newest report and the earliest other period, and over-cap reports are simply absent', () => {
  const rep = (period, filingDate, size) => row({ fund: 'f', sourceId: 'rep', reportingPeriod: period, filingDate, likelyContent: 'shareholder_report', format: 'inline_html', size, overFetchCap: size > 15 * 1024 * 1024, filename: `${period}.htm` });
  let out = selectFinal([rep('2024-12-31', '2025-03-11', 1_500_000), rep('2025-12-31', '2026-03-10', 1_800_000), rep('2026-06-30', '2026-09-04', 1_400_000)], SRC, {})[0];
  assert.deepEqual(out.picks.map((p) => p.key), ['2026-06-30', '2024-12-31'], 'newest, then the earliest other period');
  // Oakmark's four reports as they really are: two above the cap, two below.
  out = selectFinal([rep('2024-09-30', '2024-12-04', 13_674_170), rep('2025-03-31', '2025-05-29', 15_598_170), rep('2025-09-30', '2025-12-02', 16_984_969), rep('2026-03-31', '2026-05-22', 16_776_637)], SRC, {})[0];
  assert.deepEqual(out.picks.map((p) => p.key), ['2025-03-31', '2024-09-30'], 'the two under the cap, newest first then the earlier period');
  assert.equal(out.shortfall, null);
  assert.equal(out.picks[0].exception, null);
  assert.equal(out.picks[1].exception, null, 'no pick anywhere carries a size exception any more');
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



// ── The fetch cap, refusals and the ledger ──────────────────────────────────

import { isRefused } from '../../lib/letters-select.mjs';
import { ledgerSummary } from '../../lib/letters-ledger.mjs';
import { FETCH_CAP_BYTES, overFetchCap } from '../../lib/letters.mjs';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('the size threshold holds at one byte below, exactly at, and one byte above', () => {
  assert.equal(FETCH_CAP_BYTES, 15_728_640, '15 MiB, the threshold as it has been applied throughout');
  assert.equal(overFetchCap(FETCH_CAP_BYTES - 1), false, 'one byte below is eligible');
  assert.equal(overFetchCap(FETCH_CAP_BYTES), false, 'exactly at the cap is eligible');
  assert.equal(overFetchCap(FETCH_CAP_BYTES + 1), true, 'one byte above is not');
  const at = (size) => row({ fund: 'f', sourceId: 'rep', reportingPeriod: `p${size}`, filingDate: '2026-01-01', likelyContent: 'shareholder_report', size, overFetchCap: overFetchCap(size), filename: `${size}.htm`, format: 'inline_html' });
  const out = selectFinal([at(FETCH_CAP_BYTES - 1), at(FETCH_CAP_BYTES), at(FETCH_CAP_BYTES + 1)], SRC, { refused: [] })[0];
  assert.equal(out.picks.length, 2);
  assert.ok(!out.picks.some((p) => p.best.size > FETCH_CAP_BYTES), 'nothing above the cap is ever selected');
  assert.ok(out.picks.every((p) => p.exception === null), 'and nothing is carried as a size exception');
});

test('a document Suro refused is never selected again, whatever its score', () => {
  const decisions = { refused: [{ accession: 'a1', filename: 'big.pdf', reason: 'size exception refused' }] };
  const rows = [
    row({ fund: 'e', sourceId: 'ex', campaign: 'c1', filingDate: '2025-04-09', likelyContent: 'letter', filename: 'ok.htm', format: 'html', accession: 'a0' }),
    row({ fund: 'e', sourceId: 'ex', campaign: 'c2', filingDate: '2024-09-24', likelyContent: 'letter', filename: 'big.pdf', accession: 'a1' }),
  ];
  assert.equal(isRefused(rows[1], decisions), true);
  assert.equal(candidateRows(rows, decisions).length, 1);
  const out = selectFinal(rows, SRC, decisions)[0];
  assert.deepEqual(out.picks.map((p) => p.key), ['c1']);
  assert.match(out.shortfall, /only 1 acceptable campaign\(s\) under the fetch cap/);
});

test('the ledger separates what was observed from what was reconstructed', () => {
  const s = ledgerSummary(join(REPO, 'data', 'letters.requests.jsonl'));
  assert.ok(s.observed > 0 && s.reconstructed > 0);
  assert.equal(s.reconstructed, 20, 'the five discovery and fifteen index attempts of 16 September');
  assert.equal(s.byScript['enumerate-letters'].reconstructed, 15);
  assert.match(s.note, /reconstructed/i, 'the file says in its first line which lines are which');
  const raw = readFileSync(join(REPO, 'data', 'letters.requests.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(raw.filter((l) => l.status === 503).every((l) => l.reconstructed === true), 'the 503 and its retry are marked reconstructed');
  assert.ok(raw.filter((l) => l.attempt === 1).every((l) => l.reconstructed === true));
});

test('no committed report carries a response body or extracted prose', () => {
  for (const f of ['letters.selection.json', 'letters.exhibits.json', 'letters.discovery.json', 'letters.validations.json']) {
    const text = readFileSync(join(REPO, 'data', f), 'utf8');
    assert.ok(!/<html|<!DOCTYPE|%PDF/i.test(text), `${f} holds no markup or PDF bytes`);
    let longest = 0;
    (function walk(v) {
      if (typeof v === 'string') longest = Math.max(longest, v.length);
      else if (v && typeof v === 'object') for (const x of Object.values(v)) walk(x);
    })(JSON.parse(text));
    assert.ok(longest <= 600, `${f} longest string is ${longest} characters: metadata, not text`);
  }
});

console.log(`${passed} passed`);
