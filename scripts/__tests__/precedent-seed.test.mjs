/**
 * A review run started from a seed, run for real against git.
 *
 *   node scripts/__tests__/precedent-seed.test.mjs
 *
 * THE FINDING
 * -----------
 * On 22 October 2026 controlled review runs of collect.yml were dispatched
 * from branches carrying an earlier run's data/precedent-transactions.auto.json
 * as their starting state. collect.yml checks out main, so every run started
 * from the file published on 11 October, and progress across review runs
 * could not accumulate.
 *
 * WHAT THIS SHOWS
 * ---------------
 * Against a bare repository standing in for GitHub and a clone of its main
 * standing in for the checkout, with a seed branch that also changes code,
 * workflows and other data:
 *
 *   - an unseeded run changes nothing and records published main;
 *   - a seeded review run takes the two precedent files and nothing else;
 *   - a seed on a run that is not review-only is refused before any fetch;
 *   - a malformed seed (bad JSON, missing keys, a symlink, a missing file,
 *     a branch name that is not one) is refused and changes nothing;
 *   - the precedent guard's baseline is then the seed, read by main's own
 *     collector code, and the file it writes says where it started;
 *   - the publisher's gate refuses a seeded file on the scheduled path and
 *     names the seed in a review body.
 *
 * No network: the only remote is a directory.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applySeed, seedFileProblems } from '../precedent-seed.mjs';
import {
  SEED_PATHS,
  publicationTarget,
  seedBranchProblems,
  seedPublicationProblems,
  startedFrom,
  startedFromLines,
  publicationReport,
} from '../publication-contracts.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

let pass = 0;
let fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass += 1; console.log(`PASS  ${name}`); }
  else { fail += 1; console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const made = [];
const tmp = (p) => { const d = mkdtempSync(join(tmpdir(), p)); made.push(d); return d; };
const GIT_ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 }).trim();
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const MAIN = 'refs/heads/main';
const FEATURE = 'refs/heads/ccr-d7cb454b-j6ri1l-seeded-review';
const PRE = 'data/precedent-transactions.auto.json';
const IDX = 'data/merger-index.auto.json';

// ── fixtures: real rows from the committed database ──────────────────────
// Thirty rows that carry a one-day premium, and twenty that do not. main's
// copy is an older reading that had no premium on the thirty; the seed is the
// reviewed reading that has them. That difference is what the guard is
// asked to protect below.
const real = JSON.parse(readFileSync(join(ROOT, PRE), 'utf8'));
const withPrem = real.transactions.filter((r) => r.status === 'ok' && typeof r.premium1Day === 'number').slice(0, 30);
const without = real.transactions.filter((r) => r.status === 'ok' && r.premium1Day == null).slice(0, 20);
check('the fixture has thirty rows with a premium and twenty without', withPrem.length === 30 && without.length === 20);
const seedRows = [...withPrem, ...without];
const mainRows = seedRows.map((r) => (withPrem.includes(r) ? Object.fromEntries(Object.entries(r).filter(([k]) => !k.startsWith('premium'))) : r));
const dump = (v) => `${JSON.stringify(v, null, 1)}\n`;
const mainFile = dump({ generatedAt: '2026-10-11T17:59:57Z', method: real.method, counts: { transactions: 50 }, transactions: mainRows });
const seedFile = dump({ generatedAt: '2026-10-21T09:12:00Z', method: real.method, counts: { transactions: 50 }, transactions: seedRows });
const mainIndex = dump({ generatedAt: '2026-10-11T17:59:57Z', source: 'form.idx', quarters: { '2026Q3': [{ form: 'DEFM14A', accession: 'm' }] } });
const seedIndex = dump({ generatedAt: '2026-10-21T09:12:00Z', source: 'form.idx', quarters: { '2026Q3': [{ form: 'DEFM14A', accession: 'm' }], '2026Q4': [{ form: 'DEFM14A', accession: 's' }] } });

// ── a GitHub with a main and seed branches ───────────────────────────────
const world = tmp('precseed-');
const origin = join(world, 'origin.git');
git(world, 'init', '-q', '--bare', '-b', 'main', origin);
const work = join(world, 'work');
git(world, 'clone', '-q', origin, work);
git(work, 'checkout', '-q', '-b', 'main');
mkdirSync(join(work, 'data'));
mkdirSync(join(work, 'scripts'));
mkdirSync(join(work, '.github', 'workflows'), { recursive: true });
cpSync(join(ROOT, 'scripts', 'precedent_transactions'), join(work, 'scripts', 'precedent_transactions'), { recursive: true, filter: (s) => !s.includes('__pycache__') });
writeFileSync(join(work, '.gitignore'), '__pycache__/\n');
writeFileSync(join(work, PRE), mainFile);
writeFileSync(join(work, IDX), mainIndex);
writeFileSync(join(work, 'data', 'decks.auto.json'), dump({ generatedAt: '2026-10-11T00:00:00Z', decks: [] }));
writeFileSync(join(work, '.github', 'workflows', 'collect.yml'), 'name: main\n');
git(work, 'add', '-A');
git(work, 'commit', '-q', '-m', 'main');
git(work, 'push', '-q', 'origin', 'main');
const mainCommit = git(work, 'rev-parse', 'HEAD');

/** A branch on origin: main plus `change(dir)`. */
function branch(name, change) {
  git(work, 'checkout', '-q', '-B', name, 'main');
  change(work);
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', name);
  git(work, 'push', '-q', '--force', 'origin', `HEAD:refs/heads/${name}`);
  const c = git(work, 'rev-parse', 'HEAD');
  git(work, 'checkout', '-q', 'main');
  return c;
}

