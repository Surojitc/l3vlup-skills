// The thesis workflow's security properties, and the sanitiser it depends on.
//
// Everything here is offline. The workflow is read as text and its rules are
// asserted; the sanitiser is driven with claims a run could actually produce,
// including the ones it must refuse.
//
//   node scripts/__tests__/thesis-publish.test.mjs

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildFailureReport, buildFeed, FAILURE_REASONS, FEED_VERSION, FORBIDDEN_PUBLISHED_FIELDS,
  HUMAN_ONLY_STATES, PUBLISHABLE_STATES, PUBLISHED_CLAIM_FIELDS, sanitiseClaim,
  serialiseFeed, validateFailureReport, validateFeed,
} from '../../lib/thesis-publish.mjs';
import { DOCUMENT_SETS, managerNames, parseArgs } from '../thesis-pilot.mjs';
import { LIMITS, PILOT_BUDGET_USD, PILOT_MODEL } from '../../lib/thesis-cost.mjs';
import { MAX_DOCUMENT_QUOTED_WORDS } from '../../lib/thesis-evidence.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WF = readFileSync(join(REPO, '.github', 'workflows', 'thesis-pilot.yml'), 'utf8');

// Every feed now has to say it read everything it selected, so the fixtures
// carry a complete coverage row for the one document they use.
const COVERAGE = [{ documentId: 'd-1', chunksPlanned: 1, chunksProcessed: 1, complete: true, reason: null }];

let passed = 0;
function test(name, fn) { fn(); passed += 1; console.log(`  ok  ${name}`); }

/** The block of YAML belonging to one job. */
function job(name) {
  const start = WF.indexOf(`\n  ${name}:\n`);
  assert.notEqual(start, -1, `there is no ${name} job`);
  const rest = WF.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][a-z0-9-]*:\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

const claim = {
  claimId: 'c-1', managerId: 'starboard-value', documentId: 'd-1', filingDate: '2026-03-11',
  kind: 'statement', stance: 'long', paraphrase: 'Margins should improve.',
  tags: ['driver.margin_inflection'], publicationState: 'needs_review',
  evidenceState: 'verified', reviewStatus: 'pending', model: PILOT_MODEL,
};
const reference = { sourceUrl: 'https://www.sec.gov/Archives/x.pdf', locator: 'page 3', excerpt: 'Margins should move from 31% to 38%', attribution: 'Starboard, 2026-03-11' };

// ── The credential ─────────────────────────────────────────────────────────

