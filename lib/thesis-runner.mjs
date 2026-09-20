// The extraction run: model in, reviewable claims out, nothing published.
//
// The model is injected. This file never constructs a client, never reads an
// environment variable and never imports a provider SDK; it takes something
// with a `propose` method and calls it. Every test drives it with a
// deterministic fake, which is also the only implementation in the
// repository today.
//
// The order of operations is the safety argument, and it is one-way:
//
//   chunk the transient text
//     -> ask the model about a chunk, within budget
//     -> strip anything it said that it is not allowed to say
//     -> translate its offsets into the whole document
//     -> verify the span byte for byte against the transient text
//     -> enforce the closed taxonomy
//     -> resolve the issuer deterministically, or leave it unresolved
//     -> truncate and meter the public quotation
//     -> fingerprint, and drop anything already rejected
//     -> hand a person a review card
//
// A claim that fails any step is dropped at that step. Nothing is sent back
// to a model to be fixed, and nothing reaches `published` without somebody.
// The run is resumable: state is a value, and a run interrupted mid-document
// resumes from the calls already in its ledger rather than repeating them.

import { createHash } from 'node:crypto';
import { claimFingerprint, validateClaim, validateTags } from './thesis-schema.mjs';
import { excerptProblems, reassemblyProblems, verifyEvidence, wordCount } from './thesis-evidence.mjs';
import { EXCERPT_MAX_CHARS, EXCERPT_MAX_WORDS } from './thesis-schema.mjs';
import { MAX_DOCUMENT_QUOTED_WORDS } from './thesis-evidence.mjs';
import { chunkDocument, toDocumentOffsets } from './thesis-chunk.mjs';
import { stripToProposable } from './thesis-model.mjs';
import { resolveIssuerMention } from './security-master.mjs';
import { checkBudget, emptyCostLedger, LIMITS, MAX_CLAIMS_PER_DOCUMENT, recordCall } from './thesis-cost.mjs';
import { filterAlreadyRejected } from './thesis-review.mjs';
import { candidateId, dedupeCandidates, forConsolidation, resolveSelections } from './thesis-candidates.mjs';
import { transition } from './thesis-states.mjs';

export const RUNNER_VERSION = 2;

/** Roughly how much of the context one consolidation call will need. */
export const estimateConsolidationTokens = (candidates) =>
  Math.ceil(JSON.stringify(forConsolidation(candidates)).length / 3.5) + 1_000;

/** Cut a public excerpt down to the cap rather than refusing it outright. */
export function truncateExcerpt(text) {
  let out = String(text).trim();
  const words = out.match(/\S+/g) || [];
  if (words.length > EXCERPT_MAX_WORDS) out = `${words.slice(0, EXCERPT_MAX_WORDS).join(' ')}…`;
  if (out.length > EXCERPT_MAX_CHARS) out = `${out.slice(0, EXCERPT_MAX_CHARS - 1).trimEnd()}…`;
  return out;
}

const drop = (chunk, proposal, reason) => ({
  dropped: true, reason, chunkId: chunk.chunkId,
  paraphrase: (proposal?.paraphrase || '').slice(0, 120),
});

/**
 * Turn one model proposal into a claim, or say why it could not become one.
 *
 * Deliberately a pure function of its inputs: given the same proposal, the
 * same source text and the same reference data, it returns the same thing,
 * which is what makes a rerun comparable.
 */
