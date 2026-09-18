// The thesis contract, tested before anything can be generated against it.
//
// Every fixture here is invented. No manager's words appear in this
// repository, and the source text these offsets point into is a paragraph
// written for the purpose.
//
//   node scripts/__tests__/thesis.test.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CLAIM_KINDS, claimFingerprint, ENTITIES, EXCERPT_MAX_CHARS, EXCERPT_MAX_WORDS,
  FORBIDDEN_FIELDS, KINDS_NEVER_QUOTED, STANCES, validateClaim, validateTags,
} from '../../lib/thesis-schema.mjs';
import { excerptProblems, MAX_DOCUMENT_QUOTED_CHARS, MAX_DOCUMENT_QUOTED_WORDS, publicView, reassemblyProblems, verifyEvidence, wordCount } from '../../lib/thesis-evidence.mjs';
import {
  normaliseCusip, positionContext, positionDelta, resolveIssuerMention,
  resolveSecurity, validateSecurityRow,
} from '../../lib/security-master.mjs';
import { buildHistory, currentStance, staleness, thesisKey, transitionBetween } from '../../lib/thesis-history.mjs';
import { checkBudget, emptyCostLedger, estimateUsd, LIMITS, MODEL_ALLOWLIST, recordCall } from '../../lib/thesis-cost.mjs';
import { cardProblems, emptyDecisionLog, filterAlreadyRejected, priorDecision, recordDecision, renderReview, reviewCard } from '../../lib/thesis-review.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const F = JSON.parse(readFileSync(join(REPO, 'data', 'fixtures', 'thesis', 'fixtures.json'), 'utf8'));
const SOURCE = readFileSync(join(REPO, 'data', 'fixtures', 'thesis', 'source-text.txt'), 'utf8');
const TAXONOMY = JSON.parse(readFileSync(join(REPO, 'data', 'letters.taxonomy.json'), 'utf8'));

let passed = 0;
function test(name, fn) { fn(); passed += 1; console.log(`  ok  ${name}`); }

const baseClaim = {
  claimId: 'c-1', managerId: 'm-fixture', documentId: 'doc-1', filingDate: '2026-08-14',
  kind: 'statement', stance: 'long', paraphrase: 'Margins should improve as the second line fills.',
  evidenceRef: 'e-1', evidenceState: 'verified', tags: ['driver.margin_inflection'],
  provenance: 'model', model: 'claude-haiku-4-5', promptVersion: 'thesis-extract-v1',
  reviewStatus: 'pending',
};

// ── Evidence ───────────────────────────────────────────────────────────────

test('an evidence span that matches the source at its stated offsets verifies', () => {
  const r = verifyEvidence(F.evidence[0], SOURCE);
  assert.equal(r.state, 'verified', r.problems.join('; '));
  assert.deepEqual(r.problems, []);
});

test('an offset that does not point where the excerpt actually sits is rejected', () => {
  const moved = { ...F.evidence[0], startOffset: F.evidence[0].startOffset + 3, endOffset: F.evidence[0].endOffset + 3 };
  const r = verifyEvidence(moved, SOURCE);
  assert.equal(r.state, 'failed');
  assert.match(r.problems[0], /occurs in the source but not at the stated offsets/);

  const absent = { ...F.evidence[0], excerpt: 'Margins will triple by Thursday', startOffset: 0, endOffset: 31 };
  assert.match(verifyEvidence(absent, SOURCE).problems[0], /does not occur in the source/);

  for (const bad of [{ startOffset: 10, endOffset: 10 }, { startOffset: 20, endOffset: 5 }, { startOffset: 0, endOffset: 99999 }]) {
    assert.equal(verifyEvidence({ ...F.evidence[0], ...bad }, SOURCE).state, 'failed');
  }
});

