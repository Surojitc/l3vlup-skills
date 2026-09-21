/**
 * Which job in this repository may write, and which may open or merge a pull
 * request.
 *
 *   node scripts/__tests__/workflow-permissions.test.mjs
 *
 * WHY THIS EXISTS
 * ---------------
 * A ruleset closed direct pushes to `main` on 18 September, and the answer
 * was to let the daily collection open a pull request like everyone else.
 * That answer is only safe while the token that can open and merge one is
 * held by a job that reads nothing from the outside world. The collection
 * fetches ninety-odd careers boards and parses whatever comes back; the
 * letters and thesis workflows fetch documents and call a model. None of
 * those jobs may hold a token that can write to `main` by any route.
 *
 * That separation lives in five YAML files, and nothing in YAML enforces it.
 * A job added next year with no `permissions:` block inherits the repository
 * default, which is a setting in a web form that nobody reviewing a diff will
 * see. So the split is asserted here instead, as a list: these three jobs may
 * open a pull request, this one may merge one, and every other job in the
 * repository may not. Adding a job to either list is then a visible, arguable
 * line in a diff rather than a silence.
 *
 * The parser below understands the subset of YAML these files are written in
 * and nothing more. It is checked against a list of jobs it must find, so a
 * reformatting that defeats it fails the suite rather than passing it vacuously.
 */

