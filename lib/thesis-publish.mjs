// What a workflow run is allowed to hand back, and in what shape.
//
// The runner already refuses to publish a claim and already caps quotation.
// This is the layer below that: an allowlist applied to the bytes that leave
// the runner, because a workflow artefact and a pull-request diff are both
// permanent and public in a way a local file is not.
//
// It exists separately from lib/thesis-schema.mjs on purpose. That file says
// what a claim *is*; this one says what may be written down where other
// people can read it. They overlap, and the overlap is deliberate: two
// independent checks, written at different times, and only one of them has
// to hold for a letter to stay unpublished.

import { EXCERPT_MAX_CHARS, EXCERPT_MAX_WORDS } from './thesis-schema.mjs';
import { MAX_DOCUMENT_QUOTED_WORDS, wordCount } from './thesis-evidence.mjs';

export const FEED_VERSION = 1;

/** Every field a published claim may carry. Anything else is dropped. */
export const PUBLISHED_CLAIM_FIELDS = Object.freeze([
  'claimId', 'managerId', 'managerName', 'documentId', 'accession', 'filingDate', 'form',
  'sourceUrl', 'locator', 'kind', 'stance', 'conviction', 'paraphrase',
  'excerpt', 'excerptWithheld', 'attribution', 'tags', 'horizon',
  'catalysts', 'risks', 'issuerId', 'issuerName', 'issuerResolution',
  'publicationState', 'evidenceState', 'model', 'promptVersion',
  'schemaVersion', 'extractionConfigVersion', 'reviewStatus',
]);

/**
 * Fields that must never appear, named rather than merely absent.
 *
 * `text`, `sourceText` and the rest are the letter itself. `prompt` and
 * `systemPrompt` are ours but would publish the extraction recipe. `apiKey`
 * and `authorization` should be impossible; they are listed because a list
 * that only holds the things you thought of is not a defence.
 */
export const FORBIDDEN_PUBLISHED_FIELDS = Object.freeze([
  'text', 'fullText', 'sourceText', 'extractedText', 'pageText', 'body', 'html',
  'chunkText', 'passage', 'rawResponse', 'completion', 'prompt', 'systemPrompt',
  'promptText', 'messages', 'apiKey', 'authorization', 'token', 'secret',
  'convictionScore', 'compositeScore', 'localPath', 'originalPath', 'workspacePath',
]);

/** States a claim may be in when a workflow hands it over. */
export const PUBLISHABLE_STATES = Object.freeze(['needs_review', 'issuer_unresolved']);

/** States only a person may set, and which a workflow may therefore never emit. */
export const HUMAN_ONLY_STATES = Object.freeze(['accepted', 'edited', 'published']);

const pick = (row, fields) => {
  const out = {};
  for (const f of fields) if (row[f] !== undefined) out[f] = row[f];
  return out;
};

/**
 * One claim, reduced to what may be published, or refused with a reason.
 *
 * A refusal is not an error to recover from: the claim is left out of the
 * feed and its reason is recorded. A feed that silently drops things is as
 * bad as one that publishes too much.
 */
export function sanitiseClaim(claim, reference = {}) {
  const problems = [];
  const state = claim.publicationState;

  if (HUMAN_ONLY_STATES.includes(state)) {
    problems.push(`a workflow may not emit a claim in ${state}; only a person may set that`);
  } else if (!PUBLISHABLE_STATES.includes(state)) {
    problems.push(`${state ?? 'no publication state'} is not a state a workflow may hand over`);
  }
  if (claim.reviewStatus && claim.reviewStatus !== 'pending') {
    problems.push(`reviewStatus ${claim.reviewStatus} was set by something other than a person`);
  }

  const merged = { ...claim, ...pick(reference, ['sourceUrl', 'locator', 'excerpt', 'excerptWithheld', 'attribution']) };
  for (const key of Object.keys(merged)) {
    if (FORBIDDEN_PUBLISHED_FIELDS.includes(key)) problems.push(`${key} may never be published`);
  }

  const excerpt = merged.excerpt ?? null;
  if (excerpt !== null) {
    const words = wordCount(excerpt);
    if (words > EXCERPT_MAX_WORDS) problems.push(`the excerpt is ${words} words, over the ${EXCERPT_MAX_WORDS}-word cap`);
    if (String(excerpt).length > EXCERPT_MAX_CHARS) problems.push(`the excerpt is ${String(excerpt).length} characters, over the ${EXCERPT_MAX_CHARS}-character cap`);
    // An inference was never said, so it can carry no quotation at all.
    if (['inference', 'filing'].includes(merged.kind)) problems.push(`a ${merged.kind} may never carry an excerpt`);
  }

  if (problems.length) return { ok: false, problems, claimId: claim.claimId ?? null };
  return { ok: true, claim: pick(merged, PUBLISHED_CLAIM_FIELDS) };
}