test('a public excerpt is capped at 25 words and 200 characters, the lower biting', () => {
  assert.deepEqual(excerptProblems('a '.repeat(20).trim()), []);
  const manyWords = Array.from({ length: 26 }, () => 'ab').join(' '); // 26 words, 77 chars
  assert.equal(wordCount(manyWords), 26);
  assert.ok(manyWords.length < EXCERPT_MAX_CHARS);
  assert.match(excerptProblems(manyWords)[0], /26 words, over the 25-word cap/, 'the word cap did not bite first');

  const fewLongWords = Array.from({ length: 6 }, () => 'x'.repeat(40)).join(' '); // 6 words, 245 chars
  assert.ok(wordCount(fewLongWords) < EXCERPT_MAX_WORDS);
  assert.ok(fewLongWords.length > EXCERPT_MAX_CHARS);
  assert.match(excerptProblems(fewLongWords)[0], /characters, over the 200-character cap/, 'the character cap did not bite first');
});

test('excerpts may not be reassembled into the letter', () => {
  const doc = 'doc-1';
  const src = 'word '.repeat(5000);
  const spans = (n, words) => Array.from({ length: n }, (_, i) => ({ documentId: doc, startOffset: i * 500, endOffset: i * 500 + words * 5 - 1 }));

  // Two spans that touch merge into one span over the per-excerpt cap.
  const adjacent = [
    { documentId: doc, startOffset: 0, endOffset: 150, excerpt: 'a' },
    { documentId: doc, startOffset: 150, endOffset: 300, excerpt: 'b' },
  ];
  assert.match(reassemblyProblems(adjacent)[0], /merge into a 300-character span/);

  // The cumulative cap is what stops many individually valid excerpts
  // reproducing the document. Two 20-word excerpts pass; three do not.
  assert.deepEqual(reassemblyProblems(spans(2, 20), { sourceText: src }), []);
  assert.match(reassemblyProblems(spans(3, 20), { sourceText: src })[0],
    /60 words quoted in total, over the 50-word cumulative cap/);
  assert.match(reassemblyProblems(spans(10, 20), { sourceText: src })[0], /over the 50-word cumulative cap/);
});

test('the cumulative cap is absolute, so a short document cannot be reproduced by many valid excerpts', () => {
  assert.equal(MAX_DOCUMENT_QUOTED_WORDS, 50);
  assert.equal(MAX_DOCUMENT_QUOTED_CHARS, 400);

  // The case the earlier proportional rule got wrong in both directions.
  // A short note: one legitimate excerpt is allowed, five are not, and the
  // answer no longer depends on how long the document happens to be.
  const one = [{ documentId: 'short', startOffset: 0, endOffset: 65, excerpt: SOURCE.slice(107, 172) }];
  assert.deepEqual(reassemblyProblems(one, { sourceText: SOURCE }), [], 'a single excerpt was refused on a short note');

  const five = Array.from({ length: 5 }, (_, i) => ({ documentId: 'short', startOffset: i * 80, endOffset: i * 80 + 60, excerpt: SOURCE.slice(i * 80, i * 80 + 60) }));
  assert.ok(reassemblyProblems(five, { sourceText: SOURCE }).length, 'five excerpts reproduced a 432-character note');

  // And a very long document gets no more latitude than a short one.
  const long = 'word '.repeat(200_000);
  const many = Array.from({ length: 4 }, (_, i) => ({ documentId: 'long', startOffset: i * 10_000, endOffset: i * 10_000 + 99 }));
  assert.match(reassemblyProblems(many, { sourceText: long })[0], /over the 50-word cumulative cap/,
    'a long document was allowed more quotation than a short one');

  // Without the source text the word count falls back to the excerpts, and
  // an overlap is counted twice, which errs toward refusing.
  assert.ok(reassemblyProblems([
    { documentId: 'd', startOffset: 0, endOffset: 300, excerpt: 'a '.repeat(30) },
    { documentId: 'd', startOffset: 900, endOffset: 1200, excerpt: 'b '.repeat(30) },
  ]).some((p) => /cumulative cap/.test(p)));
});

