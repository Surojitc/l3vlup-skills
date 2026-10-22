/**
 * Scheduled and review publications, run for real against git.
 *
 *   node scripts/__tests__/publication-review.test.mjs
 *
 * THE INCIDENT
 * ------------
 * On 20 October 2026 collect.yml was dispatched from a feature branch (run
 * 81). Its publisher rebuilt the scheduled branch on main, committed the
 * run's files and opened #192, and under G1 did not merge it. Two minutes
 * later the scheduled run's publisher rebuilt the same branch from main and
 * its own files, force-pushed it and merged #192. The review copy was lost
 * and the pull request a person had been asked to read was merged with
 * different contents.
 *
 * WHAT THIS DOES
 * --------------
 * Reads the publisher's steps out of .github/workflows/publish-data.yml, the
 * scripts and the environment each one is given, and runs them in order
 * under bash, as the runner would: against a bare repository standing in for
 * GitHub, a fresh clone of its `main` standing in for the checkout, a real
 * handoff tar, main's own scripts, and a stand-in for `gh` that keeps the
 * pull requests in a file and reads their commits out of the bare
 * repository. The step `if:` conditions and the concurrency group are
 * evaluated from the workflow's own text.
 *
 * Then it replays the incident and the cases around it: a review run, the
 * scheduled run after it, a second review run, a re-run, a review run from
 * main, a pull request left by a publisher that predates review branches,
 * and the scheduled path updating its own pull request.
 *
 * WHAT IT CANNOT SHOW
 * -------------------
 * That GitHub evaluates the expressions as this file does, that `gh` behaves
 * as its stand-in does, or that the concurrency groups queue as documented.
 * Those need a real run. No network: the stand-in is the only `gh` on PATH.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

let pass = 0;
let fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass += 1; console.log(`PASS  ${name}`); }
  else { fail += 1; console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

// ── the workflow, read as the runner reads it ────────────────────────────
const yml = readFileSync(join(ROOT, '.github', 'workflows', 'publish-data.yml'), 'utf8');
const lines = yml.split('\n');
const indentOf = (l) => l.length - l.trimStart().length;

function step(name) {
  const start = lines.findIndex((l) => l.startsWith(`      - name: ${name}`));
  if (start === -1) throw new Error(`publish-data.yml has no step named ${name}`);
  let end = lines.findIndex((l, i) => i > start && /^ {6}- /.test(l));
  if (end === -1) end = lines.length;
  const body = lines.slice(start + 1, end);
  const ifLine = body.find((l) => /^ {8}if: /.test(l));
  const env = {};
  const envAt = body.findIndex((l) => l === '        env:');
  if (envAt > -1) {
    for (let i = envAt + 1; i < body.length && (body[i].trim() === '' || body[i].trimStart().startsWith('#') || indentOf(body[i]) > 8); i += 1) {
      const m = body[i].match(/^ {10}([A-Z_]+): \$\{\{ (.+) \}\}$/);
      if (m) env[m[1]] = m[2];
    }
  }
  const runAt = body.findIndex((l) => /^ {8}run: /.test(l));
  let script;
  if (/^ {8}run: \|$/.test(body[runAt])) {
    script = [];
    for (let i = runAt + 1; i < body.length && (body[i].trim() === '' || indentOf(body[i]) >= 10); i += 1) script.push(body[i].slice(10));
    script = script.join('\n');
  } else {
    script = body[runAt].replace(/^ {8}run: /, '');
  }
  return { if: ifLine ? ifLine.replace(/^ {8}if: /, '') : null, env, script };
}

// How the runner invokes a `run:` script: `bash --noprofile --norc -eo pipefail {0}`.
const BASH = ['--noprofile', '--norc', '-eo', 'pipefail', '-c'];

const CONTRACT = step("Read the producer's contract");
const PR = step('Open or update the data pull request');
const NOTICE = step('Leave a collection from another branch');
const MERGE = step('Merge the data pull request');

/**
 * The expression subset the publisher uses: contexts, string literals,
 * ==, !=, &&, ||, !, parentheses and format(). Anything else throws, so a
 * new construct in the workflow fails this suite rather than being guessed.
 */