export function proposalToClaim(raw, { chunk, document, manager, sourceText, taxonomy, aliases, model, promptVersion }) {
  const { proposal, stripped } = stripToProposable(raw);

  const offsets = toDocumentOffsets(chunk, proposal.evidenceStartOffset, proposal.evidenceEndOffset);
  if (offsets.problem) return { ...drop(chunk, proposal, `offsets: ${offsets.problem}`), stripped };

  const reference = {
    evidenceId: `e-${document.documentId}-${offsets.start}-${offsets.end}`,
    documentId: document.documentId,
    documentUrl: document.documentUrl,
    locator: `chunk ${chunk.index}, characters ${offsets.start}–${offsets.end}`,
    startOffset: offsets.start,
    endOffset: offsets.end,
    excerpt: proposal.evidenceExcerpt,
    sha256OfSource: document.sha256,
  };

  // The span is checked against the whole transient document, not the chunk,
  // so an offset translated wrongly fails here rather than passing quietly.
  //
  // A span that is too long to publish is not a fabrication: it matches the
  // source, and the public excerpt is truncated below. So the length
  // complaints are separated from the ones that mean the model made the
  // quotation up, and only the latter drop the claim.
  const verdict = verifyEvidence(reference, sourceText);
  const fabricated = verdict.problems.filter((p) => !/-word cap|-character cap/.test(p));
  if (fabricated.length) return { ...drop(chunk, proposal, `evidence: ${fabricated.join('; ')}`), stripped };

  const tagProblems = validateTags(proposal.tags || [], taxonomy);
  if (tagProblems.length) return { ...drop(chunk, proposal, `taxonomy: ${tagProblems.join('; ')}`), stripped };

  // The issuer is resolved here, deterministically, from a reviewed alias.
  // The model's mention is the question; it is never the answer.
  const resolution = resolveIssuerMention(proposal.issuerMention, aliases);

  const publicExcerpt = truncateExcerpt(reference.excerpt);

  // The id has to be stable across reruns and distinct between claims. The
  // span alone is neither: a statement and an inference can rest on the same
  // sentence, and giving them one id would merge two different claims in the
  // decision log. So the id carries a digest of what makes the claim itself
  // — kind, stance, tags and paraphrase — which is exactly the fingerprint.
  const identity = { managerId: manager.managerId, documentId: document.documentId, kind: proposal.kind, stance: proposal.stance || 'unclear', tags: [...(proposal.tags || [])].sort(), paraphrase: proposal.paraphrase };
  const digest = createHash('sha256').update(claimFingerprint(identity)).digest('hex').slice(0, 10);
  const claim = {
    claimId: `c-${document.documentId}-${offsets.start}-${offsets.end}-${digest}`,
    managerId: manager.managerId,
    documentId: document.documentId,
    filingDate: document.filingDate,
    kind: proposal.kind,
    stance: proposal.stance || 'unclear',
    paraphrase: proposal.paraphrase,
    evidenceRef: reference.evidenceId,
    evidenceState: 'verified',
    tags: [...(proposal.tags || [])].sort(),
    catalysts: proposal.catalyst ? [proposal.catalyst] : [],
    risks: proposal.risk ? [proposal.risk] : [],
    horizon: proposal.horizon || null,
    provenance: 'model',
    model,
    promptVersion,
    reviewStatus: 'pending',
    publicationState: 'proposed',
    issuerMention: proposal.issuerMention,
    issuerId: resolution.issuerId,
    issuerResolution: resolution.state,
  };

  const problems = validateClaim(claim, { taxonomy });
  if (problems.length) return { ...drop(chunk, proposal, `schema: ${problems.join('; ')}`), stripped };

  // Evidence verified, so the claim advances; then to unresolved or review
  // depending on what the deterministic lookup said, never on what the model
  // asserted about the company.
  let staged = transition(claim, 'evidence_verified', { actor: 'runner' });
  staged = transition(staged, resolution.state === 'resolved' ? 'needs_review' : 'issuer_unresolved', { actor: 'runner' });

  return {
    dropped: false, claim: staged, reference: { ...reference, publicExcerpt },
    fingerprint: claimFingerprint(staged), stripped,
  };
}

/**
 * Run one document. Returns a value; holds no state of its own.
 *
 * `ledger` and `decisionLog` are passed in and returned, so an interrupted
 * run resumes by handing back what it had: chunks already charged for are
 * skipped, and the budget carries forward rather than resetting.
 */