test('no public view carries the source text, and a full document can never be one', () => {
  const view = publicView({ ...baseClaim, managerName: 'Fixture Capital Partners' }, F.evidence[0], { kindsNeverQuoted: KINDS_NEVER_QUOTED });
  assert.ok(view.excerpt.length <= EXCERPT_MAX_CHARS);
  assert.ok(!JSON.stringify(view).includes(SOURCE.slice(0, 120)), 'the view carries a long run of the source');
  for (const f of FORBIDDEN_FIELDS) assert.equal(view[f], undefined, `${f} reached a public view`);
});

// ── Claim kinds ────────────────────────────────────────────────────────────

test('a statement is separated from an inference, and an inference is never quoted', () => {
  assert.deepEqual(Object.keys(CLAIM_KINDS), ['statement', 'paraphrase', 'classification', 'inference', 'filing']);

  const stated = publicView(baseClaim, F.evidence[0], { kindsNeverQuoted: KINDS_NEVER_QUOTED });
  assert.ok(stated.excerpt, 'a verified statement should carry its excerpt');
  assert.match(stated.attribution, /2026-08-14/);

  const inferred = publicView({ ...baseClaim, kind: 'inference' }, F.evidence[0], { kindsNeverQuoted: KINDS_NEVER_QUOTED });
  assert.equal(inferred.excerpt, null, 'an inference was rendered as a quotation');
  assert.equal(inferred.attribution, null, 'an inference was attributed to the manager');

  const filed = publicView({ ...baseClaim, kind: 'filing' }, F.evidence[0], { kindsNeverQuoted: KINDS_NEVER_QUOTED });
  assert.equal(filed.excerpt, null);

  // And the three evidence-bearing kinds cannot enter review unverified.
  for (const kind of ['statement', 'paraphrase', 'classification']) {
    const p = validateClaim({ ...baseClaim, kind, evidenceState: 'unverified' }, { taxonomy: TAXONOMY });
    assert.ok(p.some((x) => /may not enter review until its evidence is verified/.test(x)), `${kind} entered review unverified`);
  }
  // A filing claim is deterministic by definition.
  assert.ok(validateClaim({ ...baseClaim, kind: 'filing' }, { taxonomy: TAXONOMY })
    .some((x) => /may not be model-derived/.test(x)));
});

// ── Taxonomy ───────────────────────────────────────────────────────────────

test('the taxonomy is closed, complete and between 40 and 60 tags', () => {
  assert.ok(TAXONOMY.tags.length >= 40 && TAXONOMY.tags.length <= 60, `${TAXONOMY.tags.length} tags`);
  const codes = new Set();
  for (const t of TAXONOMY.tags) {
    for (const f of ['code', 'label', 'definition', 'aliases', 'positiveExample', 'negativeExample', 'exclusiveWith', 'compatibleWith', 'versionIntroduced', 'axis']) {
      assert.ok(t[f] !== undefined, `${t.code} has no ${f}`);
    }
    assert.ok(t.positiveExample && t.negativeExample, `${t.code} needs both examples`);
    // A definition has to say something. An empty or one-word definition is
    // how a tag quietly becomes whatever the model wants it to mean.
    assert.ok(t.definition.length >= 15, `${t.code} has a definition too thin to classify against: "${t.definition}"`);
    assert.ok(t.positiveExample.length >= 10 && t.negativeExample.length >= 10, `${t.code} has a token example`);
    assert.ok(!codes.has(t.code), `${t.code} is defined twice`);
    codes.add(t.code);
    assert.ok(Object.prototype.hasOwnProperty.call(t, 'deprecatedBy'));
  }
  // Every exclusion names a tag that exists.
  for (const t of TAXONOMY.tags) for (const o of t.exclusiveWith) assert.ok(codes.has(o), `${t.code} excludes unknown ${o}`);
  // Sector is an issuer attribute, not a thesis tag.
  assert.ok(!TAXONOMY.tags.some((t) => /^sector\.(technology|healthcare|financials|energy)/.test(t.code)), 'sector leaked into the taxonomy');
  assert.ok(F.issuers.every((i) => i.sector && i.sectorSource), 'sector must be a deterministic issuer attribute');
});

