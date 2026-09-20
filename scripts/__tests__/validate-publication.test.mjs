/**
 * The last gate before the collection is published.
 *
 *   node scripts/__tests__/validate-publication.test.mjs
 *
 * Two halves. The first is the path allowlist, which is the part that makes a
 * machine-opened pull request into a protected branch safe to merge without a
 * person reading every line: a run that has touched a script or a workflow
 * must fail, not quietly leave that change uncommitted. The second is the set
 * of properties the feed itself has to have, including the one that would
 * catch a classification rule swallowing a whole vertical.
 *
 * The case that matters most is the last one in the invariants section. The
 * classifier change shipped alongside this guard moves a fifth of the
 * investment banking rows to other verticals on purpose, and a gate tuned so
 * tightly that it blocked its own release would simply be turned off.
 */

import { unexpectedPaths, feedInvariants, verticalMovement, publicationReport, PUBLISHABLE } from '../validate-publication.mjs';

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

// ── 1. the path allowlist ────────────────────────────────────────────────
const generated = [
  'data/opportunities.auto.json',
  'data/tracker-slugs.json',
  'data/tracker-archive.json',
  'data/tracker-history.json',
  'data/deadlines.learned.json',
  'data/econ.auto.json',
  'data/erp.auto.json',
  'samples/AAPL_company_profile.xlsx',
  'samples/NVDA_comps.xlsx',
];
eq('every file this workflow writes is publishable', unexpectedPaths(generated), []);

// Each of these has a plausible route into a staged change, and none of them
// may ride along with a data refresh.
for (const [path, why] of [
  ['scripts/sync-ats.mjs', 'the collector itself'],
  ['scripts/validate-publication.mjs', 'this gate'],
  ['.github/workflows/build-samples.yml', 'the workflow'],
  ['package.json', 'the manifest'],
  ['package-lock.json', 'the lockfile'],
  ['lib/sources/ats-registry.json', 'the board registry, which is hand-maintained'],
  ['lib/sources/careers-seed.json', 'the firm seed'],
  ['data/letters.parsed.json', 'another workflow s output'],
  ['data/ats-discovery.json', 'the discovery run s output'],
  ['samples/run.sh', 'an executable in the samples directory'],
  ['samples/nested/profile.xlsx', 'a workbook one directory down'],
  ['data/opportunities.auto.json.bak', 'a near miss on a real name'],
  ['Data/opportunities.auto.json', 'a case variant'],
  ['../secrets.json', 'a path that climbs out of the tree'],
]) {
  eq(`refused: ${path} (${why})`, unexpectedPaths([path]), [path]);
}
eq('one bad path among good ones is still caught', unexpectedPaths([...generated, 'middleware.ts']), ['middleware.ts']);
check('the allowlist is a list of anchored patterns', PUBLISHABLE.every((a) => a.pattern.source.startsWith('^') && a.pattern.source.endsWith('$')));
check('every allowlist entry says which step writes it', PUBLISHABLE.every((a) => typeof a.what === 'string' && a.what.length > 6));

// ── 2. the feed's own properties ─────────────────────────────────────────
const now = new Date('2026-09-20T09:00:00Z');
const row = (over = {}) => ({
  id: 'x1',
  firm: 'A Bank',
  role: 'Investment Banking Summer Analyst',
  vertical: 'Investment Banking',
  programmeType: 'Summer Internship',
  location: 'London',
  region: 'UK',
  level: 'Internship',
  status: 'Listed',
  ...over,
});
const feedOf = (counts, over = {}) => ({
  generatedAt: '2026-09-20T08:11:52.883Z',
  opportunities: Object.entries(counts).flatMap(([vertical, n]) =>
    Array.from({ length: n }, (_, i) => row({ id: `${vertical}-${i}`, vertical, firm: `Firm ${i % 40}` })),
  ),
  ...over,
});

const healthy = feedOf({ 'Software Engineering': 330, Other: 296, 'Investment Banking': 141, Quant: 100 });
eq('a healthy feed has nothing to say', feedInvariants(healthy, null, now).problems, []);

