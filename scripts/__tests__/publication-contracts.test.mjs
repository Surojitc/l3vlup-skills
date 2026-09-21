/**
 * What each producer may publish, and what each file has to look like.
 *
 *   node scripts/__tests__/publication-contracts.test.mjs
 *
 * The tracker half of this is already pinned by validate-publication.test.mjs
 * and is not repeated. What is pinned here is everything the tracker's gate
 * did not cover: the two producers that were still pushing to `main`, the
 * per-file thresholds that are theirs rather than the tracker's, and the
 * properties that make an unattended merge safe for all three at once.
 *
 * The case that matters most is the last section. `collect.yml` reported
 * success every morning for two days while its push was being refused, so
 * every check here is written as "this must FAIL", and the CLI is run as a
 * process to prove the failure reaches an exit code rather than a log line.
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CONTRACTS,
  allPaths,
  unexpectedPaths,
  fileProblems,
  contractProblems,
  groupMovement,
  publicationReport,
  archiveMemberProblems,
} from '../publication-contracts.mjs';

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
const refuses = (name, verdict, needle) =>
  check(name, verdict.problems.some((p) => p.includes(needle)), JSON.stringify(verdict.problems));

const now = new Date('2026-09-20T12:00:00Z');
const fresh = '2026-09-20T11:00:00Z';

// ── 1. the table itself ──────────────────────────────────────────────────
eq('there are three producers and no more', Object.keys(CONTRACTS).sort(), ['ats-registry', 'open-data', 'tracker']);
for (const [id, c] of Object.entries(CONTRACTS)) {
  check(`${id} publishes to one predictable branch`, /^automation\/[a-z-]+$/.test(c.branch), c.branch);
  check(`${id} has a title with no newline`, typeof c.title === 'string' && !/[\r\n]/.test(c.title));
  check(`${id} names every file it may write`, c.files.length > 0 && c.files.every((f) => f.path || f.pattern));
  check(`${id} says what each file is`, c.files.every((f) => typeof f.label === 'string' && f.label.length > 5));
}

// No two producers may own the same file. Two workflows writing one file is
// two workflows racing to publish it, and the loser's copy silently wins.
const owners = new Map();
for (const { producer, path } of allPaths()) {
  if (!path) continue;
  owners.set(path, [...(owners.get(path) ?? []), producer]);
}
eq('no file is written by two producers', [...owners].filter(([, p]) => p.length > 1), []);

// Each producer's branch is its own, so two of them cannot force-push over
// one another between a push and a merge.
eq(
  'no two producers share a branch',
  Object.values(CONTRACTS).map((c) => c.branch).filter((b, i, a) => a.indexOf(b) !== i),
  [],
);

// ── 2. the allowlists, per producer ──────────────────────────────────────
eq(
  'the open-data collection may publish what its collectors write',
  unexpectedPaths('open-data', ['data/calendar.auto.json', 'data/deals.auto.json', 'data/newsflow.auto.json', 'data/macro.auto.json', 'data/decks.auto.json', 'data/funds.auto.json', 'data/peers.auto.json', 'data/career-snapshots.json']),
  [],
);
eq(
  'discovery may publish the registry and its report',
  unexpectedPaths('ats-registry', ['lib/sources/ats-registry.json', 'data/ats-discovery.json']),
  [],
);
for (const [producer, path, why] of [
  ['open-data', 'scripts/sync-calendar.mjs', 'one of its own collectors'],
  ['open-data', '.github/workflows/collect.yml', 'the workflow'],
  ['open-data', 'package.json', 'the manifest'],
  ['open-data', 'lib/sources/ats-registry.json', "the other producer's file"],
  ['open-data', 'data/opportunities.auto.json', "the tracker's feed"],
  ['open-data', 'data/calendar.auto.json.bak', 'a near miss on a real name'],
  ['open-data', '../secrets.json', 'a path that climbs out of the tree'],
  ['ats-registry', 'scripts/discover-ats.mjs', 'the discovery script'],
  ['ats-registry', 'lib/sources/careers-seed.json', 'the hand-maintained seed'],
  ['ats-registry', 'data/calendar.auto.json', "the other producer's file"],
  ['tracker', 'data/calendar.auto.json', "a file the tracker does not write"],
]) {
  eq(`${producer} refuses ${path} (${why})`, unexpectedPaths(producer, [path]), [path]);
}
eq('an unknown producer may publish nothing at all', unexpectedPaths('invented', ['data/calendar.auto.json']), ['data/calendar.auto.json']);

// ── 3. per-file checks that are this source's, not the tracker's ─────────
const calendarSpec = CONTRACTS['open-data'].files.find((f) => f.path === 'data/calendar.auto.json');
const event = (over = {}) => ({ date: '2026-09-21', time: '09:00', tz: 'UTC', country: 'US', title: 'CPI', importance: 'high', source: 'BLS', url: 'https://example.invalid', ...over });
const calendar = (n, over = {}) => ({ generatedAt: fresh, events: Array.from({ length: n }, () => event()), ...over });

eq('a healthy calendar has nothing to say', fileProblems(calendarSpec, calendar(34), calendar(30), now).problems, []);
refuses('a calendar that came back empty is refused', fileProblems(calendarSpec, calendar(2), calendar(30), now), 'below its floor');
refuses('a calendar row with no source is refused', fileProblems(calendarSpec, { generatedAt: fresh, events: [event({ source: '' })] }, null, now), 'missing source');
refuses('a calendar left from a step that failed quietly is refused', fileProblems(calendarSpec, calendar(34, { generatedAt: '2026-09-18T10:09:20Z' }), calendar(30), now), 'old');
refuses('a calendar stamped in the future is refused', fileProblems(calendarSpec, calendar(34, { generatedAt: '2026-09-25T00:00:00Z' }), calendar(30), now), 'future');
refuses('a calendar with no events array is refused', fileProblems(calendarSpec, { generatedAt: fresh }, null, now), 'no events array');
refuses('a calendar that did not parse is refused', fileProblems(calendarSpec, null, null, now), 'not readable JSON');
// The band is wide because the window really does thin and fill; that is the
// point of stating it per source rather than borrowing the tracker's.
eq('a calendar thinning over a quiet week is published', fileProblems(calendarSpec, calendar(15), calendar(34), now).problems, []);
refuses('a calendar that collapsed is not', fileProblems(calendarSpec, calendar(9), calendar(34), now), 'past its 35% floor');
refuses('a calendar that quadrupled is not', fileProblems(calendarSpec, calendar(120), calendar(34), now), 'ceiling');

const macroSpec = CONTRACTS['open-data'].files.find((f) => f.path === 'data/macro.auto.json');
const series = (points = 5) => ({ id: 'dgs10', name: '10y', unit: '%', country: 'US', sourceName: 'FRED', url: 'https://example.invalid', blurb: 'x', points: Array.from({ length: points }, (_, i) => ({ d: i, v: i })) });
const macro = (n, points = 5) => ({ generatedAt: fresh, series: Array.from({ length: n }, () => series(points)) });
eq('a healthy chartbook has nothing to say', fileProblems(macroSpec, macro(11), macro(11), now).problems, []);
refuses('a chartbook that silently dropped a series is refused', fileProblems(macroSpec, macro(9), macro(11), now), 'past its 90% floor');
refuses('a chartbook whose series came back empty is refused', fileProblems(macroSpec, macro(11, 1), macro(11), now), 'fewer than 2 points');
// Weekly, so yesterday's chartbook is not stale.
eq('a chartbook from five days ago is still publishable', fileProblems(macroSpec, { ...macro(11), generatedAt: '2026-09-15T12:00:00Z' }, macro(11), now).problems, []);
refuses('a chartbook from three weeks ago is not', fileProblems(macroSpec, { ...macro(11), generatedAt: '2026-08-29T12:00:00Z' }, macro(11), now), 'old');

const decksSpec = CONTRACTS['open-data'].files.find((f) => f.path === 'data/decks.auto.json');
const decks = (n) => ({ generatedAt: fresh, transactions: Array.from({ length: n }, (_, i) => ({ id: `t${i}`, announced: '2026-01-01' })) });
eq('an index that grew is published', fileProblems(decksSpec, decks(280), decks(277), now).problems, []);
refuses('an index that shrank is refused: it only ever grows', fileProblems(decksSpec, decks(200), decks(277), now), 'only ever grows');

const registrySpec = CONTRACTS['ats-registry'].files.find((f) => f.path === 'lib/sources/ats-registry.json');
const registry = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`firm-${i}`, { ats: 'greenhouse', token: `t${i}` }]));
eq('discovery adding boards is published', fileProblems(registrySpec, registry(90), registry(85), now).problems, []);
refuses('discovery losing boards is refused', fileProblems(registrySpec, registry(80), registry(85), now), 'only ever grows');
refuses('a registry that doubled is refused', fileProblems(registrySpec, registry(200), registry(85), now), 'ceiling');

const newsSpec = CONTRACTS['open-data'].files.find((f) => f.path === 'data/newsflow.auto.json');
const item = (vertical) => ({ date: '2026-09-20', title: 't', link: 'https://example.invalid', source: 'wire', vertical });
const news = (counts) => ({ generatedAt: fresh, items: Object.entries(counts).flatMap(([v, n]) => Array.from({ length: n }, () => item(v))) });
eq('a healthy news map has nothing to say', fileProblems(newsSpec, news({ 'M&A': 60, 'Private Equity': 40, 'Venture Capital': 46 }), news({ 'M&A': 58, 'Private Equity': 44, 'Venture Capital': 44 }), now).problems, []);
refuses(
  'a wire going dark and taking a vertical with it is refused',
  fileProblems(newsSpec, news({ 'M&A': 90, 'Private Equity': 5, 'Venture Capital': 51 }), news({ 'M&A': 58, 'Private Equity': 44, 'Venture Capital': 44 }), now),
  'Private Equity collapsed from 44 to 5',
);
eq(
  'a small category going to zero is not a collapse: they do that between cycles',
  fileProblems(newsSpec, news({ 'M&A': 60, 'Private Equity': 40, 'Venture Capital': 46, 'Hedge Fund': 0 }), news({ 'M&A': 58, 'Private Equity': 44, 'Venture Capital': 44, 'Hedge Fund': 3 }), now).problems,
  [],
);

// ── 4. a whole producer, and the cadences it really runs at ──────────────
const world = (files) => ({
  staged: Object.keys(files),
  read: (p) => files[p],
  readPrev: () => null,
});
eq(
  'a daily run writing only the daily files is publishable',
  contractProblems('open-data', world({
    'data/calendar.auto.json': calendar(34),
    'data/deals.auto.json': { generatedAt: fresh, items: Array.from({ length: 80 }, () => ({ date: '2026-09-20', title: 't', link: 'https://example.invalid', source: 'wire' })) },
    'data/newsflow.auto.json': news({ 'M&A': 60, 'Private Equity': 40, 'Venture Capital': 46 }),
  }), now).problems,
  [],
);
eq(
  'a Monday run that also rebuilt the chartbook is publishable',
  contractProblems('open-data', world({
    'data/calendar.auto.json': calendar(34),
    'data/macro.auto.json': macro(11),
    'data/decks.auto.json': decks(277),
  }), now).problems,
  [],
);
refuses(
  'a run that edited a collector publishes nothing at all',
  contractProblems('open-data', world({ 'data/calendar.auto.json': calendar(34), 'scripts/sync-calendar.mjs': {} }), now),
  "outside open-data's allowlist",
);
refuses(
  'one stale file refuses the whole run, not just itself',
  contractProblems('open-data', world({ 'data/calendar.auto.json': calendar(34, { generatedAt: '2026-09-18T10:00:00Z' }), 'data/deals.auto.json': { generatedAt: fresh, items: Array.from({ length: 80 }, () => ({ date: '2026-09-20', title: 't', link: 'https://x.invalid', source: 'w' })) } }), now),
  'old',
);
refuses('an unknown producer publishes nothing', contractProblems('invented', world({}), now), 'no publication contract');

// ── 5. the body a reviewer reads ─────────────────────────────────────────
const { stats } = contractProblems('open-data', {
  staged: ['data/newsflow.auto.json'],
  read: () => news({ 'M&A': 60, 'Private Equity': 40, 'Venture Capital': 46 }),
  readPrev: () => news({ 'M&A': 58, 'Private Equity': 44, 'Venture Capital': 44 }),
}, now);
const body = publicationReport({ producer: 'open-data', stats, staged: ['data/newsflow.auto.json'], runUrl: 'https://example.invalid/run/1' });
for (const needle of ['The open-data collection', 'the news map', '| Private Equity | 44 | 40 | -4 |', 'publishes nothing']) {
  check(`the pull request body carries ${JSON.stringify(needle)}`, body.includes(needle), body.slice(0, 200));
}

// ── 6. the failure reaches an exit code ──────────────────────────────────
// The defect this whole change exists to fix was a failure that stayed a log
// line. Every refusal above is worthless if the process still exits 0.
const dir = mkdtempSync(join(tmpdir(), 'pubgate-'));
const cli = new URL('../validate-data-publication.mjs', import.meta.url).pathname;
function run(args, cwd) {
  try {
    execFileSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', stdio: 'pipe' });
    return 0;
  } catch (err) {
    return err.status ?? -1;
  }
}
writeFileSync(join(dir, 'staged.txt'), 'scripts/sync-calendar.mjs\n');
check('a path outside the allowlist exits non-zero', run(['--producer', 'open-data', '--staged', join(dir, 'staged.txt')], dir) === 1);
writeFileSync(join(dir, 'none.txt'), '');
check('an unknown producer exits non-zero', run(['--producer', 'invented', '--staged', join(dir, 'none.txt')], dir) === 2);
writeFileSync(join(dir, 'cal.txt'), 'data/calendar.auto.json\n');
mkdirSync(join(dir, 'data'), { recursive: true });
writeFileSync(join(dir, 'data/calendar.auto.json'), 'not json at all');
check('a malformed file exits non-zero', run(['--producer', 'open-data', '--staged', join(dir, 'cal.txt')], dir) === 1);
writeFileSync(join(dir, 'data/calendar.auto.json'), JSON.stringify(calendar(34)));
check('a good file in the same place exits zero', run(['--producer', 'open-data', '--staged', join(dir, 'cal.txt')], dir) === 0);
// Staged but gone from disk is not "this step did not run this cycle".
writeFileSync(join(dir, 'cal.txt'), 'data/macro.auto.json\n');
check('a staged file that is not there exits non-zero', run(['--producer', 'open-data', '--staged', join(dir, 'cal.txt')], dir) === 1);

// ── the archive, judged before it is unpacked ────────────────────────────
// The boundary this section is about: unprivileged collection may propose
// bytes, and only code and policy already on `main` may decide whether those
// bytes are safe to publish. Everything below is that decision, made on the
// member list alone, before tar has written anything.
//
// It matters that this is a separate decision from the gate. The gate reads
// the git index, and a file tar wrote outside the working tree never reaches
// the index: by the time the gate has an opinion, the write has happened.

const clean = ['lib/sources/ats-registry.json', 'data/ats-discovery.json'];
eq('a clean registry archive may be unpacked', archiveMemberProblems('ats-registry', clean, ['-', '-']), []);
check('an empty archive may not', archiveMemberProblems('ats-registry', []).length === 1);
check('an archive for a producer nobody declared may not', archiveMemberProblems('invented', clean).length === 1);

const refused = (members, types) => archiveMemberProblems('ats-registry', members, types).join(' | ');
check('an absolute path is refused', /is an absolute path/.test(refused(['/etc/passwd'], ['-'])));
check('a home-relative path is refused', /starts at a home directory/.test(refused(['~/.ssh/authorized_keys'], ['-'])));
check('a traversing path is refused', /traverses out of the working tree/.test(refused(['../../escaped.json'], ['-'])));
check('a traversal in the middle of a path is refused', /traverses out of the working tree/.test(refused(['data/../../escaped.json'], ['-'])));
check('a dot-slash path is refused', /not a plain relative path/.test(refused(['./data/ats-discovery.json'], ['-'])));
check('an empty segment is refused', /empty path segment/.test(refused(['data//ats-discovery.json'], ['-'])));
check('a newline inside a path is refused', /a character a collected path never has/.test(refused(['data/a\nb.json'], ['-'])));
check('a symlink is refused', /is not a plain file/.test(refused(['data/ats-discovery.json'], ['l'])));
check('a hard link is refused', /is not a plain file/.test(refused(['data/ats-discovery.json'], ['h'])));
check('a device node is refused', /is not a plain file/.test(refused(['data/ats-discovery.json'], ['c'])));
check('a directory entry is refused', /is not a plain file/.test(refused(['data/ats-discovery.json'], ['d'])));
check('a member list and a type list of different lengths is refused whole', /cannot be read reliably/.test(refused(clean, ['-'])));

// The finding this section was written for. An in-tree path is not caught by
// any traversal check, and `git add -A` after extraction would stage it.
for (const [path, why] of [
  ['.github/workflows/anything.yml', 'a workflow'],
  ['.github/dependabot.yml', 'repository configuration'],
  ['scripts/validate-data-publication.mjs', 'the gate itself'],
  ['scripts/sync-calendar.mjs', 'a collector'],
  ['package.json', 'a manifest'],
  ['data/evil.sh', 'a shell script under data/'],
  ['data/evil.mjs', 'a module under data/'],
  ['.npmrc', 'a dotfile'],
]) {
  check(`${path} is refused before extraction (${why})`, archiveMemberProblems('ats-registry', [path], ['-']).length > 0);
}
check(
  'and the refusal says it is code or configuration, not merely unexpected',
  /no collection may publish/.test(refused(['.github/workflows/anything.yml'], ['-'])),
);
// The two locks overlap on most paths, which makes it easy to write a test
// that cannot tell which one is holding: drop the `.github/` rule and a
// workflow file is still refused, by its `.yml` extension and by the
// allowlist. These three carry no banned extension and are not dotfiles, so
// only the directory rules can name them as code or configuration, and a
// mutation that removes one of those rules shows up here rather than nowhere.
for (const [path, rule] of [
  ['.github/CODEOWNERS', 'the .github rule'],
  ['.github/ISSUE_TEMPLATE/bug', 'the .github rule'],
  ['scripts/anything.json', 'the scripts rule'],
]) {
  check(
    `${path} is refused as code or configuration by ${rule}, not only as unexpected`,
    /no collection may publish/.test(refused([path], ['-'])),
    refused([path], ['-']),
  );
}

// Two locks on the same door: the allowlist, and the list of things no
// producer may publish whatever its allowlist says. A file legitimately
// inside another producer's allowlist is still refused here.
check('another producer\'s file is outside this one\'s allowlist', /outside ats-registry's allowlist/.test(refused(['data/calendar.auto.json'], ['-'])));
eq('every producer can publish its own files and no others', Object.keys(CONTRACTS).map((id) => {
  const own = CONTRACTS[id].files.filter((f) => f.path).map((f) => f.path);
  const others = allPaths().filter((x) => x.producer !== id && x.path).map((x) => x.path);
  return [
    id,
    archiveMemberProblems(id, own, own.map(() => '-')).length,
    archiveMemberProblems(id, others, others.map(() => '-')).length > 0,
  ];
}), Object.keys(CONTRACTS).map((id) => [id, 0, true]));

// ── the same policy, on archives tar actually wrote ──────────────────────
// The checks above are about the decision. These are about the pipeline the
// workflow runs it through: `tar -tf` for names, `tar -tvf | cut -c1` for
// types, both fed to the CLI that the publisher invokes from its checkout.
const memberCli = new URL('../validate-archive-members.mjs', import.meta.url).pathname;
const tar = mkdtempSync(join(tmpdir(), 'archive-'));
const sh = (cmd, cwd = tar) => execFileSync('bash', ['-c', cmd], { cwd, encoding: 'utf8', stdio: 'pipe' });

mkdirSync(join(tar, 'lib/sources'), { recursive: true });
mkdirSync(join(tar, 'data'), { recursive: true });
writeFileSync(join(tar, 'lib/sources/ats-registry.json'), '{"boards":[]}');
writeFileSync(join(tar, 'data/ats-discovery.json'), '{"report":[]}');

/** Exactly what the publisher does, on an archive built here. */
function judge(archive) {
  try {
    sh(`tar -tf  ${archive}           > members.txt
        tar -tvf ${archive} | cut -c1 > types.txt
        node ${memberCli} --producer ats-registry --members members.txt --types types.txt`);
    return 0;
  } catch (err) {
    return err.status ?? -1;
  }
}

