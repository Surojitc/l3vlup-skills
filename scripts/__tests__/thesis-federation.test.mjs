// What the federation rule must refuse.
//
// The rule itself lives in the Claude Console, where it cannot be reviewed in
// a diff or exercised in CI. lib/thesis-federation.mjs writes it down as data
// and reimplements Anthropic's documented matching semantics; this suite runs
// hostile claim sets against it.
//
// A failure here means the policy in docs/thesis-oidc-federation.md would let
// something authenticate that must not. It does not prove the Console matches
// what is written down: that is checked once, by hand, against the Console's
// authentication history.
//
//   node scripts/__tests__/thesis-federation.test.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AUDIENCE, BRANCH, evaluateMatch, FEDERATION_RULE, ISSUER_URL, legitimateClaims,
  REPOSITORY, SDK_FEDERATION_FLOOR, WORKFLOW_PATH, wouldAuthenticate,
} from '../../lib/thesis-federation.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WF = readFileSync(join(REPO, '.github', 'workflows', 'thesis-pilot.yml'), 'utf8');
const DOC = readFileSync(join(REPO, 'docs', 'thesis-oidc-federation.md'), 'utf8');

let passed = 0;
function test(name, fn) { fn(); passed += 1; console.log(`  ok  ${name}`); }

const job = (name) => {
  const start = WF.indexOf(`\n  ${name}:`);
  const rest = WF.slice(start + 1);
  const next = rest.search(/\n  [a-z][\w-]*:\n/);
  return next === -1 ? rest : rest.slice(0, next);
};

