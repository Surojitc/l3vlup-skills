// The extraction harness, driven by a deterministic fake model.
//
// Nothing here reaches a network or a provider. `fakeModel` answers from a
// fixture map, so every assertion is on the whole output rather than on its
// shape, and a rerun is comparable byte for byte.
//
//   node scripts/__tests__/thesis-extraction.test.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeModel, NOT_PROPOSABLE, PROPOSABLE, stripToProposable, unpricedModel } from '../../lib/thesis-model.mjs';
import { proposalToClaim, runDocument, truncateExcerpt } from '../../lib/thesis-runner.mjs';
import { chunkDocument, estimateTokens, mentionCandidates, toDocumentOffsets } from '../../lib/thesis-chunk.mjs';
import { canTransition, HUMAN_ONLY, reachableWithoutHuman, STATES, transition } from '../../lib/thesis-states.mjs';
import { checkBudget, emptyCostLedger, estimateUsd, LIMITS, MODEL_ALLOWLIST, PILOT_BUDGET_USD, recordCall } from '../../lib/thesis-cost.mjs';
import { emptyDecisionLog, recordDecision } from '../../lib/thesis-review.mjs';
import { MAX_DOCUMENT_QUOTED_WORDS } from '../../lib/thesis-evidence.mjs';
import { EXCERPT_MAX_CHARS, EXCERPT_MAX_WORDS } from '../../lib/thesis-schema.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const F = JSON.parse(readFileSync(join(REPO, 'data', 'fixtures', 'thesis', 'fixtures.json'), 'utf8'));
const SOURCE = readFileSync(join(REPO, 'data', 'fixtures', 'thesis', 'source-text.txt'), 'utf8');
const TAXONOMY = JSON.parse(readFileSync(join(REPO, 'data', 'letters.taxonomy.json'), 'utf8'));
const PROPOSALS = JSON.parse(readFileSync(join(REPO, 'data', 'fixtures', 'thesis', 'model-proposals.json'), 'utf8'));

let passed = 0;
async function test(name, fn) { await fn(); passed += 1; console.log(`  ok  ${name}`); }

const run = (over = {}) => runDocument({
  model: fakeModel({ responses: PROPOSALS }), modelId: 'claude-haiku-4-5-20251001',
  document: F.document, manager: F.manager, sourceText: SOURCE,
  taxonomy: TAXONOMY, aliases: F.aliases,
  // The per-chunk cap is lifted here on purpose. This suite drives one chunk
  // of nine proposals to check what validation drops and why; the cap itself
  // is tested against the production default in thesis-two-stage.test.mjs.
  maxCandidatesPerChunk: 99,
  ledger: emptyCostLedger(), decisionLog: emptyDecisionLog(), ...over,
});

const reason = (out, re) => out.dropped.find((d) => re.test(d.reason));

// ── Evidence ───────────────────────────────────────────────────────────────

await test('a correctly located span verifies and reaches review', async () => {
  const out = await run();
  const kept = out.claims.find((c) => /Margins should improve/.test(c.claim.paraphrase));
  assert.ok(kept, 'the valid statement did not reach review');
  assert.equal(kept.claim.evidenceState, 'verified');
  assert.equal(kept.claim.publicationState, 'needs_review');
  assert.equal(kept.reference.publicExcerpt, SOURCE.slice(kept.reference.startOffset, kept.reference.endOffset));
});