function evaluate(expr, ctx) {
  const resolved = expr.replace(/\b(steps\.[a-z]+\.outputs\.[a-z_]+|inputs\.[a-z_]+|github\.[a-z_]+|secrets\.[A-Z_]+)\b/g, (m) => {
    if (!(m in ctx)) throw new Error(`the harness does not know ${m}`);
    return JSON.stringify(ctx[m]);
  });
  const js = resolved.replace(/format\(/g, '__format(');
  if (/[^\s"'()\w!=&|,{}.:/@-]/.test(js.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, ''))) throw new Error(`unexpected syntax in ${expr}`);
  // eslint-disable-next-line no-new-func
  return new Function('__format', `return (${js});`)((f, ...a) => f.replace(/\{(\d+)\}/g, (_, i) => String(a[Number(i)])));
}
const groupExpr = yml.match(/^concurrency:\n {2}group: \$\{\{ (.+) \}\}$/m)?.[1];

// ── a GitHub to publish to ───────────────────────────────────────────────
const made = [];
const tmp = (p) => { const d = mkdtempSync(join(tmpdir(), p)); made.push(d); return d; };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const world = tmp('pubreview-');
const origin = join(world, 'origin.git');
const bin = join(world, 'bin');
const state = join(world, 'prs.json');
const ghLog = join(world, 'gh.log');
mkdirSync(bin);
git(world, 'init', '-q', '--bare', '-b', 'main', origin);
writeFileSync(state, JSON.stringify({ next: 1, prs: [] }));

// The stand-in for `gh`: just the calls the publisher makes, against the
// bare repository. Pull requests live in a file; their commits are read from
// git, as GitHub reads them.
writeFileSync(join(bin, 'gh'), `#!${process.execPath}
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const [STATE, ORIGIN, LOG] = [process.env.FAKE_GH_STATE, process.env.FAKE_GH_ORIGIN, process.env.FAKE_GH_LOG];
const a = process.argv.slice(2);
fs.appendFileSync(LOG, JSON.stringify(a) + '\\n');
const s = JSON.parse(fs.readFileSync(STATE, 'utf8'));
const save = () => fs.writeFileSync(STATE, JSON.stringify(s, null, 2));
const opt = (k) => { const i = a.indexOf(k); return i > -1 ? a[i + 1] : undefined; };
const g = (...x) => execFileSync('git', ['--git-dir', ORIGIN, ...x], { encoding: 'utf8' }).trim();
const find = (ref) => s.prs.find((p) => String(p.number) === String(ref)) ?? s.prs.find((p) => p.head === ref && p.state === 'open');
if (a[0] !== 'pr') { console.error('stand-in gh: unsupported ' + a.join(' ')); process.exit(9); }
const sub = a[1];
if (sub === 'list') {
  const hits = s.prs.filter((p) => p.head === opt('--head') && p.base === opt('--base') && p.state === opt('--state'));
  if (opt('--jq') !== '.[0].number // empty') { console.error('stand-in gh: unsupported jq ' + opt('--jq')); process.exit(9); }
  if (hits.length) console.log(hits[0].number);
} else if (sub === 'view') {
  const pr = find(a[2]);
  if (!pr) { console.error('no pull request found for ' + a[2]); process.exit(1); }
  const json = opt('--json');
  if (json === 'commits') {
    const raw = g('log', '--reverse', '--format=%H%x1f%s%x1f%b%x1e', 'main..refs/heads/' + pr.head);
    const commits = raw.split('\\x1e').map((r) => r.replace(/^\\n/, '')).filter(Boolean).map((r) => { const [oid, messageHeadline, messageBody] = r.split('\\x1f'); return { oid, messageHeadline, messageBody: (messageBody ?? '').trim() }; });
    console.log(JSON.stringify({ commits }));
  } else if (json === 'number' && opt('--jq') === '.number') console.log(pr.number);
  else if (json === 'headRefName' && opt('--jq') === '.headRefName') console.log(pr.head);
  else { console.error('stand-in gh: unsupported view ' + a.join(' ')); process.exit(9); }
} else if (sub === 'create') {
  const head = opt('--head');
  if (s.prs.some((p) => p.head === head && p.state === 'open')) { console.error('a pull request for branch ' + head + ' already exists'); process.exit(1); }
  const pr = { number: s.next++, head, base: opt('--base'), title: opt('--title'), body: fs.readFileSync(opt('--body-file'), 'utf8'), draft: a.includes('--draft'), state: 'open', sha: g('rev-parse', 'refs/heads/' + head) };
  s.prs.push(pr); save();
  console.log('https://github.invalid/pull/' + pr.number);
} else if (sub === 'edit') {
  const pr = find(a[2]);
  pr.title = opt('--title'); pr.body = fs.readFileSync(opt('--body-file'), 'utf8'); pr.sha = g('rev-parse', 'refs/heads/' + pr.head); pr.edits = (pr.edits ?? 0) + 1; save();
} else if (sub === 'merge') {
  const pr = find(a[2]);
  if (pr.draft) { console.error('pull request is still a draft'); process.exit(1); }
  const tree = g('rev-parse', 'refs/heads/' + pr.head + '^{tree}');
  const sha = g('-c', 'user.name=github', '-c', 'user.email=github@example.invalid', 'commit-tree', tree, '-p', 'main', '-m', pr.title);
  g('update-ref', 'refs/heads/main', sha);
  pr.state = 'merged'; pr.mergedSha = g('rev-parse', 'refs/heads/' + pr.head); save();
} else { console.error('stand-in gh: unsupported ' + a.join(' ')); process.exit(9); }
`);
chmodSync(join(bin, 'gh'), 0o755);

// main, holding main's own publication scripts and one published file.
const QUEUE = 'data/career-review-queue.json';
{
  const seed = tmp('pubreview-seed-');
  git(seed, 'init', '-q', '-b', 'main');
  git(seed, 'config', 'user.email', 't@example.invalid');
  git(seed, 'config', 'user.name', 't');
  mkdirSync(join(seed, 'scripts'));
  mkdirSync(join(seed, 'data'));
  for (const f of ['publication-contracts.mjs', 'publication-target.mjs', 'validate-archive-members.mjs', 'keep-published-observations.mjs', 'validate-data-publication.mjs', 'check-publication-branch.mjs']) {
    cpSync(join(ROOT, 'scripts', f), join(seed, 'scripts', f));
  }
  writeFileSync(join(seed, QUEUE), JSON.stringify({ generatedAt: new Date(Date.now() - 6 * 3_600_000).toISOString(), by: 'main' }));
  git(seed, 'add', '-A');
  git(seed, 'commit', '-q', '-m', 'main');
  git(seed, 'push', '-q', origin, 'HEAD:refs/heads/main');
}

const prs = () => JSON.parse(readFileSync(state, 'utf8')).prs;
const pr = (n) => prs().find((p) => p.number === n);
const tip = (branch) => { try { return git(world, '--git-dir', origin, 'rev-parse', `refs/heads/${branch}`); } catch { return null; } };
const onMain = () => JSON.parse(git(world, '--git-dir', origin, 'show', `main:${QUEUE}`)).by;
const onBranch = (branch) => { try { return JSON.parse(git(world, '--git-dir', origin, 'show', `refs/heads/${branch}:${QUEUE}`)).by; } catch { return null; } };
const ghCalls = () => readFileSync(ghLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
writeFileSync(ghLog, '');

let minutes = 0;
/**
 * One publish job, step by step, as the runner would run it.
 * `by` is what the collected file says, so each run's copy is recognisable.
 */
function publish({ ref, runId, by, review = false, merge = true, producer = 'open-data', files = {} }) {
  minutes += 1;
  const ws = tmp('pubreview-run-');
  const checkout = join(ws, 'checkout');
  const temp = join(ws, 'temp');
  mkdirSync(join(temp, 'handoff'), { recursive: true });
  git(ws, 'clone', '-q', '--branch', 'main', origin, checkout);
  // The collecting job's archive: one file, newer than main's copy.
  const stage = join(ws, 'stage');
  mkdirSync(join(stage, 'data'), { recursive: true });
  writeFileSync(join(stage, QUEUE), JSON.stringify({ generatedAt: new Date(Date.now() - 3_600_000 + minutes * 60_000).toISOString(), by }));
  // Any other files this collection produced, such as a precedent database.
  for (const [path, value] of Object.entries(files)) writeFileSync(join(stage, path), JSON.stringify(value));
  execFileSync('tar', ['-cf', join(temp, 'handoff', 'publishable.tar'), QUEUE, ...Object.keys(files)], { cwd: stage });

  const ctx = {
    'inputs.producer': producer, 'inputs.merge': merge, 'inputs.review': review, 'inputs.artifact': 'open-data-refresh',
    'github.ref': ref, 'github.run_id': String(runId), 'secrets.GITHUB_TOKEN': 'not-a-token',
  };
  const baseEnv = {
    PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: ws,
    RUNNER_TEMP: temp, GITHUB_SERVER_URL: 'https://github.invalid', GITHUB_REPOSITORY: 'l3vlup/l3vlup-skills', GITHUB_RUN_ID: String(runId),
    FAKE_GH_STATE: state, FAKE_GH_ORIGIN: origin, FAKE_GH_LOG: ghLog,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
  };
  const runStep = (s, id) => {
    const out = join(temp, `${id}.out`);
    writeFileSync(out, '');
    const env = { ...baseEnv, GITHUB_OUTPUT: out };
    for (const [k, expr] of Object.entries(s.env)) env[k] = String(evaluate(expr, ctx));
    const r = spawnSync('bash', [...BASH, s.script], { cwd: checkout, env, encoding: 'utf8' });
    const outputs = Object.fromEntries(readFileSync(out, 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
    for (const [k, v] of Object.entries(outputs)) ctx[`steps.${id}.outputs.${k}`] = v;
    return { code: r.status, log: `${r.stdout}${r.stderr}`, outputs };
  };

  const result = { group: evaluate(groupExpr, ctx), steps: {} };
  result.steps.contract = runStep(CONTRACT, 'contract');
  if (result.steps.contract.code !== 0) return result;
  result.steps.pr = runStep(PR, 'pr');
  if (result.steps.pr.code !== 0) return result;
  ctx['steps.pr.outputs.number'] ??= '';
  ctx['steps.merge.outputs.merged'] ??= '';
  if (evaluate(NOTICE.if, ctx)) result.steps.notice = runStep(NOTICE, 'notice');
  if (evaluate(MERGE.if, ctx)) result.steps.merge = runStep(MERGE, 'merge');
  result.number = result.steps.pr.outputs.number ? Number(result.steps.pr.outputs.number) : null;
  return result;
}

const SCHED = 'automation/open-data-refresh';
const MAIN = 'refs/heads/main';
const FEATURE = 'refs/heads/ccr-d7cb454b-j6ri1l-collect-run-data';

try {
  check('the harness found the publisher\'s concurrency expression', !!groupExpr);

  // ── 1. the controlled run of 20 October, on the new road ──
  const a = publish({ ref: FEATURE, runId: 81, by: 'review run 81' });
  eq('review run: the contract step places it on a branch of its own', [a.steps.contract.code, a.steps.contract.outputs.branch, a.steps.contract.outputs.review], [0, `${SCHED}-review-81`, 'true']);
  eq('review run: it queues alone, outside the scheduled publication queue', a.group, 'publish-data-review-81');
  eq('review run: it publishes, on that branch', [a.steps.pr.code, onBranch(`${SCHED}-review-81`)], [0, 'review run 81']);
  eq('review run: it never touches the scheduled branch', tip(SCHED), null);
  const ra = pr(a.number);
  check('review run: its pull request is a draft titled "review:"', ra?.draft === true && /^review: chore\(data\): open data \d{4}-\d{2}-\d{2}$/.test(ra.title), JSON.stringify(ra && { draft: ra.draft, title: ra.title }));
  check('review run: the body says review only, the ref, the run and that it needs a person', /Review only\. This pull request will not be merged automatically\./.test(ra.body) && ra.body.includes(`\`${FEATURE}\``) && ra.body.includes('/actions/runs/81') && /needs a person/.test(ra.body), ra.body.slice(0, 400));
  check('review run: the merge step does not run, and the notice does', !a.steps.merge && a.steps.notice?.code === 0 && /will not be merged automatically/.test(a.steps.notice.log));
  eq('review run: main is untouched', onMain(), 'main');
  const reviewTip = tip(`${SCHED}-review-81`);
  const reviewCommit = git(world, '--git-dir', origin, 'log', '-1', '--format=%B', reviewTip);
  check('review run: its commit says which path made it', /Publication: review/.test(reviewCommit) && reviewCommit.includes(`Collected-by: ${FEATURE}`) && /Publication-run: 81/.test(reviewCommit), reviewCommit);

  // ── 2. two minutes later, the scheduled run ──
  const b = publish({ ref: MAIN, runId: 82, by: 'scheduled run 82' });
  eq('scheduled run: the contract branch, as always', [b.steps.contract.outputs.branch, b.steps.contract.outputs.review], [SCHED, 'false']);
  eq('scheduled run: the shared queue, as always', b.group, 'publish-data');
  eq('scheduled run: it opens its own pull request and merges it', [b.steps.pr.code, b.steps.merge?.code, b.steps.merge?.outputs.merged, pr(b.number)?.state], [0, 0, 'true', 'merged']);
  check('scheduled run: a different pull request from the review one', b.number !== a.number);
  check('scheduled run: not a draft, no review title', pr(b.number).draft === false && /^chore\(data\): open data /.test(pr(b.number).title));
  check('scheduled run: its body is the scheduled one', !/Review only/.test(pr(b.number).body) && /Collected by `main`\./.test(pr(b.number).body));
  eq('scheduled run: main now carries the scheduled copy', onMain(), 'scheduled run 82');
  eq('the review branch is exactly as the review run left it', tip(`${SCHED}-review-81`), reviewTip);
  eq('...and so is its pull request: open, a draft, its title and body untouched', [pr(a.number).state, pr(a.number).draft, pr(a.number).title, pr(a.number).body, pr(a.number).edits ?? 0], [ra.state, true, ra.title, ra.body, 0]);
  check('the scheduled run never named the review branch or its pull request to GitHub', !ghCalls().slice(ghCalls().findIndex((c) => c.includes(SCHED))).some((c) => c.includes(`${SCHED}-review-81`) || (c[1] !== 'create' && c[2] === String(a.number))));
  const schedCommit = git(world, '--git-dir', origin, 'log', '-1', '--format=%B', tip(SCHED));
  check('scheduled run: its commit says it is the scheduled path', /Publication: scheduled/.test(schedCommit) && schedCommit.includes(`Collected-by: ${MAIN}`), schedCommit);

  // ── 3. another controlled run while the first is still open ──
  const c = publish({ ref: FEATURE, runId: 83, by: 'review run 83' });
  eq('a second review run gets a second branch and pull request', [c.steps.contract.outputs.branch, c.number !== a.number, pr(c.number)?.draft], [`${SCHED}-review-83`, true, true]);
  eq('...and the first is untouched by it', [tip(`${SCHED}-review-81`), onBranch(`${SCHED}-review-81`)], [reviewTip, 'review run 81']);
  eq('...each in a queue of its own', c.group, 'publish-data-review-83');

  // ── 4. a re-run of the first is the same run, and updates its own ──
  const a2 = publish({ ref: FEATURE, runId: 81, by: 'review run 81, attempt 2' });
  eq('a re-run of review run 81 updates its own pull request, not a new one', [a2.number, pr(a.number).edits, onBranch(`${SCHED}-review-81`)], [a.number, 1, 'review run 81, attempt 2']);
  eq('...still a draft, still unmerged', [pr(a.number).draft, pr(a.number).state, !!a2.steps.merge], [true, 'open', false]);

  // ── 5. main's code, marked review-only by the dispatch ──
  const d = publish({ ref: MAIN, runId: 84, by: 'review-only run 84', review: true, merge: true });
  eq('a run from main marked review-only gets its own branch, and merge: true does not merge it', [d.steps.contract.outputs.branch, d.group, !!d.steps.merge, pr(d.number)?.state, pr(d.number)?.draft], [`${SCHED}-review-84`, 'publish-data-review-84', false, 'open', true]);
  eq('...and main still carries the scheduled copy', onMain(), 'scheduled run 82');

  // ── 6. the scheduled path updating its own open pull request ──
  const e = publish({ ref: MAIN, runId: 85, by: 'scheduled run 85, unmerged', merge: false });
  eq('a scheduled run that does not merge leaves its pull request open', [pr(e.number)?.state, !!e.steps.merge], ['open', false]);
  const f = publish({ ref: MAIN, runId: 86, by: 'scheduled run 86' });
  eq('the next scheduled run updates that same pull request and merges it', [f.steps.pr.code, f.number, pr(e.number).state, onMain()], [0, e.number, 'merged', 'scheduled run 86']);

  // ── 7. a pull request left on the scheduled branch by the old road ──
  // What run 81 did: a publisher that predates review branches commits
  // without trailers onto the scheduled branch and opens a pull request.
  {
    const old = tmp('pubreview-old-');
    git(old, 'clone', '-q', '--branch', 'main', origin, 'c');
    const co = join(old, 'c');
    git(co, 'checkout', '-q', '-B', SCHED);
    writeFileSync(join(co, QUEUE), JSON.stringify({ generatedAt: new Date().toISOString(), by: 'controlled run on the old road' }));
    git(co, 'add', '-A');
    execFileSync('git', ['-c', 'user.name=l3vlup-bot', '-c', 'user.email=a@example.invalid', 'commit', '-q', '-m', 'chore(data): open data 2026-10-20 [skip ci]'], { cwd: co });
    git(co, 'push', '-q', '--force', 'origin', `HEAD:refs/heads/${SCHED}`);
    const s = JSON.parse(readFileSync(state, 'utf8'));
    s.prs.push({ number: 192, head: SCHED, base: 'main', title: 'chore(data): open data 2026-10-20', body: 'Collected by `main`.', draft: false, state: 'open' });
    writeFileSync(state, JSON.stringify(s));
  }
  const legacyTip = tip(SCHED);
  const g = publish({ ref: MAIN, runId: 87, by: 'scheduled run 87' });
  check('the scheduled run refuses to rewrite a branch holding a commit it did not make', g.steps.pr.code !== 0 && /carries commit [0-9a-f]{12}, carries no publication trailers/.test(g.steps.pr.log) && /left exactly as it is/.test(g.steps.pr.log), g.steps.pr.log);
  eq('...the branch is exactly as the old road left it', tip(SCHED), legacyTip);
  eq('...its pull request is neither edited nor merged', [pr(192).state, pr(192).edits ?? 0, pr(192).title], ['open', 0, 'chore(data): open data 2026-10-20']);
  eq('...and main still carries the last scheduled copy', onMain(), 'scheduled run 86');
  check('...and no merge was attempted', !g.steps.merge && !ghCalls().some((x) => x[1] === 'merge' && x[2] === '192'));

  // A person closes it; the next scheduled run goes on as usual.
  { const s = JSON.parse(readFileSync(state, 'utf8')); s.prs.find((p) => p.number === 192).state = 'closed'; writeFileSync(state, JSON.stringify(s)); }
  const h = publish({ ref: MAIN, runId: 88, by: 'scheduled run 88' });
  eq('once that pull request is closed, the scheduled run publishes and merges as before', [h.steps.pr.code, pr(h.number)?.state, onMain()], [0, 'merged', 'scheduled run 88']);

  // ── 8. the merge step, given a review branch it should never see ──
  // Belt and braces: the `if:` already keeps it away, so run the script alone.
  {
    const r = spawnSync('bash', [...BASH, MERGE.script], { env: { PATH: `${bin}:/usr/bin:/bin`, NUMBER: String(a.number), BRANCH: `${SCHED}-review-81`, GH_TOKEN: 'x', RUNNER_TEMP: world, GITHUB_OUTPUT: join(world, 'm.out'), FAKE_GH_STATE: state, FAKE_GH_ORIGIN: origin, FAKE_GH_LOG: ghLog }, encoding: 'utf8' });
    check('the merge step refuses a review branch even when reached', r.status !== 0 && /is a review branch/.test(r.stdout + r.stderr), r.stdout + r.stderr);
    const r2 = spawnSync('bash', [...BASH, MERGE.script], { env: { PATH: `${bin}:/usr/bin:/bin`, NUMBER: String(a.number), BRANCH: SCHED, GH_TOKEN: 'x', RUNNER_TEMP: world, GITHUB_OUTPUT: join(world, 'm.out'), FAKE_GH_STATE: state, FAKE_GH_ORIGIN: origin, FAKE_GH_LOG: ghLog }, encoding: 'utf8' });
    check('...and a pull request whose head is not the scheduled branch', r2.status !== 0 && /not the scheduled branch/.test(r2.stdout + r2.stderr), r2.stdout + r2.stderr);
    eq('...so review run 81 is still open', pr(a.number).state, 'open');
  }

  // ── 9. a review run started from a seed (22 October 2026) ──
  // The precedent collector records where it started in the file it writes
  // (startedFrom). The publisher is handed no seed: what it says about one,
  // and whether it refuses one, it reads from that file with main's gate.
  {
    const PRE = 'data/precedent-transactions.auto.json';
    const SEED = 'refs/heads/automation/open-data-refresh-review-81';
    const COMMIT = 'a'.repeat(40);
    const SHA = 'b'.repeat(64);
    const precedents = (run, dataset = 'seed') => ({
      generatedAt: new Date(Date.now() - 30 * 60_000).toISOString(),
      startedFrom: dataset === 'seed'
        ? { dataset, ref: SEED, commit: COMMIT, generatedAt: '2026-10-21T09:12:00Z', sha256: SHA, main: 'c'.repeat(40), run: String(run) }
        : { dataset, ref: MAIN, commit: 'c'.repeat(40), generatedAt: '2026-10-11T17:59:57Z', sha256: 'd'.repeat(64), run: String(run) },
      method: {},
      counts: { transactions: 1 },
      transactions: [{ id: '0000000000-26-000001' }],
    });
    const before = { main: onMain(), sched: tip(SCHED) };

    const s1 = publish({ ref: FEATURE, runId: 89, by: 'seeded review run 89', files: { [PRE]: precedents(89) } });
    const b1 = pr(s1.number)?.body ?? '';
    eq('a seeded review run publishes on its own review branch, as a draft', [s1.steps.pr.code, s1.steps.contract.outputs.branch, pr(s1.number)?.draft, !!s1.steps.merge], [0, `${SCHED}-review-89`, true, false]);
    check('...its body names the seed\'s ref, commit, generatedAt and sha256', b1.includes(`\`${SEED}\``) && b1.includes(`\`${COMMIT}\``) && b1.includes('`2026-10-21T09:12:00Z`') && b1.includes(`\`${SHA}\``), b1.slice(0, 1500));
    check('...and says the guard compared against the seed, the diff against main', /relative to the seed, not to main/.test(b1) && /diff of this pull request is against main/.test(b1), b1.slice(0, 1500));
    check('...after the review notice and before the table', b1.indexOf('Review only') < b1.indexOf('started from a seed') && b1.indexOf('started from a seed') < b1.indexOf('| File |'));

    const s2 = publish({ ref: MAIN, runId: 90, by: 'scheduled run 90, seeded', files: { [PRE]: precedents(90) } });
    check('a scheduled publication of a seeded collection is refused by main\'s gate', s2.steps.pr.code !== 0 && /never on the scheduled branch/.test(s2.steps.pr.log), s2.steps.pr.log);
    eq('...nothing reaches the scheduled branch or main, and nothing is merged', [tip(SCHED), onMain(), !!s2.steps.merge, s2.number ?? null], [before.sched, before.main, false, null]);

    const s3 = publish({ ref: MAIN, runId: 91, by: 'review-only run 91, unseeded', review: true, files: { [PRE]: precedents(91, 'published main') } });
    check('an unseeded review run says it started from published main', s3.steps.pr.code === 0 && /started from published main/.test(pr(s3.number)?.body ?? ''), pr(s3.number)?.body?.slice(0, 1200));

    const s4 = publish({ ref: FEATURE, runId: 92, by: 'review run 92, file from run 89', files: { [PRE]: precedents(89) } });
    check('a precedent file whose record is another run\'s is not described as this run\'s start', /does not record that this run wrote it/.test(pr(s4.number)?.body ?? '') && !(pr(s4.number)?.body ?? '').includes(COMMIT), pr(s4.number)?.body?.slice(0, 1200));

    const s5 = publish({ ref: MAIN, runId: 93, by: 'scheduled run 93', files: { [PRE]: precedents(93, 'published main') } });
    eq('an unseeded scheduled run publishes and merges exactly as before', [s5.steps.pr.code, pr(s5.number)?.state, onMain()], [0, 'merged', 'scheduled run 93']);
    check('...and its body is the scheduled one, with no section about where it started', !/precedent collector started/.test(pr(s5.number)?.body ?? ''));
  }

  // ── 10. the other producers on the same road ──
  for (const producer of ['tracker', 'market-reference', 'ats-registry']) {
    const ctx = { 'github.ref': FEATURE, 'inputs.review': false, 'github.run_id': '91' };
    eq(`${producer}: a run from another branch queues alone`, evaluate(groupExpr, ctx), 'publish-data-review-91');
    eq(`${producer}: a run from main queues with the rest`, evaluate(groupExpr, { ...ctx, 'github.ref': MAIN }), 'publish-data');
  }
} finally {
  for (const d of made) rmSync(d, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
