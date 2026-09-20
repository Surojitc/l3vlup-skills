// The trust policy: which GitHub Actions run may borrow our Anthropic identity.
//
// There is no API key in this repository. The extraction job asks GitHub for a
// short-lived OIDC identity token and Anthropic exchanges it for an access
// token, but only if the token's claims satisfy a federation rule configured
// in the Claude Console. That rule is the entire security boundary: anything
// it matches can spend money as us.
//
// The rule lives in Anthropic's Console, where it cannot be code-reviewed and
// cannot be tested. So it is written down here as data, `FEDERATION_RULE`, and
// `evaluateMatch` below reimplements Anthropic's documented matching semantics
// so the policy can be exercised against hostile claim sets in `npm test`.
//
// This file proves nothing about the Console. It proves that the policy we
// wrote down refuses the runs it must refuse, which is the half we can check.
// Keep the two identical: docs/thesis-oidc-federation.md is what gets typed in.

export const REPOSITORY = 'Surojitc/l3vlup-skills';
export const OWNER = 'Surojitc';
export const WORKFLOW_PATH = '.github/workflows/thesis-pilot.yml';
export const BRANCH = 'main';
export const AUDIENCE = 'https://api.anthropic.com';
export const ISSUER_URL = 'https://token.actions.githubusercontent.com';

/**
 * The numeric ids GitHub puts in this repository's tokens.
 *
 * They matter twice. The `sub` claim this issuer produces carries them inline,
 * so the subject cannot be written without them. And as claims in their own
 * right they survive a rename: if the account or the repository is renamed and
 * somebody registers the old name, the names still match and the ids do not.
 */
export const REPOSITORY_ID = '1344803946';
export const OWNER_ID = '68951812';

/**
 * The `sub` claim, built the way this issuer builds it.
 *
 * Observed verbatim in Anthropic's authentication event for run 35448297026,
 * request req_011CfCwbzdMDYfwWeAUBGgd2:
 *
 *   repo:Surojitc@68951812/l3vlup-skills@1344803946:ref:refs/heads/main
 *
 * GitHub's published default is the undecorated `repo:<owner>/<repo>:ref:…`,
 * and that is what this file used to say. The rule was written against the
 * documented shape rather than the issued one and the exchange was refused
 * with `match_subject_prefix`. The decoded token in the authentication event
 * is the authority here: a `sub` is whatever the issuer puts in it, and the
 * only way to know is to read one.
 */
export const subjectFor = ({ owner = OWNER, ownerId = OWNER_ID, repo = REPOSITORY.split('/')[1], repoId = REPOSITORY_ID, trailer = `ref:refs/heads/${BRANCH}` } = {}) =>
  `repo:${owner}@${ownerId}/${repo}@${repoId}:${trailer}`;

/** The floor at which @anthropic-ai/sdk learned to federate. */
export const SDK_FEDERATION_FLOOR = '0.93.0';

/**
 * The rule, exactly as it must be entered in the Console.
 *
 * `subject_prefix` carries no trailing `*`, so it is an exact match on `sub`.
 * That alone rejects every pull-request run, whose `sub` ends `:pull_request`
 * rather than `:ref:refs/heads/main`. The `claims` entries are belt and
 * braces: `event_name` rejects a `push` that somehow reached main,
 * `workflow_ref` rejects any other workflow file in this repository, which is
 * the one restriction `sub` cannot express, and the two numeric ids reject a
 * rename-and-squat that the names alone would accept.
 */
export const FEDERATION_RULE = Object.freeze({
  name: 'l3vlup-skills-thesis-pilot',
  match: Object.freeze({
    subject_prefix: subjectFor(),
    audience: AUDIENCE,
    claims: Object.freeze({
      repository: REPOSITORY,
      repository_owner: OWNER,
      repository_id: REPOSITORY_ID,
      repository_owner_id: OWNER_ID,
      ref: `refs/heads/${BRANCH}`,
      event_name: 'workflow_dispatch',
      workflow_ref: `${REPOSITORY}/${WORKFLOW_PATH}@refs/heads/${BRANCH}`,
    }),
  }),
  oauth_scope: 'workspace:inference',
  // Longer than the job's 20-minute timeout, and deliberately so. A token that
  // expired mid-run would make the SDK re-read the identity token file and
  // exchange it again; GitHub's tokens carry a `jti`, an assertion with a
  // `jti` may be exchanged only once, and the second exchange is rejected as a
  // replay. One exchange per run is the only shape that works.
  token_lifetime_seconds: 1800,
});

/**
 * Anthropic's documented matching semantics, reimplemented.
 *
 * Every populated matcher must hold (AND). `subject_prefix` is an exact,
 * case-sensitive match on `sub` unless it ends in `*`, which makes it a
 * prefix. `audience` must appear exactly in `aud`, which may be a string or an
 * array. Each `claims` entry is an exact string match on a top-level claim.
 *
 * Returns the name of the first matcher that refused, or null if the claim set
 * is accepted.
 */
export function evaluateMatch(match, claims) {
  if (!claims || typeof claims !== 'object') return 'claims';

  if (match.subject_prefix !== undefined) {
    const sub = claims.sub;
    if (typeof sub !== 'string') return 'match_subject_prefix';
    const ok = match.subject_prefix.endsWith('*')
      ? sub.startsWith(match.subject_prefix.slice(0, -1))
      : sub === match.subject_prefix;
    if (!ok) return 'match_subject_prefix';
  }

  if (match.audience !== undefined) {
    const aud = claims.aud;
    const list = Array.isArray(aud) ? aud : [aud];
    if (!list.includes(match.audience)) return 'match_audience';
  }

  for (const [name, expected] of Object.entries(match.claims || {})) {
    if (claims[name] !== expected) return `match_claims.${name}`;
  }
  return null;
}

/** True when this claim set would be allowed to mint an Anthropic token. */
export const wouldAuthenticate = (claims, rule = FEDERATION_RULE) =>
  evaluateMatch(rule.match, claims) === null;

/** The claim set GitHub issues for the one run we intend to allow. */
export const legitimateClaims = () => ({
  iss: ISSUER_URL,
  aud: AUDIENCE,
  sub: subjectFor(),
  repository: REPOSITORY,
  repository_owner: OWNER,
  repository_id: REPOSITORY_ID,
  repository_owner_id: OWNER_ID,
  repository_visibility: 'public',
  ref: 'refs/heads/main',
  ref_type: 'branch',
  event_name: 'workflow_dispatch',
  workflow: 'Thesis pilot — extract claims from approved documents',
  workflow_ref: `${REPOSITORY}/${WORKFLOW_PATH}@refs/heads/${BRANCH}`,
  actor: 'Surojitc',
  jti: 'a-fresh-token-each-time',
});
