// How a thesis moves, and the one movement that is not a movement.
//
// A thesis is keyed by the manager, the canonical issuer and a thesis
// identity — not by a taxonomy tag. A manager can hold two theses on one
// company at once (a long on the core business and a view on a spin-off),
// and a tag is a label on a thesis rather than the thesis itself. Keying on
// a tag would merge those two and split one thesis whose tags were revised.
//
// Every transition needs two dated observations. The default when a document
// says nothing about a holding is `no_new_evidence`: silence is the absence
// of a signal, not a bearish one, and a manager who stops writing about a
// position has told you nothing except that they stopped writing.

import { TRANSITIONS } from './thesis-schema.mjs';

export const HISTORY_VERSION = 1;

/** The identity a thesis keeps while its tags, stance and catalysts change. */
export function thesisKey({ managerId, issuerId, thesisIdentity }) {
  if (!managerId || !issuerId) return null;
  return `${managerId}|${issuerId}|${thesisIdentity || 'primary'}`;
}

/**
 * The transition between two observations of one thesis.
 *
 * `previous` null means this is the first sighting. Everything else is read
 * from what the later document actually said, and `no_new_evidence` is the
 * answer whenever it said nothing.
 */
export function transitionBetween(previous, current) {
  if (!previous) return 'initiated';
  if (!current.mentioned) return 'no_new_evidence';
  if (current.closedExplicitly) return 'closed_explicitly';
  if (current.stance !== previous.stance) return 'revised';
  if (current.catalystsChanged) return 'catalyst_update';
  if (current.risksChanged) return 'risk_update';
  if (current.convictionStated && previous.convictionStated) {
    const rank = { stated_low: 1, stated_moderate: 2, stated_high: 3 };
    const before = rank[previous.convictionStated];
    const after = rank[current.convictionStated];
    if (after > before) return 'strengthened';
    if (after < before) return 'weakened';
  }
  return 'reiterated';
}

/** Build the ordered history, refusing an undated or out-of-vocabulary step. */
export function buildHistory(observations) {
  const problems = [];
  const sorted = [...observations].sort((a, b) => String(a.observedOn).localeCompare(String(b.observedOn)) || String(a.observationId).localeCompare(String(b.observationId)));
  const out = [];
  let previous = null;
  for (const o of sorted) {
    if (!o.observedOn) { problems.push(`${o.observationId} has no date; a transition without a date is not a transition`); continue; }
    const transition = o.transition || transitionBetween(previous, o);
    if (!TRANSITIONS.includes(transition)) { problems.push(`${transition} is not a transition`); continue; }
    out.push({ ...o, transition, previousObservationId: previous?.observationId ?? null });
    // A document that says nothing does not become the new baseline: the
    // last thing the manager actually said stays the thing they said.
    if (transition !== 'no_new_evidence') previous = o;
  }
  return { observations: out, problems };
}

/**
 * The stance a thesis currently carries.
 *
 * Only an explicit close, or an observation whose exit basis is recorded,
 * moves it to exited. Running out of observations does not.
 */
export function currentStance(history) {
  const meaningful = history.filter((o) => o.transition !== 'no_new_evidence');
  if (!meaningful.length) return { stance: 'unclear', basis: 'no observation has said anything yet' };
  const last = meaningful[meaningful.length - 1];
  if (last.transition === 'closed_explicitly') return { stance: 'exited', basis: `closed explicitly on ${last.observedOn}` };
  return { stance: last.stance || 'unclear', basis: `as stated on ${last.observedOn}` };
}

/** How stale the view is, as a fact rather than a judgement. */
export function staleness(history, today) {
  const meaningful = history.filter((o) => o.transition !== 'no_new_evidence');
  if (!meaningful.length) return { days: null, note: 'nothing has been said' };
  const last = meaningful[meaningful.length - 1].observedOn;
  const days = Math.round((Date.parse(today) - Date.parse(last)) / 86400000);
  return { days, lastSpokeOn: last, note: `the manager last wrote about this ${days} days ago; that is silence, not a change of view` };
}
