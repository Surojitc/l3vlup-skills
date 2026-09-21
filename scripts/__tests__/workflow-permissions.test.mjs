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

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

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

eq('exactly four jobs in this repository may open a pull request', holding('pull-requests'), [
  'build-samples.yml:publish',
  'discover-ats.yml:publish',
  'letters-parse.yml:open-pull-request',
  'thesis-pilot.yml:open-pull-request',
]);
// collect.yml is the fifth, and it is the one still pushing straight to a
// branch a ruleset refuses. It moves in PR C.
eq('five may write to the repository at all', holding('contents'), [
  'build-samples.yml:publish',
  'collect.yml:collect',
  'discover-ats.yml:publish',
  'letters-parse.yml:open-pull-request',
  'thesis-pilot.yml:open-pull-request',
]);
// The three that publish data do nothing themselves: they are a `uses:` and a
// grant. A step added to one of them would be a step running with the only
// token in the repository that can merge.
for (const id of ['discover-ats.yml:publish']) {
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
check('the publisher re-runs the gate on what it is about to commit', /gate\.mjs["']?[\s\\]*--producer "\$PRODUCER" --staged/.test(publishScripts));
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
check('an archive naming a path outside the tree is refused', /grep -qE '\(\^\/\|\^\\\.\\\.[\s\S]*?exit 1/.test(publishScripts), 'no traversal guard');
check('an archive holding anything but a plain file is refused', /tar -tvf[\s\S]*?grep -qvE '\^\[-d\]'[\s\S]*?exit 1/.test(publishScripts));
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

// The collecting jobs are the ones with the credentials and the network, so
// the properties that matter there are the negative ones.
for (const [file, name] of [['build-samples.yml', 'collect'], ['discover-ats.yml', 'discover']]) {
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


console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
