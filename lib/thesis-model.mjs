// The model interface, and the boundary drawn around it.
//
// Nothing in this file calls anything. `Model` is a shape: one async method
// that takes a request and returns a proposal. The runner is written against
// that shape, the tests drive it with a deterministic fake, and a real client
// is a later decision requiring a key nobody has yet granted.
//
// The boundary is the design. A language model reading a letter is good at
// one thing — saying what the letter says, and where. It is not a source of
// truth about which company that is, what it trades as, what CUSIP it
// carries, or what anybody holds. Those are lookups, and a model asked to
// perform a lookup will answer confidently from memory.
//
// So the fields split in two, and the split is enforced rather than
// documented: anything the model returns outside PROPOSABLE is stripped
// before the proposal is looked at, and a stripped field is reported.

export const MODEL_INTERFACE_VERSION = 1;

/** What a model may propose. Everything else it returns is discarded. */
export const PROPOSABLE = Object.freeze([
  'issuerMention',     // the company as the letter names it, in prose
  'paraphrase',
  'kind',
  'stance',
  'tags',
  'catalyst',
  'risk',
  'horizon',
  'evidenceExcerpt',
  'evidenceStartOffset',
  'evidenceEndOffset',
]);

/**
 * What the model may never determine, with the reason each is on the list.
 *
 * These are not "fields we prefer to compute". They are fields where a
 * plausible wrong answer is worse than no answer, because nothing downstream
 * would catch it: a wrong ticker resolves, a wrong CUSIP matches a real
 * security, a hallucinated position reads exactly like a real one.
 */
export const NOT_PROPOSABLE = Object.freeze({
  issuerId: 'canonical identity is a reviewed alias lookup',
  canonicalIssuerName: 'canonical identity is a reviewed alias lookup',
  ticker: 'a ticker comes from the security master, never from memory',
  cusip: 'a CUSIP comes from the filing, never from memory',
  cusipNormalised: 'derived deterministically from the filed CUSIP',
  shareClass: 'a share class comes from the security master',
  issuerCik: 'a CIK comes from SEC data',
  position: 'a position comes from a 13F',
  shares: 'a position comes from a 13F',
  positionChange: 'computed from two filings',
  filingDate: 'filing metadata comes from the filing',
  accession: 'filing metadata comes from the filing',
  form: 'filing metadata comes from the filing',
  documentUrl: 'filing metadata comes from the filing',
  sha256: 'computed while streaming the bytes',
  evidenceState: 'whether evidence matches is decided by comparing strings, not by asking',
  evidenceVerified: 'whether evidence matches is decided by comparing strings, not by asking',
  reviewStatus: 'whether a claim is published is a person’s decision',
  publicationState: 'whether a claim is published is a person’s decision',
  published: 'whether a claim is published is a person’s decision',
});

/**
 * Keep only what a model is allowed to say, and report what was thrown away.
 *
 * A model returning a ticker is not an error to abort on — it is a normal
 * thing for a model to do, and the right response is to drop it and note it.
 * Silently dropping would hide a prompt that is inviting the wrong answer.
 */
export function stripToProposable(raw) {
  const proposal = {};
  const stripped = [];
  for (const [key, value] of Object.entries(raw || {})) {
    if (PROPOSABLE.includes(key)) proposal[key] = value;
    else stripped.push({ field: key, reason: NOT_PROPOSABLE[key] || 'not a proposable field' });
  }
  return { proposal, stripped };
}

/**
 * The fake used by every test, and the only implementation in this repository.
 *
 * Deterministic by construction: it answers from a fixture map keyed by chunk
 * id, so a rerun returns the same proposals in the same order and a test can
 * assert on the whole output rather than on its shape.
 */
export function fakeModel({ responses, id = 'fake-model-v1' }) {
  const calls = [];
  return {
    id,
    calls,
    async propose(request) {
      calls.push({ chunkId: request.chunkId, documentId: request.documentId });
      const answer = responses[request.chunkId];
      if (answer === undefined) return { proposals: [], usage: { inputTokens: request.estimatedInputTokens ?? 0, outputTokens: 0 } };
      if (typeof answer === 'function') return answer(request);
      return answer;
    },
  };
}

/** A model that is configured but has no price. The runner must refuse it. */
export function unpricedModel(id = 'mystery-model-v9') {
  return { id, async propose() { throw new Error('this model should never have been called'); } };
}