// Comments in this workflow explain the absences they describe, so a plain
// search for "id-token" finds the sentence saying there is none. Assert about
// the YAML, not the prose.
const code = (text) => text.split('\n').map((l) => l.replace(/(^|\s)#.*$/, '')).join('\n');

// ── The one run we mean to allow ───────────────────────────────────────────

test('the intended run authenticates', () => {
  assert.equal(wouldAuthenticate(legitimateClaims()), true,
    `the legitimate run is refused by ${evaluateMatch(FEDERATION_RULE.match, legitimateClaims())}`);
});

// ── Everything else must not ───────────────────────────────────────────────

const refused = [
  ['another repository owned by someone else', { sub: 'repo:attacker/l3vlup-skills:ref:refs/heads/main', repository: 'attacker/l3vlup-skills', repository_owner: 'attacker' }],
  ['another repository under the same owner', { sub: `repo:${REPOSITORY.split('/')[0]}/L3vlup:ref:refs/heads/main`, repository: `${REPOSITORY.split('/')[0]}/L3vlup`, workflow_ref: `${REPOSITORY.split('/')[0]}/L3vlup/${WORKFLOW_PATH}@refs/heads/main` }],
  ['a feature branch', { sub: `repo:${REPOSITORY}:ref:refs/heads/letters-thesis-oidc`, ref: 'refs/heads/letters-thesis-oidc', workflow_ref: `${REPOSITORY}/${WORKFLOW_PATH}@refs/heads/letters-thesis-oidc` }],
  ['a tag', { sub: `repo:${REPOSITORY}:ref:refs/tags/v1`, ref: 'refs/tags/v1', ref_type: 'tag' }],
  ['a pull request', { sub: `repo:${REPOSITORY}:pull_request`, event_name: 'pull_request', ref: 'refs/pull/7/merge' }],
  ['a pull request from a fork', { sub: `repo:${REPOSITORY}:pull_request`, event_name: 'pull_request', actor: 'a-stranger', ref: 'refs/pull/9/merge' }],
  ['a different workflow file in this repository', { workflow_ref: `${REPOSITORY}/.github/workflows/parse-letters.yml@refs/heads/main`, workflow: 'Parse letters' }],
  ['a workflow file in a subdirectory with a similar name', { workflow_ref: `${REPOSITORY}/.github/workflows/nested/thesis-pilot.yml@refs/heads/main` }],
  ['a push to main rather than a manual dispatch', { event_name: 'push' }],
  ['a schedule', { event_name: 'schedule' }],
  ['a repository_dispatch', { event_name: 'repository_dispatch' }],
  ['a workflow_run triggered by something else', { event_name: 'workflow_run' }],
  ['a deployment environment', { sub: `repo:${REPOSITORY}:environment:production`, event_name: 'deployment' }],
  ['a token minted for a different audience', { aud: 'https://sts.amazonaws.com' }],
  ['a token with no audience at all', { aud: undefined }],
  ['a token with no subject', { sub: undefined }],
];

for (const [what, patch] of refused) {
  test(`${what} is refused`, () => {
    const claims = { ...legitimateClaims(), ...patch };
    const reason = evaluateMatch(FEDERATION_RULE.match, claims);
    assert.notEqual(reason, null, `${what} would have been allowed to mint a token`);
    assert.equal(wouldAuthenticate(claims), false);
  });
}

test('a claim set is refused when a required claim is missing entirely', () => {
  // A rule entry compares against `undefined` when the claim is absent, which
  // must not read as a match.
  for (const name of Object.keys(FEDERATION_RULE.match.claims)) {
    const claims = { ...legitimateClaims() };
    delete claims[name];
    assert.equal(wouldAuthenticate(claims), false, `a token missing ${name} authenticated`);
  }
});

test('case matters, and a prefix of the repository name is not the repository', () => {
  assert.equal(wouldAuthenticate({ ...legitimateClaims(), sub: `repo:${REPOSITORY.toLowerCase()}:ref:refs/heads/MAIN` }), false);
  assert.equal(wouldAuthenticate({ ...legitimateClaims(), repository: `${REPOSITORY}-evil` }), false);
  assert.equal(wouldAuthenticate({ ...legitimateClaims(), sub: `repo:${REPOSITORY}-evil:ref:refs/heads/main` }), false);
});

// ── The rule's own shape ───────────────────────────────────────────────────

test('the subject is pinned exactly, never by wildcard', () => {
  // A trailing `*` would also match `:pull_request`, including runs from forks.
  assert.ok(!FEDERATION_RULE.match.subject_prefix.endsWith('*'),
    'the subject is a wildcard; a pull request from a fork would match');
  assert.equal(FEDERATION_RULE.match.subject_prefix, `repo:${REPOSITORY}:ref:refs/heads/${BRANCH}`);
});

test('the rule grants the least scope the pipeline can work with', () => {
  // The pipeline calls messages.create and models.retrieve, both of which
  // workspace:inference covers. It never touches Files or Skills, so
  // workspace:developer would be more than it needs.
  assert.equal(FEDERATION_RULE.oauth_scope, 'workspace:inference');
  const client = readFileSync(join(REPO, 'lib', 'thesis-anthropic.mjs'), 'utf8');
  const calls = [...client.matchAll(/client\.(\w+)\.(\w+)\(/g)].map((m) => `${m[1]}.${m[2]}`);
  const covered = new Set(['messages.create', 'models.retrieve', 'models.list', 'messages.countTokens']);
  for (const call of calls) {
    assert.ok(covered.has(call), `${call} is outside workspace:inference; the scope must be widened deliberately`);
  }
});

test('the token outlives the job, because it can only be minted once', () => {
  const timeout = Number(/timeout-minutes: (\d+)/.exec(job('extract'))[1]);
  assert.ok(FEDERATION_RULE.token_lifetime_seconds > timeout * 60,
    'the access token expires before the job can, and the refresh would replay a spent jti');
  assert.ok(FEDERATION_RULE.token_lifetime_seconds <= 3600, 'the token lives longer than an hour');
});

// ── The workflow side ──────────────────────────────────────────────────────

test('only the extraction job may ask GitHub for an identity', () => {
  assert.ok(!/^permissions:\n(?:  .*\n)*?  id-token:/m.test(code(WF)),
    'id-token is granted at the workflow level, so every job would hold it');
  assert.match(job('extract'), /id-token: write/);
  const open = code(job('open-pull-request'));
  assert.ok(!open.includes('id-token'), 'the job that can write may ask for an identity token');
  assert.ok(!open.includes('ANTHROPIC'), 'the job that can write is given an Anthropic credential');
  assert.ok(!open.includes('ACTIONS_ID_TOKEN_REQUEST'), 'the job that can write reaches the token endpoint');
});

test('the identity token is fetched into the runner temp, never the checkout', () => {
  const extract = job('extract');
  assert.match(extract, /ACTIONS_ID_TOKEN_REQUEST_URL/);
  assert.match(extract, /audience=https:\/\/api\.anthropic\.com/, 'the token is minted for the wrong audience');
  assert.match(extract, /runner\.temp \}\}\/anthropic-identity-token/);
  assert.ok(!/ANTHROPIC_IDENTITY_TOKEN:/.test(WF), 'the JWT is passed through the environment rather than a file');
  // Fetched before the extraction, and only on a real run.
  assert.ok(extract.indexOf('Ask GitHub who this workflow run is') < extract.indexOf('- name: Extract'));
});

test('a static credential in the environment stops the run', () => {
  // An API key, even an empty one, outranks federation in the SDK's credential
  // order, so the run would authenticate as something other than this workflow.
  const extract = job('extract');
  for (const name of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_PROFILE']) {
    assert.ok(extract.includes(name), `${name} is not checked for before the run`);
  }
  assert.match(extract, /would shadow the federated credential/);
});

test('the pinned SDK is new enough to federate', () => {
  const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
  const pinned = (pkg.dependencies?.['@anthropic-ai/sdk'] || pkg.devDependencies?.['@anthropic-ai/sdk'] || '').replace(/^[^\d]*/, '');
  const num = (v) => v.split('.').map(Number).reduce((a, n) => a * 10000 + n, 0);
  assert.ok(num(pinned) >= num(SDK_FEDERATION_FLOOR),
    `@anthropic-ai/sdk ${pinned} predates federation (${SDK_FEDERATION_FLOOR})`);
  assert.match(WF, /predates workload identity federation/, 'the workflow does not check the floor itself');
});

// ── The written-down policy and the documented one agree ───────────────────

test('the documentation states the same rule the tests exercise', () => {
  for (const value of [
    FEDERATION_RULE.match.subject_prefix,
    FEDERATION_RULE.match.claims.workflow_ref,
    FEDERATION_RULE.match.claims.event_name,
    FEDERATION_RULE.oauth_scope,
    String(FEDERATION_RULE.token_lifetime_seconds),
    ISSUER_URL,
    AUDIENCE,
  ]) {
    assert.ok(DOC.includes(value), `the setup document does not state ${value}`);
  }
  // The document names the `sk-ant-oat01-` prefix when describing what the
  // exchange returns; what must not appear is a credential's worth of
  // characters after one of these prefixes.
  assert.ok(!/sk-ant-[A-Za-z0-9_-]{20,}/.test(DOC), 'the document contains something shaped like a key');
  assert.ok(!/\b(fdrl|svac|fdis|wrkspc)_[A-Za-z0-9]{10,}/.test(DOC), 'the document contains a real resource id rather than a placeholder');
});

console.log(`${passed} passed`);