test('a tag outside the closed list is rejected, and the model may not invent one', () => {
  assert.deepEqual(validateTags(['driver.margin_inflection'], TAXONOMY), []);
  assert.match(validateTags(['driver.margin_inflection', 'driver.vibes'], TAXONOMY)[0], /not in the closed taxonomy/);
  assert.match(validateTags(['case.quality_compounder', 'case.turnaround'], TAXONOMY)[0], /mutually exclusive/);
  assert.match(validateTags(['horizon.under_one_year', 'horizon.over_five_years'], TAXONOMY)[0], /mutually exclusive/);
  assert.match(validateTags(['driver.margin_inflection', 'driver.margin_inflection'], TAXONOMY)[0], /appears twice/);
  assert.ok(validateClaim({ ...baseClaim, tags: ['invented.tag'] }, { taxonomy: TAXONOMY }).some((p) => /not in the closed taxonomy/.test(p)));
});

// ── Stance, conviction and silence ─────────────────────────────────────────

test('silence is no_new_evidence, never an exit', () => {
  const obs = [
    { observationId: 'o1', thesisId: 't1', observedOn: '2026-02-01', stance: 'long', mentioned: true },
    { observationId: 'o2', thesisId: 't1', observedOn: '2026-05-01', stance: 'long', mentioned: false },
    { observationId: 'o3', thesisId: 't1', observedOn: '2026-08-01', stance: 'long', mentioned: false },
  ];
  const { observations, problems } = buildHistory(obs);
  assert.deepEqual(problems, []);
  assert.deepEqual(observations.map((o) => o.transition), ['initiated', 'no_new_evidence', 'no_new_evidence']);
  assert.equal(currentStance(observations).stance, 'long', 'silence changed the stance');
  assert.notEqual(currentStance(observations).stance, 'exited');
  assert.match(staleness(observations, '2026-09-18').note, /silence, not a change of view/);

  assert.equal(transitionBetween({ stance: 'long' }, { mentioned: false }), 'no_new_evidence');
});

test('exited needs a basis, and position evidence must carry its lag warning', () => {
  assert.ok(validateClaim({ ...baseClaim, stance: 'exited' }, { taxonomy: TAXONOMY })
    .some((p) => /exited requires an explicit manager statement or qualified position evidence/.test(p)));
  assert.deepEqual(validateClaim({ ...baseClaim, stance: 'exited', exitBasis: 'manager_statement' }, { taxonomy: TAXONOMY }), []);
  assert.ok(validateClaim({ ...baseClaim, stance: 'exited', exitBasis: 'position_evidence' }, { taxonomy: TAXONOMY })
    .some((p) => /must carry its filing-lag warning/.test(p)));
  assert.deepEqual(validateClaim({ ...baseClaim, stance: 'exited', exitBasis: 'position_evidence', lagWarning: 'reported up to 45 days later' }, { taxonomy: TAXONOMY }), []);
  assert.ok(STANCES.includes('unclear'));
});

test('a larger or smaller 13F position changes no conviction by itself', () => {
  const [q1, q2, q3] = F.positions;
  const up = positionDelta(q1, q2);
  assert.equal(up.direction, 'increased');
  assert.equal(up.impliesConviction, false, 'a bigger position implied more conviction');

  const gone = positionDelta(q2, q3);
  assert.equal(gone.direction, 'absent_from_filing');
  assert.equal(gone.impliesExit, false, 'absence from a filing was read as an exit');
  assert.match(gone.note, /not an exit without a manager statement/);

  // No composite score may exist anywhere in the contract.
  for (const f of ['convictionScore', 'compositeScore']) assert.ok(FORBIDDEN_FIELDS.includes(f));
  assert.ok(validateClaim({ ...baseClaim, convictionScore: 0.8 }, { taxonomy: TAXONOMY })
    .some((p) => /may never appear on a claim/.test(p)));
});

