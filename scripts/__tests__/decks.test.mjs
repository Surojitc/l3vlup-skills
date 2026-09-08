// Offline checks on the board-book index parsers. No network: every fixture
// is a fragment of a real EDGAR page, cut down to the lines that matter.
//
//   node scripts/__tests__/decks.test.mjs

import assert from 'node:assert/strict';
import {
  acquirerType,
  capSize,
  classifyExhibit,
  detectAdvisers,
  detectAnalyses,
  extractCoverTitle,
  findCoverDate,
  findProjectName,
  parseHeader,
  parseTransactionValue,
  rate,
  sectorOf,
  stripHtml,
} from '../../lib/decks.mjs';

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

// ── Exhibit letters ─────────────────────────────────────────────────────────

test('exhibit letter is the classification, Arabic or Roman', () => {
  assert.equal(classifyExhibit('EX-99.(C)(2)'), 'adviser');
  assert.equal(classifyExhibit('EX-99.(C)(III)'), 'adviser');
  assert.equal(classifyExhibit('EX-99.CII'), 'adviser');
  assert.equal(classifyExhibit('EX-(c)(1)'), 'adviser');
  assert.equal(classifyExhibit('EX-99.(A)(1)(A)'), 'offer');
  assert.equal(classifyExhibit('EX-99.(B)(1)'), 'financing');
  assert.equal(classifyExhibit('EX-99.(D)(1)'), 'agreement');
  assert.equal(classifyExhibit('EX-FILING FEES'), 'other');
  assert.equal(classifyExhibit('EX-99'), 'other');
  assert.equal(classifyExhibit('GRAPHIC'), 'other');
});

// ── Header ──────────────────────────────────────────────────────────────────

const HEADER = `<html><body><pre>
&lt;SEC-HEADER&gt;0001193125-20-245290.hdr.sgml : 20200914
ACCESSION NUMBER:\t\t0001193125-20-245290
CONFORMED SUBMISSION TYPE:\tSC TO-T
GROUP MEMBERS:\t\tAVALANCHE MERGER SUB, INC.
SUBJECT COMPANY:\t
\tCOMPANY DATA:\t
\t\tCOMPANY CONFORMED NAME:\t\t\tAKCEA THERAPEUTICS, INC.
\t\tCENTRAL INDEX KEY:\t\t\t0001662524
\t\tSTANDARD INDUSTRIAL CLASSIFICATION:\tPHARMACEUTICAL PREPARATIONS [2834]
\t\tSTATE OF INCORPORATION:\t\t\tDE
\tFILING VALUES:
\t\tFORM TYPE:\t\tSC 13E3
FILED BY:\t\t
\tCOMPANY DATA:\t
\t\tCOMPANY CONFORMED NAME:\t\t\tIONIS PHARMACEUTICALS INC
\t\tCENTRAL INDEX KEY:\t\t\t0000874015
\t\tSTANDARD INDUSTRIAL CLASSIFICATION:\tPHARMACEUTICAL PREPARATIONS [2834]
&lt;/SEC-HEADER&gt;
&lt;DOCUMENT&gt;
&lt;TYPE&gt;SC TO-T
&lt;SEQUENCE&gt;1
&lt;FILENAME&gt;d70561dsctot.htm
&lt;DESCRIPTION&gt;SC TO-T
&lt;DOCUMENT&gt;
&lt;TYPE&gt;EX-99.CII
&lt;SEQUENCE&gt;9
&lt;FILENAME&gt;d70561dex99cii.htm
&lt;DESCRIPTION&gt;EX-(C)(II)
&lt;DOCUMENT&gt;
&lt;TYPE&gt;GRAPHIC
&lt;SEQUENCE&gt;10
&lt;FILENAME&gt;g70561ex99ciis10g1.jpg
</pre></body></html>`;

