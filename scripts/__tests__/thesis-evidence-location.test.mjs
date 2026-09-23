// Where a quotation sits is found, not asked for.
//
// The first paid pilot lost eight of eleven proposals to "the excerpt occurs
// in the source but not at the stated offsets": the model quoted the letter
// correctly and miscounted the character positions. Asking a language model
// to count characters was the mistake. It now returns the words and nothing
// else, and this suite is the guarantee that the position we compute from
// them is the right one, in the awkward cases as well as the easy ones.
//
//   node scripts/__tests__/thesis-evidence-location.test.mjs

import assert from 'node:assert/strict';
import { chunkDocument, locateExcerpt, toDocumentOffsets } from '../../lib/thesis-chunk.mjs';
import { CANDIDATE_TOOL, SELECTION_TOOL, extractionPrompt } from '../../lib/thesis-anthropic.mjs';
import { NOT_PROPOSABLE, PROPOSABLE, stripToProposable } from '../../lib/thesis-model.mjs';

let passed = 0;
const test = (name, fn) => { fn(); passed += 1; console.log(`  ok  ${name}`); };

/** A chunk that starts part way into a document, so translation is exercised. */
const chunkOf = (text, startOffset = 0, chunkId = 'd#0') => ({ chunkId, index: 0, startOffset, text });

// ── Exact match ────────────────────────────────────────────────────────────

test('a unique excerpt is located, and the offsets point at it', () => {
  const doc = 'Alpha beta. Gross margin should move from 31% to 38%. Gamma delta.';
  const c = chunkOf(doc);
  const r = locateExcerpt(c, 'Gross margin should move from 31% to 38%');
  assert.equal(r.problem, null);
  assert.equal(doc.slice(r.start, r.end), 'Gross margin should move from 31% to 38%');
});

test('the excerpt may be the whole chunk, its first character or its last', () => {
  // Characters chosen to occur once, so this tests the boundary rather than
  // the ambiguity rule.
  const doc = 'Quick brown fox';
  const c = chunkOf(doc);
  for (const ex of [doc, 'Q', 'x', 'Quick', 'fox']) {
    const r = locateExcerpt(c, ex);
    assert.equal(r.problem, null, `${JSON.stringify(ex)}: ${r.problem}`);
    assert.equal(doc.slice(r.start, r.end), ex);
  }
});

test('an excerpt the chunk does not contain is refused, never repaired', () => {
  const c = chunkOf('We added to Northwind Components during the quarter.');
  for (const ex of ['Earnings will double by Thursday', 'northwind components', 'We  added']) {
    const r = locateExcerpt(c, ex);
    assert.match(r.problem, /does not occur in chunk/, `${JSON.stringify(ex)} was located`);
    assert.equal(r.start, null);
  }
});

// ── Ambiguity ──────────────────────────────────────────────────────────────

test('an excerpt that occurs twice is dropped rather than resolved to the first', () => {
  const c = chunkOf('The risk we watch. Something else. The risk we watch.');
  const r = locateExcerpt(c, 'The risk we watch');
  assert.match(r.problem, /occurs more than once/);
  assert.equal(r.start, null);
});

test('overlapping repeats count as repeats', () => {
  // "aa" sits in "aaa" twice, at 0 and at 1. Counting by splitting would say
  // once and quietly pick a position.
  const r = locateExcerpt(chunkOf('xaaay'), 'aa');
  assert.match(r.problem, /occurs more than once/);
});

test('a longer excerpt disambiguates, which is what the model is asked to do', () => {
  const doc = 'Margin should rise, we think. Margin should rise, they agree.';
  assert.match(locateExcerpt(chunkOf(doc), 'Margin should rise').problem, /more than once/);
  const r = locateExcerpt(chunkOf(doc), 'Margin should rise, they agree');
  assert.equal(r.problem, null);
  assert.equal(doc.slice(r.start, r.end), 'Margin should rise, they agree');
});

// ── Unicode ────────────────────────────────────────────────────────────────

test('non-ASCII text is located, and the offsets are the ones a slice uses', () => {
  // Offsets are UTF-16 code units, because that is what String.slice takes and
  // what verifyEvidence re-checks with. Astral characters count as two, and
  // the assertion below is what keeps that true rather than assumed.
  const doc = 'Le résultat du deuxième trimestre — 38 % — dépasse nos attentes. 家族経営の企業です。';
  const c = chunkOf(doc);
  for (const ex of ['résultat du deuxième trimestre', '38 % — dépasse', '家族経営の企業']) {
    const r = locateExcerpt(c, ex);
    assert.equal(r.problem, null, `${ex}: ${r.problem}`);
    assert.equal(doc.slice(r.start, r.end), ex);
  }
});