test('no secret exists: the workflow reads none and stores none', () => {
  const uses = [...WF.matchAll(/\$\{\{\s*secrets\.(\w+)\s*\}\}/g)].map((m) => m[1]);
  assert.deepEqual(uses, [], `the workflow reads a stored secret: ${uses.join(', ')}`);
  assert.ok(!/ANTHROPIC_API_KEY:\s*\$\{\{/.test(WF), 'a static key is still passed to a step');

  // Federation identifiers are not secrets; they must come from `vars`, so a
  // reviewer can read the trust boundary without Console access.
  for (const name of ['ANTHROPIC_FEDERATION_RULE_ID', 'ANTHROPIC_ORGANIZATION_ID', 'ANTHROPIC_SERVICE_ACCOUNT_ID']) {
    assert.ok(WF.includes(`${name}: \${{ vars.${name} }}`), `${name} does not come from a repository variable`);
  }

  // The credential is never echoed, written to the checkout, or sent anywhere.
  assert.ok(!/echo .*IDENTITY_TOKEN_FILE"?\s*$|cat .*identity-token/.test(WF), 'the identity token could be printed');
  assert.ok(!/ANTHROPIC_API_KEY.*>|>.*ANTHROPIC_API_KEY/.test(WF), 'a key could be written to a file');
});

test('no credential reaches a dry run, and the client fails helpfully without one', () => {
  // The dry-run step carries no key at all.
  // To the next step, not to Extract: a step inserted between them would
  // otherwise be read as part of the dry run.
  const dryStart = WF.indexOf('- name: Dry run');
  const dry = WF.slice(dryStart, WF.indexOf('\n      - name:', dryStart + 1));
  assert.ok(!dry.includes('ANTHROPIC_FEDERATION'), 'a dry run is given a credential');
  assert.ok(!dry.includes('IDENTITY_TOKEN'), 'a dry run is given an identity token');

  // And with no credential the client says what to do rather than leaking.
  const client = readFileSync(join(REPO, 'lib', 'thesis-anthropic.mjs'), 'utf8');
  assert.match(client, /no_credential/);
  assert.match(client, /reads no key of its own/);
  assert.match(client, /In CI it federates/, 'the client still advises setting a key, which would break federation');
  const code = client.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/process\.env/.test(code), 'the client reads the environment itself');
});

// ── Events and forks ───────────────────────────────────────────────────────

test('the workflow runs on nothing but a manual dispatch in this repository', () => {
  assert.match(WF, /^on:\n {2}workflow_dispatch:/m);
  for (const bad of ['schedule:', 'push:', 'pull_request:', 'pull_request_target:', 'repository_dispatch:', 'issue_comment:', 'workflow_run:', 'workflow_call:']) {
    assert.ok(!new RegExp(`^ {2}${bad.replace(':', ':')}`, 'm').test(WF), `${bad} was added`);
  }
  assert.match(job('extract'), /if: github\.event_name == 'workflow_dispatch' && github\.repository == 'Surojitc\/l3vlup-skills'/);
  assert.ok(!/fork/i.test(WF) || /github\.repository ==/.test(WF));
});

// ── Inputs ─────────────────────────────────────────────────────────────────

test('every input is a fixed dropdown, and none reaches a shell', () => {
  const on = WF.slice(WF.indexOf('on:'), WF.indexOf('concurrency:'));
  // Split on the six-space keys rather than matching them: consecutive
  // regex matches cannot both claim the newline that separates them, which
  // silently found three of the five.
  const lines = on.split('\n');
  const inputs = [];
  for (let i = 0; i < lines.length; i += 1) {
    const head = lines[i].match(/^ {6}(\w+):$/);
    if (!head) continue;
    const body = [];
    for (let j = i + 1; j < lines.length && !/^ {0,6}\S/.test(lines[j]); j += 1) body.push(lines[j]);
    inputs.push({ name: head[1], body: body.join('\n') });
  }
  assert.equal(inputs.length, 6, `${inputs.length} inputs found`);
  for (const i of inputs) {
    assert.match(i.body, /type: (choice|boolean)/, `${i.name} is not a choice or a boolean`);
    if (/type: choice/.test(i.body)) assert.match(i.body, /options:/, `${i.name} has no fixed options`);
  }
  // A choice input can only ever be one of its listed options, and a boolean
  // only true or false. There is no free text to inject with.
  assert.ok(!/type: string/.test(on), 'a free-text input was added');

  // No expression is interpolated into any run: script.
  const runBlocks = [...WF.matchAll(/\n\s+run: \|?\n([\s\S]*?)(?=\n\s+- |\n\s{2}\w|$)/g)].map((m) => m[1]);
  assert.ok(runBlocks.length >= 6, 'the run blocks were not found');
  for (const b of runBlocks) {
    const found = b.match(/\$\{\{[^}]*\}\}/);
    assert.equal(found, null, `an expression reaches a shell script: ${found?.[0]}`);
  }
  // Inputs reach the script as environment variables only.
  for (const m of WF.matchAll(/inputs\.(\w+)/g)) {
    const line = WF.slice(WF.lastIndexOf('\n', m.index) + 1, WF.indexOf('\n', m.index)).trim();
    assert.ok(/^(if:|#|[A-Z_]+:)/.test(line), `an input is used outside an if: or an env: assignment — ${line}`);
  }
});

test('an input the dropdown could not have produced resolves to nothing', () => {
  assert.deepEqual(parseArgs(['--from-env'], { DOCUMENT_SET: 'pilot-two', BUDGET_USD: '3', MODEL: PILOT_MODEL }).documents,
    ['starboard-value-2026-03-11', 'southeastern-2026-09-04']);
  for (const hostile of ['pilot-two; rm -rf /', '$(whoami)', '`id`', '../../etc/passwd', 'pilot-two\npilot-two', '__proto__', 'constructor']) {
    const out = parseArgs(['--from-env'], { DOCUMENT_SET: hostile, BUDGET_USD: '3' });
    assert.ok(out.problems.some((p) => /is not a known set/.test(p)), `${hostile} was accepted`);
    assert.deepEqual(out.documents, [], `${hostile} produced documents`);
  }
  for (const b of ['99', '-1', '0', 'free', '', undefined]) {
    assert.ok(parseArgs(['--from-env'], { DOCUMENT_SET: 'pilot-two', BUDGET_USD: b }).problems.length, `BUDGET_USD ${b} was accepted`);
  }
  assert.ok(parseArgs(['--from-env'], { DOCUMENT_SET: 'pilot-two', BUDGET_USD: '3', MODEL: 'gpt-x' }).problems.some((p) => /not on the allowlist/.test(p)));
  // The default set is the two-document pilot.
  assert.deepEqual(DOCUMENT_SETS['pilot-two'].length, 2);
  assert.match(WF, /document_set:[\s\S]*?default: 'pilot-two'/);
});

// ── Permissions ────────────────────────────────────────────────────────────

test('the job that holds the key cannot write, and the job that can write never sees it', () => {
  assert.match(WF, /^permissions:\n {2}contents: read\n/m);
  const extract = job('extract');
  assert.match(extract, /permissions:\n {6}contents: read\n/);
  assert.ok(!/contents: write|pull-requests: write/.test(extract), 'the extract job can write');
  assert.match(extract, /persist-credentials: false/);

  const open = job('open-pull-request');
  assert.match(open, /permissions:\n {6}contents: write\n {6}pull-requests: write\n/);
  for (const scope of ['packages:', 'actions: write', 'deployments:', 'id-token:', 'security-events:', 'attestations:']) {
    assert.ok(!open.includes(scope), `the pull-request job asks for ${scope}`);
  }
  assert.ok(!/thesis-pilot\.mjs/.test(open), 'the write-enabled job runs the extraction script');
  // It may name sec.gov in the pull-request body it writes; what it may not
  // do is address it.
  assert.ok(!/https?:\/\/\S*sec\.gov/.test(open), 'the write-enabled job addresses sec.gov');
  assert.ok(!/\bcurl\b|\bwget\b/.test(open), 'the write-enabled job fetches something of its own');
});

test('nothing in the workflow approves, merges, or publishes', () => {
  for (const forbidden of ['gh pr merge', 'gh pr review', '--approve', 'enable_pr_auto_merge', 'auto-merge', 'gh pr ready']) {
    assert.ok(!WF.includes(forbidden), `the workflow can ${forbidden}`);
  }
  assert.match(WF, /gh pr create --draft/, 'the generated pull request is not a draft');
});

// ── Budget ─────────────────────────────────────────────────────────────────

test('the ceilings are checked in code before anything is fetched', () => {
  const extract = job('extract');
  const guard = extract.indexOf('- name: Confirm the ceilings are still in the code');
  assert.ok(guard !== -1, 'nothing checks the ceilings');
  assert.ok(guard < extract.indexOf('- name: Extract'), 'the ceilings are checked after the fetch');
  assert.match(extract, /hardStopUsd !== 15/);
  assert.match(extract, /PILOT_BUDGET_USD !== 3/);
  assert.match(extract, /budgetUsd: 1e6 \}\)\.budgetUsd !== 15/);
  assert.match(extract, /MAX_RETRIES = 0/);
  // The dropdown cannot offer a budget over the pilot default.
  const options = WF.slice(WF.indexOf('budget_usd:'), WF.indexOf('dry_run:'));
  assert.deepEqual([...options.matchAll(/- '(\d+)'/g)].map((m) => Number(m[1])), [1, 3]);
  assert.equal(PILOT_BUDGET_USD, 3);
  assert.equal(LIMITS.hardStopUsd, 15);
});

// ── Cleanup ────────────────────────────────────────────────────────────────

test('documents, extracted text and the identity token are deleted whatever happened', () => {
  const step = WF.slice(WF.indexOf('- name: Delete every document, extracted text and identity token'));
  assert.match(step, /if: always\(\)/, 'the cleanup is conditional on success');
  assert.match(step, /letters-run-\*/);
  assert.match(step, /RUNNER_TEMP/);
  assert.match(step, /rm -rf \$leftover/, 'a surviving workspace is reported but not removed');
  assert.match(step, /pdf\|html\?\|txt\|xml/);
  assert.match(step, /exit \$status/);
  // The identity token is a live bearer credential; it goes with the rest.
  assert.match(step, /rm -f "\$\{RUNNER_TEMP:-\/tmp\}\/anthropic-identity-token"/, 'the identity token is not deleted');
  assert.match(step, /the identity token survived cleanup/, 'the deletion is not verified');
  // And it runs before the upload, so nothing unexpected can be collected.
  assert.ok(WF.indexOf('- name: Delete every document, extracted text and identity token') < WF.indexOf('- name: Upload the sanitised feed'));
  const workspace = readFileSync(join(REPO, 'lib', 'letters-workspace.mjs'), 'utf8');
  assert.match(workspace, /prefix = 'letters-run-'/, 'the prefix no longer matches the cleanup step');
});

test('the feed and the review notes leave as separate, short-lived artefacts', () => {
  const feed = WF.slice(WF.indexOf('- name: Upload the sanitised feed'), WF.indexOf('- name: Upload the review notes'));
  assert.match(feed, /name: thesis-pilot-feed/);
  assert.match(feed, /path: \.pilot\/feed\.json/, 'the feed artefact carries more than the feed');
  assert.match(feed, /retention-days: 1/);

  const review = WF.slice(WF.indexOf('- name: Upload the review notes'));
  const paths = review.slice(review.indexOf('path: |')).split('\n').slice(1).map((l) => l.trim()).filter((l) => l.startsWith('.pilot/'));
  assert.deepEqual(paths, ['.pilot/review.md', '.pilot/cost.json']);
  assert.match(review.slice(0, review.indexOf('- name:', 10) + 1), /retention-days: 1/);

  assert.ok(!WF.includes('.pilot/*') && !WF.includes('path: .pilot\n'), 'an upload uses a wildcard or a directory');

  // The write-capable job downloads the feed and only the feed, and refuses
  // an artefact carrying anything else.
  const open = job('open-pull-request');
  assert.match(open, /name: thesis-pilot-feed/);
  assert.ok(!open.includes('thesis-pilot-review'), 'the write-capable job downloads the review notes');
  assert.ok(!open.includes('review.md'), 'the write-capable job handles the review markdown');
  assert.match(open, /printf '%s\\n' feed\.json > \/tmp\/expected/);
});

// ── The sanitiser ──────────────────────────────────────────────────────────

test('a claim awaiting review is published; one a person must set is refused', () => {
  const ok = sanitiseClaim(claim, reference);
  assert.equal(ok.ok, true, JSON.stringify(ok.problems));
  assert.equal(ok.claim.publicationState, 'needs_review');
  assert.equal(ok.claim.excerpt, reference.excerpt);

  assert.equal(sanitiseClaim({ ...claim, publicationState: 'issuer_unresolved' }, reference).ok, true);
  for (const state of HUMAN_ONLY_STATES) {
    const out = sanitiseClaim({ ...claim, publicationState: state }, reference);
    assert.equal(out.ok, false, `${state} was published`);
    assert.match(out.problems[0], /only a person may set that/);
  }
  assert.equal(sanitiseClaim({ ...claim, publicationState: 'proposed' }, reference).ok, false);
  assert.match(sanitiseClaim({ ...claim, reviewStatus: 'accepted' }, reference).problems[0], /set by something other than a person/);
  assert.deepEqual(PUBLISHABLE_STATES, ['needs_review', 'issuer_unresolved']);
});

test('a prohibited field is refused by name, however it arrives', () => {
  for (const field of FORBIDDEN_PUBLISHED_FIELDS) {
    const out = sanitiseClaim({ ...claim, [field]: 'x' }, reference);
    assert.equal(out.ok, false, `${field} was published`);
    assert.ok(out.problems.some((p) => p.startsWith(field)), `${field} was refused for the wrong reason`);
  }
  // And a field nobody thought of is dropped rather than carried.
  const out = sanitiseClaim({ ...claim, somethingNew: 'x' }, reference);
  assert.equal(out.ok, true);
  assert.equal(out.claim.somethingNew, undefined, 'an unknown field survived');
  for (const f of Object.keys(out.claim)) assert.ok(PUBLISHED_CLAIM_FIELDS.includes(f), `${f} is not a published field`);
});

test('quotation caps hold on the way out, per excerpt and per document', () => {
  const long = Array.from({ length: 40 }, (_, i) => `w${i}`).join(' ');
  assert.match(sanitiseClaim(claim, { ...reference, excerpt: long }).problems[0], /over the 25-word cap/);
  assert.match(sanitiseClaim(claim, { ...reference, excerpt: 'x'.repeat(300) }).problems[0], /over the 200-character cap/);
  for (const kind of ['inference', 'filing']) {
    assert.match(sanitiseClaim({ ...claim, kind }, reference).problems[0], new RegExp(`a ${kind} may never carry an excerpt`));
  }
  // The cumulative cap is applied across the feed, not per claim.
  const many = Array.from({ length: 6 }, (_, i) => ({ ...claim, claimId: `c-${i}` }));
  const refs = new Map(many.map((c) => [c.claimId, { ...reference, excerpt: 'one two three four five six seven eight nine ten' }]));
  const feed = buildFeed({ claims: many, references: refs, model: PILOT_MODEL, promptVersion: 'v1', coverage: COVERAGE });
  assert.ok(feed.refused.some((r) => /cumulative cap/.test(r.problems.join(' '))), `${MAX_DOCUMENT_QUOTED_WORDS}-word cap not enforced across the feed`);
});

test('the feed carries no source text, is ordered, and is re-checked on the way in', () => {
  const feed = buildFeed({
    coverage: COVERAGE,
    claims: [{ ...claim, claimId: 'c-b' }, { ...claim, claimId: 'c-a' }],
    references: new Map([['c-a', reference], ['c-b', reference]]),
    dropped: [{ chunkId: 'k1', reason: 'evidence: the excerpt does not occur in the source', paraphrase: 'LEAK' }],
    stripped: [{ chunkId: 'k1', field: 'ticker', reason: 'a ticker comes from the security master' }],
    ledger: { estimatedUsd: 0.02, actualUsd: 0.018, budgetUsd: 3, calls: [{ documentId: 'd-1', chunkId: 'k1', model: PILOT_MODEL, inputTokens: 100, outputTokens: 20, actualUsd: 0.0002 }] },
    model: PILOT_MODEL, promptVersion: 'thesis-extract-v1',
  });
  assert.deepEqual(feed.claims.map((c) => c.claimId), ['c-a', 'c-b'], 'the feed is not ordered');
  assert.deepEqual(validateFeed(feed), []);
  assert.equal(feed.feedVersion, FEED_VERSION);
  // A dropped row carries its reason and nothing else.
  assert.deepEqual(Object.keys(feed.dropped[0]).sort(), ['chunkId', 'reason']);
  assert.ok(!serialiseFeed(feed).includes('LEAK'), 'a dropped claim carried its text into the feed');
  // Two builds of the same input are byte-identical.
  assert.equal(serialiseFeed(feed), serialiseFeed(buildFeed({
    coverage: COVERAGE,
    claims: [{ ...claim, claimId: 'c-a' }, { ...claim, claimId: 'c-b' }],
    references: new Map([['c-a', reference], ['c-b', reference]]),
    dropped: [{ chunkId: 'k1', reason: 'evidence: the excerpt does not occur in the source', paraphrase: 'LEAK' }],
    stripped: [{ chunkId: 'k1', field: 'ticker', reason: 'a ticker comes from the security master' }],
    ledger: { estimatedUsd: 0.02, actualUsd: 0.018, budgetUsd: 3, calls: [{ documentId: 'd-1', chunkId: 'k1', model: PILOT_MODEL, inputTokens: 100, outputTokens: 20, actualUsd: 0.0002 }] },
    model: PILOT_MODEL, promptVersion: 'thesis-extract-v1',
  })));
});

test('a feed that arrives carrying anything forbidden is refused', () => {
  const good = buildFeed({ claims: [claim], references: new Map([['c-1', reference]]), model: PILOT_MODEL, promptVersion: 'v1', coverage: COVERAGE });
  assert.deepEqual(validateFeed(good), []);

  assert.ok(validateFeed({ ...good, feedVersion: 99 }).some((p) => /feedVersion/.test(p)));
  assert.ok(validateFeed({ ...good, claims: [{ ...good.claims[0], publicationState: 'published' }] }).some((p) => /not a state a workflow may hand over/.test(p)));
  assert.ok(validateFeed({ ...good, claims: [{ ...good.claims[0], sourceText: 'the whole letter' }] }).some((p) => /sourceText may never be published/.test(p)));
  assert.ok(validateFeed({ ...good, cost: { prompt: 'the system prompt' } }).some((p) => /prompt may never be published/.test(p)));
  assert.ok(validateFeed({ ...good, claims: [{ ...good.claims[0], kind: 'inference' }] }).some((p) => /carries an excerpt/.test(p)));
  assert.ok(validateFeed({ ...good, quotedWordsByDocument: { 'd-1': 500 } }).some((p) => /over the cumulative cap/.test(p)));
  assert.ok(validateFeed(null).length);
  assert.ok(validateFeed({ feedVersion: FEED_VERSION }).some((p) => /no claims array/.test(p)));
});

test('the feed checker is run by both jobs, and exits non-zero on a bad feed', () => {
  assert.equal((WF.match(/thesis-feed-check\.mjs/g) || []).length, 2, 'the feed is not checked twice');
  const checker = readFileSync(join(REPO, 'scripts', 'thesis-feed-check.mjs'), 'utf8');
  assert.match(checker, /process\.exit\(1\)/);
  assert.match(checker, /validateFeed/);
  // The extract job checks before uploading; the PR job before committing.
  const extract = job('extract');
  assert.ok(extract.indexOf('thesis-feed-check') < extract.indexOf('- name: Upload the sanitised feed'));
  const open = job('open-pull-request');
  assert.ok(open.indexOf('thesis-feed-check') < open.indexOf('git checkout -b'));
});

test('every action is pinned to a full commit SHA', () => {
  const uses = [...WF.matchAll(/uses: (\S+)/g)].map((m) => m[1]);
  assert.ok(uses.length >= 4);
  for (const u of uses) assert.match(u, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, `${u} is not pinned`);
  for (const line of WF.split('\n').filter((l) => l.includes('uses:'))) assert.match(line, /# v\d/, `${line.trim()} does not name its version`);
});

test('the pull request job stages before asking whether anything changed', () => {
  // The feed is a new, untracked file on the first run, and `git diff` does
  // not see one of those. Checking before staging made the very first pilot
  // finish with no pull request at all.
  const open = job('open-pull-request');
  const add = open.indexOf('git add data/thesis/claims.pending.json');
  const check = open.indexOf('git diff --cached --quiet;');
  assert.ok(add > -1, 'the feed is never staged');
  assert.ok(check > -1, 'the change check does not read the index');
  assert.ok(add < check, 'the change is checked before it is staged');
  assert.ok(!/git diff --quiet -- data\/thesis/.test(open), 'the working-tree check is still there and cannot see a new file');
});

test('a quotation is attributed to the manager by name, never by slug', () => {
  const pilot = readFileSync(join(REPO, 'scripts', 'thesis-pilot.mjs'), 'utf8');
  assert.ok(!/attribution: [^\n]*managerId/.test(pilot), 'attribution is built from the slug');
  assert.match(pilot, /attribution: [^\n]*managerName/);
  assert.ok(PUBLISHED_CLAIM_FIELDS.includes('managerName'), 'the feed cannot carry the manager name');

  // The mapping exists for every fund the selection can draw on.
  const sources = JSON.parse(readFileSync(join(REPO, 'data', 'letters.sources.json'), 'utf8'));
  const names = managerNames(sources);
  const selection = JSON.parse(readFileSync(join(REPO, 'data', 'letters.selection.json'), 'utf8')).selection;
  for (const d of selection) {
    const name = names.get(d.fund);
    assert.ok(name && name !== d.fund, `${d.fund} has no legal name to attribute a quotation to`);
  }
});

// ── A run that did not finish ───────────────────────────────────────────────

test('a failed run reports its cost and nothing else', () => {
  const ledger = {
    estimatedUsd: 0.0512, actualUsd: 0.0447, budgetUsd: 3, stopped: false, stopReason: null,
    calls: [{ documentId: 'd-1', chunkId: 'c-1', model: PILOT_MODEL, inputTokens: 2500, outputTokens: 8000, estimatedUsd: 0.0512, actualUsd: 0.0447 }],
  };
  const r = buildFailureReport({ reason: 'truncated', detail: 'the answer hit max_tokens', ledger, model: PILOT_MODEL, documentsAttempted: 1 });
  assert.deepEqual(validateFailureReport(r), []);
  assert.equal(r.failed, true);
  assert.equal(r.reason, 'truncated');
  assert.equal(r.cost.actualUsd, 0.0447);
  assert.equal(r.cost.calls.length, 1);
  assert.equal(r.documentsAttempted, 1);
  // The per-call record is identifiers and numbers only.
  for (const k of Object.keys(r.cost.calls[0])) {
    assert.ok(['documentId', 'chunkId', 'model', 'inputTokens', 'outputTokens', 'estimatedUsd', 'actualUsd'].includes(k), `${k} rides along in a call record`);
  }
});

test('a failure report may not carry claims, text, quotations or a feed', () => {
  const base = buildFailureReport({ reason: 'truncated', ledger: {} });
  for (const leak of [
    { claims: [{ paraphrase: 'x' }] },
    { proposals: [{ evidenceExcerpt: 'a verbatim run of the letter' }] },
    { refused: [] }, { dropped: [] }, { stripped: [] },
    { quotedWordsByDocument: { 'd-1': 12 } },
    { sourceText: 'the whole letter' },
    { rawResponse: 'the partial tool input' },
    { prompt: 'the extraction recipe' },
    { cost: { calls: [{ chunkText: 'a passage' }] } },
  ]) {
    const problems = validateFailureReport({ ...base, ...leak });
    assert.ok(problems.length, `${Object.keys(leak)[0]} was accepted into a failure report`);
  }
});

test('a failure reason is snapped to a known vocabulary, and the detail is bounded', () => {
  // A reason we do not recognise becomes `unknown` rather than travelling
  // whatever string threw it, which could be a model's or a document's words.
  assert.equal(buildFailureReport({ reason: 'something the model said', ledger: {} }).reason, 'unknown');
  for (const r of FAILURE_REASONS) assert.equal(buildFailureReport({ reason: r, ledger: {} }).reason, r);
  const long = buildFailureReport({ reason: 'truncated', detail: 'x'.repeat(5000), ledger: {} });
  assert.equal(long.detail.length, 200);
  assert.deepEqual(validateFailureReport(long), []);
  assert.ok(validateFailureReport({ ...long, detail: 'x'.repeat(201) }).length);
});

test('the failure artefact waits for a clean cleanup, and carries one file', () => {
  const extract = job('extract');
  // The cleanup says whether it actually succeeded...
  assert.match(extract, /id: cleanup/);
  assert.match(extract, /echo "clean=\$\(\[ "\$status" -eq 0 \]/);
  // ...and both failure steps wait on that, so a surviving workspace or
  // identity token means nothing leaves the runner.
  const checks = [...extract.matchAll(/steps\.cleanup\.outputs\.clean == 'true'/g)];
  assert.equal(checks.length, 2, 'a failure step does not wait for a clean cleanup');
  const upload = extract.slice(extract.indexOf("- name: Upload the failed run's cost report"));
  assert.match(upload, /name: thesis-pilot-failure/);
  assert.match(upload, /path: \.pilot\/failure\.json/, 'the failure artefact carries more than the cost report');
  assert.match(upload, /retention-days: 1/);
  assert.match(extract, /failure\(\) && !inputs\.dry_run && !inputs\.auth_check_only/);
  // It is checked before it is uploaded, by the same validator the library uses.
  assert.ok(extract.indexOf('thesis-failure-check.mjs') < extract.indexOf('name: thesis-pilot-failure'));
  // And the write-capable job never sees it.
  assert.ok(!job('open-pull-request').includes('thesis-pilot-failure'));
});

test('a cleanup that failed reports it, so nothing is uploaded after it', () => {
  // The gate is only as good as the line that sets it, so run that line.
  const line = 'echo "clean=$([ "$status" -eq 0 ] && echo true || echo false)"';
  const run = (status) => execFileSync('bash', ['-c', `status=${status}; ${line}`], { encoding: 'utf8' }).trim();
  assert.equal(run(0), 'clean=true');
  assert.equal(run(1), 'clean=false', 'a failed cleanup would still let the artefact out');

  // And the line is the one the workflow actually runs.
  const extract = job('extract');
  assert.ok(extract.includes(line.replace('echo "clean=', 'echo "clean=')), 'the workflow sets the flag some other way');
  // The cleanup still fails the job: reporting is not the same as forgiving.
  assert.match(extract, /exit \$status/);
  const cleanup = extract.slice(extract.indexOf('- name: Delete every document'));
  assert.ok(cleanup.indexOf('clean=') < cleanup.indexOf('exit $status'), 'the flag is written after the job has already exited');
});

console.log(`${passed} passed`);
