/**
 * The safety contract generated data must meet before it can persist to main
 * without a person merging it. Four rules:
 *
 *   G1  only data collected by main's own code may be merged automatically
 *   G2  a staged file may not be older than the copy already on main
 *   G3  a dated board-check observation is written once
 *   G4  open-data collections run one at a time, and publications queue
 *
 * G2 and G3 are exercised through the real gate, and G3's restore step
 * through the real script against throwaway git repositories, including the
 * case where main gains the day's file while a collection is running. G1 and
 * G4 are properties of the workflow files and are read from them. No
 * network, no clock but the fixtures'.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONTRACTS, contractProblems, staleProblems, immutableProblems, immutablePaths, intrinsicStamp, archiveMemberProblems } from '../publication-contracts.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const RESTORE = join(ROOT, 'scripts', 'keep-published-observations.mjs');

let pass = 0;
let fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass += 1; console.log(`PASS  ${name}`); }
  else { fail += 1; console.log(`FAIL  ${name}${detail ? `   ${detail}` : ''}`); }
};
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
const has = (problems, text) => problems.some((p) => p.includes(text));

const spec = (producer, path) => CONTRACTS[producer].files.find((f) => f.path === path);
const STALE = 'older than the copy on main';

// ── G2: stale-overwrite protection ───────────────────────────────────────
{
  const cal = spec('open-data', 'data/calendar.auto.json');
  const at = (t) => ({ generatedAt: t, events: [] });
  eq('a newer copy is publishable', staleProblems(cal, at('2026-09-27T10:00:00Z'), at('2026-09-26T10:00:00Z')), []);
  eq('an equal stamp is publishable (a rerun that changed nothing it stamps)', staleProblems(cal, at('2026-09-27T10:00:00Z'), at('2026-09-27T10:00:00Z')), []);
  check('an older copy is refused', has(staleProblems(cal, at('2026-09-26T09:00:00Z'), at('2026-09-27T10:00:00Z')), STALE));
  check('...even by a single second', has(staleProblems(cal, at('2026-09-27T09:59:59Z'), at('2026-09-27T10:00:00Z')), STALE));
  eq('a first publication has nothing to be older than', staleProblems(cal, at('2026-09-27T10:00:00Z'), null), []);
  eq('a main copy with no readable stamp is not a baseline', staleProblems(cal, at('2026-09-27T10:00:00Z'), { events: [] }), []);
  check('a new copy with no readable stamp, over a stamped one, is refused', has(staleProblems(cal, { events: [] }, at('2026-09-27T10:00:00Z')), 'cannot be shown to be newer'));
  check('a stamp that does not parse counts as unreadable', has(staleProblems(cal, at('not a date'), at('2026-09-27T10:00:00Z')), 'cannot be shown to be newer'));

  // The field comes from each file's own contract, not a guess.
  const ledger = spec('tracker', 'data/deadlines.learned.json');
  eq('the deadline ledger is judged on updatedAt, its own field', intrinsicStamp(ledger, { updatedAt: '2026-09-27T00:00:00Z' }).field, 'updatedAt');
  check('...and an older ledger is refused', has(staleProblems(ledger, { updatedAt: '2026-09-25T00:00:00Z' }, { updatedAt: '2026-09-26T00:00:00Z' }), STALE));
  eq('...a generatedAt on the ledger is not read in its place', staleProblems(ledger, { generatedAt: '2020-01-01T00:00:00Z', updatedAt: '2026-09-27T00:00:00Z' }, { updatedAt: '2026-09-26T00:00:00Z' }), []);

  // A shape-only file carries a stamp too, and fileProblems returns early for
  // those, which is why G2 is its own pass.
  const slugs = spec('tracker', 'data/tracker-slugs.json');
  check('a shape-only file with a generation stamp is judged', slugs.shapeOnly && has(staleProblems(slugs, { generatedAt: '2026-09-25T00:00:00Z' }, { generatedAt: '2026-09-26T00:00:00Z' }), STALE));

  // Files whose freshness is read from a commit, or which have no cadence
  // stamp, are not judged: git and filesystem times say when bytes moved.
  const snaps = spec('open-data', 'data/career-snapshots.json');
  eq('a commit-dated file is not judged on any timestamp', [snaps.freshness.from, staleProblems(snaps, { generatedAt: '2020-01-01T00:00:00Z' }, { generatedAt: '2026-09-27T00:00:00Z' })], ['commit', []]);
  const history = spec('tracker', 'data/tracker-history.json');
  eq('a manual-cadence file is not judged', staleProblems(history, { generatedAt: '2020-01-01T00:00:00Z' }, { generatedAt: '2026-09-27T00:00:00Z' }), []);

  // Through the whole gate, as the publisher runs it.
  const fresh = new Date().toISOString();
  const older = new Date(Date.now() - 3_600_000).toISOString();
  const event = { date: '2026-09-21', time: '09:00', tz: 'UTC', country: 'US', title: 'CPI', importance: 'high', source: 'BLS', url: 'https://example.invalid' };
  const run = (nextStamp, prevStamp) => contractProblems('open-data', {
    staged: ['data/calendar.auto.json'],
    read: () => ({ generatedAt: nextStamp, events: Array.from({ length: 34 }, () => event) }),
    readPrev: () => ({ generatedAt: prevStamp, events: Array.from({ length: 34 }, () => event) }),
    existedBefore: () => true,
  }).problems;
  check('the gate refuses a run that would roll main back', has(run(older, fresh), STALE));
  check('the gate passes the same run the right way round', !has(run(fresh, older), STALE));
}

// ── G3: immutable dated observations, in the gate ────────────────────────
{
  const d1 = 'data/board-checks/2026-09-28.json';
  const d2 = 'data/board-checks/2026-09-29.json';
  const onMain = (paths) => (p) => paths.includes(p);
  eq('first observation of a date is publishable', immutableProblems('tracker', [d1], onMain([])), []);
  check('a same-date replacement is refused', has(immutableProblems('tracker', [d1], onMain([d1])), 'written once'));
  eq('the next date is publishable beside a published one', immutableProblems('tracker', [d2], onMain([d1])), []);
  check('a deleted observation is refused like a replaced one', has(immutableProblems('tracker', [d1], onMain([d1])), d1));
  eq('the rule is scoped to the dated files: the feed may change every run', immutableProblems('tracker', ['data/opportunities.auto.json'], onMain(['data/opportunities.auto.json'])), []);
  eq('only the board-check family is immutable today', CONTRACTS.tracker.files.filter((f) => f.immutable).map((f) => String(f.pattern)), [String(/^data\/board-checks\/\d{4}-\d{2}-\d{2}\.json$/)]);
  eq('no other producer has an immutable path', ['open-data', 'ats-registry'].map((p) => CONTRACTS[p].files.filter((f) => f.immutable).length), [0, 0]);
  check('a caller that cannot say what main holds is treated as replacing', has(contractProblems('tracker', { staged: [d1], read: () => ({}), readPrev: () => null }).problems, 'written once'));
  eq('immutablePaths picks out only the dated files', immutablePaths('tracker', [d1, 'data/opportunities.auto.json', 'samples/x.xlsx']), [d1]);
}

// ── G3: the restore step, against real git repositories ──────────────────
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'persist-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@example.invalid');
  git(dir, 'config', 'user.name', 't');
  mkdirSync(join(dir, 'data', 'board-checks'), { recursive: true });
  return dir;
}
const put = (dir, path, body) => writeFileSync(join(dir, path), JSON.stringify(body));
const commit = (dir, msg) => { git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', msg); };
const restore = (dir) => execFileSync(process.execPath, [RESTORE, '--producer', 'tracker'], { cwd: dir, encoding: 'utf8' });
const stagedAfterRestore = (dir) => { restore(dir); git(dir, 'add', '-A'); return git(dir, 'diff', '--cached', '--name-only').split('\n').filter(Boolean).sort(); };
const FEED = 'data/opportunities.auto.json';
const D1 = 'data/board-checks/2026-09-28.json';
const D2 = 'data/board-checks/2026-09-29.json';
const dirs = [];
try {
  {
    // First observation: main has none for the day; the run's file is new.
    const dir = repo(); dirs.push(dir);
    put(dir, FEED, { generatedAt: 'a' }); commit(dir, 'main');
    put(dir, FEED, { generatedAt: 'b' }); put(dir, D1, { checkedAt: 'morning' });
    eq('restore: a first observation is left as written and staged', stagedAfterRestore(dir), [D1, FEED]);
  }
  {
    // Same-day rerun: main already has the day's file; the rerun rewrote it.
    const dir = repo(); dirs.push(dir);
    put(dir, FEED, { generatedAt: 'a' }); put(dir, D1, { checkedAt: 'morning' }); commit(dir, 'main');
    put(dir, FEED, { generatedAt: 'b' }); put(dir, D1, { checkedAt: 'afternoon' });
    const out = restore(dir);
    check('restore: a same-day rerun names the observation it kept', out.includes(D1));
    eq('restore: ...and main\'s observation is what remains', JSON.parse(readFileSync(join(dir, D1), 'utf8')), { checkedAt: 'morning' });
    git(dir, 'add', '-A');
    eq('restore: ...while the refreshed feed is still staged', git(dir, 'diff', '--cached', '--name-only').split('\n').filter(Boolean), [FEED]);
  }
  {
    // Next date: yesterday's file untouched, today's new.
    const dir = repo(); dirs.push(dir);
    put(dir, FEED, { generatedAt: 'a' }); put(dir, D1, { checkedAt: 'day 1' }); commit(dir, 'main');
    put(dir, FEED, { generatedAt: 'b' }); put(dir, D2, { checkedAt: 'day 2' });
    eq('restore: the next date is staged and the previous one untouched', stagedAfterRestore(dir), [D2, FEED]);
  }
  {
    // Rerun after main advanced: the collection began before main had the
    // day's file (so its archive carries one), and by the time it publishes
    // main has one. The publisher checks out that newer main, unpacks the
    // archive over it, and must keep main's copy.
    const dir = repo(); dirs.push(dir);
    put(dir, FEED, { generatedAt: 'a' }); commit(dir, 'old main');
    put(dir, FEED, { generatedAt: 'b' }); put(dir, D1, { checkedAt: 'first run' }); commit(dir, 'main advances: the first run published');
    // What the second run's archive unpacks: its own feed and its own copy of the day.
    put(dir, FEED, { generatedAt: 'c' }); put(dir, D1, { checkedAt: 'second run' });
    eq('restore after main advanced: only the feed is staged', stagedAfterRestore(dir), [FEED]);
    eq('...and the day is still the first run\'s', JSON.parse(readFileSync(join(dir, D1), 'utf8')), { checkedAt: 'first run' });
  }
  {
    // A run that deleted the day's file gets it back.
    const dir = repo(); dirs.push(dir);
    put(dir, D1, { checkedAt: 'morning' }); commit(dir, 'main');
    rmSync(join(dir, D1));
    restore(dir);
    check('restore: a deleted observation is put back', existsSync(join(dir, D1)));
  }
  {
    // The restore step can only put main's bytes back: it never adds a path.
    const dir = repo(); dirs.push(dir);
    put(dir, FEED, { generatedAt: 'a' }); commit(dir, 'main');
    put(dir, FEED, { generatedAt: 'b' });
    const before = git(dir, 'status', '--porcelain');
    restore(dir);
    eq('restore: with no observation rewritten it changes nothing', git(dir, 'status', '--porcelain'), before);
  }
} finally {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
}

// ── nothing but data through the publisher ───────────────────────────────
{
  const refused = (members) => archiveMemberProblems('tracker', members).length > 0;
  check('an archive carrying a workflow is refused', refused([FEED, '.github/workflows/build-samples.yml']));
  check('an archive carrying a script is refused', refused([FEED, 'scripts/keep-published-observations.mjs']));
  check('an archive carrying the contract itself is refused', refused(['scripts/publication-contracts.mjs']));
  check('an archive carrying a manifest is refused', refused(['package.json']));
  check('an archive carrying code under data/ is refused', refused(['data/board-checks/x.mjs']));
  check('an archive reaching outside the tree is refused', refused(['../outside.json']));
  check('a board-check name outside the dated pattern is refused', refused(['data/board-checks/latest.json']));
  eq('an archive of the tracker\'s own data files is accepted', archiveMemberProblems('tracker', [FEED, D1]), []);
}

// ── G1 and G4: the workflow files themselves ─────────────────────────────
const wf = (f) => readFileSync(join(ROOT, '.github', 'workflows', f), 'utf8');
{
  const pub = wf('publish-data.yml');
  check('G1: the merge step requires the caller\'s ref to be main', /name: Merge the data pull request\n\s+id: merge\n\s+if: steps\.pr\.outputs\.number != '' && inputs\.merge && github\.ref == 'refs\/heads\/main'/.test(pub));
  const notice = pub.split('- name: ').find((s) => s.startsWith('Leave a collection from another branch'));
  check('G1: a collection from another branch is announced, not merged', notice && /github\.ref != 'refs\/heads\/main'/.test(notice) && !/gh pr merge/.test(notice));
  check('G1: the branch name reaches the shell only through the environment', notice && !/run:.*\$\{\{/.test(notice));
  const restoreAt = pub.indexOf('keep-published-observations.mjs --producer "$PRODUCER"');
  const unpackAt = pub.indexOf('tar -xf "$archive"');
  // The first `git add -A` after unpacking (the phrase also appears in comments above).
  const stageAt = pub.indexOf('git add -A', unpackAt);
  check('G3: the publisher restores observations after unpacking and before staging', unpackAt > -1 && restoreAt > unpackAt && restoreAt < stageAt);
  check('G3: ...and still runs the gate on what it staged', pub.indexOf('validate-data-publication.mjs', restoreAt) > restoreAt);
  const bs = wf('build-samples.yml');
  const stage = bs.slice(bs.indexOf('- name: Stage the collection'));
  check('G3: the tracker restores observations before it stages', stage.indexOf('keep-published-observations.mjs --producer tracker') > -1 && stage.indexOf('keep-published-observations.mjs') < stage.indexOf('git add -A'));

  const conc = (text) => {
    const m = text.match(/^concurrency:\n\s+group: (\S+)\n\s+cancel-in-progress: (\S+)/m);
    return m ? [m[1], m[2]] : null;
  };
  eq('G4: open-data collections share one group and are never cancelled', conc(wf('collect.yml')), ['collect-open-data', 'false']);
  eq('G4: the tracker already has its own', conc(wf('build-samples.yml')), ['build-samples', 'false']);
  eq('G4: so does discovery', conc(wf('discover-ats.yml')), ['discover-ats', 'false']);
  eq('G4: publications queue repository-wide and are never cancelled', conc(pub), ['publish-data', 'false']);
  const groups = ['collect.yml', 'build-samples.yml', 'discover-ats.yml'].map((f) => conc(wf(f))[0]);
  eq('G4: no producer shares the publication queue\'s group (it would deadlock behind itself)', groups.includes('publish-data'), false);

  // Which producers merge their own publication. open-data does, having
  // shown both halves of the road (#81); the others do not yet, and the
  // ATS registry never does, since it steers which hosts are collected.
  const MERGES = { 'collect.yml': 'true', 'build-samples.yml': 'false', 'discover-ats.yml': 'false' };
  for (const [f, want] of Object.entries(MERGES)) {
    const passed = [...wf(f).matchAll(/^\s+merge:\s*(\S+)\s*$/gm)].map((m) => m[1]);
    eq(`${f} passes merge: ${want}`, passed, [want]);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