test('an emoji or other astral character does not shift the span', () => {
  const doc = 'Up 📈 sharply, and margin should move from 31% to 38%.';
  const r = locateExcerpt(chunkOf(doc), 'margin should move from 31% to 38%');
  assert.equal(r.problem, null);
  assert.equal(doc.slice(r.start, r.end), 'margin should move from 31% to 38%');
});

test('characters that look alike are not the same characters', () => {
  // A curly apostrophe is not a straight one and an en dash is not a hyphen.
  // Matching is byte-for-byte on purpose: a tidied quotation is not a
  // quotation, and silently accepting one would let the excerpt drift from
  // what the manager wrote.
  const doc = 'The company’s margin — 31% – 38% — is turning.';
  assert.match(locateExcerpt(chunkOf(doc), "The company's margin").problem, /does not occur/);
  assert.match(locateExcerpt(chunkOf(doc), 'margin - 31%').problem, /does not occur/);
  assert.equal(locateExcerpt(chunkOf(doc), 'The company’s margin').problem, null);
});

// ── Punctuation and whitespace ─────────────────────────────────────────────

test('punctuation is part of the excerpt, not decoration around it', () => {
  const doc = 'Two customers are 58% of revenue, which is the risk we watch most closely.';
  const c = chunkOf(doc);
  const withComma = locateExcerpt(c, 'Two customers are 58% of revenue,');
  assert.equal(withComma.problem, null);
  assert.equal(doc.slice(withComma.start, withComma.end), 'Two customers are 58% of revenue,');
  assert.match(locateExcerpt(c, 'Two customers are 58% of revenue.').problem, /does not occur/);
});

test('whitespace must match exactly, including newlines and runs of spaces', () => {
  const doc = 'First line.\n\nSecond  line with two spaces.\tAnd a tab.';
  const c = chunkOf(doc);
  for (const ex of ['First line.\n\nSecond', 'Second  line', 'tab.']) {
    assert.equal(locateExcerpt(c, ex).problem, null, `${JSON.stringify(ex)} was not located`);
  }
  // A collapsed run of spaces is a different string.
  assert.match(locateExcerpt(c, 'Second line with two spaces').problem, /does not occur/);
  // So is a newline the model turned into a space.
  assert.match(locateExcerpt(c, 'First line. Second').problem, /does not occur/);
});

test('leading and trailing whitespace is significant, because a slice keeps it', () => {
  const doc = 'alpha beta gamma';
  const r = locateExcerpt(chunkOf(doc), ' beta ');
  assert.equal(r.problem, null);
  assert.equal(doc.slice(r.start, r.end), ' beta ');
});

// ── Boundaries and refusals ────────────────────────────────────────────────

test('an empty, missing or non-string excerpt is refused before any search', () => {
  const c = chunkOf('anything at all');
  for (const bad of ['', null, undefined, 42, {}, [], true]) {
    const r = locateExcerpt(c, bad);
    assert.match(r.problem, /missing or is not a string/, `${JSON.stringify(bad)} was searched for`);
    assert.equal(r.start, null);
  }
});

test('an excerpt longer than the chunk is refused without scanning it', () => {
  const r = locateExcerpt(chunkOf('short'), 'a great deal longer than the chunk itself');
  assert.match(r.problem, /longer than chunk/);
});

test('a match cannot straddle the end of its chunk', () => {
  // The document says one thing; this chunk holds only part of it. An excerpt
  // spanning the boundary belongs to no chunk and is refused here rather than
  // translated into a span that reads correctly against the whole document.
  const document = 'Margin should move from 31% to 38% as the second line fills.';
  const c = chunkOf(document.slice(0, 33), 0);
  assert.equal(locateExcerpt(c, 'Margin should move from 31% to 38').problem, null);
  assert.match(locateExcerpt(c, '31% to 38% as the second').problem, /longer than chunk|does not occur/);
});

// ── Offset conversion ──────────────────────────────────────────────────────

