// The two-stage contract: what Stage B may do, and what a partial run may not.
//
// Stage A offers at most two evidence-backed candidates per chunk. Stage B
// ranks them and returns identifiers and integers. The claims that reach a
// reader are the candidates Stage B named, byte for byte, and a document that
// did not finish produces none at all.
//
//   node scripts/__tests__/thesis-two-stage.test.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { candidateId, dedupeCandidates, forConsolidation, resolveSelections } from '../../lib/thesis-candidates.mjs';
import { canCompleteDocument, checkBudget, completionHeadroom, emptyCostLedger, LIMITS, MAX_CANDIDATES_PER_CHUNK, MAX_CLAIMS_PER_DOCUMENT, MODEL_ALLOWLIST, PILOT_BUDGET_USD, recordCall } from '../../lib/thesis-cost.mjs';
import { buildFeed, buildFailureReport, coverageProblems, validateFailureReport, validateFeed } from '../../lib/thesis-publish.mjs';
import { CANDIDATE_TOOL, SELECTION_TOOL } from '../../lib/thesis-anthropic.mjs';
import { runDocument } from '../../lib/thesis-runner.mjs';
import { fakeModel } from '../../lib/thesis-model.mjs';
import { emptyDecisionLog } from '../../lib/thesis-review.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const F = JSON.parse(readFileSync(join(REPO, 'data', 'fixtures', 'thesis', 'fixtures.json'), 'utf8'));
const SOURCE = readFileSync(join(REPO, 'data', 'fixtures', 'thesis', 'source-text.txt'), 'utf8');
const TAXONOMY = JSON.parse(readFileSync(join(REPO, 'data', 'letters.taxonomy.json'), 'utf8'));
const PROPOSALS = JSON.parse(readFileSync(join(REPO, 'data', 'fixtures', 'thesis', 'model-proposals.json'), 'utf8'));
const MODEL = 'claude-sonnet-5';
const PRICE = MODEL_ALLOWLIST[MODEL];

let passed = 0;
async function test(name, fn) { await fn(); passed += 1; console.log(`  ok  ${name}`); }

const run = (over = {}) => runDocument({
  model: fakeModel({ responses: PROPOSALS }), modelId: 'claude-haiku-4-5-20251001',
  document: F.document, manager: F.manager, sourceText: SOURCE, taxonomy: TAXONOMY, aliases: F.aliases,
  ledger: emptyCostLedger({ budgetUsd: 3 }), decisionLog: emptyDecisionLog(), ...over,
});

// ── 1. Incomplete coverage cannot become a success or a pull request ────────

await test('a document that did not finish yields no claims and says so', async () => {
  // A budget too small to admit every chunk.
  const out = await run({ ledger: { ...emptyCostLedger({ budgetUsd: 3 }), estimatedUsd: 2.999 } });
  assert.equal(out.coverage.complete, false);
  assert.equal(out.claims.length, 0, 'a stopped document still produced claims');
  assert.ok(out.coverage.chunksProcessed < out.coverage.chunksPlanned);
});

await test('incomplete coverage fails the feed, whatever the claims look like', () => {
  const short = [{ documentId: 'd-1', chunksPlanned: 9, chunksProcessed: 2, complete: false, reason: 'budget' }];
  assert.ok(coverageProblems(short, 1).length);
  // Even a feed whose claims are individually perfect is refused.
  const feed = buildFeed({ claims: [], model: MODEL, promptVersion: 'v1', coverage: short });
  assert.ok(validateFeed(feed).some((p) => /incomplete coverage/.test(p)), 'a short document produced a publishable feed');
  // A feed with no coverage at all is refused too, so the field cannot simply
  // be left off to get past the check.
  assert.ok(validateFeed(buildFeed({ claims: [], model: MODEL, promptVersion: 'v1' })).some((p) => /incomplete coverage/.test(p)));
  // And a document short of the selected count is refused.
  assert.ok(coverageProblems([{ documentId: 'd-1', chunksPlanned: 1, chunksProcessed: 1, complete: true }], 2).length);
});