import { readFileSync, readdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

const DIR = '.github/workflows';

let pass = 0;
let fail = 0;
const check = (name, cond, detail) => {
  if (cond) {
    pass += 1;
    console.log(`PASS  ${name}`);
  } else {
    fail += 1;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
};
const eq = (name, got, want) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

// ── the subset of YAML these files are written in ────────────────────────

const indentOf = (line) => line.length - line.trimStart().length;
const isSkippable = (line) => line.trim() === '' || line.trimStart().startsWith('#');

/** The lines under `key:` at column 0, up to the next key at column 0. */
function topBlock(lines, key) {
  const start = lines.findIndex((l) => l === `${key}:` || l.startsWith(`${key}:`));
  if (start === -1) return null;
  const body = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (isSkippable(line)) continue;
    if (indentOf(line) === 0) break;
    body.push(line);
  }
  return body;
}

/** `{ contents: 'write', ... }` from the lines under a `permissions:` key. */
function permissionsUnder(body, keyIndent) {
  // `permissions: {}` grants nothing and is the right thing for a job that
  // only reads a step output. It is a block, not an absence.
  if (body.some((l) => indentOf(l) === keyIndent && l.trim() === 'permissions: {}')) return {};
  const at = body.findIndex((l) => indentOf(l) === keyIndent && l.trim() === 'permissions:');
  if (at === -1) return null;
  const out = {};
  for (let i = at + 1; i < body.length; i += 1) {
    if (isSkippable(body[i])) continue;
    if (indentOf(body[i]) <= keyIndent) break;
    const m = body[i].trim().match(/^([a-z-]+):\s*(read|write|none)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/** Every `run: |` script in a block, as text. */
function runScripts(body) {
  const out = [];
  for (let i = 0; i < body.length; i += 1) {
    const m = body[i].match(/^(\s*)run:\s*\|/);
    if (!m) continue;
    const indent = m[1].length;
    const script = [];
    for (let j = i + 1; j < body.length; j += 1) {
      if (body[j].trim() === '') { script.push(''); continue; }
      if (indentOf(body[j]) <= indent) break;
      script.push(body[j]);
    }
    out.push(script.join('\n'));
  }
  return out;
}

function readWorkflow(file) {
  const text = readFileSync(join(DIR, file), 'utf8');
  const lines = text.split('\n');
  const jobsBody = topBlock(lines, 'jobs') ?? [];
  const jobs = [];
  for (let i = 0; i < jobsBody.length; i += 1) {
    const m = jobsBody[i].match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
    if (!m) continue;
    const body = [];
    for (let j = i + 1; j < jobsBody.length; j += 1) {
      if (/^ {2}[A-Za-z0-9_-]+:\s*$/.test(jobsBody[j])) break;
      body.push(jobsBody[j]);
    }
    const uses = body.find((l) => /^ {4}uses:/.test(l));
    jobs.push({
      name: m[1],
      body,
      permissions: permissionsUnder(body, 4),
      scripts: runScripts(body),
      uses: uses ? uses.split('uses:')[1].trim() : null,
    });
  }
  return {
    file,
    text,
    lines,
    top: permissionsUnder(lines.filter((l) => indentOf(l) === 0 || indentOf(l) === 2), 0),
    jobs,
  };
}

const files = readdirSync(DIR).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml')).sort();
const workflows = files.map(readWorkflow);

// The parser is only worth anything if it sees what is actually there.
eq('every workflow in the directory is read', files, [
  'build-samples.yml',
  'collect.yml',
  'discover-ats.yml',
  'letters-parse.yml',
  'publish-data.yml',
  'thesis-pilot.yml',
]);
const allJobs = workflows.flatMap((w) => w.jobs.map((j) => `${w.file}:${j.name}`));
eq('every job is found, and none has been renamed out from under this test', allJobs.sort(), [
  'build-samples.yml:collect',
  'build-samples.yml:health',
  'build-samples.yml:publish',
  'collect.yml:collect',
  'collect.yml:health',
  'collect.yml:notify',
  'collect.yml:publish',
  'discover-ats.yml:discover',
  'discover-ats.yml:publish',
  'letters-parse.yml:open-pull-request',
  'letters-parse.yml:parse',
  'publish-data.yml:publish',
  'thesis-pilot.yml:extract',
  'thesis-pilot.yml:open-pull-request',
]);

// ── 1. no workflow leaves its floor to a repository setting ──────────────
// The setting is a web form. A job with no `permissions:` of its own inherits
// whatever it says, which is invisible in a diff and invisible in review.
// publish-data.yml is the one exception, and it is an exception on purpose: a
// called workflow may only narrow what its caller granted, so a block there
// would read as a self-granted right to write and act as a floor. Its
// permissions come from the three calling jobs, asserted below. Everything
// else in the directory states its own floor rather than inheriting a
// repository setting that appears in no diff.
const REUSABLE = 'publish-data.yml';
for (const w of workflows) {
  if (w.file === REUSABLE) {
    check(`${w.file} is called, never triggered`, /^on:\n {2}workflow_call:/m.test(w.text));
    check(`${w.file} declares no permissions of its own`, w.top === null && w.jobs.every((j) => j.permissions === null));
    continue;
  }
  check(`${w.file} states a top-level permissions block`, w.top !== null && Object.keys(w.top).length > 0);
  check(
    `${w.file}'s top-level block grants no write`,
    w.top !== null && Object.values(w.top).every((v) => v !== 'write'),
    JSON.stringify(w.top),
  );
}

// ── 2. the two lists ─────────────────────────────────────────────────────
const holding = (scope) =>
  workflows
    .flatMap((w) => w.jobs.map((j) => ({ id: `${w.file}:${j.name}`, p: j.permissions ?? w.top ?? {} })))
    .filter((j) => j.p[scope] === 'write')
    .map((j) => j.id)
    .sort();

eq('exactly five jobs in this repository may open a pull request', holding('pull-requests'), [
  'build-samples.yml:publish',
  'collect.yml:publish',
  'discover-ats.yml:publish',
  'letters-parse.yml:open-pull-request',
  'thesis-pilot.yml:open-pull-request',
]);
eq('exactly the same five may write to the repository at all', holding('contents'), [
  'build-samples.yml:publish',
  'collect.yml:publish',
  'discover-ats.yml:publish',
  'letters-parse.yml:open-pull-request',
  'thesis-pilot.yml:open-pull-request',
]);
// The three that publish data do nothing themselves: they are a `uses:` and a
// grant. A step added to one of them would be a step running with the only
// token in the repository that can merge.
for (const id of ['collect.yml:publish', 'discover-ats.yml:publish']) {
  const [file, name] = id.split(':');
  const job = workflows.find((w) => w.file === file).jobs.find((j) => j.name === name);
  eq(`${id} calls the shared publisher and nothing else`, job.uses, `./.github/workflows/${REUSABLE}`);
  eq(`${id} runs no steps of its own`, job.scripts, []);
  eq(`${id} grants exactly what publication needs`, job.permissions, { contents: 'write', 'pull-requests': 'write' });
}
eq('only the thesis extractor may ask GitHub who it is', holding('id-token'), ['thesis-pilot.yml:extract']);

// ── 3. nothing that reads the outside world may open a pull request ──────
// The jobs that fetch a careers board, a filing or a letter, and the one that
// calls a model. Whatever any of them reads, none can act on `main`.
const READS_THE_WORLD = [/sync-ats\.mjs/, /discover-ats\.mjs/, /sync-calendar\.mjs/, /firecrawl/i, /anthropic/i, /thesis-extract\.mjs/, /retrieve-letters\.mjs/, /company-profile/, /sync_econ\.py/];
for (const w of workflows) {
  for (const job of w.jobs) {
    const body = job.body.join('\n');
    if (!READS_THE_WORLD.some((r) => r.test(body))) continue;
    const p = job.permissions ?? w.top ?? {};
    check(`${w.file}:${job.name} reads the outside world and cannot open a pull request`, p['pull-requests'] !== 'write');
  }
}

// ── 4. merging ───────────────────────────────────────────────────────────
const merges = workflows
  .flatMap((w) => w.jobs.map((j) => ({ id: `${w.file}:${j.name}`, text: j.scripts.join('\n') })))
  .filter((j) => /gh pr merge/.test(j.text))
  .map((j) => j.id);
// TWO, for the length of the migration and no longer. build-samples keeps
// its proven inline publisher until PR D, which is the deliberate cost of
// not switching every producer at once. PR D deletes the inline one and this
// list goes back to a single entry.
eq('two publishers can merge during the migration, and they are these', merges, ['build-samples.yml:publish', 'publish-data.yml:publish']);
// Against what the runner executes, not against the prose: these files
// explain the ruleset at length in comments, and a comment cannot call an API.
const executable = (w) =>
  w.jobs
    .flatMap((j) => j.scripts)
    .join('\n')
    .split('\n')
    .filter((l) => !l.trim().startsWith('#'))
    .join('\n');

for (const w of workflows) {
  const runs = executable(w);
  for (const [what, forbidden] of [
    ['approve a review', /gh pr review|--approve\b/],
    ['reach the review API', /pull_request_review|\/reviews\b/],
    ['touch a ruleset or a branch protection', /rulesets?\b|branch-protection|\/protection\b/],
    ['grant itself a bypass', /bypass/i],
  ]) {
    check(`nothing in ${w.file} tries to ${what}`, !forbidden.test(runs), runs.match(forbidden)?.[0]);
  }
  // The only credential any of this may use is the one GitHub mints for the
  // run. A PAT or an app installation token would carry a person's rights
  // into a machine's hands, and a ruleset cannot tell the difference.
  const tokens = Array.from(w.text.matchAll(/^\s*(?:GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN):\s*(.+)$/gm)).map((m) => m[1].trim());
  check(
    `${w.file} authenticates as the run and nothing else`,
    tokens.every((t) => t === '${{ secrets.GITHUB_TOKEN }}' || t === '${{ github.token }}'),
    tokens.join(' | '),
  );
  check(`${w.file} runs on no trigger that carries a stranger's code`, !/pull_request_target:|issue_comment:|^\s*pull_request:/m.test(w.text));
}

// ── 4b. the run's conclusion, and the sweep behind it ───────────────────
// A stale required source must not stop a healthy one publishing, and must
// not let the morning report success either, so this runs after publication
// and fails the run rather than gating it.
for (const file of ['build-samples.yml', 'collect.yml']) {
  const w = workflows.find((x) => x.file === file);
  const health = w.jobs.find((j) => j.name === 'health');
  if (!health) {
    check(`${file} has a health job`, false, 'the run has no way to report a stale source');
    continue;
  }
  eq(`${file}:health holds no token at all`, health.permissions, {});
  check(`${file}:health runs even when publication did not`, /if: always\(\)/.test(health.body.join('\n')));
  check(`${file}:health fails the run on a stale required source`, /BLOCKING[\s\S]*?= "true"[\s\S]*?exit 1/.test(health.scripts.join('\n')));
  check(`${file}:health publishes nothing and merges nothing`, !/gh pr |git push/.test(health.scripts.join('\n')));

  const collect = w.jobs.find((j) => j.name === 'collect');
  const cb = collect.body.join('\n');
  check(`${file} sweeps every source it owns`, /check-freshness\.mjs/.test(cb));
  check(`${file} writes the freshness table where an operator will see it`, /--summary "\$GITHUB_STEP_SUMMARY"/.test(cb));
  check(`${file} never lets the sweep itself fail the collection`, !/check-freshness[\s\S]{0,240}?exit 1/.test(cb));
  check(`${file} publishes the verdict for the health job to read`, /blocking: \$\{\{ steps\.freshness\.outputs\.blocking \}\}/.test(cb) || /blocking: \$\{\{ steps\.freshness\.outputs\.blocking \}\}/.test(w.text));
}

// ── 5. the publication path itself ───────────────────────────────────────
const reusable = workflows.find((w) => w.file === REUSABLE);
const publish = reusable.jobs.find((j) => j.name === 'publish');
const publishText = publish.body.join('\n');
const publishScripts = publish.scripts.join('\n');

check('the publisher starts from main, not from the ref the run was dispatched on', /ref: main/.test(publishText));
check('the handoff is unpacked outside the working tree', /path: \$\{\{ runner\.temp \}\}\/handoff/.test(publishText));
check(
  'the publisher re-runs the gate on what it is about to commit',
  /validate-data-publication\.mjs[\s\\]*--producer "\$PRODUCER"[\s\\]*--staged/.test(publishScripts),
);
check('nothing is interpolated into the publisher s shell', !publishScripts.includes('${{'), publishScripts.match(/.*\$\{\{.*/)?.[0]);
check('the pull request body is a file, never an argument', /--body-file/.test(publishScripts) && !/--body\s+["']/.test(publishScripts));
// The branch and the title are looked up from the contract by producer id, so
// a caller cannot name them and nothing a collector read can either.
// Where the data lands is the producer's own business, looked up by an id
// that must already be in the contract table. If a caller could name the
// branch, a caller could publish anywhere.
check('the branch is looked up from the contract', /publication-target\.mjs "\$PRODUCER"/.test(publishScripts));
for (const key of ['BRANCH', 'TITLE']) {
  const line = reusable.lines.find((l) => l.trim().startsWith(`${key}:`));
  check(`the publisher's ${key} comes from the contract, not from its caller`, !!line && /\$\{\{ steps\.contract\.outputs\./.test(line), line);
}
// Every reference, not only the interpolated ones: `inputs.merge` is read in
// an `if:` without braces, and a smuggled `inputs.branch` would be too.
const inputsUsed = Array.from(new Set(Array.from(reusable.text.matchAll(/\binputs\.([a-z_]+)/g)).map((m) => m[1]))).sort();
eq('the publisher reads three inputs and no others', inputsUsed, ['artifact', 'merge', 'producer']);
const inputsStart = reusable.lines.findIndex((l) => l.trim() === 'inputs:');
const inputsBlock = [];
for (let i = inputsStart + 1; i < reusable.lines.length; i += 1) {
  const line = reusable.lines[i];
  if (line.trim() === '') continue;
  if (indentOf(line) <= 4) break;
  if (/^ {6}[a-z_]+:$/.test(line)) inputsBlock.push(line.trim().slice(0, -1));
}
const inputsDeclared = inputsBlock.sort();
eq('and declares exactly those three', inputsDeclared, ['artifact', 'merge', 'producer']);
check('an existing pull request is found before a new one is opened', publishScripts.indexOf('gh pr list') < publishScripts.indexOf('gh pr create'));
check('a pull request that could not be opened stops the run rather than being merged', /if: steps\.pr\.outputs\.number != '' && inputs\.merge/.test(publishText));
check('a merge that fails leaves the pull request open and fails the run', /could not be merged[\s\S]*?exit 1/.test(publishScripts));
check('a publication that changes nothing opens no pull request', /nothing to publish[\s\S]*?number=/.test(publishScripts));

// The archive arrives from a job this one did not watch, and tar will write
// through `../` or a symlink before any gate has run. So it is read first.
check('the archive is inspected before it is unpacked', publishScripts.indexOf('tar -tf') < publishScripts.indexOf('tar -xf'));
// These two used to be shell greps written out here, which meant the policy
// lived in the workflow and could only be read, never exercised. It is now a
// function in the contract module with its own suite, and what this file has
// to pin is that the publisher actually calls it, on both lists tar can give
// it, before extraction. The refusals themselves are proved against archives
// tar really wrote, in publication-contracts.test.mjs.
check('the member names are read from the archive and judged', /tar -tf\s+"\$archive"[\s\S]*?members\.txt/.test(publishScripts));
check('so are the member types, which is how a symlink announces itself', /tar -tvf\s+"\$archive" \| cut -c1[\s\S]*?types\.txt/.test(publishScripts));
check(
  'and both go to the validator, from the checkout, before anything is unpacked',
  /validate-archive-members\.mjs[\s\S]*?--members[\s\S]*?--types/.test(publishScripts) &&
    publishScripts.indexOf('validate-archive-members.mjs') < publishScripts.indexOf('tar -xf'),
);
check('extraction claims no ownership or permissions from the archive', /--no-same-owner --no-same-permissions/.test(publishScripts));

// Everything the privileged job reaches for is GitHub's, and both actions are
// held at a digest. No toolchain download, no third-party action, no wildcard.
const publishUses = publish.body.filter((l) => /^\s+- uses:/.test(l)).map((l) => l.split('uses:')[1].trim());
eq('the publisher runs two actions, both pinned by digest', publishUses, [
  'actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5.1.0',
  'actions/download-artifact@634f93cb2916e3fdff6788551b99b062d0335ce0 # v5.0.0',
]);
check('the publisher installs no toolchain', !/setup-node|setup-python|npm (ci|install)|pip install/.test(publishText));
check('the publisher reaches nothing but GitHub', !/curl|wget|fetch\(/.test(publishScripts));
// One group across every caller: two producers committing into the same
// branch history at once is how one of them publishes over the other.
check('publishers are serialised repository-wide', /^concurrency:\n {2}group: publish-data\n {2}cancel-in-progress: false$/m.test(reusable.text));

// A downstream announcement waits for the merge. The daily social post reads
// the calendar, the deal tape and the chartbook, so announcing a collection
// that failed to publish is announcing yesterday's data.
{
  const job = workflows.find((w) => w.file === 'collect.yml').jobs.find((j) => j.name === 'notify');
  check("collect.yml:notify runs only after a successful merge", /needs\.publish\.outputs\.merged == 'true'/.test(job.body.join('\n')));
  eq('collect.yml:notify holds a read-only token', job.permissions, { contents: 'read' });
}

// The collecting jobs are the ones with the credentials and the network, so
// the properties that matter there are the negative ones.
for (const [file, name] of [['build-samples.yml', 'collect'], ['collect.yml', 'collect'], ['discover-ats.yml', 'discover']]) {
  const w = workflows.find((x) => x.file === file);
  const job = w.jobs.find((j) => j.name === name);
  const text = job.scripts.join('\n');
  eq(`${file}:${name} holds a read-only token`, job.permissions, { contents: 'read' });
  check(`${file}:${name} pushes nothing`, !/git push/.test(text));
  check(`${file}:${name} opens and merges nothing`, !/gh pr /.test(text));
  // Before the handoff specifically: discover-ats also uploads a dry-run
  // report, which is a deliverable rather than something to publish.
  check(`${file}:${name} runs a gate before the handoff leaves it`, job.body.join('\n').indexOf('validate-') < job.body.join('\n').indexOf('runner.temp }}/handoff'));
  check(`${file}:${name} stages everything, so a stray change fails rather than hides`, /git add -A/.test(text) && !/git add data\//.test(text));
  // The defect this replaced: a push inside a retry loop left the loop's exit
  // status to whatever ran last, so a refused push reported success.
  check(`${file}:${name} has no retry loop that can swallow a failure`, !/for i in [\s\S]{0,200}?git (push|pull)/.test(text));
}

// The run's conclusion. A stale required source must not stop a healthy one
// publishing, and must not let the morning report success either, so this
// runs after publication and fails the run rather than gating it.
for (const file of ['build-samples.yml', 'collect.yml']) {
  const w = workflows.find((x) => x.file === file);
  const health = w.jobs.find((j) => j.name === 'health');
  if (!health) {
    check(`${file} has a health job`, false, 'the run has no way to report a stale source');
    continue;
  }
  const text = health.body.join('\n');
  eq(`${file}:health holds no token at all`, health.permissions, {});
  // build-samples publishes in the same run, so its health job waits for
  // that job too. collect.yml does not publish yet; it gains the second
  // dependency in PR C, when it has something to wait for.
  check(`${file}:health runs after everything else in its workflow`, /needs: \[collect(, publish)?\]/.test(text));
  check(`${file}:health runs even when publication did not`, /if: always\(\)/.test(text));
  check(`${file}:health fails the run on a stale required source`, /BLOCKING[\s\S]*?= "true"[\s\S]*?exit 1/.test(health.scripts.join('\n')));
  check(`${file}:health publishes nothing and merges nothing`, !/gh pr |git push/.test(health.scripts.join('\n')));
  // The sweep reads the working tree after collection and before the gate.
  const collect = w.jobs.find((j) => j.name === 'collect');
  const cb = collect.body.join('\n');
  const staged = cb.indexOf('Stage the collection');
  check(
    `${file} sweeps every source before it stages anything`,
    staged === -1 ? /check-freshness\.mjs/.test(cb) : cb.indexOf('check-freshness.mjs') < staged,
  );
  check(`${file} writes the freshness table to the job summary`, /--summary "\$GITHUB_STEP_SUMMARY"/.test(cb));
  check(`${file} never lets the sweep itself fail the collection`, !/check-freshness[\s\S]{0,200}?exit 1/.test(cb));
}


// ── who decides whether the proposed bytes may be published ─────────────
// The invariant: unprivileged collection may propose bytes, and only code
// and policy already on `main` may decide whether those bytes are safe.
//
// An earlier draft of the publisher ran `node "$RUNNER_TEMP/handoff/gate.mjs"`
// — a gate the producer had copied into the artifact. Every other control in
// that job sits downstream of the gate, so a producer able to supply its own
// judge could approve of whatever else it supplied. These checks exist so
// that cannot come back quietly.
// Every job that unpacks a handoff, not only the shared one. The inline
// publisher in `build-samples` has the same power and had the same defect.
const PUBLISHERS = [
  ['publish-data.yml', 'publish'],
  ['build-samples.yml', 'publish'],
];
for (const [file, name] of PUBLISHERS) {
  const w = workflows.find((x) => x.file === file);
  const job = w.jobs.find((j) => j.name === name);
  const script = job.scripts.join('\n');
  const where = `${file}:${name}`;

  check(`${where} executes nothing out of the handoff`, !/\b(node|bash|sh|python3?)\s+["'$]*\{?\{?\s*(\$RUNNER_TEMP|\$\{\{ runner\.temp \}\})/.test(script), script.match(/\b(node|bash|sh|python3?)\s+\S*(RUNNER_TEMP|runner\.temp)\S*/g)?.join(' ; '));
  check(`${where} names no gate.mjs at all`, !/gate\.mjs/.test(w.text));
  check(`${where} runs every script from its own checkout`, (script.match(/\bnode\s+(\S+)/g) ?? []).every((m) => m.replace(/^node\s+/, '').startsWith('scripts/')), (script.match(/\bnode\s+(\S+)/g) ?? []).join(' ; '));
  check(`${where} judges the archive members before unpacking`, /validate-archive-members\.mjs/.test(script));
  check(`${where} reads both the names and the types from the archive`, /tar -tf\s+"\$archive"/.test(script) && /tar -tvf\s+"\$archive" \| cut -c1/.test(script));
  check(`${where} judges them before tar writes anything`, script.indexOf('validate-archive-members.mjs') < script.indexOf('tar -xf'));
  check(`${where} claims no ownership or permissions from the archive`, /--no-same-owner --no-same-permissions/.test(script));
  check(`${where} gates the staged diff, not the archive's own claim`, /--staged "\$RUNNER_TEMP\/publishing\.txt"/.test(script) && /git diff --cached --name-only > "\$RUNNER_TEMP\/publishing\.txt"/.test(script));
  check(`${where} gates it before committing`, Math.max(script.indexOf('validate-publication.mjs'), script.indexOf('validate-data-publication.mjs')) < script.indexOf('git commit'));
  check(`${where} gates it before opening a pull request`, Math.max(script.indexOf('validate-publication.mjs'), script.indexOf('validate-data-publication.mjs')) < script.indexOf('gh pr create'));
  check(`${where} writes the pull request body itself`, /--report "\$RUNNER_TEMP\/pr-body\.md"/.test(script) && !/handoff\/pr-body/.test(w.text));
  check(`${where} checks out main and nothing else`, /ref: main/.test(w.text));
  // Nothing a careers board returned may reach the pull request unchecked,
  // and nothing it returned may decide anything at all. The board count is
  // the only value the publisher cannot work out for itself, so it is the
  // only one these rules have to hold.
  const boardLines = script.split('\n').filter((l) => l.includes('BOARDS'));
  check(`${where} re-checks the shape of anything the collector passed it`, !boardLines.length || boardLines.some((l) => /grep -qE '\^\[0-9\]\+\/\[0-9\]\+ boards/.test(l)));
  check(`${where} falls back rather than failing on a malformed one`, !boardLines.length || boardLines.some((l) => /BOARDS=unknown/.test(l)));
  check(`${where} never lets it end the run`, !boardLines.some((l) => /exit\s+\d/.test(l)));
  // It may reach the report and nothing else: not the branch, not the title,
  // not the commit, not the merge, not either validator's arguments.
  eq(
    `${where} lets it reach the pull request body and nothing else`,
    boardLines.filter((l) => /(branch=|git commit|git push|gh pr|validate-archive-members|--staged|--producer|--next)/.test(l)),
    [],
  );
  check(`${where} passes it only as --boards`, !boardLines.some((l) => /\$BOARDS/.test(l) && !/--boards "\$BOARDS"/.test(l) && !/printf '%s' "\$\{BOARDS:-\}"/.test(l)), boardLines.join(' ; '));
}

const publisher = workflows.find((w) => w.file === 'publish-data.yml');
const pub = publisher.jobs.find((j) => j.name === 'publish');
const pubScript = pub.scripts.join('\n');
const pubText = publisher.text;

check(
  'the publisher never executes anything out of the handoff',
  !/\b(node|bash|sh|python3?)\s+["'$]*\{?\{?\s*(\$RUNNER_TEMP|\$\{\{ runner\.temp \}\})/.test(pubScript),
  pubScript.match(/\b(node|bash|sh|python3?)\s+\S*(RUNNER_TEMP|runner\.temp)\S*/g)?.join(' ; '),
);
check('the publisher names no gate.mjs at all', !/gate\.mjs/.test(pubText));
check(
  'every script the publisher runs comes from its own checkout',
  (pubScript.match(/\bnode\s+(\S+)/g) ?? []).every((m) => m.replace(/^node\s+/, '').startsWith('scripts/')),
  (pubScript.match(/\bnode\s+(\S+)/g) ?? []).join(' ; '),
);
check('the publisher checks the archive members before unpacking', /validate-archive-members\.mjs/.test(pubScript));
check('the publisher gates the staged diff before committing', /validate-data-publication\.mjs/.test(pubScript));
check(
  'the member check runs before tar writes anything',
  pubScript.indexOf('validate-archive-members.mjs') < pubScript.indexOf('tar -xf'),
);
check(
  'the gate runs before the commit',
  pubScript.indexOf('validate-data-publication.mjs') < pubScript.indexOf('git commit'),
);
check(
  'the pull request body is written by the publisher, not carried in the handoff',
  /--report "\$RUNNER_TEMP\/pr-body\.md"/.test(pubScript) && !/handoff\/pr-body/.test(pubText),
);
check('the publisher checks out main and nothing else', /ref: main/.test(pubText));

// The other half of the same invariant: a producer may hand over generated
// data, and nothing else. A `cp` of anything into the handoff is how the
// gate got there the first time.
for (const w of workflows) {
  for (const j of w.jobs) {
    const body = j.body.join('\n');
    if (!/handoff/.test(body)) continue;
    // No exemptions. `build-samples` held one until its inline publisher
    // was fixed: it copied its gate in beside the archive and ran that copy,
    // which is the same defect the shared publisher was corrected for and
    // sat in the producer that actually feeds the site.
    check(
      `${w.file}:${j.name} puts only the archive in the handoff`,
      !/\bcp\s+\S*scripts\//.test(body) && !/\bcp\s+\S+\s+"?\$RUNNER_TEMP\/handoff/.test(body),
      body.match(/\bcp\s+.*/g)?.join(' ; '),
    );
    check(
      `${w.file}:${j.name} builds that archive from the staged list`,
      !/tar -cf/.test(body) || /tar -cf "\$RUNNER_TEMP\/handoff\/publishable\.tar" -T "\$RUNNER_TEMP\/staged\.txt"/.test(body),
    );
  }
}

// The first producer on the shared publisher opens a pull request and stops.
// Opening one is reversible by closing it; merging one is not, and a merge in
// the same minute as the dispatch leaves nothing to inspect in between.
const ats = workflows.find((w) => w.file === 'discover-ats.yml');
check('discover-ats delegates publication rather than merging inline', /uses: \.\/\.github\/workflows\/publish-data\.yml/.test(ats.text));
check('discover-ats does not merge its own data pull request', /merge: false/.test(ats.text));
check('and the publisher honours that', /if: steps\.pr\.outputs\.number != '' && inputs\.merge/.test(pubText));
check('the conditions for changing it to true are written down beside it', /WHAT WOULD JUSTIFY `true`/.test(ats.text));

// Pinned by digest, on both halves of the first migrated producer. A moved
// tag on the privileged half would be a moved tag on every producer at once;
// on the collecting half it is a moved tag in front of 160 careers sites.
// The rule that matters, applied everywhere: a job that can write must not
// run an action whose tag could move under it. A moved tag in front of a
// token that can merge is a different thing from a moved tag in front of a
// crawler.
const floating = (lines) =>
  lines
    .filter((l) => /^\s*(- )?uses:/.test(l))
    .map((l) => l.split('uses:')[1].trim())
    .filter((u) => !u.startsWith('./') && !/@[0-9a-f]{40}\b/.test(u));

const writeJobs = [];
const stillFloating = [];
for (const w of workflows) {
  for (const j of w.jobs) {
    const perms = j.permissions ?? {};
    if (perms.contents !== 'write' && perms['pull-requests'] !== 'write') continue;
    writeJobs.push(`${w.file}:${j.name}`);
    if (floating(j.body).length) stillFloating.push(`${w.file}:${j.name}`);
  }
}
check('there is more than one job that can write, so this rule has work to do', writeJobs.length >= 2, writeJobs.join(', '));
// The list PR B opened and #65 left for this stage to close. `collect.yml`
// was the last producer pushing to `main` itself; it now delegates, its
// collecting job is read-only, and nothing that can write runs an action
// whose tag could move under it.
eq('every job that can write pins every action it runs', stillFloating, []);

// Two workflows pin everything, collecting half included, and are held to it
// so the discipline cannot quietly retreat to the privileged job alone.
for (const file of ['discover-ats.yml', 'publish-data.yml']) {
  const w = workflows.find((x) => x.file === file);
  eq(`${file} pins every action it runs to a commit`, floating(w.text.split('\n')), []);
  check(`${file} runs at least one action`, /uses:/.test(w.text));
}


// ── the open-data producer cannot merge itself yet ──────────────────────
// `collect.yml` is the first producer on the shared publisher that runs to a
// schedule. Until it has shown that both halves of the road work — opening a
// pull request, and updating that same pull request on a second run — it must
// be structurally incapable of merging, on every trigger, with no input
// anybody could set wrong at four in the morning.
{
  const ats = workflows.find((w) => w.file === 'discover-ats.yml').text;
  const col = workflows.find((w) => w.file === 'collect.yml').text;
  for (const [file, text] of [['collect.yml', col], ['discover-ats.yml', ats]]) {
    const passed = [...text.matchAll(/^\s+merge:\s*(\S+)\s*$/gm)].map((m) => m[1]);
    eq(`${file} passes merge, and passes it as a literal false`, passed, ['false']);
    check(`${file} does not decide it from an input, a secret or an expression`, !/merge:\s*\$\{\{/.test(text));
  }
  // Nor by the back door: a workflow-level input called `merge` or `publish`
  // that a dispatch could set and something downstream could read.
  const inputs = [...col.matchAll(/^ {6}(\w[\w-]*):\s*$/gm)].map((m) => m[1]);
  eq('collect.yml offers no dispatch input that could turn merging on', inputs.filter((i) => /^(merge|publish)$/.test(i)), []);
  check('and the conditions for changing it are written down beside it', /WHAT WOULD JUSTIFY `true`/.test(col));
}

// ── an absent answer is not an all-clear ────────────────────────────────
// `blocking` and `degraded` come from a step inside the collecting job. If
// that job dies before reaching it, both arrive as empty strings, and empty
// is not false. The health job used to read that as an all-clear and print
// "every required source is within its horizon" over a collection that never
// happened. The run was red either way, but the operator was told the
// opposite of the truth.
//
// Run the real script, out of the real workflow, under the situations it has
// to tell apart.
{
  const health = workflows.find((w) => w.file === 'collect.yml').jobs.find((j) => j.name === 'health');
  const script = join(mkdtempSync(join(tmpdir(), 'health-')), 'health.sh');
  writeFileSync(script, health.scripts.join('\n'));

  const run = (env) => {
    try {
      return { code: 0, out: execFileSync('bash', [script], { env: { PATH: process.env.PATH, ...env }, encoding: 'utf8', stdio: 'pipe' }) };
    } catch (err) {
      return { code: err.status ?? -1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
    }
  };
  const ALL_CLEAR = /every required source is within its horizon/;

  for (const [name, env, wantCode, wantSays] of [
    ['the collecting job failed', { COLLECT: 'failure', PUBLISH: 'skipped' }, 1, /could not establish an all-clear/],
    // The realistic one, and the one an all-clear would be most misleading
    // over: the sweep ran and wrote its verdict, and a later step — staging,
    // the gate, the upload — failed. Both outputs are present and both say
    // everything is fine, because on the morning's data it was; nothing was
    // published all the same.
    ['the sweep ran and a later step failed', { COLLECT: 'failure', PUBLISH: 'skipped', BLOCKING: 'false', DEGRADED: 'false' }, 1, /the collection did not finish/],
    ['the collecting job was cancelled', { COLLECT: 'cancelled', PUBLISH: 'skipped' }, 1, /could not establish an all-clear/],
    ['the collection finished but publication failed', { COLLECT: 'success', PUBLISH: 'failure', BLOCKING: 'false', DEGRADED: 'false' }, 1, /publication did not/],
    ['the collection reported success but wrote no verdict', { COLLECT: 'success', PUBLISH: 'success', BLOCKING: '', DEGRADED: '' }, 1, /wrote no freshness verdict/],
    ['the collection finished and a required source is stale', { COLLECT: 'success', PUBLISH: 'success', BLOCKING: 'true', DEGRADED: 'false' }, 1, /not been collected inside its horizon/],
  ]) {
    const r = run(env);
    eq(`${name}: the run fails`, r.code, wantCode);
    check(`${name}: and says why`, wantSays.test(r.out), r.out.trim());
    check(`${name}: and never claims an all-clear`, !ALL_CLEAR.test(r.out), r.out.trim());
  }

  for (const [name, env] of [
    ['everything worked', { COLLECT: 'success', PUBLISH: 'success', BLOCKING: 'false', DEGRADED: 'false' }],
    ['everything worked and there was nothing to publish', { COLLECT: 'success', PUBLISH: 'skipped', BLOCKING: 'false', DEGRADED: 'false' }],
    ['everything worked and an optional source is degraded', { COLLECT: 'success', PUBLISH: 'success', BLOCKING: 'false', DEGRADED: 'true' }],
  ]) {
    const r = run(env);
    eq(`${name}: the run passes`, r.code, 0);
    check(`${name}: and the all-clear is stated`, ALL_CLEAR.test(r.out), r.out.trim());
  }
  const degraded = run({ COLLECT: 'success', PUBLISH: 'success', BLOCKING: 'false', DEGRADED: 'true' });
  check('a degraded optional source is a warning, not a failure', /::warning::/.test(degraded.out));
}

// ── every external action in the migrated workflow is pinned ────────────
// The rule reaches write-capable jobs everywhere. This workflow is being
// rewritten anyway, and the repository has taken digest pinning as the
// invariant rather than the precaution, so its read-only jobs come too.
{
  const col = workflows.find((w) => w.file === 'collect.yml');
  const external = [...col.text.matchAll(/uses:\s+(\S+)/g)].map((m) => m[1]).filter((u) => !u.startsWith('./'));
  eq('collect.yml pins every action it runs to a commit', external.filter((u) => !/@[0-9a-f]{40}$/.test(u)), []);
  check('and it runs several', external.length >= 4);
  // `build-samples.yml`'s collecting job is the last place a tag still
  // floats. Named rather than forgotten: it is read-only, it is not this
  // stage's file, and a sweep of its own closes it.
  const stillLoose = workflows
    .filter((w) => [...w.text.matchAll(/uses:\s+(\S+)/g)].some((m) => !m[1].startsWith('./') && !/@[0-9a-f]{40}$/.test(m[1])))
    .map((w) => w.file)
    .sort();
  eq('and the only workflow left with a floating tag is the one this stage does not touch', stillLoose, ['build-samples.yml']);
}

// ── the handoff, once more, for this producer ───────────────────────────
// Asserted against the file rather than inherited from the loop above, so a
// reader of this stage can see it stated for the workflow it migrates.
{
  const col = workflows.find((w) => w.file === 'collect.yml');
  const pack = col.jobs.find((j) => j.name === 'collect').body.join('\n');
  check('collect.yml packs the archive and copies nothing beside it', !/\bcp\s+/.test(pack), pack.match(/\bcp\s+.*/g)?.join(' ; '));
  check('collect.yml builds that archive from the staged list', /tar -cf "\$RUNNER_TEMP\/handoff\/publishable\.tar" -T "\$RUNNER_TEMP\/staged\.txt"/.test(pack));
  check('collect.yml writes no pull request body', !/--report/.test(pack));
  check('collect.yml still runs the gate before the handoff leaves it', pack.indexOf('validate-data-publication.mjs') < pack.indexOf('handoff'));
}


console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
