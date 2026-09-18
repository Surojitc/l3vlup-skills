// Where a claim can be, and which moves are legal.
//
// The states exist so that "published" is unreachable from "the model said
// so". There is no edge from `proposed` to `published`; getting there takes
// verified evidence, a resolved issuer, and a person. The graph is data
// rather than a series of if-statements, so the absence of that edge is
// something a test can assert rather than something a reader has to trust.

export const STATES = Object.freeze([
  'proposed',           // the model said it; nothing has been checked
  'evidence_verified',  // the span matches the source at its offsets
  'issuer_unresolved',  // verified, but we do not know which company
  'needs_review',       // verified and resolved; waiting on a person
  'accepted',
  'edited',
  'rejected',
  'published',
]);

/** Legal transitions. Everything absent is refused. */
export const TRANSITIONS = Object.freeze({
  proposed: ['evidence_verified', 'rejected'],
  evidence_verified: ['issuer_unresolved', 'needs_review', 'rejected'],
  issuer_unresolved: ['needs_review', 'rejected'],
  needs_review: ['accepted', 'edited', 'rejected'],
  accepted: ['published', 'rejected'],
  edited: ['published', 'rejected'],
  rejected: [],
  published: ['rejected'],
});

/** The only states a person may put a claim into. */
export const HUMAN_ONLY = Object.freeze(['accepted', 'edited', 'rejected', 'published']);

/** States a claim may be in and still be invisible to the public. */
export const UNPUBLISHED = Object.freeze(STATES.filter((s) => s !== 'published'));

export function canTransition(from, to) {
  return Boolean(TRANSITIONS[from]?.includes(to));
}

/**
 * Move a claim, refusing an illegal move and refusing a machine-made one
 * into a state only a person may choose.
 */
export function transition(claim, to, { actor }) {
  const from = claim.publicationState;
  if (!STATES.includes(to)) throw new Error(`${to} is not a publication state`);
  if (!canTransition(from, to)) throw new Error(`${from} cannot move to ${to}`);
  if (HUMAN_ONLY.includes(to) && actor !== 'human') {
    throw new Error(`only a person may move a claim to ${to}; ${actor} tried`);
  }
  return { ...claim, publicationState: to, stateHistory: [...(claim.stateHistory || []), { from, to, actor }] };
}

/** Whether `published` can be reached from a state without a person. */
export function reachableWithoutHuman(from) {
  const seen = new Set([from]);
  const queue = [from];
  while (queue.length) {
    const s = queue.shift();
    for (const next of TRANSITIONS[s] || []) {
      if (HUMAN_ONLY.includes(next) || seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return [...seen];
}