await test('the pilot writes no feed and exits non-zero on incomplete coverage', () => {
  const src = readFileSync(join(REPO, 'scripts', 'thesis-pilot.mjs'), 'utf8');
  const gate = src.slice(src.indexOf('const gaps = coverageProblems'), src.indexOf('const feedProblems'));
  assert.match(gate, /writeFailureReport\('incomplete_coverage'/);
  assert.match(gate, /process\.exit\(6\)/);
  // The gate is before the feed is written, so there is nothing on disk for
  // the pull-request job to collect.
  assert.ok(src.indexOf('const gaps = coverageProblems') < src.indexOf("writeOut('feed.json'"), 'the feed is written before coverage is checked');
});

// ── 2. Every pilot chunk fits the proposed budgets ──────────────────────────

await test('every pilot chunk is admitted at realistic and worst-case outputs', () => {
  // Starboard 3 chunks + 1 consolidation, Longleaf 9 + 1.
  for (const [name, calls] of [['starboard', 4], ['longleaf', 10]]) {
    for (const actualOut of [1_000, 2_000, LIMITS.maxOutputTokensPerCall]) {
      let ledger = emptyCostLedger({ budgetUsd: PILOT_BUDGET_USD });
      let admitted = 0;
      for (let i = 0; i < calls; i += 1) {
        const call = { model: MODEL, stage: 'extraction', chunkId: `c${i}`, documentId: name, inputTokens: 3_000, outputTokens: LIMITS.maxOutputTokensPerCall };
        const check = checkBudget(ledger, call);
        if (!check.allowed) break;
        ledger = recordCall(ledger, { ...call, outputTokens: actualOut, actualUsd: (3_000 / 1e6) * PRICE.inputPerMTok + (actualOut / 1e6) * PRICE.outputPerMTok });
        if (ledger.stopped) break;
        admitted += 1;
      }
      assert.equal(admitted, calls, `${name} admitted ${admitted} of ${calls} calls at ${actualOut} output tokens`);
    }
  }
});

await test('the per-document ceiling is derived from the per-call one, not guessed', () => {
  // (chunks + 1) x per-call: the reservation is the whole ceiling, so call i
  // needs i x per-call of room, and the +1 is consolidation.
  assert.equal(completionHeadroom(LIMITS.maxChunksPerDocument), (LIMITS.maxChunksPerDocument + 1) * LIMITS.maxOutputTokensPerCall);
  assert.ok(canCompleteDocument(LIMITS.maxChunksPerDocument), 'a document at the chunk ceiling cannot finish');
  assert.ok(canCompleteDocument(9) && canCompleteDocument(3), 'a pilot document cannot finish');
  // The pairing that caused the incomplete runs is caught by the same rule.
  assert.equal(canCompleteDocument(9, { maxOutputTokensPerCall: 8_000, maxOutputTokensPerDocument: 16_000, maxChunksPerDocument: 12 }), false);
  assert.equal(canCompleteDocument(9, { maxOutputTokensPerCall: 4_000, maxOutputTokensPerDocument: 8_000, maxChunksPerDocument: 12 }), false);
});

// ── 3. Six per document, and the caps are structural ────────────────────────

await test('a document cannot end with more than six claims', () => {
  const candidates = Array.from({ length: 20 }, (_, i) => ({ candidateId: `cand-${String(i).padStart(16, '0')}`, fingerprint: `fp-${i}`, excerpt: `e${i}`, paraphrase: `p${i}` }));
  const asked = candidates.map((c, i) => ({ candidateId: c.candidateId, rank: i + 1 }));
  const { selected, rejected } = resolveSelections(asked, candidates);
  assert.equal(selected.length, MAX_CLAIMS_PER_DOCUMENT);
  assert.ok(rejected.some((r) => /over the 6-claim cap/.test(r.reason)));
  // The schemas hold no count, because a strict schema may not. Both tools
  // still state the number in the description the model reads.
  assert.equal(SELECTION_TOOL.input_schema.properties.selections.maxItems, undefined);
  assert.equal(CANDIDATE_TOOL.input_schema.properties.candidates.maxItems, undefined);
  assert.equal(SELECTION_TOOL.strict, true);
  assert.equal(CANDIDATE_TOOL.strict, true);
  assert.match(CANDIDATE_TOOL.description, new RegExp(`at most ${MAX_CANDIDATES_PER_CHUNK}`));
  // The feed is checked independently of the run that produced it.
  const many = Array.from({ length: 7 }, (_, i) => ({ claimId: `c-${i}`, documentId: 'd-1', kind: 'statement', publicationState: 'needs_review', reviewStatus: 'pending' }));
  const feed = buildFeed({ claims: many, model: MODEL, promptVersion: 'v1', coverage: [{ documentId: 'd-1', chunksPlanned: 1, chunksProcessed: 1, complete: true }] });
  assert.ok(validateFeed(feed).some((p) => /over the 6-claim cap/.test(p)));
});

// ── 4. Consolidation cannot touch the words ─────────────────────────────────

await test('Stage B can return nothing but an id and a rank', () => {
  const props = SELECTION_TOOL.input_schema.properties.selections.items.properties;
  assert.deepEqual(Object.keys(props).sort(), ['candidateId', 'rank']);
  assert.equal(props.rank.type, 'integer');
  assert.equal(SELECTION_TOOL.input_schema.properties.selections.items.additionalProperties, false);
  // No field on this schema could carry a paraphrase or a quotation.
  for (const [name, spec] of Object.entries(props)) {
    if (spec.type === 'string') assert.equal(name, 'candidateId', `${name} is a free-text field on the selection schema`);
  }
});

await test('a selected claim is its candidate, byte for byte', async () => {
  const out = await run();
  assert.ok(out.claims.length, 'nothing was selected');
  const byId = new Map(out.candidates.map((c) => [c.candidateId, c]));
  for (const claim of out.claims) {
    const candidate = byId.get(claim.candidateId);
    assert.ok(candidate, `${claim.candidateId} is not a candidate this run produced`);
    assert.equal(claim.reference.startOffset, candidate.startOffset, 'an offset moved between the stages');
    assert.equal(claim.reference.endOffset, candidate.endOffset, 'an offset moved between the stages');
    assert.equal(claim.claim.paraphrase, candidate.paraphrase, 'the paraphrase changed between the stages');
    // The verified span itself, which is always present: `publicExcerpt` can
    // be withheld later by the cumulative quotation cap, and that is a
    // publication decision rather than a change to the evidence.
    assert.equal(claim.reference.excerpt, candidate.excerpt, 'the evidence text changed between the stages');
    assert.equal(SOURCE.slice(claim.reference.startOffset, claim.reference.endOffset), claim.reference.excerpt,
      'the claim is no longer anchored to the document it came from');
    if (claim.reference.publicExcerpt) {
      assert.ok(claim.reference.excerpt.startsWith(claim.reference.publicExcerpt.replace(/…$/, '')),
        'the published excerpt is not a prefix of the verified span');
    }
  }
});

await test('what Stage B is shown carries no way back to the verified record', () => {
  const shown = forConsolidation([{ candidateId: 'cand-1', issuerMention: 'X', paraphrase: 'p', kind: 'statement', stance: 'long', tags: [], excerpt: 'e', result: { secret: true }, fingerprint: 'fp' }]);
  assert.deepEqual(Object.keys(shown[0]).sort(), ['candidateId', 'excerpt', 'horizon', 'issuerMention', 'kind', 'paraphrase', 'stance', 'tags']);
  assert.equal(shown[0].result, undefined, 'the verified result was sent to the model');
  assert.equal(shown[0].fingerprint, undefined);
});

await test('only verified candidates reach Stage B', async () => {
  const out = await run();
  assert.ok(out.dropped.length, 'the fixture no longer exercises a dropped claim');
  for (const c of out.candidates) {
    assert.equal(c.verified, true);
    assert.equal(SOURCE.slice(c.startOffset, c.endOffset), c.excerpt, 'an unverified span became a candidate');
  }
  const droppedExcerpts = new Set(out.dropped.map((d) => d.proposal?.evidenceExcerpt));
  for (const c of out.candidates) assert.ok(!droppedExcerpts.has(c.excerpt), 'a dropped claim reached consolidation');
});

// ── 5. Ids, duplicates and bad selections ───────────────────────────────────

await test('candidate ids are ours, deterministic, and distinguish claims on one span', () => {
  const at = (fingerprint) => candidateId({ documentId: 'd1', chunkId: 'c1', startOffset: 10, endOffset: 40, excerpt: 'the same sentence', fingerprint });
  assert.equal(at('fp-a'), at('fp-a'), 'the same candidate hashed differently twice');
  assert.notEqual(at('fp-a'), at('fp-b'), 'a statement and an inference on one span share an id');
  assert.match(at('fp-a'), /^cand-[0-9a-f]{16}$/);
  // Nothing in the pipeline takes an id from a model.
  const runner = readFileSync(join(REPO, 'lib', 'thesis-runner.mjs'), 'utf8');
  assert.ok(!/candidateId:\s*(raw|proposal|answer)\./.test(runner), 'a candidate id is taken from model output');
});

await test('duplicate candidates collapse, and their provenance survives', () => {
  const mk = (chunkId, off, fp) => ({ candidateId: candidateId({ documentId: 'd1', chunkId, startOffset: off, endOffset: off + 5, excerpt: 'same', fingerprint: fp }), chunkId, startOffset: off, endOffset: off + 5, excerpt: 'same', fingerprint: fp });
  const deduped = dedupeCandidates([mk('c1', 10, 'fp-a'), mk('c2', 90, 'fp-a'), mk('c3', 200, 'fp-b')]);
  assert.equal(deduped.length, 2, 'the overlapping duplicate was not collapsed');
  const survivor = deduped.find((c) => c.fingerprint === 'fp-a');
  assert.equal(survivor.alsoSeenIn.length, 1, 'the duplicate’s provenance was discarded');
  assert.ok(survivor.alsoSeenIn[0].chunkId && Number.isInteger(survivor.alsoSeenIn[0].startOffset));
  // Deterministic: the same input twice gives the same survivor and order.
  assert.deepEqual(dedupeCandidates([mk('c2', 90, 'fp-a'), mk('c1', 10, 'fp-a'), mk('c3', 200, 'fp-b')]).map((c) => c.candidateId), deduped.map((c) => c.candidateId));
});

await test('an unknown, repeated or malformed selection is dropped and named', () => {
  const candidates = [{ candidateId: 'cand-aaaaaaaaaaaaaaaa', fingerprint: 'fp-a' }, { candidateId: 'cand-bbbbbbbbbbbbbbbb', fingerprint: 'fp-b' }];
  const { selected, rejected } = resolveSelections([
    { candidateId: 'cand-aaaaaaaaaaaaaaaa', rank: 1 },
    { candidateId: 'cand-invented00000', rank: 2 },
    { candidateId: 'cand-aaaaaaaaaaaaaaaa', rank: 3 },
    { candidateId: 'cand-bbbbbbbbbbbbbbbb', rank: 0 },
    { rank: 4 }, null, 'nonsense',
  ], candidates);
  assert.equal(selected.length, 1);
  const reasons = rejected.map((r) => r.reason);
  assert.ok(reasons.some((r) => /no candidate with that id/.test(r)));
  assert.ok(reasons.some((r) => /selected twice/.test(r)));
  assert.ok(reasons.some((r) => /not a positive integer/.test(r)));
  assert.ok(reasons.some((r) => /carried no candidate id/.test(r)));
  assert.ok(reasons.some((r) => /was not an object/.test(r)));
});

await test('a document with no verified candidates records zero claims honestly', async () => {
  const out = await run({ model: fakeModel({ responses: {} }) });
  assert.equal(out.claims.length, 0);
  assert.equal(out.candidates.length, 0);
  assert.equal(out.coverage.complete, true, 'an empty document was reported as incomplete');
  // And it did not pay for a consolidation call it had nothing to consolidate.
  assert.equal(out.ledger.calls.filter((c) => c.stage === 'consolidation').length, 0);
});

// ── 6. Cost, by stage, under the budget ─────────────────────────────────────

await test('usage is tracked separately for extraction and consolidation', async () => {
  const out = await run();
  const feed = buildFeed({ claims: [], ledger: out.ledger, model: MODEL, promptVersion: 'v1', coverage: [out.coverage] });
  assert.ok(feed.cost.byStage.extraction, 'extraction is not costed separately');
  assert.ok(feed.cost.byStage.consolidation, 'consolidation is not costed separately');
  assert.equal(feed.cost.byStage.extraction.calls + feed.cost.byStage.consolidation.calls, out.ledger.calls.length);
  for (const c of feed.cost.calls) assert.ok(['extraction', 'consolidation'].includes(c.stage));
});

await test('the worst-case pilot cost stays under the $3 budget', () => {
  const usd = (i, o) => (i / 1e6) * PRICE.inputPerMTok + (o / 1e6) * PRICE.outputPerMTok;
  // Bounded by the per-document ceilings, two documents.
  const worst = usd(2 * LIMITS.maxInputTokensPerDocument, 2 * LIMITS.maxOutputTokensPerDocument);
  assert.ok(worst < PILOT_BUDGET_USD, `the worst case is $${worst.toFixed(2)}`);
  assert.equal(Number(worst.toFixed(2)), 1.00);
  // And the whole pilot fits inside the global call ceiling.
  assert.ok(3 + 1 + 9 + 1 <= LIMITS.maxModelCalls, 'the pilot needs more calls than the ceiling allows');
  assert.equal(LIMITS.maxModelCalls, 18);
});

// ── 7. The failure artefact stays cost-only ─────────────────────────────────

await test('an incomplete run reports coverage counts and nothing it read', () => {
  const r = buildFailureReport({
    reason: 'incomplete_coverage', detail: 'longleaf: 3 of 9 chunk(s) processed', stage: 'extraction',
    coverage: [{ documentId: 'longleaf', chunksPlanned: 9, chunksProcessed: 3, complete: false, reason: 'budget', excerpt: 'a quotation that must not travel' }],
    ledger: { actualUsd: 0.21, budgetUsd: 3, calls: [] }, model: MODEL,
  });
  assert.deepEqual(validateFailureReport(r), []);
  assert.equal(r.reason, 'incomplete_coverage');
  assert.equal(r.stage, 'extraction');
  // Counts only: the coverage row is rebuilt from a closed field list, so a
  // reason or an excerpt attached to it upstream does not travel.
  assert.deepEqual(Object.keys(r.coverage[0]).sort(), ['chunksPlanned', 'chunksProcessed', 'complete', 'documentId']);
  assert.equal(r.coverage[0].excerpt, undefined, 'a quotation reached the failure artefact');
  // An unknown stage is dropped rather than carried.
  assert.equal(buildFailureReport({ reason: 'unknown', stage: 'something the model said', ledger: {} }).stage, null);
});

// ── The schema defect of run 35501855065, and the caps that replaced it ─────

await test('the per-chunk cap holds on the verified list, at the production default', async () => {
  // The fixture offers nine proposals on one chunk. Four verify; the default
  // cap keeps two of them and records the rest as drops rather than silence.
  const lifted = await run({ maxCandidatesPerChunk: 99 });
  const capped = await run();
  assert.ok(lifted.claims.length > capped.claims.length, 'the cap changed nothing, so it is not being applied');
  assert.ok(capped.claims.length <= MAX_CANDIDATES_PER_CHUNK, `${capped.claims.length} candidates survived a ${MAX_CANDIDATES_PER_CHUNK} cap`);
  assert.ok(capped.dropped.some((d) => /over the 2-candidate cap for one chunk/.test(d.reason)),
    'candidates past the cap vanished without a reason');
});

await test('a candidate is only cut after it has been verified, never before', async () => {
  // The malformed proposals sit first in the fixture. A cap applied to the raw
  // list would keep two of those and throw away the good claim behind them,
  // which is how a cap turns into data loss.
  const out = await run();
  assert.ok(out.claims.length > 0, 'the cap consumed the whole chunk on malformed proposals');
  for (const c of out.claims) assert.equal(c.claim.evidenceState, 'verified');
});

await test('a failed run names the error that caused it, beside the gate that refused', () => {
  const report = buildFailureReport({
    reason: 'incomplete_coverage', detail: 'the run reported no coverage at all', ledger: {},
    documentsSelected: 2, documentsFetched: 1, documentsStarted: 1, documentsCompleted: 0,
    failure: { reason: 'api_error', detail: 'HTTP 400 invalid_request_error tools.0...', stage: 'extraction' },
  });
  assert.deepEqual(validateFailureReport(report), []);
  // The gate's reason stays the invariant the pull-request job reads.
  assert.equal(report.reason, 'incomplete_coverage');
  // The cause rides beside it, so the symptom no longer hides the finding.
  assert.equal(report.failure.reason, 'api_error');
  assert.equal(report.failure.stage, 'extraction');
  // Four counts say how far the run got: fetched one of two, completed none.
  assert.deepEqual(
    [report.documentsSelected, report.documentsFetched, report.documentsStarted, report.documentsCompleted],
    [2, 1, 1, 0],
  );
});

await test('the failure field is rebuilt from a closed list, so nothing rides in on it', () => {
  const report = buildFailureReport({
    reason: 'unknown', ledger: {},
    failure: {
      reason: 'not a reason we know', detail: 'x'.repeat(500), stage: 'whatever the model said',
      excerpt: 'a sentence from the letter', paraphrase: 'what the manager claims', claims: [{ claimId: 'c1' }],
    },
  });
  assert.deepEqual(validateFailureReport(report), []);
  assert.deepEqual(Object.keys(report.failure).sort(), ['detail', 'reason', 'stage']);
  assert.equal(report.failure.reason, 'unknown');
  assert.equal(report.failure.stage, null);
  assert.equal(report.failure.detail.length, 200);
});

console.log(`${passed} passed`);