test('a 13F position is corroboration carrying a filing-lag warning, never proof', () => {
  const ctx = positionContext(F.positions[1], { asOf: '2026-09-18' });
  assert.equal(ctx.corroborationOnly, true);
  assert.equal(ctx.provesThesis, false);
  assert.match(ctx.lagWarning, /up to 45 days after the period end/);

  const absent = positionContext(F.positions[2], { asOf: '2026-11-20' });
  assert.match(absent.lagWarning, /below the reporting threshold/);
  assert.match(absent.lagWarning, /confidential treatment/);
  assert.match(absent.lagWarning, /non-13F instrument/);
});

// ── Security master ────────────────────────────────────────────────────────

test('a CUSIP is validated, and a share class is never silently substituted', () => {
  assert.equal(normaliseCusip('037833100').cusip, '037833100');
  assert.match(normaliseCusip('037833101').problem, /check digit/);
  assert.match(normaliseCusip('not-a-cusip').problem, /is not a CUSIP/);

  const ok = resolveSecurity({ cusip: '037833100' }, F.securityMaster, { asOf: '2026-06-30' });
  assert.equal(ok.state, 'resolved');
  assert.equal(ok.security.shareClass, 'A');

  // One CUSIP carrying two share classes must not pick one.
  const ambiguous = resolveSecurity({ cusip: '38259P508' }, F.securityMaster, { asOf: '2026-06-30' });
  assert.equal(ambiguous.state, 'ambiguous');
  assert.equal(ambiguous.security, null, 'an ambiguous share class was silently resolved');
  assert.match(ambiguous.reason, /matches 2 rows: A, C/);
});

test('an unresolved issuer or security stays unresolved, and a name never resolves alone', () => {
  const pending = resolveSecurity({ cusip: '594918104' }, F.securityMaster);
  assert.equal(pending.state, 'needs_review');
  assert.equal(pending.security, null);

  const unknown = resolveSecurity({ cusip: '594918153' }, F.securityMaster);
  assert.equal(unknown.state, 'unresolved');

  assert.equal(resolveIssuerMention('Northwind Components', F.aliases).issuerId, 'i-northwind');
  assert.equal(resolveIssuerMention('Northwind', F.aliases).state, 'needs_review', 'an unconfirmed alias resolved');
  assert.equal(resolveIssuerMention('Some Company Nobody Mapped', F.aliases).state, 'unresolved');
  assert.equal(resolveIssuerMention('Meridian Group', F.aliases).state, 'ambiguous', 'a name matching two issuers resolved');
  for (const m of ['Northwind', 'Meridian Group', 'Some Company Nobody Mapped']) {
    assert.equal(resolveIssuerMention(m, F.aliases).issuerId, null);
  }

  assert.deepEqual(validateSecurityRow(F.securityMaster[0]), []);
  assert.ok(validateSecurityRow({ ...F.securityMaster[0], cusipNormalised: '000000000' }).some((p) => /does not follow from/.test(p)));
  assert.ok(validateSecurityRow({ ...F.securityMaster[0], mappingConfidence: 'low', mappingSource: 'sec_company_tickers' })
    .some((p) => /must name manual_review/.test(p)));
});

// ── Thesis history ─────────────────────────────────────────────────────────

test('thesis identity is the manager, issuer and thesis, never a single tag', () => {
  assert.equal(thesisKey({ managerId: 'm', issuerId: 'i' }), 'm|i|primary');
  assert.notEqual(thesisKey({ managerId: 'm', issuerId: 'i', thesisIdentity: 'spin-off' }), thesisKey({ managerId: 'm', issuerId: 'i' }));
  assert.equal(thesisKey({ managerId: 'm' }), null);
});

