// The thesis data contract: what may be recorded, and what may never be.
//
// Nothing here calls a model. These are the shapes a model's output must fit
// and the deterministic checks it must pass before a person ever sees it, so
// the rules exist and are tested before anything is generated against them.
//
// Two ideas run through every entity.
//
// The first is that a claim's *kind* is part of the claim. An analytical
// conclusion and a sentence the manager wrote are different objects with
// different licences, and collapsing them is the failure mode that makes a
// research product worthless. `inference` may never be rendered as a
// quotation or attributed as a manager statement; the renderer enforces it
// and a test holds it.
//
// The second is that absence is not evidence. A manager who stops writing
// about a holding has not sold it, and a 13F that no longer lists a security
// may mean a threshold, confidential treatment, a non-13F instrument or
// simply the lag. Every field that could tempt a reader into that inference
// is either refused or forced to carry its qualification.

export const SCHEMA_VERSION = 1;

/** The five ways a claim can be supported. The distinction is the product. */
export const CLAIM_KINDS = Object.freeze({
  statement: 'explicitly stated by the manager, verifiable against the source text',
  paraphrase: 'a faithful compression of stated material, still anchored to a verified span',
  classification: 'application of the closed taxonomy to stated material',
  inference: 'an analytical conclusion not directly stated; never rendered as a quotation',
  filing: 'a deterministic fact from a 13F, 13D/G or filing metadata; no model involved',
});

/** Kinds that must resolve to a verified span in the source before review. */
export const KINDS_NEEDING_EVIDENCE = Object.freeze(['statement', 'paraphrase', 'classification']);

/** Kinds that may never be presented as the manager's own words. */
export const KINDS_NEVER_QUOTED = Object.freeze(['inference', 'filing']);

/**
 * Stance. `unclear` is a real answer and the default, not a failure.
 *
 * `exited` is deliberately hard to reach: it needs the manager to say so, or
 * deterministic position evidence carrying its filing-lag qualification.
 * Silence is `no_new_evidence` on the observation, never a stance.
 */
export const STANCES = Object.freeze(['long', 'short', 'exited', 'unclear']);

/** Conviction is recorded, never computed. There is no composite score. */
export const CONVICTION = Object.freeze(['stated_high', 'stated_moderate', 'stated_low', 'not_stated']);

/** How a thesis moved between two dated observations. */
export const TRANSITIONS = Object.freeze([
  'initiated', 'reiterated', 'strengthened', 'weakened', 'revised',
  'catalyst_update', 'risk_update', 'closed_explicitly', 'no_new_evidence',
]);

export const EVIDENCE_STATES = Object.freeze(['verified', 'failed', 'unverified']);
export const REVIEW_STATES = Object.freeze(['pending', 'accepted', 'edited', 'rejected', 'unresolved_company']);

/** Whether a field is produced by code or by a model. Printed, never inferred. */
export const PROVENANCE = Object.freeze(['deterministic', 'model']);

/**
 * The public excerpt cap, in both units, whichever bites first.
 *
 * The letters are the managers' copyrighted work. We quote to evidence a
 * paraphrase, not to reproduce; and because many short excerpts reassemble
 * into a long one, the renderer also refuses overlapping or adjacent spans
 * from the same document.
 */
export const EXCERPT_MAX_WORDS = 25;
export const EXCERPT_MAX_CHARS = 200;

/** Every entity the contract defines, and the fields each must carry. */
export const ENTITIES = Object.freeze({
  manager: ['managerId', 'slug', 'legalName', 'cik'],
  document: ['documentId', 'managerId', 'accession', 'form', 'filingDate', 'documentUrl', 'sha256'],
  issuer: ['issuerId', 'canonicalName', 'issuerCik', 'sector', 'sectorSource'],
  security: ['securityId', 'issuerId', 'cusipNormalised', 'shareClass', 'ticker', 'exchange'],
  thesis: ['thesisId', 'managerId', 'issuerId', 'openedOn', 'stance', 'status'],
  thesis_observation: ['observationId', 'thesisId', 'documentId', 'observedOn', 'transition', 'stance'],
  claim: ['claimId', 'managerId', 'documentId', 'filingDate', 'kind', 'stance', 'paraphrase', 'evidenceRef', 'evidenceState', 'tags', 'provenance', 'reviewStatus'],
  evidence_reference: ['evidenceId', 'documentId', 'locator', 'startOffset', 'endOffset', 'excerpt', 'sha256OfSource'],
  taxonomy_tag: ['code', 'axis', 'versionIntroduced'],
  catalyst: ['catalystId', 'claimId', 'description', 'expectedBy', 'dateIsExplicit'],
  risk: ['riskId', 'claimId', 'description', 'tags'],
  position_context: ['positionId', 'managerId', 'securityId', 'periodEnd', 'filedOn', 'shares', 'lagWarning'],
  review_decision: ['decisionId', 'claimId', 'claimFingerprint', 'decision', 'decidedOn'],
  connection: ['connectionId', 'kind', 'fromId', 'toId', 'basis'],
});