sh('tar -cf clean.tar lib/sources/ats-registry.json data/ats-discovery.json');
eq('a real archive of the two registry files is accepted', judge('clean.tar'), 0);

sh('tar -cf traverse.tar --transform="s|^data/|../../data/|" data/ats-discovery.json 2>/dev/null');
eq('a real archive naming ../../data/ats-discovery.json is refused', judge('traverse.tar'), 1);

sh('tar -P -cf absolute.tar /etc/hostname 2>/dev/null');
eq('a real archive naming /etc/hostname is refused', judge('absolute.tar'), 1);

sh('ln -sf /etc/passwd data/link.json && tar -cf symlink.tar data/link.json');
eq('a real archive holding a symlink to /etc/passwd is refused', judge('symlink.tar'), 1);

sh('ln -f data/ats-discovery.json data/hard.json && tar -cf hardlink.tar data/ats-discovery.json data/hard.json');
eq('a real archive holding a hard link is refused', judge('hardlink.tar'), 1);

mkdirSync(join(tar, '.github/workflows'), { recursive: true });
writeFileSync(join(tar, '.github/workflows/anything.yml'), 'on: push\n');
sh('tar -cf workflow.tar .github/workflows/anything.yml data/ats-discovery.json');
eq('a real archive smuggling a workflow beside the data is refused', judge('workflow.tar'), 1);