// The seed a person means: an earlier review run's branch. It also carries
// code, a workflow and other data, none of which may reach the checkout.
const SEED = 'automation/open-data-refresh-review-81';
const seedCommit = branch(SEED, (d) => {
  writeFileSync(join(d, PRE), seedFile);
  writeFileSync(join(d, IDX), seedIndex);
  writeFileSync(join(d, 'scripts', 'precedent_transactions', 'guard.py'), '# a seed branch rewrote the guard\nMAX_FIELD_LOSS = 1.0\n');
  writeFileSync(join(d, 'scripts', 'payload.mjs'), 'process.exit(0);\n');
  writeFileSync(join(d, '.github', 'workflows', 'collect.yml'), 'name: rewritten by the seed\n');
  writeFileSync(join(d, 'data', 'decks.auto.json'), dump({ generatedAt: '2026-10-21T00:00:00Z', decks: ['from the seed'] }));
  writeFileSync(join(d, 'data', 'other.auto.json'), dump({ from: 'seed' }));
});

const bad = {
  'seed/bad-json': (d) => writeFileSync(join(d, PRE), '{"generatedAt": "2026-10-21T09:12:00Z", "transactions": ['),
  'seed/no-transactions': (d) => writeFileSync(join(d, PRE), dump({ generatedAt: '2026-10-21T09:12:00Z', method: {}, counts: {} })),
  'seed/empty': (d) => writeFileSync(join(d, PRE), dump({ generatedAt: '2026-10-21T09:12:00Z', method: {}, counts: {}, transactions: [] })),
  'seed/no-id': (d) => writeFileSync(join(d, PRE), dump({ generatedAt: '2026-10-21T09:12:00Z', method: {}, counts: {}, transactions: [{ status: 'ok' }] })),
  'seed/twice': (d) => writeFileSync(join(d, PRE), dump({ generatedAt: '2026-10-21T09:12:00Z', method: {}, counts: {}, transactions: [{ id: 'a' }, { id: 'a' }] })),
  'seed/no-stamp': (d) => writeFileSync(join(d, PRE), dump({ method: {}, counts: {}, transactions: [{ id: 'a' }] })),
  'seed/a-list': (d) => writeFileSync(join(d, PRE), dump([{ id: 'a' }])),
  'seed/index-no-quarters': (d) => { writeFileSync(join(d, PRE), seedFile); writeFileSync(join(d, IDX), dump({ generatedAt: '2026-10-21T09:12:00Z', source: 'x' })); },
  'seed/index-odd-quarter': (d) => { writeFileSync(join(d, PRE), seedFile); writeFileSync(join(d, IDX), dump({ generatedAt: '2026-10-21T09:12:00Z', source: 'x', quarters: { '../x': [] } })); },
  'seed/no-index': (d) => { writeFileSync(join(d, PRE), seedFile); unlinkSync(join(d, IDX)); },
  'seed/symlink': (d) => { unlinkSync(join(d, PRE)); symlinkSync('/etc/passwd', join(d, PRE)); writeFileSync(join(d, IDX), seedIndex); },
  'seed/directory': (d) => { unlinkSync(join(d, IDX)); mkdirSync(join(d, IDX)); writeFileSync(join(d, IDX, 'x'), '{}'); writeFileSync(join(d, PRE), seedFile); },
};
for (const [name, change] of Object.entries(bad)) branch(name, change);