/** Fields no public record may carry, whatever the entity. */
export const FORBIDDEN_FIELDS = Object.freeze([
  'text', 'fullText', 'pageText', 'body', 'html', 'sourceText', 'extractedText',
  'rawResponse', 'promptText', 'completion', 'apiKey', 'convictionScore', 'compositeScore',
]);

const err = (list, msg) => { list.push(msg); return list; };

/** Everything wrong with a claim, as a list. Empty means it may enter review. */
export function validateClaim(claim, { taxonomy, now = null } = {}) {
  const problems = [];
  for (const field of ENTITIES.claim) {
    if (claim[field] === undefined || claim[field] === null || claim[field] === '') err(problems, `${field} is required`);
  }
  for (const key of Object.keys(claim)) {
    if (FORBIDDEN_FIELDS.includes(key)) err(problems, `${key} may never appear on a claim`);
  }
  if (!Object.prototype.hasOwnProperty.call(CLAIM_KINDS, claim.kind)) {
    err(problems, `${claim.kind} is not a claim kind: ${Object.keys(CLAIM_KINDS).join(', ')}`);
  }
  if (!STANCES.includes(claim.stance)) err(problems, `${claim.stance} is not a stance`);
  if (claim.conviction && !CONVICTION.includes(claim.conviction)) err(problems, `${claim.conviction} is not a conviction value`);
  if (claim.provenance && !PROVENANCE.includes(claim.provenance)) err(problems, `${claim.provenance} is not a provenance`);
  if (!REVIEW_STATES.includes(claim.reviewStatus)) err(problems, `${claim.reviewStatus} is not a review state`);
  if (claim.evidenceState && !EVIDENCE_STATES.includes(claim.evidenceState)) err(problems, `${claim.evidenceState} is not an evidence state`);

  // A model-derived claim must name the model and the prompt that made it,
  // so a later change to either can be traced to what it produced.
  if (claim.provenance === 'model') {
    if (!claim.model) err(problems, 'a model-derived claim must name its model');
    if (!claim.promptVersion) err(problems, 'a model-derived claim must name its prompt version');
  }
  if (claim.kind === 'filing' && claim.provenance !== 'deterministic') {
    err(problems, 'a filing claim is deterministic by definition and may not be model-derived');
  }

  if (KINDS_NEEDING_EVIDENCE.includes(claim.kind) && claim.evidenceState !== 'verified') {
    err(problems, `a ${claim.kind} may not enter review until its evidence is verified`);
  }
  if (claim.stance === 'exited' && !claim.exitBasis) {
    err(problems, 'exited requires an explicit manager statement or qualified position evidence: set exitBasis');
  }
  if (claim.exitBasis && !['manager_statement', 'position_evidence'].includes(claim.exitBasis)) {
    err(problems, `${claim.exitBasis} is not an exit basis`);
  }
  if (claim.exitBasis === 'position_evidence' && !claim.lagWarning) {
    err(problems, 'an exit inferred from position evidence must carry its filing-lag warning');
  }

  if (taxonomy) for (const p of validateTags(claim.tags, taxonomy)) err(problems, p);
  if (now && claim.filingDate > now) err(problems, 'a claim cannot be dated in the future');
  return problems;
}

/** Tags must come from the closed list, be compatible, and not be invented. */
export function validateTags(tags, taxonomy) {
  const problems = [];
  if (!Array.isArray(tags)) return ['tags must be a list'];
  const byCode = new Map(taxonomy.tags.map((t) => [t.code, t]));
  const seen = new Set();
  for (const code of tags) {
    const tag = byCode.get(code);
    if (!tag) { problems.push(`${code} is not in the closed taxonomy`); continue; }
    if (tag.deprecatedBy) problems.push(`${code} is deprecated; use ${tag.deprecatedBy}`);
    if (seen.has(code)) problems.push(`${code} appears twice`);
    seen.add(code);
  }
  for (const code of seen) {
    for (const other of byCode.get(code)?.exclusiveWith || []) {
      if (seen.has(other)) problems.push(`${code} and ${other} are mutually exclusive`);
    }
  }
  return problems;
}

/** A fingerprint that survives re-proposal, so a rejection can be remembered. */
export function claimFingerprint(claim) {
  return [claim.managerId, claim.documentId, claim.kind, claim.stance, (claim.tags || []).slice().sort().join('+'), (claim.paraphrase || '').trim().toLowerCase()].join('|');
}