test('header yields the target with its industry code, the filer, and typed documents', () => {
  const h = parseHeader(HEADER);
  assert.equal(h.subjects.length, 1);
  assert.equal(h.subjects[0].name, 'AKCEA THERAPEUTICS, INC.');
  assert.equal(h.subjects[0].cik, '0001662524');
  assert.equal(h.subjects[0].sic, '2834');
  assert.equal(h.subjects[0].sicDescription, 'PHARMACEUTICAL PREPARATIONS');
  assert.equal(h.filers[0].name, 'IONIS PHARMACEUTICALS INC');
  assert.deepEqual(h.groupMembers, ['AVALANCHE MERGER SUB, INC.']);
  assert.equal(h.documents.length, 3);
  assert.equal(h.documents[1].type, 'EX-99.CII');
  assert.equal(h.documents[1].file, 'd70561dex99cii.htm');
  assert.equal(h.documents[1].description, 'EX-(C)(II)');
  assert.equal(h.documents[2].description, '');
});

// ── Fee table ───────────────────────────────────────────────────────────────

test('transaction value from the 2022+ fee exhibit', () => {
  const t = 'Table 1 - Transaction Valuation Transaction Valuation* Fee Rate Amount of Filing Fee** Fees to Be Paid $ 20,072,133.27 0.00013810 $ 2,771.96 Fees Previously Paid';
  assert.equal(parseTransactionValue(t), 20);
});

test('transaction value from a pre-2022 cover page', () => {
  const t = 'CALCULATION OF FILING FEE Transaction Valuation* Amount of Filing Fee** $ 535,900,072 $ 69,559.83 * Estimated for purposes of calculating the filing fee only.';
  assert.equal(parseTransactionValue(t), 536);
});

test('no fee table, no value', () => {
  assert.equal(parseTransactionValue('nothing to see'), null);
  assert.equal(parseTransactionValue('Transaction Valuation N/A'), null);
});

// ── Deck contents ───────────────────────────────────────────────────────────

test('analyses need more than a passing mention', () => {
  const text = stripHtml('<p>Discounted cash flow analysis</p><p>DCF</p><p>Selected companies analysis</p><p>selected companies</p><p>premium once</p>');
  const found = detectAnalyses(text);
  assert.ok(found.includes('dcf'));
  assert.ok(found.includes('trading-comps'));
  assert.ok(!found.includes('premiums-paid'));
});

test('the adviser is the bank named repeatedly in the opening pages', () => {
  const opening = 'Project Avalanche. Goldman Sachs Disclaimer. These materials were prepared by Goldman Sachs. Stifel is quoted once.';
  assert.deepEqual(detectAdvisers(opening), ['Goldman Sachs']);
});

// ── Cuts ────────────────────────────────────────────────────────────────────

test('industry codes map to sectors', () => {
  assert.equal(sectorOf('7372'), 'Technology');
  assert.equal(sectorOf('2834'), 'Healthcare');
  assert.equal(sectorOf('6798'), 'Real Estate');
  assert.equal(sectorOf('6022'), 'Financials');
  assert.equal(sectorOf('1311'), 'Energy');
  assert.equal(sectorOf('5812'), 'Consumer & Retail');
  assert.equal(sectorOf('4813'), 'Media & Telecom');
  assert.equal(sectorOf('4911'), 'Utilities');
  assert.equal(sectorOf(null), 'Other');
});

test('size buckets on stated value', () => {
  assert.equal(capSize(null), 'Undisclosed');
  assert.equal(capSize(120), 'Micro');
  assert.equal(capSize(600), 'Small');
  assert.equal(capSize(3200), 'Mid');
  assert.equal(capSize(9000), 'Large');
  assert.equal(capSize(25000), 'Mega');
});

test('buyer type from the filing persons', () => {
  assert.equal(acquirerType(['Silver Lake Partners V, L.P.', 'Bravo Merger Sub, Inc.'], 'Target'), 'Financial sponsor');
  assert.equal(acquirerType(['IONIS PHARMACEUTICALS INC'], 'Akcea'), 'Strategic');
  assert.equal(acquirerType(['John A. Smith'], 'Target'), 'Management / founder');
  assert.equal(acquirerType(['2025 Acquisition Company, LLC'], 'Forian Inc.'), 'Acquisition vehicle');
  assert.equal(acquirerType([], 'Target'), 'Unclassified');
});

test('rating rewards breadth, count, readability and a stated value', () => {
  assert.equal(rate({ decks: 0, readable: 0, analyses: 0, valued: false }).grade, null);
  assert.equal(rate({ decks: 5, readable: 5, analyses: 8, valued: true }).grade, 'A');
  assert.equal(rate({ decks: 2, readable: 2, analyses: 5, valued: true }).grade, 'B');
  assert.equal(rate({ decks: 2, readable: 2, analyses: 4, valued: false }).grade, 'C');
  assert.equal(rate({ decks: 1, readable: 0, analyses: 0, valued: false }).grade, 'D');
});

