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
import { checkBudget, emptyCostLedger, LIMITS, recordCall } from './thesis-cost.mjs';
import { filterAlreadyRejected } from './thesis-review.mjs';
import { transition } from './thesis-states.mjs';

export const RUNNER_VERSION = 1;

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

  for (const chunk of chunks) {
    if (done.has(chunk.chunkId)) { notes.push(`${chunk.chunkId}: already charged for; resuming past it`); continue; }

    const call = { model: modelId, chunkId: chunk.chunkId, documentId: document.documentId, inputTokens: chunk.estimatedInputTokens, outputTokens: LIMITS.maxOutputTokensPerCall };
    const budget = checkBudget(workingLedger, call);
    if (!budget.allowed) {
      workingLedger = { ...workingLedger, stopped: true, stopReason: budget.reason };
      notes.push(`stopped before ${chunk.chunkId}: ${budget.reason}`);
      break;
    }

    const answer = await model.propose({ ...chunk, promptVersion });
    workingLedger = recordCall(workingLedger, { ...call, outputTokens: answer.usage?.outputTokens ?? 0, actualUsd: answer.usage?.actualUsd ?? 0 });

    for (const raw of answer.proposals || []) {
      const result = proposalToClaim(raw, { chunk, document, manager, sourceText, taxonomy, aliases, model: modelId, promptVersion });
      strippedFields.push(...(result.stripped || []).map((s) => ({ chunkId: chunk.chunkId, ...s })));
      if (result.dropped) { droppedRows.push(result); continue; }
      kept.push(result);
    }
  }

  // Two claims from overlapping chunks can be the same claim. The identity
  // is the span plus the fingerprint, so a duplicate collapses rather than
  // being reviewed twice.
  const byIdentity = new Map();
  for (const r of kept) {
    if (!byIdentity.has(r.claim.claimId)) byIdentity.set(r.claim.claimId, r);
  }
  let unique = [...byIdentity.values()];

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
    claims: publishable.sort((a, b) => a.claim.claimId.localeCompare(b.claim.claimId)),
    dropped: droppedRows.sort((a, b) => `${a.chunkId}${a.reason}`.localeCompare(`${b.chunkId}${b.reason}`)),
    strippedFields: strippedFields.sort((a, b) => `${a.chunkId}${a.field}`.localeCompare(`${b.chunkId}${b.field}`)),
    suppressed,
    reassembly,
    quotedWords: spent,
    ledger: workingLedger,
    notes,
  };
}
