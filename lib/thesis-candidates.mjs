// Candidates, and what a consolidation call is allowed to do with them.
//
// Stage A offers at most two evidence-backed candidates per chunk. Stage B
// ranks them. The whole point of splitting the two is that the second call
// cannot touch the words: it returns identifiers and integers, and the claim
// that reaches review is the candidate it named, byte for byte.
//
// So the identifier has to be ours. A model-supplied id could be made up to
// match a claim it invented; a digest of the candidate's own content cannot.
// Every id here is computed from the document, the chunk, the offsets and the
// excerpt, which means an id that does not correspond to something we already
// verified simply will not be found.

import { createHash } from 'node:crypto';
import { MAX_CLAIMS_PER_DOCUMENT } from './thesis-cost.mjs';

export const CANDIDATE_VERSION = 1;

/**
 * A candidate's identity, from its own content.
 *
 * Deterministic, so the same verified span in the same chunk of the same
 * document is always the same candidate, and a rerun produces the same ids.
 */
export function candidateId({ documentId, chunkId, startOffset, endOffset, excerpt, fingerprint }) {
  // The claim's own fingerprint is part of the digest, not decoration. A
  // statement and an inference can rest on the same sentence at the same
  // offsets; without it they would share an id, and Stage B naming that id
  // would be ambiguous about which claim it meant.
  const material = [documentId, chunkId, startOffset, endOffset, excerpt, fingerprint].join('\u0000');
  return `cand-${createHash('sha256').update(material).digest('hex').slice(0, 16)}`;
}

/**
 * Collapse candidates that are the same claim, keeping where each came from.
 *
 * Overlapping chunks quote the same sentence twice. Deduplicating on the
 * claim's fingerprint rather than the id means two chunks that produced the
 * same claim collapse; the survivor carries `alsoSeenIn` so nothing about
 * where it was found is lost.
 */
export function dedupeCandidates(candidates) {
  const byFingerprint = new Map();
  for (const c of [...candidates].sort((a, b) => a.candidateId.localeCompare(b.candidateId))) {
    const key = c.fingerprint ?? c.candidateId;
    const seen = byFingerprint.get(key);
    if (!seen) {
      byFingerprint.set(key, { ...c, alsoSeenIn: [] });
      continue;
    }
    // Provenance is preserved rather than discarded: the duplicate's chunk and
    // offsets are recorded on the survivor.
    seen.alsoSeenIn.push({ chunkId: c.chunkId, startOffset: c.startOffset, endOffset: c.endOffset, candidateId: c.candidateId });
    seen.alsoSeenIn.sort((a, b) => a.candidateId.localeCompare(b.candidateId));
  }
  return [...byFingerprint.values()].sort((a, b) => a.candidateId.localeCompare(b.candidateId));
}

/**
 * Turn what Stage B returned into an ordered list of candidates.
 *
 * Everything the model could get wrong is dropped and named: an id we never
 * offered, the same id twice, a rank that is not a positive integer, a row
 * that is not an object, and anything past the per-document cap. What comes
 * back is candidates from the list we passed in, unmodified.
 */
export function resolveSelections(selections, candidates, { maxClaims = MAX_CLAIMS_PER_DOCUMENT } = {}) {
  const byId = new Map(candidates.map((c) => [c.candidateId, c]));
  const chosen = [];
  const rejected = [];
  const used = new Set();

  for (const row of Array.isArray(selections) ? selections : []) {
    if (!row || typeof row !== 'object') { rejected.push({ candidateId: null, reason: 'a selection was not an object' }); continue; }
    const { candidateId: id, rank } = row;
    if (typeof id !== 'string' || !id) { rejected.push({ candidateId: null, reason: 'a selection carried no candidate id' }); continue; }
    if (!byId.has(id)) { rejected.push({ candidateId: id, reason: 'no candidate with that id was offered' }); continue; }
    if (used.has(id)) { rejected.push({ candidateId: id, reason: 'the same candidate was selected twice' }); continue; }
    if (!Number.isInteger(rank) || rank < 1) { rejected.push({ candidateId: id, reason: `rank ${rank} is not a positive integer` }); continue; }
    used.add(id);
    chosen.push({ candidate: byId.get(id), rank });
  }

  chosen.sort((a, b) => a.rank - b.rank || a.candidate.candidateId.localeCompare(b.candidate.candidateId));
  const kept = chosen.slice(0, maxClaims);
  for (const extra of chosen.slice(maxClaims)) {
    rejected.push({ candidateId: extra.candidate.candidateId, reason: `over the ${maxClaims}-claim cap for one document` });
  }
  return {
    selected: kept.map((c, i) => ({ ...c.candidate, rank: i + 1 })),
    rejected: rejected.sort((a, b) => `${a.candidateId}${a.reason}`.localeCompare(`${b.candidateId}${b.reason}`)),
  };
}

/** What Stage B is given: enough to rank, and an id it cannot have invented. */
export const forConsolidation = (candidates) => candidates.map((c) => ({
  candidateId: c.candidateId,
  issuerMention: c.issuerMention,
  paraphrase: c.paraphrase,
  kind: c.kind,
  stance: c.stance,
  tags: c.tags,
  horizon: c.horizon ?? null,
  excerpt: c.excerpt,
}));

/**
 * The ceiling the schema used to hold, held in code instead.
 *
 * A strict schema cannot carry `maxItems`, so the count arrives as a request
 * in the tool description rather than a constraint the API enforces. That is
 * a difference worth naming: a description is a thing the model may ignore,
 * and the one place a model's word is never taken is a limit. Anything past
 * the cap is cut here, in document order, and the overflow is counted so a
 * run that keeps overshooting is visible rather than silently trimmed.
 */
export function capList(items, max) {
  const list = Array.isArray(items) ? items : [];
  return { kept: list.slice(0, max), discarded: Math.max(0, list.length - max) };
}