eq('no opportunities array at all', feedInvariants({ generatedAt: now.toISOString() }, null, now).problems, [
  'the feed has no opportunities array',
]);
check('a feed below the floor is refused', feedInvariants(feedOf({ Other: 30 }), null, now).problems.some((p) => /publication floor/.test(p)));
check(
  'a row missing the field the board indexes by is refused',
  feedInvariants({ ...healthy, opportunities: [...healthy.opportunities, row({ vertical: '' })] }, null, now).problems.some((p) =>
    /missing vertical/.test(p),
  ),
);
check('a feed with no stamp is refused', feedInvariants({ ...healthy, generatedAt: undefined }, null, now).problems.some((p) => /generatedAt/.test(p)));
check(
  'a feed left over from a step that failed quietly is refused',
  feedInvariants({ ...healthy, generatedAt: '2026-09-15T08:00:00Z' }, null, now).problems.some((p) => /old/.test(p)),
);
check(
  'a feed stamped in the future is refused',
  feedInvariants({ ...healthy, generatedAt: '2026-09-22T08:00:00Z' }, null, now).problems.some((p) => /future/.test(p)),
);

// Relative movement, which needs a previous feed to compare against.
const prev = feedOf({ 'Software Engineering': 330, Other: 296, 'Investment Banking': 141, Quant: 100 });
check(
  'a board that halves overnight is refused',
  feedInvariants(feedOf({ 'Software Engineering': 200, Other: 150 }), prev, now).problems.some((p) => /past the 60% floor/.test(p)),
);
check(
  'a board that doubles overnight is refused',
  feedInvariants(feedOf({ 'Software Engineering': 1000, Other: 900, 'Investment Banking': 141, Quant: 100 }), prev, now).problems.some(
    (p) => /ceiling/.test(p),
  ),
);
check(
  'a vertical swallowed by a bad rule is refused',
  feedInvariants(feedOf({ 'Software Engineering': 330, Other: 400, 'Investment Banking': 10, Quant: 100 }), prev, now).problems.some((p) =>
    /Investment Banking collapsed from 141 to 10/.test(p),
  ),
);
eq(
  'a small vertical going to zero is not a collapse: they do that between cycles',
  feedInvariants(feedOf({ 'Software Engineering': 330, Other: 296, 'Investment Banking': 141, Quant: 100, 'Hedge Fund': 0 }), feedOf({ 'Software Engineering': 330, Other: 296, 'Investment Banking': 141, Quant: 100, 'Hedge Fund': 3 }), now).problems,
  [],
);

// The change this gate shipped with: the classifier moves 36 rows out of
// investment banking and into the verticals they belong to. It must pass.
const beforeFix = feedOf({ 'Software Engineering': 330, Other: 296, 'Investment Banking': 141, 'Corporate Banking': 52, 'Sales & Trading': 70, Operations: 33, Risk: 39 });
const afterFix = feedOf({ 'Software Engineering': 330, Other: 310, 'Investment Banking': 111, 'Corporate Banking': 66, 'Sales & Trading': 77, Operations: 35, Risk: 40 });
eq('the classification repair itself is publishable', feedInvariants(afterFix, beforeFix, now).problems, []);
const movement = verticalMovement(beforeFix, afterFix);
eq('...and the movement is reported row by row', movement.find((v) => v.name === 'Investment Banking'), {
  name: 'Investment Banking',
  from: 141,
  to: 111,
  delta: -30,
});

// ── 3. the report a reviewer reads ───────────────────────────────────────
const { stats } = feedInvariants(afterFix, beforeFix, now);
const body = publicationReport({ stats, staged: generated, boards: '94/95', runUrl: 'https://example.invalid/run/1' });
for (const needle of ['Daily data refresh', '| Roles |', 'Investment banking', '94/95', 'data/opportunities.auto.json', 'Verticals that moved', '| Investment Banking | 141 | 111 | -30 |']) {
  check(`the pull request body carries ${needle}`, body.includes(needle));
}
check('the body names every staged file', generated.every((p) => body.includes(p)));
check('an unchanged board says so rather than printing an empty table', publicationReport({ stats: feedInvariants(healthy, healthy, now).stats, staged: generated }).includes('None.'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