// ── Cover titles ────────────────────────────────────────────────────────────

/** A Donnelley exhibit: slide images with each slide's own text in white under it. */
const COVER = `<DOCUMENT>
<TYPE>EX-99.(C)(III)
<SEQUENCE>3
<FILENAME>d75849dex99ciii.htm
<DESCRIPTION>EX-99.(C)(III)
<TEXT>
<HTML><HEAD><TITLE>EX-99.(c)(iii)</TITLE></HEAD><BODY>
<P ALIGN="right"><B>Exhibit (c)(iii) </B></P>
<P><IMG SRC="g75849page11.jpg" ALT="LOGO"></P>
<P STYLE="font-size:0.5pt"><FONT COLOR="#FFFFFF">Project ECLIPSEDiscussion Materials for the Board of
Directors April 2026 Privileged&nbsp;&amp; Confidential / Prepared in Consultation with Counsel Confidential </FONT></P>
</BODY></HTML>`;

test('the cover title is rebuilt from the phrases on the first slide', () => {
  const c = extractCoverTitle(COVER, { filedOn: '2026-09-01' });
  assert.equal(c.coverTitle, 'Project Eclipse: discussion materials for the Board of Directors, April 2026');
  assert.equal(c.projectName, 'Eclipse');
  assert.equal(c.documentKind, 'discussion materials');
  assert.equal(c.preparedFor, 'the Board of Directors');
  assert.equal(c.coverDate, 'April 2026');
});

test('confidentiality boilerplate never reaches the name', () => {
  const c = extractCoverTitle(COVER, { filedOn: '2026-09-01' });
  assert.ok(!/confidential|privileged|counsel|draft/i.test(c.coverTitle));
});

test('a cover that says nothing certain yields no name', () => {
  assert.equal(extractCoverTitle('<TEXT><HTML><BODY><IMG SRC="page1.jpg"></BODY></HTML>').coverTitle, null);
  // A first page that is only the adviser's disclaimer is not a title.
  const disclaimer = '<TEXT><p>Jefferies LLC Member SIPC. The information provided in this document, '
    + 'including valuation discussions, represents the views of Jefferies Investment Banking.</p>';
  assert.equal(extractCoverTitle(disclaimer).coverTitle, null);
});

test('a word every deck uses needs a code name or a committee behind it', () => {
  assert.equal(extractCoverTitle('<TEXT><p>This presentation has been prepared by the adviser.</p>').coverTitle, null);
  assert.equal(
    extractCoverTitle('<TEXT><p>Project Tempest Presentation Materials June 2024</p>').coverTitle,
    'Project Tempest: presentation materials, June 2024',
  );
});

test('the code name survives spacing the filing agent lost', () => {
  assert.equal(findProjectName('Project ECLIPSEDiscussion Materials').name, 'Eclipse');
  assert.equal(findProjectName('Project Northern Lights Presentation prepared for').name, 'Northern Lights');
  // A bank's own name is not the second half of a code name.
  assert.equal(findProjectName('Prepared for Project Stallion WELLS FARGO').name, 'Stallion');
  assert.equal(findProjectName('Project Discussion Materials'), null);
  assert.equal(findProjectName('Discussion Materials'), null);
});

test('the date next to the title beats one left in the template', () => {
  const cover = 'DRAFT CONFIDENTIAL PREPARED JULY 2022 FOR: Project Northern Lights Presentation '
    + 'prepared for the Transaction Committee of the Board of Directors August 12, 2024';
  assert.equal(findCoverDate(cover, { anchor: cover.indexOf('Project') }), '12 August 2024');
  // Letter-spaced covers only read once the spacing is out.
  assert.equal(findCoverDate('Di s cuss ion Materia l s Janu a ry 11, 2024'), '11 January 2024');
  // A date after the filing is a misread, not a meeting.
  assert.equal(findCoverDate('Discussion Materials March 1, 2027', { filedOn: '2026-09-01' }), null);
});

console.log(`${passed} passed`);
