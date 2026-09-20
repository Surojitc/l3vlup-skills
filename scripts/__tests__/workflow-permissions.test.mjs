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
    jobs.push({ name: m[1], body, permissions: permissionsUnder(body, 4), scripts: runScripts(body) });
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
  'letters-parse.yml:open-pull-request',
  'letters-parse.yml:parse',
  'thesis-pilot.yml:extract',
  'thesis-pilot.yml:open-pull-request',
]);

// ── 1. no workflow leaves its floor to a repository setting ──────────────
// The setting is a web form. A job with no `permissions:` of its own inherits
// whatever it says, which is invisible in a diff and invisible in review.
for (const w of workflows) {
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

eq('exactly three jobs in this repository may open a pull request', holding('pull-requests'), [
  'build-samples.yml:publish',
  'letters-parse.yml:open-pull-request',
  'thesis-pilot.yml:open-pull-request',
]);
eq('exactly five jobs may write to the repository at all', holding('contents'), [
  'build-samples.yml:publish',
  'collect.yml:collect',
  'discover-ats.yml:discover',
  'letters-parse.yml:open-pull-request',
  'thesis-pilot.yml:open-pull-request',
]);
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
eq('one job in the repository merges a pull request, and it is the data publisher', merges, ['build-samples.yml:publish']);
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
const samples = workflows.find((w) => w.file === 'build-samples.yml');
const publish = samples.jobs.find((j) => j.name === 'publish');
const publishText = publish.body.join('\n');
const publishScripts = publish.scripts.join('\n');

check('the publisher takes its input from the collecting job', /needs: collect/.test(publishText));
check('the publisher runs only when the collection changed something', /if: needs\.collect\.outputs\.changed == 'true'/.test(publishText));
check('the publisher starts from main, not from the ref the run was dispatched on', /ref: main/.test(publishText));
check('the handoff is unpacked outside the working tree', /path: \$\{\{ runner\.temp \}\}\/handoff/.test(publishText));
check('the publisher re-runs the gate on what it is about to commit', /gate\.mjs["']? --staged/.test(publishScripts));
check('nothing is interpolated into the publisher s shell', !publishScripts.includes('${{'), publishScripts.match(/.*\$\{\{.*/)?.[0]);
check('the pull request body is a file, never an argument', /--body-file/.test(publishScripts) && !/--body\s+["']/.test(publishScripts));
check('the branch is one constant, assigned once', (publishScripts.match(/branch=automation\/daily-data-refresh/g) ?? []).length === 1);
check('an existing pull request is found before a new one is opened', publishScripts.indexOf('gh pr list') < publishScripts.indexOf('gh pr create'));
check('a pull request that could not be opened stops the run rather than being merged', /if: steps\.pr\.outputs\.number != ''/.test(publishText));
check('a merge that fails leaves the pull request open and fails the run', /could not be merged[\s\S]*?exit 1/.test(publishScripts));
check('the run does not race itself', /group: build-samples/.test(samples.text) && /cancel-in-progress: false/.test(samples.text));

// The collecting job is the one with the credentials and the network, so the
// property that matters there is the negative one.
const collect = samples.jobs.find((j) => j.name === 'collect');
eq('the collecting job holds a read-only token', collect.permissions, { contents: 'read' });
check('the collecting job pushes nothing', !/git push/.test(collect.scripts.join('\n')));
check('the collecting job opens nothing', !/gh pr /.test(collect.scripts.join('\n')));
check('the gate runs before anything leaves the collecting job', collect.body.join('\n').indexOf('validate-publication.mjs') < collect.body.join('\n').indexOf('upload-artifact'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