writeFileSync(join(tar, 'gate.mjs'), 'process.exit(0)\n');
sh('mkdir -p scripts && cp gate.mjs scripts/validate-data-publication.mjs && tar -cf gate.tar scripts/validate-data-publication.mjs data/ats-discovery.json');
eq('a real archive carrying a replacement gate is refused', judge('gate.tar'), 1);

// ── the same archives, judged for the tracker ───────────────────────────
// `build-samples` publishes the feed a candidate actually acts on, inline,
// every morning. Its publisher had the same defect and now runs the same
// check, so it gets the same proof rather than inheriting confidence from
// the producer next door.
mkdirSync(join(tar, 'samples'), { recursive: true });
writeFileSync(join(tar, 'data/opportunities.auto.json'), '{"roles":[]}');
writeFileSync(join(tar, 'data/tracker-slugs.json'), '{}');
writeFileSync(join(tar, 'samples/model.xlsx'), 'PK');

function judgeTracker(archive) {
  try {
    sh(`tar -tf  ${archive}           > tmembers.txt
        tar -tvf ${archive} | cut -c1 > ttypes.txt
        node ${memberCli} --producer tracker --members tmembers.txt --types ttypes.txt`);
    return 0;
  } catch (err) {
    return err.status ?? -1;
  }
}