await test('invented evidence is dropped, not repaired', async () => {
  const out = await run();
  assert.ok(reason(out, /does not occur in the source/), 'a fabricated quotation survived');
  assert.ok(!out.claims.some((c) => /doubling of earnings/.test(c.claim.paraphrase)));
  // Nothing re-asks the model about a dropped claim.
  const source = readFileSync(join(REPO, 'lib', 'thesis-runner.mjs'), 'utf8');
  assert.equal((source.match(/model\.propose\(/g) || []).length, 1, 'the runner calls the model more than once per chunk');
});

await test('a real sentence at the wrong offsets is dropped', async () => {
  const out = await run();
  assert.ok(reason(out, /not at the stated offsets/), 'a misplaced offset survived');
});

await test('chunk offsets are translated into the document, and a span outside its chunk is refused', () => {
  const chunk = { chunkId: 'd#3', startOffset: 1000, text: 'x'.repeat(500) };
  assert.deepEqual(toDocumentOffsets(chunk, 10, 20), { start: 1010, end: 1020, problem: null });
  assert.match(toDocumentOffsets(chunk, 10, 900).problem, /does not sit inside chunk d#3/);
  assert.match(toDocumentOffsets(chunk, 20, 10).problem, /does not sit inside/);
  assert.match(toDocumentOffsets(chunk, 1.5, 10).problem, /not integers/);

  const { chunks } = chunkDocument(SOURCE, { documentId: 'd' });
  for (const c of chunks) assert.equal(SOURCE.slice(c.startOffset, c.endOffset), c.text, `${c.chunkId} does not match the source it claims`);
  assert.ok(estimateTokens('a'.repeat(350)) >= 100);
});

// ── Duplicates, tags, issuers ──────────────────────────────────────────────

await test('a duplicate proposal from an overlapping chunk collapses', async () => {
  const out = await run();
  const ids = out.claims.map((c) => c.claim.claimId);
  assert.equal(new Set(ids).size, ids.length, 'two claims share an id');
  assert.equal(out.claims.filter((c) => /Margins should improve as the second production line fills/.test(c.claim.paraphrase)).length, 1,
    'the duplicate was reviewed twice');
  // Two different claims resting on one sentence stay two claims.
  const sameSpan = out.claims.filter((c) => c.reference.startOffset === 107);
  assert.equal(sameSpan.length, 2, 'a statement and an inference on one sentence were merged');
  assert.notEqual(sameSpan[0].claim.claimId, sameSpan[1].claim.claimId);
});

await test('an unsupported tag drops the claim', async () => {
  const out = await run();
  assert.ok(reason(out, /vibes\.strong_setup is not in the closed taxonomy/));
  assert.ok(!out.claims.some((c) => (c.claim.tags || []).includes('vibes.strong_setup')));
});

await test('an ambiguous or unconfirmed issuer is preserved, never guessed', async () => {
  const out = await run();
  const unresolved = out.claims.find((c) => c.claim.issuerMention === 'Northwind');
  assert.ok(unresolved, 'the unconfirmed-alias claim was dropped rather than preserved');
  assert.equal(unresolved.claim.issuerId, null, 'an unconfirmed alias was resolved');
  assert.equal(unresolved.claim.issuerResolution, 'needs_review');
  assert.equal(unresolved.claim.publicationState, 'issuer_unresolved');

  const resolved = out.claims.find((c) => c.claim.issuerMention === 'Northwind Components');
  assert.equal(resolved.claim.issuerId, 'i-northwind');
  assert.equal(resolved.claim.publicationState, 'needs_review');
});

await test('an unresolved ticker, CUSIP, CIK or position is never taken from the model', async () => {
  const out = await run();
  const fields = out.strippedFields.map((s) => s.field).sort();
  for (const f of ['cusip', 'issuerCik', 'shares', 'ticker', 'evidenceVerified', 'publicationState']) {
    assert.ok(fields.includes(f), `${f} was not stripped from the model's answer`);
  }
  for (const c of out.claims) {
    for (const f of ['ticker', 'cusip', 'cusipNormalised', 'shareClass', 'issuerCik', 'shares', 'position']) {
      assert.equal(c.claim[f], undefined, `${f} reached a claim`);
    }
  }
  // And the boundary is declared, not just observed.
  assert.ok(!PROPOSABLE.some((f) => Object.keys(NOT_PROPOSABLE).includes(f)), 'a field is both proposable and forbidden');
  const { proposal, stripped } = stripToProposable({ paraphrase: 'ok', ticker: 'NWC', nonsense: 1 });
  assert.deepEqual(Object.keys(proposal), ['paraphrase']);
  assert.equal(stripped.length, 2);
});

// ── Kinds, stance, silence ─────────────────────────────────────────────────

await test('a statement keeps its excerpt and an inference never gets one', async () => {
  const out = await run();
  const statement = out.claims.find((c) => c.claim.kind === 'statement' && c.reference.publicExcerpt);
  const inference = out.claims.find((c) => c.claim.kind === 'inference');
  assert.ok(statement.reference.publicExcerpt);
  assert.ok(inference, 'the inference was dropped');
  // The runner keeps the reference; the review layer is what refuses to show
  // it, and the rendered output is the thing that must never quote.
  const rendered = readFileSync(join(REPO, 'lib', 'thesis-review.mjs'), 'utf8');
  assert.match(rendered, /KINDS_NEVER_QUOTED\.includes\(card\.kind\)/);
});

await test('stance stays unclear where the letter is unclear, and silence never becomes exited', async () => {
  const out = await run();
  const calder = out.claims.find((c) => c.claim.issuerMention === 'Calder Industries');
  assert.equal(calder.claim.stance, 'unclear', 'a holding with nothing said became something other than unclear');
  assert.notEqual(calder.claim.stance, 'exited');
  for (const c of out.claims) assert.notEqual(c.claim.stance, 'exited', 'the runner produced an exit with no basis');
});

// ── Quotation ──────────────────────────────────────────────────────────────

await test('a long excerpt is truncated to the per-excerpt cap rather than published whole', () => {
  const long = Array.from({ length: 60 }, (_, i) => `w${i}`).join(' ');
  const cut = truncateExcerpt(long);
  assert.ok((cut.match(/\S+/g) || []).length <= EXCERPT_MAX_WORDS + 1);
  assert.ok(cut.length <= EXCERPT_MAX_CHARS);
  assert.match(cut, /…$/);
  assert.ok(truncateExcerpt('x'.repeat(500)).length <= EXCERPT_MAX_CHARS);
});

await test('the cumulative per-document cap withholds excerpts once it is spent', async () => {
  const out = await run();
  assert.ok(out.quotedWords <= MAX_DOCUMENT_QUOTED_WORDS, `${out.quotedWords} words quoted`);
  assert.deepEqual(out.reassembly, [], out.reassembly.join('; '));

  // Start with the budget nearly spent: the claims keep their paraphrase and
  // lose their excerpt, rather than being dropped.
  const spent = new Map([[F.document.documentId, MAX_DOCUMENT_QUOTED_WORDS - 2]]);
  const tight = await run({ quotedWordsByDocument: spent });
  assert.ok(tight.claims.length > 0);
  assert.ok(tight.claims.some((c) => c.reference.publicExcerpt === null), 'nothing was withheld');
  for (const c of tight.claims.filter((x) => !x.reference.publicExcerpt)) {
    assert.match(c.reference.excerptWithheld, /cumulative cap/);
    assert.ok(c.claim.paraphrase, 'the paraphrase was lost along with the excerpt');
  }
  assert.ok(tight.quotedWords <= MAX_DOCUMENT_QUOTED_WORDS);
});

// ── Publication states ─────────────────────────────────────────────────────

await test('published is unreachable without a person', () => {
  assert.ok(!reachableWithoutHuman('proposed').includes('published'));
  assert.ok(!canTransition('proposed', 'published'));
  assert.ok(!canTransition('evidence_verified', 'published'));
  assert.ok(!canTransition('needs_review', 'published'));
  assert.ok(canTransition('accepted', 'published'));
  // Each human-only state, refused to the runner from a state that could
  // legally reach it — so the refusal is the actor check, not the graph.
  for (const [from, to] of [['needs_review', 'accepted'], ['needs_review', 'edited'], ['needs_review', 'rejected'], ['accepted', 'published'], ['edited', 'published']]) {
    assert.ok(canTransition(from, to), `${from} -> ${to} should be a legal move`);
    assert.throws(() => transition({ publicationState: from }, to, { actor: 'runner' }), /only a person/, `the runner moved ${from} to ${to}`);
    assert.equal(transition({ publicationState: from }, to, { actor: 'human' }).publicationState, to);
  }
  assert.deepEqual(HUMAN_ONLY.slice().sort(), ['accepted', 'edited', 'published', 'rejected']);
  assert.throws(() => transition({ publicationState: 'proposed' }, 'accepted', { actor: 'human' }), /cannot move to/);
  assert.deepEqual(STATES.filter((s) => !Object.keys({ proposed: 1, evidence_verified: 1, issuer_unresolved: 1, needs_review: 1, accepted: 1, edited: 1, rejected: 1, published: 1 }).includes(s)), []);
});

// ── Rejection persistence and determinism ──────────────────────────────────

await test('a rejected claim is not proposed again on a rerun', async () => {
  const first = await run();
  const target = first.claims[0].claim;
  const log = recordDecision(emptyDecisionLog(), { claim: target, decision: 'rejected', decidedOn: '2026-09-18' });

  const second = await run({ decisionLog: log });
  assert.ok(!second.claims.some((c) => c.claim.claimId === target.claimId), 'a rejected claim came back');
  assert.ok(second.suppressed.some((s) => s.claimId === target.claimId));
  assert.equal(second.claims.length, first.claims.length - 1);
});

await test('two runs of the same input produce byte-identical output', async () => {
  const strip = (o) => JSON.stringify({ ...o, ledger: { ...o.ledger, calls: o.ledger.calls.map((c) => ({ ...c })) } });
  assert.equal(strip(await run()), strip(await run()), 'the run is not deterministic');

  // And the order does not depend on the order proposals arrived in.
  const reversed = { 'doc-1#0': { ...PROPOSALS['doc-1#0'], proposals: [...PROPOSALS['doc-1#0'].proposals].reverse() } };
  const back = await run({ model: fakeModel({ responses: reversed }) });
  const forward = await run();
  assert.deepEqual(back.claims.map((c) => c.claim.claimId), forward.claims.map((c) => c.claim.claimId));
});

// ── Cost ───────────────────────────────────────────────────────────────────

await test('a call is estimated before it is made, and usage is recorded after', async () => {
  const out = await run();
  // One chunk, so one extraction call and one consolidation call.
  assert.equal(out.ledger.calls.length, 2);
  const extraction = out.ledger.calls.filter((c) => c.stage === 'extraction');
  const consolidation = out.ledger.calls.filter((c) => c.stage === 'consolidation');
  assert.equal(extraction.length, 1, 'extraction calls are not tagged with their stage');
  assert.equal(consolidation.length, 1, 'the consolidation call is not tagged with its stage');
  assert.ok(out.ledger.estimatedUsd > 0);
  assert.equal(extraction[0].actualUsd, 0.0013, 'actual usage was not recorded');
  assert.ok(out.ledger.estimatedUsd <= PILOT_BUDGET_USD);
  assert.equal(out.ledger.stopped, false);
});

await test('a configured model with no price refuses to run rather than costing nothing', () => {
  const priceless = { 'configured-but-unpriced': { role: 'extraction' } };
  assert.equal(estimateUsd('configured-but-unpriced', 1000, 100, priceless), null);
  const check = checkBudget(emptyCostLedger(), { model: 'configured-but-unpriced', inputTokens: 1000, outputTokens: 100, documentId: 'd' }, priceless);
  assert.equal(check.allowed, false);
  assert.match(check.reason, /no price is configured .* refusing to run rather than assuming it is free/);
  const after = recordCall(emptyCostLedger(), { model: 'configured-but-unpriced', inputTokens: 1000, outputTokens: 100, documentId: 'd' }, priceless);
  assert.equal(after.stopped, true);
  assert.equal(after.calls.length, 0);
  assert.rejects(() => unpricedModel().propose({}), /never have been called/);
});

await test('the $3 pilot budget stops the run, and the $15 milestone ceiling is absolute', () => {
  assert.equal(PILOT_BUDGET_USD, 3);
  assert.equal(LIMITS.hardStopUsd, 15);

  const pilot = { ...emptyCostLedger(), estimatedUsd: 2.99 };
  const stopped = checkBudget(pilot, { model: 'claude-sonnet-5', inputTokens: LIMITS.maxInputTokensPerCall, outputTokens: LIMITS.maxOutputTokensPerCall, documentId: 'd' });
  assert.equal(stopped.allowed, false);
  assert.match(stopped.reason, /over this run's \$3\.00 budget/);

  // A run may not raise its own budget above the milestone ceiling.
  assert.equal(emptyCostLedger({ budgetUsd: 500 }).budgetUsd, LIMITS.hardStopUsd);
  const wide = { ...emptyCostLedger({ budgetUsd: 15 }), estimatedUsd: 14.99 };
  assert.match(checkBudget(wide, { model: 'claude-sonnet-5', inputTokens: LIMITS.maxInputTokensPerCall, outputTokens: LIMITS.maxOutputTokensPerCall, documentId: 'd' }).reason,
    /over the \$15\.00 milestone ceiling/);

  // And the stop is a stop: no fallback to the cheaper model.
  const after = recordCall(wide, { model: 'claude-sonnet-5', inputTokens: LIMITS.maxInputTokensPerCall, outputTokens: LIMITS.maxOutputTokensPerCall, documentId: 'd' });
  assert.equal(after.stopped, true);
  assert.equal(checkBudget(after, { model: 'claude-haiku-4-5-20251001', inputTokens: 1, outputTokens: 1, documentId: 'd' }).allowed, false);
  assert.deepEqual(Object.keys(MODEL_ALLOWLIST), ['claude-haiku-4-5-20251001', 'claude-sonnet-5']);
});

await test('a run stopped by the budget yields what it had, and resumes without re-charging', async () => {
  const broke = { ...emptyCostLedger(), estimatedUsd: 2.999 };
  const out = await run({ ledger: broke });
  assert.equal(out.ledger.stopped, true);
  assert.match(out.notes.join(' '), /stopped before doc-1#0/);
  assert.deepEqual(out.claims, [], 'claims were produced after the budget stopped');

  // Resuming: a chunk already in the ledger is not asked about again.
  const done = await run();
  const again = await run({ ledger: done.ledger });
  assert.match(again.notes.join(' '), /already charged for; resuming past it/);
  assert.equal(again.ledger.calls.length, done.ledger.calls.length, 'a resumed run charged for the same chunk twice');
});

// ── The standing prohibitions ──────────────────────────────────────────────

await test('no public output carries the source text, and no module can reach a model', async () => {
  const out = await run();
  const rendered = JSON.stringify(out.claims.map((c) => ({ ...c.claim, excerpt: c.reference.publicExcerpt })));
  assert.ok(!rendered.includes(SOURCE.slice(0, 150)), 'a long run of the source reached the output');
  for (const c of out.claims) {
    if (c.reference.publicExcerpt) assert.ok(c.reference.publicExcerpt.length <= EXCERPT_MAX_CHARS);
  }

  for (const f of ['lib/thesis-model.mjs', 'lib/thesis-runner.mjs', 'lib/thesis-chunk.mjs', 'lib/thesis-states.mjs', 'lib/thesis-cost.mjs', 'scripts/thesis-extract.mjs']) {
    const text = readFileSync(join(REPO, f), 'utf8');
    for (const forbidden of ['ANTHROPIC_API_KEY', 'sk-ant', '@anthropic-ai', 'import Anthropic', 'fetch(', 'process.env']) {
      assert.ok(!text.includes(forbidden), `${f} contains ${forbidden}`);
    }
  }
  // The SDK belongs to the pilot client alone. The harness is written
  // against the Model interface and must never reach for it directly.
  const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
  assert.deepEqual(Object.keys(pkg.dependencies).sort(), ['@anthropic-ai/sdk', 'parse5', 'pdfjs-dist']);
  for (const f of ['lib/thesis-model.mjs', 'lib/thesis-runner.mjs', 'lib/thesis-chunk.mjs', 'lib/thesis-states.mjs', 'lib/thesis-cost.mjs', 'scripts/thesis-extract.mjs']) {
    assert.ok(!readFileSync(join(REPO, f), 'utf8').includes('@anthropic-ai/sdk'), `${f} imports the SDK`);
  }
});

await test('company mentions are found without a model, as candidates only', () => {
  const found = mentionCandidates(SOURCE, { aliases: F.aliases });
  const names = found.map((m) => m.mention);
  assert.ok(names.includes('Northwind Components'), `found ${names.join(', ')}`);
  assert.ok(names.includes('Calder Industries'));
  // A candidate is a question, not an answer: none of them carries an id.
  for (const m of found) assert.equal(m.issuerId, undefined);
});

console.log(`${passed} passed`);
