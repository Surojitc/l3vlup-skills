// The review card, and the memory that stops a rejected claim coming back.
//
// A person decides what is published. This builds what they see: the
// paraphrase, the short excerpt where one is allowed, where to look in the
// filing, and the 13F context carrying its lag warning. It also records what
// they decided, keyed by a fingerprint of the claim rather than its id, so
// the same claim proposed again from a re-run is recognised as the same
// claim and not asked about twice.
//
// Local and fixture-driven. Nothing here publishes, and nothing here is a
// web page.

import { claimFingerprint, KINDS_NEVER_QUOTED, REVIEW_STATES } from './thesis-schema.mjs';
import { excerptProblems, publicView } from './thesis-evidence.mjs';

export const REVIEW_VERSION = 1;

/**
 * One card. Everything a person needs to accept, edit or reject, and nothing
 * that would let them accept it without seeing the qualification.
 */
export function reviewCard(claim, { reference = null, issuer = null, position = null, manager = null } = {}) {
  const view = publicView({ ...claim, managerName: manager?.legalName }, reference, { kindsNeverQuoted: KINDS_NEVER_QUOTED });
  return {
    claimId: claim.claimId,
    fingerprint: claimFingerprint(claim),
    kind: claim.kind,
    // Said by the manager, or concluded by us: the card never lets these
    // look alike, because the whole distinction dies at the point of review.
    kindLabel: KINDS_NEVER_QUOTED.includes(claim.kind)
      ? (claim.kind === 'inference' ? 'OUR INFERENCE — not the manager’s words' : 'FILING FACT — deterministic, not the manager’s words')
      : 'MANAGER — verified against the filing',
    manager: manager?.legalName || claim.managerId,
    issuer: issuer ? issuer.canonicalName : null,
    issuerState: issuer ? 'resolved' : 'unresolved',
    paraphrase: claim.paraphrase,
    excerpt: view.excerpt,
    attribution: view.attribution,
    locator: reference?.locator ?? null,
    sourceUrl: reference?.documentUrl ?? null,
    proposedTags: claim.tags || [],
    stance: claim.stance,
    conviction: claim.conviction || 'not_stated',
    catalysts: claim.catalysts || [],
    risks: claim.risks || [],
    positionContext: position ? { ...position, warning: position.lagWarning } : null,
    availableDecisions: issuer ? ['accept', 'edit', 'reject'] : ['unresolved_company', 'reject'],
    evidenceState: claim.evidenceState,
  };
}

/** Render a set of cards as text a person reads in a terminal. */
export function renderReview(cards) {
  const lines = ['# Thesis claims awaiting review', '', `${cards.length} claim(s). Nothing is published until each is decided.`, ''];
  for (const c of cards) {
    lines.push(`## ${c.claimId} — ${c.kindLabel}`);
    lines.push('');
    lines.push(`- Manager: ${c.manager}`);
    lines.push(`- Issuer: ${c.issuer ?? 'UNRESOLVED — resolve the company before accepting'}`);
    lines.push(`- Stance: ${c.stance} · conviction: ${c.conviction}`);
    lines.push(`- Tags: ${c.proposedTags.join(', ') || 'none'}`);
    lines.push(`- Paraphrase: ${c.paraphrase}`);
    if (c.excerpt) lines.push(`- Evidence: “${c.excerpt}” — ${c.attribution}`);
    else lines.push('- Evidence: no excerpt (this kind is never shown as a quotation)');
    if (c.sourceUrl) lines.push(`- Source: ${c.sourceUrl} (${c.locator})`);
    for (const k of c.catalysts) lines.push(`- Catalyst: ${k.description}${k.expectedBy ? ` by ${k.expectedBy}` : ''}${k.dateIsExplicit ? '' : ' (date not explicit)'}`);
    for (const r of c.risks) lines.push(`- Risk: ${r.description}`);
    if (c.positionContext) {
      lines.push(`- 13F context: ${c.positionContext.shares ?? 'not in the filing'} shares at ${c.positionContext.periodEnd}`);
      lines.push(`  WARNING: ${c.positionContext.warning}`);
    }
    lines.push(`- Decisions: ${c.availableDecisions.join(' / ')}`);
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

export const emptyDecisionLog = () => ({ reviewVersion: REVIEW_VERSION, decisions: [] });

export function recordDecision(log, { claim, decision, decidedOn, note = null, editedParaphrase = null }) {
  if (!REVIEW_STATES.includes(decision)) throw new Error(`${decision} is not a review state`);
  const fingerprint = claimFingerprint(claim);
  const decisions = log.decisions.filter((d) => d.claimFingerprint !== fingerprint);
  decisions.push({ decisionId: `d-${fingerprint.slice(0, 16)}`, claimId: claim.claimId, claimFingerprint: fingerprint, decision, decidedOn, note, editedParaphrase });
  decisions.sort((a, b) => a.claimFingerprint.localeCompare(b.claimFingerprint));
  return { ...log, decisions };
}

/**
 * Whether this claim has already been decided.
 *
 * A rejected claim proposed again unchanged is filtered out before review;
 * changing its paraphrase, stance or tags changes the fingerprint and it is
 * a new proposal, which is the behaviour we want — a genuinely different
 * claim deserves a fresh look, the same one does not.
 */
export function priorDecision(log, claim) {
  const fingerprint = claimFingerprint(claim);
  return log.decisions.find((d) => d.claimFingerprint === fingerprint) || null;
}

export function filterAlreadyRejected(log, claims) {
  const kept = [];
  const suppressed = [];
  for (const c of claims) {
    const prior = priorDecision(log, c);
    if (prior && prior.decision === 'rejected') suppressed.push({ claimId: c.claimId, because: `rejected on ${prior.decidedOn}` });
    else kept.push(c);
  }
  return { kept, suppressed };
}

/** A card may not be built from an excerpt that breaks the public cap. */
export function cardProblems(card) {
  const problems = [];
  if (card.excerpt) problems.push(...excerptProblems(card.excerpt));
  if (card.excerpt && KINDS_NEVER_QUOTED.includes(card.kind)) problems.push(`a ${card.kind} may never carry an excerpt`);
  if (card.evidenceState === 'failed') problems.push('a claim whose evidence failed may not reach review');
  return problems;
}