export async function runDocument({
  model, modelId, document, manager, sourceText, taxonomy, aliases,
  ledger = emptyCostLedger(), decisionLog = { decisions: [] },
  promptVersion = LIMITS.promptVersion, maxChunks = LIMITS.maxChunksPerDocument,
  quotedWordsByDocument = new Map(),
}) {
  const { chunks, truncated, reason } = chunkDocument(sourceText, { documentId: document.documentId, maxChunks });
  const notes = truncated ? [reason] : [];
  const done = new Set(ledger.calls.filter((c) => c.documentId === document.documentId).map((c) => c.chunkId));

  const kept = [];
  const droppedRows = [];
  const strippedFields = [];
  let workingLedger = ledger;
  let chunksProcessed = 0;
  let incompleteReason = null;

  // ── Stage A: at most two evidence-backed candidates per chunk ────────────
  for (const chunk of chunks) {
    if (done.has(chunk.chunkId)) {
      // Charged for in an earlier run, so it is not charged for again — but
      // its candidates were never persisted, and consolidation ranks
      // candidates. A document whose chunks came from two runs cannot be
      // consolidated correctly, so it is incomplete rather than quietly
      // shorter. Re-run the document from scratch to finish it.
      notes.push(`${chunk.chunkId}: already charged for; resuming past it`);
      incompleteReason = incompleteReason ?? `${chunk.chunkId} was extracted in an earlier run, so this document cannot be consolidated from one pass`;
      continue;
    }

    const call = { model: modelId, stage: 'extraction', chunkId: chunk.chunkId, documentId: document.documentId, inputTokens: chunk.estimatedInputTokens, outputTokens: LIMITS.maxOutputTokensPerCall };
    const budget = checkBudget(workingLedger, call);
    if (!budget.allowed) {
      workingLedger = { ...workingLedger, stopped: true, stopReason: budget.reason };
      incompleteReason = `stopped before ${chunk.chunkId}: ${budget.reason}`;
      notes.push(incompleteReason);
      break;
    }

    const answer = await model.propose({ ...chunk, promptVersion });
    workingLedger = recordCall(workingLedger, { ...call, outputTokens: answer.usage?.outputTokens ?? 0, actualUsd: answer.usage?.actualUsd ?? 0 });
    chunksProcessed += 1;

    for (const raw of answer.proposals || []) {
      const result = proposalToClaim(raw, { chunk, document, manager, sourceText, taxonomy, aliases, model: modelId, promptVersion });
      strippedFields.push(...(result.stripped || []).map((s) => ({ chunkId: chunk.chunkId, ...s })));
      if (result.dropped) { droppedRows.push(result); continue; }
      kept.push({ result, chunk });
    }
  }

  const coverage = {
    documentId: document.documentId,
    chunksPlanned: chunks.length,
    chunksProcessed,
    complete: chunksProcessed === chunks.length && !truncated,
    reason: incompleteReason ?? (truncated ? reason : null),
  };

  // A document that did not finish produces no claims at all. Half a
  // document's claims read exactly like a whole document's, and there is no
  // honest way to label them on the page, so the run fails instead.
  if (!coverage.complete) {
    notes.push(`incomplete coverage: ${chunksProcessed} of ${chunks.length} chunk(s) processed`);
    return {
      runnerVersion: RUNNER_VERSION, documentId: document.documentId, coverage,
      claims: [], candidates: [], selectionRejects: [],
      dropped: droppedRows, strippedFields, suppressed: [], reassembly: [],
      quotedWords: quotedWordsByDocument.get(document.documentId) || 0,
      ledger: workingLedger, notes,
    };
  }

  // Only verified candidates reach Stage B: everything in `kept` has already
  // matched its offsets byte for byte against the whole transient document.
  const candidates = dedupeCandidates(kept.map(({ result, chunk }) => ({
    candidateId: candidateId({
      documentId: document.documentId, chunkId: chunk.chunkId,
      startOffset: result.reference.startOffset, endOffset: result.reference.endOffset,
      excerpt: result.reference.excerpt,
      fingerprint: result.fingerprint,
    }),
    documentId: document.documentId,
    chunkId: chunk.chunkId,
    startOffset: result.reference.startOffset,
    endOffset: result.reference.endOffset,
    excerpt: result.reference.publicExcerpt ?? result.reference.excerpt,
    fingerprint: result.fingerprint,
    issuerMention: result.claim.issuer?.mentionText ?? null,
    paraphrase: result.claim.paraphrase,
    kind: result.claim.kind,
    stance: result.claim.stance,
    tags: result.claim.tags,
    horizon: result.claim.horizon ?? null,
    verified: true,
    result,      // never passed to a model: forConsolidation drops it
  })));

  // ── Stage B: rank what Stage A verified ─────────────────────────────────
  //
  // Consolidation is not resumable the way extraction is. A resumed run skips
  // chunks it already paid for, but its selections were never persisted, so
  // this call is made again. It is one call at the end of a document and the
  // cheapest in the run; re-extracting a chunk would not be.
  let selectionRejects = [];
  let unique = [];
  if (candidates.length) {
    const call = { model: modelId, stage: 'consolidation', chunkId: `${document.documentId}:consolidate`, documentId: document.documentId, inputTokens: estimateConsolidationTokens(candidates), outputTokens: LIMITS.maxOutputTokensPerCall };
    const budget = checkBudget(workingLedger, call);
    if (!budget.allowed) {
      workingLedger = { ...workingLedger, stopped: true, stopReason: budget.reason };
      const why = `stopped before consolidating ${document.documentId}: ${budget.reason}`;
      notes.push(why);
      return {
        runnerVersion: RUNNER_VERSION, documentId: document.documentId,
        coverage: { ...coverage, complete: false, reason: why },
        claims: [], candidates, selectionRejects: [],
        dropped: droppedRows, strippedFields, suppressed: [], reassembly: [],
        quotedWords: quotedWordsByDocument.get(document.documentId) || 0,
        ledger: workingLedger, notes,
      };
    }
    const answer = await model.select({ documentId: document.documentId, candidates: forConsolidation(candidates) });
    workingLedger = recordCall(workingLedger, { ...call, outputTokens: answer.usage?.outputTokens ?? 0, actualUsd: answer.usage?.actualUsd ?? 0 });

    const resolved = resolveSelections(answer.selections, candidates, { maxClaims: MAX_CLAIMS_PER_DOCUMENT });
    selectionRejects = resolved.rejected;
    for (const r of resolved.rejected) notes.push(`selection dropped ${r.candidateId ?? '(no id)'}: ${r.reason}`);
    // The claim is the candidate's own verified result, untouched. The model
    // contributed an id and an integer.
    unique = resolved.selected.map((c) => ({ ...c.result, rank: c.rank, candidateId: c.candidateId }));
  }

  const { kept: notRejected, suppressed } = filterAlreadyRejected(decisionLog, unique.map((r) => r.claim));
  const allowed = new Set(notRejected.map((c) => c.claimId));
  unique = unique.filter((r) => allowed.has(r.claim.claimId));

  // The cumulative quotation cap is applied across everything this document
  // has already contributed, so claims are admitted until the budget of
  // words is spent and the rest keep their paraphrase without an excerpt.
  const already = quotedWordsByDocument.get(document.documentId) || 0;
  let spent = already;
  const publishable = [];
  for (const r of [...unique].sort((a, b) => a.claim.claimId.localeCompare(b.claim.claimId))) {
    const words = wordCount(r.reference.publicExcerpt);
    if (spent + words > MAX_DOCUMENT_QUOTED_WORDS) {
      publishable.push({ ...r, reference: { ...r.reference, publicExcerpt: null, excerptWithheld: `the ${MAX_DOCUMENT_QUOTED_WORDS}-word cumulative cap for this document is spent` } });
      continue;
    }
    spent += words;
    publishable.push(r);
  }
  quotedWordsByDocument.set(document.documentId, spent);

  const reassembly = reassemblyProblems(
    publishable.filter((r) => r.reference.publicExcerpt).map((r) => r.reference),
    { sourceText }
  );

  return {
    runnerVersion: RUNNER_VERSION,
    documentId: document.documentId,
    coverage,
    candidates,
    selectionRejects,
    claims: publishable.sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0) || a.claim.claimId.localeCompare(b.claim.claimId)),
    dropped: droppedRows.sort((a, b) => `${a.chunkId}${a.reason}`.localeCompare(`${b.chunkId}${b.reason}`)),
    strippedFields: strippedFields.sort((a, b) => `${a.chunkId}${a.field}`.localeCompare(`${b.chunkId}${b.field}`)),
    suppressed,
    reassembly,
    quotedWords: spent,
    ledger: workingLedger,
    notes,
  };
}