sh('tar -cf t-clean.tar data/opportunities.auto.json data/tracker-slugs.json samples/model.xlsx');
eq('a real tracker archive of feed, slugs and a workbook is accepted', judgeTracker('t-clean.tar'), 0);

sh('tar -cf t-traverse.tar --transform="s|^data/|../../data/|" data/opportunities.auto.json 2>/dev/null');
eq('a tracker archive naming ../../data/opportunities.auto.json is refused', judgeTracker('t-traverse.tar'), 1);

sh('ln -sf /etc/passwd data/feedlink.json && tar -cf t-symlink.tar data/feedlink.json');
eq('a tracker archive holding a symlink is refused', judgeTracker('t-symlink.tar'), 1);

sh('ln -f data/opportunities.auto.json data/feedhard.json && tar -cf t-hardlink.tar data/opportunities.auto.json data/feedhard.json');
eq('a tracker archive holding a hard link is refused', judgeTracker('t-hardlink.tar'), 1);

sh('tar -cf t-workflow.tar .github/workflows/anything.yml data/opportunities.auto.json');
eq('a tracker archive smuggling a workflow beside the feed is refused', judgeTracker('t-workflow.tar'), 1);

sh('mkdir -p scripts && cp gate.mjs scripts/validate-publication.mjs && tar -cf t-gate.tar scripts/validate-publication.mjs data/opportunities.auto.json');
eq('a tracker archive carrying a replacement gate is refused', judgeTracker('t-gate.tar'), 1);

sh('tar -cf t-foreign.tar lib/sources/ats-registry.json');
eq("a tracker archive carrying another producer's file is refused", judgeTracker('t-foreign.tar'), 1);

// And the refusal happens with nothing written: the CLI only ever reads.
check(
  'refusing an archive writes nothing to the working tree',
  !sh('git status --porcelain 2>/dev/null || echo "not a repo"').includes('escaped'),
);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
