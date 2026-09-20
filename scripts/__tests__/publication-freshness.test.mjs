/**
 * Whether a source has actually been collected lately, and what the run does
 * about it.
 *
 *   node scripts/__tests__/publication-freshness.test.mjs
 *
 * WHY IT IS A SEPARATE SUITE FROM THE GATE
 * ----------------------------------------
 * The gate answers "may this be published". It is blind to the case that
 * matters most here, which is a collector that publishes nothing at all: a
 * `continue-on-error` step that fails every morning stages no file, so the
 * gate has nothing to object to and the committed copy ages behind a green
 * tick. `collect.yml` reported success for two days that way while the
 * calendar, the deal tape and the news map went stale. Fixing the refused
 * push and leaving that in place would be half a guarantee.
 *
 * The distinction the whole design turns on is one miss against a pattern. A
 * daily source gets thirty-six hours, so a collector that fails this morning
 * and succeeds tomorrow never trips it and one that fails twice running does.
 * That is the first two cases below and everything else follows from them.
 */

import {
  CONTRACTS,
  HORIZON_HOURS,
  FRESHNESS_STATES,
  fileFreshness,
  freshnessReport,
  freshnessSummary,
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

const NOW = new Date('2026-09-20T12:00:00Z');
const hoursAgo = (h) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

const spec = (path) => {
  for (const c of Object.values(CONTRACTS)) {
    const f = c.files.find((x) => x.path === path);
    if (f) return f;
  }
  throw new Error(`no spec for ${path}`);
};
const CALENDAR = spec('data/calendar.auto.json');   // daily, required
const QUEUE = spec('data/career-review-queue.json'); // daily, optional
const MACRO = spec('data/macro.auto.json');          // weekly, required
const FUNDS = spec('data/funds.auto.json');          // monthly, optional
const SNAPSHOTS = spec('data/career-snapshots.json');// daily, from a commit date
const UNIVERSE = spec('data/funds.universe.json');   // manual

const state = (s, value, committed = null) => fileFreshness(s, value, committed, NOW).state;

// ── 1. every source declares a cadence, and only the right ones block ────
for (const [id, c] of Object.entries(CONTRACTS)) {
  for (const f of c.files.filter((x) => x.path)) {
    check(`${id}: ${f.path} declares a cadence`, ['daily', 'weekly', 'monthly', 'manual'].includes(f.freshness?.cadence), JSON.stringify(f.freshness));
  }
}
// A commit date says when the data last CHANGED, not when the collector last
// ran, so a quiet week is indistinguishable from a broken one. Anything read
// that way may degrade a run and must never fail it.
const commitDerived = Object.values(CONTRACTS)
  .flatMap((c) => c.files)
  .filter((f) => f.freshness?.from === 'commit');
check('no file inferred from a commit date is allowed to block', commitDerived.every((f) => !f.freshness.required), commitDerived.map((f) => f.path).join(', '));
check('every state the report can emit is declared', FRESHNESS_STATES.length === 5);

// ── 2. one miss against a pattern ────────────────────────────────────────
// The case the whole horizon exists for.
eq(
  'a collector that failed once this morning: yesterday\'s file is still fresh',
  state(CALENDAR, { generatedAt: hoursAgo(26) }),
  'fresh',
);
eq(
  'the same collector failing a second morning: now stale',
  state(CALENDAR, { generatedAt: hoursAgo(50) }),
  'stale',
);
eq('and a file collected an hour ago is obviously fresh', state(CALENDAR, { generatedAt: hoursAgo(1) }), 'fresh');
check('the daily horizon is the number that draws that line', HORIZON_HOURS.daily === 36);

// ── 3. a slow source is old without being late ───────────────────────────
eq('a 13F file from three weeks ago is not overdue', state(FUNDS, { generatedAt: hoursAgo(500) }), 'not-due');
eq('the same file from seven weeks ago is', state(FUNDS, { generatedAt: hoursAgo(1200) }), 'degraded');
eq('a chartbook from five days ago is not overdue', state(MACRO, { generatedAt: hoursAgo(120) }), 'not-due');
eq('a chartbook from three weeks ago is stale, and it is required', state(MACRO, { generatedAt: hoursAgo(500) }), 'stale');
eq('a hand-maintained file is never late for anything', state(UNIVERSE, { managers: [] }), 'manual');
eq('...even when it has not been touched in a year', state(UNIVERSE, { managers: [] }, hoursAgo(9000)), 'manual');

// ── 4. absence, and the difference between required and not ─────────────
eq('a required file that is simply not there is stale', state(CALENDAR, undefined), 'stale');
eq('an optional file that is not there is degraded', state(QUEUE, undefined), 'degraded');
eq('a required file that will not parse is stale', state(CALENDAR, null), 'stale');
eq('a required file carrying no stamp is stale', state(CALENDAR, { events: [] }), 'stale');

// ── 5. a commit date, for the files that carry no stamp of their own ────
eq('a snapshot committed this morning is fresh', state(SNAPSHOTS, { firm: [] }, hoursAgo(3)), 'fresh');
eq('one nobody has touched in a week is degraded, never stale', state(SNAPSHOTS, { firm: [] }, hoursAgo(200)), 'degraded');

// ── 6. a healthy producer beside a degraded source ───────────────────────
const feed = (over = {}) => ({
  'data/calendar.auto.json': { generatedAt: hoursAgo(1) },
  'data/deals.auto.json': { generatedAt: hoursAgo(1) },
  'data/newsflow.auto.json': { generatedAt: hoursAgo(1) },
  'data/macro.auto.json': { generatedAt: hoursAgo(20) },
  'data/decks.auto.json': { generatedAt: hoursAgo(20) },
  'data/cusip-tickers.auto.json': { generatedAt: hoursAgo(300) },
  'data/precedent-transactions.auto.json': { generatedAt: hoursAgo(300) },
  'data/funds.auto.json': { generatedAt: hoursAgo(300) },
  'data/funds.universe.json': { managers: [] },
  'data/peers.auto.json': { generatedAt: hoursAgo(300) },
  'data/career-snapshots.json': { firm: [] },
  'data/career-review-queue.json': { generatedAt: hoursAgo(1) },
  ...over,
});
const world = (files, committed = hoursAgo(1)) => ({
  read: (p) => files[p],
  committedAt: () => committed,
});

const healthy = freshnessReport('open-data', world(feed()), NOW);
eq('a morning where everything collected blocks nothing', [healthy.blocking, healthy.degraded], [false, false]);
eq('and says so', healthy.problems, []);

const oneDegraded = freshnessReport('open-data', world(feed({ 'data/career-review-queue.json': { generatedAt: hoursAgo(90) } })), NOW);
eq('an optional source past its horizon degrades the run without blocking it', [oneDegraded.blocking, oneDegraded.degraded], [false, true]);
check(
  'and the healthy sources beside it are untouched',
  oneDegraded.sources.filter((s) => s.state === 'fresh').length >= 3,
);

const oneStale = freshnessReport('open-data', world(feed({ 'data/deals.auto.json': { generatedAt: hoursAgo(90) } })), NOW);
eq('one required source past its horizon blocks', [oneStale.blocking, oneStale.degraded], [true, false]);
check('and names it, with how long it has been', /the deal tape is stale: 90h/.test(oneStale.problems[0]), oneStale.problems[0]);
check(
  'while every other source still reads as collected',
  oneStale.sources.filter((s) => s.state === 'fresh').map((s) => s.path).includes('data/calendar.auto.json'),
);

// The incident this was written for: three daily sources, two days dead.
const theIncident = freshnessReport(
  'open-data',
  world(feed({
    'data/calendar.auto.json': { generatedAt: hoursAgo(55) },
    'data/deals.auto.json': { generatedAt: hoursAgo(55) },
    'data/newsflow.auto.json': { generatedAt: hoursAgo(55) },
  })),
  NOW,
);
eq('the 19-20 September incident would have failed the run', theIncident.blocking, true);
eq('...naming all three', theIncident.problems.length, 3);

// ── 7. what the operator reads ───────────────────────────────────────────
for (const [label, report, needle] of [
  ['healthy', healthy, 'Every source is within its horizon.'],
  ['degraded', oneDegraded, 'An optional source is degraded.'],
  ['blocking', oneStale, 'A required source is stale.'],
]) {
  const md = freshnessSummary('open-data', report);
  check(`the ${label} summary says so in its first line`, md.includes(needle), md.split('\n')[2]);
  check(`the ${label} summary is a table of every source`, (md.match(/^\| /gm) ?? []).length >= 12);
  check(`the ${label} summary names the last successful collection`, md.includes('Last successful collection'));
}
const blockingMd = freshnessSummary('open-data', oneStale);
check('a blocking summary says the healthy sources were still published', /still published/.test(blockingMd));
check('and marks the stale one', /🔴/.test(blockingMd) && /the deal tape \*\(required\)\*/.test(blockingMd));
check('a degraded summary does not claim anything is blocked', !/still published/.test(freshnessSummary('open-data', oneDegraded)));
// Colour alone is not a report: a scheduled-run email is read as text.
const mixed = freshnessReport(
  'open-data',
  world(feed({
    'data/deals.auto.json': { generatedAt: hoursAgo(90) },
    'data/career-review-queue.json': { generatedAt: hoursAgo(90) },
  })),
  NOW,
);
const mixedMd = freshnessSummary('open-data', mixed);
for (const st of ['fresh', 'degraded', 'stale', 'not-due', 'manual']) {
  check(`the summary spells out "${st}" where a source is in that state`, mixedMd.includes(`| ${st} |`), st);
}
eq('a stale source outranks a degraded one in the verdict', [mixed.blocking, mixed.degraded], [true, true]);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