test('every transition is dated, in vocabulary, and reads only what was said', () => {
  const obs = [
    { observationId: 'o1', observedOn: '2026-01-05', stance: 'long', mentioned: true, convictionStated: 'stated_moderate' },
    { observationId: 'o2', observedOn: '2026-04-05', stance: 'long', mentioned: true, convictionStated: 'stated_high' },
    { observationId: 'o3', observedOn: '2026-07-05', stance: 'long', mentioned: true, convictionStated: 'stated_low' },
    { observationId: 'o4', observedOn: '2026-08-05', stance: 'long', mentioned: true, catalystsChanged: true },
    { observationId: 'o5', observedOn: '2026-09-05', stance: 'short', mentioned: true },
    { observationId: 'o6', observedOn: '2026-09-10', stance: 'short', mentioned: true, closedExplicitly: true },
  ];
  const { observations, problems } = buildHistory(obs);
  assert.deepEqual(problems, []);
  assert.deepEqual(observations.map((o) => o.transition),
    ['initiated', 'strengthened', 'weakened', 'catalyst_update', 'revised', 'closed_explicitly']);
  assert.equal(currentStance(observations).stance, 'exited');

  const undated = buildHistory([{ observationId: 'x', stance: 'long', mentioned: true }]);
  assert.match(undated.problems[0], /no date/);
  const badKind = buildHistory([{ observationId: 'y', observedOn: '2026-01-01', transition: 'vibes_shifted' }]);
  assert.match(badKind.problems[0], /is not a transition/);

  // Order does not depend on the order they arrived in.
  const shuffled = buildHistory([...obs].reverse()).observations.map((o) => o.observationId);
  assert.deepEqual(shuffled, ['o1', 'o2', 'o3', 'o4', 'o5', 'o6']);
});

// ── Review ─────────────────────────────────────────────────────────────────

test('a review card shows the qualification a person needs to decide', () => {
  const card = reviewCard(baseClaim, {
    reference: F.evidence[0],
    issuer: F.issuers[0],
    manager: F.manager,
    position: positionContext(F.positions[1], { asOf: '2026-09-18' }),
  });
  assert.deepEqual(cardProblems(card), []);
  assert.match(card.kindLabel, /MANAGER/);
  assert.ok(card.excerpt);
  assert.match(card.positionContext.warning, /45 days/);
  assert.deepEqual(card.availableDecisions, ['accept', 'edit', 'reject']);

  const inferred = reviewCard({ ...baseClaim, kind: 'inference' }, { reference: F.evidence[0], issuer: F.issuers[0], manager: F.manager });
  assert.match(inferred.kindLabel, /OUR INFERENCE/);
  assert.equal(inferred.excerpt, null);

  const unresolved = reviewCard(baseClaim, { reference: F.evidence[0], issuer: null, manager: F.manager });
  assert.equal(unresolved.issuerState, 'unresolved');
  assert.deepEqual(unresolved.availableDecisions, ['unresolved_company', 'reject']);

  const text = renderReview([card, inferred, unresolved]);
  assert.match(text, /UNRESOLVED — resolve the company before accepting/);
  assert.match(text, /WARNING: /);
  assert.ok(!text.includes(SOURCE.slice(0, 120)), 'the review text carries a long run of the source');
});

test('a rejected claim is not proposed again unchanged, but a changed one is', () => {
  let log = emptyDecisionLog();
  log = recordDecision(log, { claim: baseClaim, decision: 'rejected', decidedOn: '2026-09-18', note: 'not a thesis' });
  assert.equal(priorDecision(log, baseClaim).decision, 'rejected');

  const again = { ...baseClaim, claimId: 'c-1-rerun' };
  const { kept, suppressed } = filterAlreadyRejected(log, [again]);
  assert.deepEqual(kept, []);
  assert.match(suppressed[0].because, /rejected on 2026-09-18/);

  // A genuinely different claim earns a fresh look.
  const revised = { ...baseClaim, claimId: 'c-2', paraphrase: 'Two customers are most of revenue.' };
  assert.notEqual(claimFingerprint(revised), claimFingerprint(baseClaim));
  assert.equal(filterAlreadyRejected(log, [revised]).kept.length, 1);

  // A decision is replaced, never duplicated.
  log = recordDecision(log, { claim: baseClaim, decision: 'accepted', decidedOn: '2026-09-19' });
  assert.equal(log.decisions.filter((d) => d.claimFingerprint === claimFingerprint(baseClaim)).length, 1);
  assert.throws(() => recordDecision(log, { claim: baseClaim, decision: 'maybe', decidedOn: '2026-09-19' }), /not a review state/);
});