test('a span found in a later chunk is translated into document offsets', () => {
  const document = 'A'.repeat(500) + 'Gross margin should move from 31% to 38%.' + 'B'.repeat(200);
  const c = chunkOf(document.slice(480, 600), 480, 'd#3');
  const r = locateExcerpt(c, 'Gross margin should move from 31% to 38%');
  assert.equal(r.problem, null);
  assert.equal(r.start, 500, 'the span was not translated into the document');
  assert.equal(document.slice(r.start, r.end), 'Gross margin should move from 31% to 38%');
});

test('every chunk of a real document translates back to the document exactly', () => {
  // Long enough to chunk for real: a single chunk would leave the
  // translation from chunk offsets to document offsets untested.
  const document = Array.from({ length: 600 }, (_, i) =>
    `Paragraph ${i}: the position in Company ${i} was increased because margin at ${i}% is turning and the market has not modelled it.`).join('\n\n');
  const { chunks } = chunkDocument(document, { documentId: 'd' });
  assert.ok(chunks.length > 1, 'the document did not chunk, so translation is untested');
  for (const chunk of chunks) {
    // A phrase unique to this chunk, taken from its own middle.
    const mid = Math.floor(chunk.text.length / 2);
    const excerpt = chunk.text.slice(mid, mid + 40);
    const r = locateExcerpt(chunk, excerpt);
    if (r.problem) continue;
    assert.equal(document.slice(r.start, r.end), excerpt, `${chunk.chunkId} translated to the wrong span`);
  }
});

test('toDocumentOffsets still refuses a span outside its chunk', () => {
  // locateExcerpt builds on it, so its own refusals still matter.
  const c = chunkOf('x'.repeat(100), 1000, 'd#9');
  assert.deepEqual(toDocumentOffsets(c, 10, 20), { start: 1010, end: 1020, problem: null });
  assert.match(toDocumentOffsets(c, 10, 900).problem, /does not sit inside chunk d#9/);
  assert.match(toDocumentOffsets(c, 20, 10).problem, /does not sit inside/);
  assert.match(toDocumentOffsets(c, 1.5, 10).problem, /not integers/);
});

// ── The wire ───────────────────────────────────────────────────────────────

test('no offset field reaches the API, in either tool schema', () => {
  for (const [name, tool] of [['propose_candidates', CANDIDATE_TOOL], ['select_claims', SELECTION_TOOL]]) {
    const json = JSON.stringify(tool);
    for (const field of ['evidenceStartOffset', 'evidenceEndOffset', 'startOffset', 'endOffset', 'offset']) {
      assert.ok(!json.includes(field), `${name} still carries ${field}`);
    }
  }
  const props = CANDIDATE_TOOL.input_schema.properties.candidates.items.properties;
  assert.ok(props.evidenceExcerpt, 'the excerpt is no longer requested');
  assert.deepEqual(
    CANDIDATE_TOOL.input_schema.properties.candidates.items.required,
    ['issuerMention', 'paraphrase', 'kind', 'stance', 'tags', 'evidenceExcerpt'],
  );
});

test('the prompt asks for words and uniqueness, and never for a position', () => {
  const prompt = extractionPrompt({ tags: [{ code: 'driver.margin_inflection', label: 'Margin inflection', axis: 'driver', definition: 'x' }] });
  assert.match(prompt, /occurs only once/i);
  assert.doesNotMatch(prompt, /character offsets|counting from 0|beginning at 0/i);
});

test('an offset the model volunteers is not proposable, and says why', () => {
  for (const field of ['evidenceStartOffset', 'evidenceEndOffset']) {
    assert.ok(!PROPOSABLE.includes(field), `${field} is still proposable`);
    assert.ok(NOT_PROPOSABLE[field], `${field} carries no reason for being refused`);
  }
  const { proposal, stripped } = stripToProposable({
    issuerMention: 'Northwind Components', paraphrase: 'p', kind: 'statement', stance: 'long',
    tags: [], evidenceExcerpt: 'x', evidenceStartOffset: 99_999, evidenceEndOffset: 1,
  });
  assert.equal(proposal.evidenceStartOffset, undefined);
  assert.equal(proposal.evidenceEndOffset, undefined);
  assert.equal(proposal.evidenceExcerpt, 'x');
  const names = JSON.stringify(stripped);
  for (const field of ['evidenceStartOffset', 'evidenceEndOffset']) {
    assert.ok(names.includes(field), `${field} was dropped silently`);
  }
});

console.log(`${passed} passed`);