/**
 * The whole feed: sanitised claims, the cost, and why anything was left out.
 *
 * Ordered by claim id so the same run twice produces the same bytes, which
 * is what makes the resulting pull request diffable.
 */
export function buildFeed({ claims = [], references = new Map(), dropped = [], stripped = [], ledger = {}, model, promptVersion, runId = null }) {
  const published = [];
  const refused = [];
  for (const claim of claims) {
    const result = sanitiseClaim(claim, references.get(claim.claimId) || {});
    if (result.ok) published.push(result.claim);
    else refused.push({ claimId: result.claimId, problems: result.problems });
  }

  const quotedByDocument = {};
  for (const c of published) {
    if (!c.excerpt) continue;
    quotedByDocument[c.documentId] = (quotedByDocument[c.documentId] || 0) + wordCount(c.excerpt);
  }
  for (const [documentId, words] of Object.entries(quotedByDocument)) {
    if (words > MAX_DOCUMENT_QUOTED_WORDS) {
      refused.push({ claimId: null, problems: [`${documentId}: ${words} words quoted in total, over the ${MAX_DOCUMENT_QUOTED_WORDS}-word cumulative cap`] });
    }
  }

  return {
    feedVersion: FEED_VERSION,
    note: 'Sanitised claims awaiting human review. No source text, no prompts, no model responses. Every claim is needs_review or issuer_unresolved; nothing here is accepted or published, and only a person can make it so.',
    model,
    promptVersion,
    runId,
    claims: published.sort((a, b) => String(a.claimId).localeCompare(String(b.claimId))),
    refused: refused.sort((a, b) => String(a.claimId).localeCompare(String(b.claimId))),
    // Reasons only, never the text that caused them.
    dropped: dropped.map((d) => ({ chunkId: d.chunkId, reason: d.reason })).sort((a, b) => `${a.chunkId}${a.reason}`.localeCompare(`${b.chunkId}${b.reason}`)),
    stripped: stripped.map((s) => ({ chunkId: s.chunkId, field: s.field, reason: s.reason })).sort((a, b) => `${a.chunkId}${a.field}`.localeCompare(`${b.chunkId}${b.field}`)),
    cost: {
      estimatedUsd: ledger.estimatedUsd ?? 0,
      actualUsd: ledger.actualUsd ?? 0,
      budgetUsd: ledger.budgetUsd ?? null,
      stopped: Boolean(ledger.stopped),
      stopReason: ledger.stopReason ?? null,
      calls: (ledger.calls || []).map((c) => ({ documentId: c.documentId, chunkId: c.chunkId, model: c.model, inputTokens: c.inputTokens, outputTokens: c.outputTokens, estimatedUsd: c.estimatedUsd, actualUsd: c.actualUsd })),
    },
    quotedWordsByDocument: quotedByDocument,
  };
}

export const serialiseFeed = (feed) => `${JSON.stringify(feed, null, 2)}\n`;

/**
 * Read a feed back and refuse it if anything is wrong.
 *
 * Run by the job that opens the pull request, against the artefact rather
 * than against its own memory of producing it, and again by the site before
 * it renders anything.
 */
export function validateFeed(feed) {
  const problems = [];
  if (!feed || typeof feed !== 'object') return ['the feed is not an object'];
  if (feed.feedVersion !== FEED_VERSION) problems.push(`feedVersion ${feed.feedVersion} is not ${FEED_VERSION}`);
  if (!Array.isArray(feed.claims)) return [...problems, 'the feed carries no claims array'];

  const walk = (value, path) => {
    if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) {
        if (FORBIDDEN_PUBLISHED_FIELDS.includes(k)) problems.push(`${path}.${k} may never be published`);
        walk(v, `${path}.${k}`);
      }
    }
  };
  walk(feed, 'feed');

  for (const c of feed.claims) {
    for (const key of Object.keys(c)) {
      if (!PUBLISHED_CLAIM_FIELDS.includes(key)) problems.push(`${c.claimId}: ${key} is not a published field`);
    }
    if (!PUBLISHABLE_STATES.includes(c.publicationState)) {
      problems.push(`${c.claimId}: ${c.publicationState} is not a state a workflow may hand over`);
    }
    if (c.excerpt) {
      if (wordCount(c.excerpt) > EXCERPT_MAX_WORDS) problems.push(`${c.claimId}: the excerpt is over the word cap`);
      if (String(c.excerpt).length > EXCERPT_MAX_CHARS) problems.push(`${c.claimId}: the excerpt is over the character cap`);
      if (['inference', 'filing'].includes(c.kind)) problems.push(`${c.claimId}: a ${c.kind} carries an excerpt`);
    }
  }
  for (const [documentId, words] of Object.entries(feed.quotedWordsByDocument || {})) {
    if (words > MAX_DOCUMENT_QUOTED_WORDS) problems.push(`${documentId}: ${words} words quoted, over the cumulative cap`);
  }
  return problems;
}