// ── Cost ───────────────────────────────────────────────────────────────────

test('the budget stops at the cap rather than switching behaviour', () => {
  assert.equal(LIMITS.hardStopUsd, 15);
  assert.equal(LIMITS.maxDocuments, 9);

  let ledger = emptyCostLedger();
  assert.equal(checkBudget(ledger, { model: 'gpt-fictional', inputTokens: 10, outputTokens: 10, documentId: 'd1' }).allowed, false);
  assert.match(checkBudget(ledger, { model: 'gpt-fictional', inputTokens: 10, outputTokens: 10, documentId: 'd1' }).reason, /not on the allowlist/);
  assert.match(checkBudget(ledger, { model: 'claude-haiku-4-5', inputTokens: 999_999, outputTokens: 10, documentId: 'd1' }).reason, /per-call limit/);

  // The per-document limit accumulates across calls, so a document cannot be
  // walked past the ceiling one legal call at a time.
  let perDoc = emptyCostLedger({ budgetUsd: 15 });
  for (let i = 0; i < 3; i += 1) perDoc = recordCall(perDoc, { model: 'claude-haiku-4-5', inputTokens: 39_000, outputTokens: 100, documentId: 'd1' });
  assert.match(checkBudget(perDoc, { model: 'claude-haiku-4-5', inputTokens: 39_000, outputTokens: 100, documentId: 'd1' }).reason, /per-document limit/);

  // Within every per-call limit, so this one is allowed.
  ledger = recordCall(ledger, { model: 'claude-haiku-4-5', inputTokens: 40_000, outputTokens: 4_000, documentId: 'd1' });
  assert.equal(ledger.stopped, false);
  assert.ok(ledger.estimatedUsd > 0);
  assert.equal(ledger.documentsProcessed, 1);

  // A tenth document is refused.
  let wide = emptyCostLedger({ budgetUsd: 15 });
  for (let i = 0; i < 9; i += 1) wide = recordCall(wide, { model: 'claude-haiku-4-5', inputTokens: 1000, outputTokens: 100, documentId: `d${i}` });
  const tenth = checkBudget(wide, { model: 'claude-haiku-4-5', inputTokens: 1000, outputTokens: 100, documentId: 'd9' });
  assert.equal(tenth.allowed, false);
  assert.match(tenth.reason, /9 document ceiling/);

  // The cap stops; it does not silently downgrade.
  let rich = emptyCostLedger({ budgetUsd: 15 });
  rich.estimatedUsd = 14.99;
  const over = recordCall(rich, { model: 'claude-sonnet-5', inputTokens: 40_000, outputTokens: 4_000, documentId: 'd1' });
  assert.equal(over.stopped, true);
  assert.match(over.stopReason, /over the \$15\.00 milestone ceiling/);
  assert.equal(over.calls.length, 0, 'a refused call was still recorded');
  assert.equal(checkBudget(over, { model: 'claude-haiku-4-5', inputTokens: 1, outputTokens: 1, documentId: 'd2' }).allowed, false,
    'the run continued after the stop');

  assert.ok(estimateUsd('claude-sonnet-5', 1e6, 0) > estimateUsd('claude-haiku-4-5', 1e6, 0));
  assert.deepEqual(Object.keys(MODEL_ALLOWLIST).length, 2);
});

