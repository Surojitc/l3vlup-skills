// Evidence: proved against the source, or dropped.
//
// A claim says the manager wrote something. The only way to know is to find
// it, byte for byte, where the claim says it is. That check runs against the
// transient extracted text inside the run, never against a stored copy, and
// its answer is binary. A span that does not match is not sent back to a
// model to be repaired — a second model asked to fix a quotation will
// produce a better-looking quotation, not a true one.

import { EXCERPT_MAX_CHARS, EXCERPT_MAX_WORDS } from './thesis-schema.mjs';

/** Words, counted the way a reader would count them. */
export const wordCount = (s) => (String(s).trim().match(/\S+/g) || []).length;

/**
 * Whether a public excerpt is short enough, in both units.
 *
 * Both caps apply and the lower bites: 25 words or 200 characters. A German
 * compound noun reaches 200 characters in far fewer than 25 words, and a
 * list of tickers reaches 25 words in far fewer than 200 characters. Naming
 * one limit would let the other through.
 */
export function excerptProblems(excerpt) {
  const problems = [];
  const chars = String(excerpt).length;
  const words = wordCount(excerpt);
  if (words > EXCERPT_MAX_WORDS) problems.push(`the excerpt is ${words} words, over the ${EXCERPT_MAX_WORDS}-word cap`);
  if (chars > EXCERPT_MAX_CHARS) problems.push(`the excerpt is ${chars} characters, over the ${EXCERPT_MAX_CHARS}-character cap`);
  return problems;
}

/**
 * Verify one evidence reference against the transient source text.
 *
 * The offsets must be the excerpt's actual position. A span that appears
 * elsewhere in the document is still a failure: an offset that does not
 * point where it claims cannot be used to locate anything later, and a
 * "close enough" match is how a quotation drifts onto the wrong page.
 */
export function verifyEvidence(reference, sourceText) {
  const problems = [];
  const { startOffset, endOffset, excerpt } = reference;
  if (!Number.isInteger(startOffset) || !Number.isInteger(endOffset)) return { state: 'failed', problems: ['the offsets are not integers'] };
  if (endOffset <= startOffset) return { state: 'failed', problems: ['the span is empty or inverted'] };
  if (endOffset > sourceText.length) return { state: 'failed', problems: ['the span runs past the end of the source'] };

  const found = sourceText.slice(startOffset, endOffset);
  if (found !== excerpt) {
    problems.push(sourceText.includes(excerpt)
      ? 'the excerpt occurs in the source but not at the stated offsets'
      : 'the excerpt does not occur in the source');
    return { state: 'failed', problems };
  }
  problems.push(...excerptProblems(excerpt));
  return { state: problems.length ? 'failed' : 'verified', problems };
}

/**
 * Refuse a set of excerpts that reassembles the source.
 *
 * Each excerpt can be inside the cap while the set is a reproduction. Spans
 * from one document that touch or overlap are treated as one span and must
 * clear the cap together; and a document may not be quoted beyond a small
 * share of its length however the spans are arranged.
 */
export const MAX_DOCUMENT_QUOTED_CHARS = 1000;

/** The share of a document that may be quoted, once it is long enough to matter. */
export const PROPORTIONAL_SHARE = 0.02;

export function reassemblyProblems(references, { sourceLength = null } = {}) {
  const problems = [];
  const byDocument = new Map();
  for (const r of references) {
    if (!byDocument.has(r.documentId)) byDocument.set(r.documentId, []);
    byDocument.get(r.documentId).push(r);
  }
  for (const [documentId, refs] of byDocument) {
    const sorted = [...refs].sort((a, b) => a.startOffset - b.startOffset);
    let merged = null;
    let total = 0;
    for (const r of sorted) {
      if (merged && r.startOffset <= merged.endOffset + 1) {
        merged = { startOffset: merged.startOffset, endOffset: Math.max(merged.endOffset, r.endOffset) };
        const span = merged.endOffset - merged.startOffset;
        if (span > EXCERPT_MAX_CHARS) problems.push(`${documentId}: adjacent excerpts merge into a ${span}-character span, over the ${EXCERPT_MAX_CHARS}-character cap`);
      } else {
        if (merged) total += merged.endOffset - merged.startOffset;
        merged = { startOffset: r.startOffset, endOffset: r.endOffset };
      }
    }
    if (merged) total += merged.endOffset - merged.startOffset;
    if (total > MAX_DOCUMENT_QUOTED_CHARS) problems.push(`${documentId}: ${total} characters quoted in total, over the ${MAX_DOCUMENT_QUOTED_CHARS}-character limit for one document`);
    // The proportional limit never falls below one permitted excerpt. Two
    // per cent of a 400-character note is nine characters, which would make
    // a single legitimate quotation impossible; the proportion is there to
    // stop a long document being quoted at length, not to forbid quoting a
    // short one at all.
    if (sourceLength) {
      const proportional = Math.max(EXCERPT_MAX_CHARS, Math.floor(sourceLength * PROPORTIONAL_SHARE));
      if (total > proportional) problems.push(`${documentId}: ${total} characters quoted, over the ${proportional} allowed for a document of ${sourceLength} characters`);
    }
  }
  return problems;
}

/**
 * What a claim may show publicly.
 *
 * The paraphrase, a link to sec.gov, where in the document to look, and an
 * excerpt only where one is needed to carry the point. An inference or a
 * filing fact never gets an excerpt, because it was never said.
 */
export function publicView(claim, reference, { kindsNeverQuoted }) {
  const view = {
    claimId: claim.claimId,
    kind: claim.kind,
    paraphrase: claim.paraphrase,
    stance: claim.stance,
    tags: claim.tags,
    source: reference ? { url: reference.documentUrl, locator: reference.locator } : null,
    excerpt: null,
    attribution: null,
  };
  if (reference && !kindsNeverQuoted.includes(claim.kind) && claim.evidenceState === 'verified' && !excerptProblems(reference.excerpt).length) {
    view.excerpt = reference.excerpt;
    view.attribution = `${claim.managerName || claim.managerId}, ${claim.filingDate}`;
  }
  return view;
}