/** A fresh checkout of main, as actions/checkout leaves one. */
function checkout() {
  const d = join(tmp('precseed-co-'), 'c');
  git(dirname(d), 'clone', '-q', '--branch', 'main', origin, d);
  return d;
}
const status = (d) => git(d, 'status', '--porcelain=v1', '--untracked-files=all');
const file = (d, p) => readFileSync(join(d, p));

try {
  // ── 1. an unseeded run behaves exactly as today ──
  for (const [ref, review] of [[MAIN, ''], [MAIN, 'false'], [MAIN, 'true'], [FEATURE, '']]) {
    const d = checkout();
    const r = applySeed({ cwd: d, seed: '', ref, runId: '91', review });
    eq(`unseeded (${ref}, review ${JSON.stringify(review)}): nothing refused, nothing seeded`, [r.problems, r.seeded], [[], false]);
    eq('...and the checkout is exactly main', [status(d), git(d, 'rev-parse', 'HEAD')], ['', mainCommit]);
    eq('...and nothing was fetched', existsSync(join(d, '.git', 'FETCH_HEAD')), false);
    eq('...the record says published main, at the checkout\'s commit, with the file\'s stamp and hash', r.record, { dataset: 'published main', ref: MAIN, commit: mainCommit, generatedAt: '2026-10-11T17:59:57Z', sha256: sha(Buffer.from(mainFile)), run: '91' });
  }

  // ── 2. a seeded review run takes the two data files and nothing else ──
  for (const [ref, review, why] of [[MAIN, 'true', 'from main, marked review-only'], [FEATURE, '', 'from another branch, review-only without asking'], [FEATURE, 'false', 'from another branch, whatever the flag says']]) {
    const d = checkout();
    const r = applySeed({ cwd: d, seed: SEED, ref, runId: '92', review });
    eq(`seeded ${why}: accepted`, [r.problems, r.seeded], [[], true]);
    eq('...exactly the two precedent files differ from main', status(d).split('\n').map((l) => l.trim().split(/\s+/).pop()).sort(), [...SEED_PATHS].sort());
    check('...each byte for byte the seed\'s', file(d, PRE).equals(Buffer.from(seedFile)) && file(d, IDX).equals(Buffer.from(seedIndex)));
    check('...the seed\'s guard, script, workflow and other data are nowhere in the checkout',
      readFileSync(join(d, 'scripts', 'precedent_transactions', 'guard.py'), 'utf8') === readFileSync(join(ROOT, 'scripts', 'precedent_transactions', 'guard.py'), 'utf8') &&
      !existsSync(join(d, 'scripts', 'payload.mjs')) && !existsSync(join(d, 'data', 'other.auto.json')) &&
      readFileSync(join(d, '.github', 'workflows', 'collect.yml'), 'utf8') === 'name: main\n' &&
      !readFileSync(join(d, 'data', 'decks.auto.json'), 'utf8').includes('from the seed'));
    eq('...HEAD is still main, and no branch was made', [git(d, 'rev-parse', 'HEAD'), git(d, 'branch', '--format=%(refname:short)')], [mainCommit, 'main']);
    eq('...the record names the seed, its commit, its stamp and its hash, and the main it replaced', r.record, {
      dataset: 'seed', ref: `refs/heads/${SEED}`, commit: seedCommit, generatedAt: '2026-10-21T09:12:00Z', sha256: sha(Buffer.from(seedFile)),
      mergerIndex: { generatedAt: '2026-10-21T09:12:00Z', sha256: sha(Buffer.from(seedIndex)) }, main: mainCommit, run: '92',
    });
  }

  // ── 3. a seed on a run that is not review-only is refused ──
  for (const review of ['', 'false', undefined]) {
    const d = checkout();
    const r = applySeed({ cwd: d, seed: SEED, ref: MAIN, runId: '93', review });
    check(`a seed on a scheduled run (review ${JSON.stringify(review)}) is refused as review-only`, r.problems.some((p) => /review-only/.test(p)) && !r.record, JSON.stringify(r.problems));
    eq('...before anything is fetched, and the checkout is main', [existsSync(join(d, '.git', 'FETCH_HEAD')), status(d)], [false, '']);
  }
  eq('publicationTarget: a seeded scheduled run is no run at all', publicationTarget('open-data', { ref: MAIN, runId: '1', seed: SEED }).problems.length, 1);
  eq('publicationTarget: a seeded review run is a review run that says it is seeded', (({ review, seeded, branch }) => ({ review, seeded, branch }))(publicationTarget('open-data', { ref: MAIN, runId: '1', review: 'true', seed: SEED })), { review: true, seeded: true, branch: 'automation/open-data-refresh-review-1' });
  eq('publicationTarget: an unseeded run is exactly as before', (({ problems, review, seeded, branch, kind }) => ({ problems, review, seeded, branch, kind }))(publicationTarget('open-data', { ref: MAIN, runId: '1' })), { problems: [], review: false, seeded: false, branch: 'automation/open-data-refresh', kind: 'scheduled' });
  check('publicationTarget: only open-data can be seeded', publicationTarget('tracker', { ref: FEATURE, runId: '1', seed: SEED }).problems.length > 0);
  check('publicationTarget: a seed with a newline in it is refused', publicationTarget('open-data', { ref: FEATURE, runId: '1', seed: 'a\nb' }).problems.length > 0);

  // ── 4. a malformed seed is refused, and changes nothing ──
  const expect = {
    'seed/bad-json': /is not JSON/, 'seed/no-transactions': /no transactions array/, 'seed/empty': /holds no transactions/, 'seed/no-id': /with no id/,
    'seed/twice': /id\(s\) twice/, 'seed/no-stamp': /no readable generatedAt/, 'seed/a-list': /not a JSON object/, 'seed/index-no-quarters': /no quarters object/,
    'seed/index-odd-quarter': /not a quarter's list/, 'seed/no-index': /has no data\/merger-index/, 'seed/symlink': /not a regular file \(mode 120000/, 'seed/directory': /not a regular file|has no data\/merger-index/,
  };
  for (const [name, why] of Object.entries(expect)) {
    const d = checkout();
    const r = applySeed({ cwd: d, seed: name, ref: FEATURE, runId: '94', review: '' });
    check(`a malformed seed (${name}) is refused`, r.problems.some((p) => why.test(p)) && !r.record, JSON.stringify(r.problems));
    eq('...and the checkout is exactly main', status(d), '');
  }
  for (const name of ['../main', '-x', 'a b', 'refs/heads/' + SEED, 'x.lock', 'a//b', '.hidden', 'a/.b', 'a..b', 'x/', `a\`b`, 'a;rm -rf /', 'a$(id)', 'é']) {
    const d = checkout();
    const r = applySeed({ cwd: d, seed: name, ref: FEATURE, runId: '95', review: '' });
    check(`a seed named ${JSON.stringify(name)} is refused before anything is fetched`, r.problems.length > 0 && !existsSync(join(d, '.git', 'FETCH_HEAD')) && status(d) === '', JSON.stringify(r.problems));
  }
  {
    const d = checkout();
    const r = applySeed({ cwd: d, seed: 'no-such-branch', ref: FEATURE, runId: '96', review: '' });
    check('a seed branch that does not exist is refused', r.problems.some((p) => /could not be fetched/.test(p)) && status(d) === '', JSON.stringify(r.problems));
  }
  {
    const d = checkout();
    writeFileSync(join(d, 'data', 'decks.auto.json'), '{}');
    const r = applySeed({ cwd: d, seed: SEED, ref: FEATURE, runId: '97', review: '' });
    check('a checkout that already differs from main is not seeded', r.problems.some((p) => /already differs/.test(p)), JSON.stringify(r.problems));
  }
  eq('seedBranchProblems accepts a review run\'s branch', seedBranchProblems('automation/open-data-refresh-review-36235700643'), []);
  eq('seedFileProblems accepts the committed database and index as they are', [seedFileProblems(PRE, readFileSync(join(ROOT, PRE))), seedFileProblems(IDX, readFileSync(join(ROOT, IDX)))], [[], []]);
  check('seedFileProblems refuses any other path', seedFileProblems('data/decks.auto.json', '{"generatedAt":"2026-10-21T00:00:00Z"}').length > 0);

  // ── 5. the CLI, as collect.yml runs it ──
  const cli = join(ROOT, 'scripts', 'precedent-seed.mjs');
  const run = (cwd, args) => spawnSync(process.execPath, [cli, ...args], { cwd, env: GIT_ENV, encoding: 'utf8' });
  {
    const d = checkout();
    const rec = join(dirname(d), 'start.json');
    const r = run(d, ['--seed', SEED, '--ref', FEATURE, '--run-id', '98', '--review', '', '--record', rec]);
    const out = Object.fromEntries(r.stdout.trim().split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
    eq('CLI: a seeded review run prints its step outputs', [r.status, out.seeded, out.record, out.commit, out.sha256, out.generated_at], [0, 'true', rec, seedCommit, sha(Buffer.from(seedFile)), '2026-10-21T09:12:00Z']);
    eq('CLI: ...writes the record where it was told, outside the checkout', JSON.parse(readFileSync(rec, 'utf8')).commit, seedCommit);
    check('CLI: ...and says on stderr that the guard compares against the seed', /baseline is this seed/.test(r.stderr), r.stderr);
    const r2 = run(checkout(), ['--seed', '', '--ref', MAIN, '--run-id', '99', '--review', '', '--record', join(dirname(d), 'start2.json')]);
    check('CLI: the monthly schedule (no seed, no inputs) records published main and succeeds', r2.status === 0 && /^seeded=false$/m.test(r2.stdout), r2.stdout + r2.stderr);
    const d3 = checkout();
    const r3 = run(d3, ['--seed', SEED, '--ref', MAIN, '--run-id', '100', '--review', 'false', '--record', join(dirname(d3), 's3.json')]);
    check('CLI: a seed on a run that is not review-only exits 1, with an error annotation, having changed nothing', r3.status === 1 && /::error::a run started from a seed is review-only/.test(r3.stderr) && status(d3) === '' && !existsSync(join(dirname(d3), 's3.json')), r3.stderr);
    const d4 = checkout();
    const r4 = run(d4, ['--seed', SEED, '--ref', FEATURE, '--run-id', '101', '--review', '', '--record', join(d4, 'start.json')]);
    check('CLI: a record inside the checkout is refused, or the collection would publish it', r4.status === 2 && status(d4) === '', r4.stderr);
  }

  // ── 6. the guard's baseline is the seed, read by main's own collector ──
  // The seed step has run; the collector starts. Its first read of the file
  // is the guard's baseline, and that file is now the seed.
  {
    const d = checkout();
    const r = applySeed({ cwd: d, seed: SEED, ref: FEATURE, runId: '102', review: '' });
    const rec = join(dirname(d), 'start.json');
    writeFileSync(rec, JSON.stringify(r.record));
    const py = `
import copy, json, os, sys
sys.path.insert(0, "scripts")
from precedent_transactions import database, guard
rows = database.load_stored()
seed = {r["id"]: r for r in json.load(open(sys.argv[1]))["transactions"]}
main = {r["id"]: r for r in json.load(open(sys.argv[2]))["transactions"]}
out = {"baselineIsSeed": database._baseline == seed, "baselineIsMain": database._baseline == main}
# A run that loses the thirty premiums without a reader moving: against the
# seed they are put back; against main there was nothing to put back.
cur = copy.deepcopy(rows)
lost = [k for k, r in cur.items() if r.get("premium1Day") is not None]
for k in lost:
    cur[k].pop("premium1Day")
rep = guard.protect(database._baseline, cur)
out["lost"] = len(lost)
out["keptAgainstSeed"] = sum(1 for k in rep["keptPrior"] if k["field"] == "premium1Day")
out["restored"] = sum(1 for k in lost if cur[k].get("premium1Day") is not None)
cur2 = copy.deepcopy(rows)
for k in lost:
    cur2[k].pop("premium1Day")
out["keptAgainstMain"] = sum(1 for k in guard.protect(main, cur2)["keptPrior"] if k["field"] == "premium1Day")
written = database.write(copy.deepcopy(rows))
out["startedFrom"] = written["startedFrom"]
out["onDisk"] = json.load(open(database.OUT))["startedFrom"]
os.environ.pop("PRECEDENTS_STARTED_FROM")
out["unrecorded"] = database.started_from()
print(json.dumps(out))
`;
    const seedPath = join(dirname(d), 'seed.json');
    const mainPath = join(dirname(d), 'main.json');
    writeFileSync(seedPath, seedFile);
    writeFileSync(mainPath, mainFile);
    const p = spawnSync('python3', ['-c', py, seedPath, mainPath], { cwd: d, env: { ...process.env, PRECEDENTS_STARTED_FROM: rec, RUNNER_TEMP: dirname(d), PYTHONDONTWRITEBYTECODE: '1' }, encoding: 'utf8' });
    let o = {};
    try { o = JSON.parse(p.stdout.trim().split('\n').pop()); } catch { /* reported below */ }
    check('the collector ran over the seeded checkout', p.status === 0, p.stderr.slice(-600));
    eq('the guard\'s baseline is the seed, row for row, and not main', [o.baselineIsSeed, o.baselineIsMain], [true, false]);
    eq('thirty premiums lost without a cause are put back from the seed', [o.lost, o.keptAgainstSeed, o.restored], [30, 30, 30]);
    eq('...where main as the baseline would have had nothing to put back', o.keptAgainstMain, 0);
    eq('the file the collector writes says it started from the seed', o.startedFrom, r.record);
    eq('...on disk too, which is what the publisher will read', o.onDisk, r.record);
    eq('outside the workflow, with no record, it describes the file it first read (the seed)', o.unrecorded, { dataset: 'file on disk', generatedAt: '2026-10-21T09:12:00Z', sha256: sha(Buffer.from(seedFile)) });

    // ── 7. what the publisher's gate does with that file ──
    const written = JSON.parse(readFileSync(join(d, PRE), 'utf8'));
    const read = (path) => (path === PRE ? written : undefined);
    const staged = [PRE, IDX];
    check('the scheduled path refuses a collection that started from a seed', seedPublicationProblems('open-data', { staged, read }, { review: false }).some((x) => /never on the scheduled branch/.test(x)));
    eq('...a review publication of it is not refused', seedPublicationProblems('open-data', { staged, read }, { review: true }), []);
    eq('...an unseeded file is never refused', seedPublicationProblems('open-data', { staged, read: () => ({ startedFrom: { dataset: 'published main' } }) }, { review: false }), []);
    eq('...nor is a run that did not touch the precedent file', seedPublicationProblems('open-data', { staged: [IDX], read }, { review: false }), []);
    const lines = startedFromLines('open-data', { staged, read }, '102').join('\n');
    check('the review body names the seed\'s ref and commit', lines.includes(`\`refs/heads/${SEED}\``) && lines.includes(`\`${seedCommit}\``), lines);
    check('...its precedent file\'s generatedAt and sha256', lines.includes('`2026-10-21T09:12:00Z`') && lines.includes(`\`${sha(Buffer.from(seedFile))}\``), lines);
    check('...and says the guard compared against the seed while the diff is against main', /relative to the seed, not to main/.test(lines) && /diff of this pull request is against main/.test(lines), lines);
    const other = startedFromLines('open-data', { staged, read }, '103').join('\n');
    check('a record written by another run is not presented as this run\'s start', /does not record that this run wrote it/.test(other) && !other.includes(seedCommit), other);
    const body = publicationReport({ producer: 'open-data', stats: [], staged, ref: FEATURE, review: { ref: FEATURE }, started: startedFromLines('open-data', { staged, read }, '102') });
    check('a review body carries the seed section after the review notice', body.indexOf('Review only') > -1 && body.indexOf('Review only') < body.indexOf('started from a seed') && body.indexOf('started from a seed') < body.indexOf('| File |'), body.slice(0, 1200));
    const sched = publicationReport({ producer: 'open-data', stats: [], staged, ref: 'main' });
    check('the scheduled body has no such section', !/precedent collector started/.test(sched));
    const evil = startedFrom({ startedFrom: { dataset: 'seed', ref: 'refs/heads/a`<b>', commit: 'x', sha256: 'y', generatedAt: '<script>', run: '1' } });
    eq('a record outside its shape is described, never quoted', [evil.ref, evil.commit, evil.sha256, evil.generatedAt], [null, null, null, null]);

    // The gate's CLI, as the publisher runs it, in the seeded checkout.
    const cliGate = join(ROOT, 'scripts', 'validate-data-publication.mjs');
    const list = join(dirname(d), 'staged.txt');
    writeFileSync(list, `${staged.join('\n')}\n`);
    const gate = (extra) => spawnSync(process.execPath, [cliGate, '--producer', 'open-data', '--staged', list, '--report', join(dirname(d), 'body.md'), ...extra], { cwd: d, env: { ...GIT_ENV, GITHUB_RUN_ID: '102' }, encoding: 'utf8' });
    const sch = gate(['--ref', 'main']);
    check('CLI gate: the scheduled publication of a seeded file exits 1, with the reason on stderr where the publisher keeps it', sch.status === 1 && /::error::.*never on the scheduled branch/.test(sch.stderr), sch.stdout + sch.stderr);
    const rev = gate(['--ref', FEATURE, '--review', FEATURE, '--base', mainCommit]);
    const md = existsSync(join(dirname(d), 'body.md')) ? readFileSync(join(dirname(d), 'body.md'), 'utf8') : '';
    check('CLI gate: the review publication passes and its body names the seed', rev.status === 0 && md.includes(`refs/heads/${SEED}`) && md.includes(sha(Buffer.from(seedFile))) && md.includes('2026-10-21T09:12:00Z'), rev.stdout + rev.stderr + md.slice(0, 300));
    const pre = spawnSync(process.execPath, [cliGate, '--producer', 'open-data', '--staged', list], { cwd: d, env: GIT_ENV, encoding: 'utf8' });
    check('CLI gate: the collecting job\'s pre-flight, which writes no body and cannot know the path, does not refuse it', pre.status === 0, pre.stdout + pre.stderr);
  }
} finally {
  for (const d of made) rmSync(d, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