// ── Shape, determinism and the standing prohibition ────────────────────────

test('every entity in the contract is defined, and no forbidden field is allowed', () => {
  for (const name of ['manager', 'document', 'issuer', 'security', 'thesis', 'thesis_observation', 'claim',
    'evidence_reference', 'taxonomy_tag', 'catalyst', 'risk', 'position_context', 'review_decision', 'connection']) {
    assert.ok(ENTITIES[name]?.length, `${name} is not defined`);
  }
  for (const f of ['text', 'fullText', 'pageText', 'sourceText', 'extractedText', 'rawResponse', 'promptText', 'apiKey']) {
    assert.ok(FORBIDDEN_FIELDS.includes(f), `${f} should be forbidden`);
    assert.ok(validateClaim({ ...baseClaim, [f]: 'x' }, { taxonomy: TAXONOMY }).some((p) => p.startsWith(f)));
  }
  assert.deepEqual(validateClaim(baseClaim, { taxonomy: TAXONOMY }), []);
  assert.ok(validateClaim({ ...baseClaim, provenance: 'model', model: null }, { taxonomy: TAXONOMY }).some((p) => /must name its model/.test(p)));
  assert.ok(validateClaim({ ...baseClaim, filingDate: '2099-01-01' }, { taxonomy: TAXONOMY, now: '2026-09-18' }).some((p) => /future/.test(p)));
});

test('the committed contract carries no model key, no client and no source text', () => {
  const files = ['lib/thesis-schema.mjs', 'lib/thesis-evidence.mjs', 'lib/thesis-history.mjs',
    'lib/thesis-review.mjs', 'lib/thesis-cost.mjs', 'lib/security-master.mjs',
    'data/letters.taxonomy.json', 'data/fixtures/thesis/fixtures.json'];
  for (const f of files) {
    const text = readFileSync(join(REPO, f), 'utf8');
    for (const forbidden of ['ANTHROPIC_API_KEY', 'sk-ant', 'OPENAI', 'import Anthropic', '@anthropic-ai', 'fetch(']) {
      assert.ok(!text.includes(forbidden), `${f} contains ${forbidden}`);
    }
  }
  // The SDK is a dependency of the repository now, for the pilot client
  // alone. What must stay true is that no contract module imports it: the
  // schemas, validators and taxonomy are decided without a model in reach.
  const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
  assert.deepEqual(Object.keys(pkg.dependencies).sort(), ['@anthropic-ai/sdk', 'parse5', 'pdfjs-dist']);
  for (const f of files) {
    assert.ok(!readFileSync(join(REPO, f), 'utf8').includes('@anthropic-ai/sdk'), `${f} imports the SDK`);
  }

  // The fixture source is invented, and no real filing text is committed.
  assert.match(SOURCE, /Fixture Capital Partners/);
  assert.ok(SOURCE.length < 1000, 'even the fixture should be short');
});

test('outputs are ordered deterministically, whatever order they were built in', () => {
  const claims = [
    { ...baseClaim, claimId: 'c-3', paraphrase: 'zebra' },
    { ...baseClaim, claimId: 'c-1', paraphrase: 'alpha' },
    { ...baseClaim, claimId: 'c-2', paraphrase: 'mid' },
  ];
  const order = (list) => [...list].sort((a, b) => claimFingerprint(a).localeCompare(claimFingerprint(b))).map((c) => c.claimId);
  assert.deepEqual(order(claims), order([...claims].reverse()));

  let a = emptyDecisionLog();
  let b = emptyDecisionLog();
  for (const c of claims) a = recordDecision(a, { claim: c, decision: 'accepted', decidedOn: '2026-09-18' });
  for (const c of [...claims].reverse()) b = recordDecision(b, { claim: c, decision: 'accepted', decidedOn: '2026-09-18' });
  assert.equal(JSON.stringify(a), JSON.stringify(b), 'the decision log depends on insertion order');
});

console.log(`${passed} passed`);
