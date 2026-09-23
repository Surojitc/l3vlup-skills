/**
 * What a board check established, and the day's file built from it.
 *
 *   node scripts/__tests__/board-checks.test.mjs
 *
 * The property everything else rests on: a board we could not read never
 * reads as a board with nothing open. A hiring measure built on these files
 * drops every observation that is not `ok`, so the classification has to be
 * right before any number derived from it can be.
 */
import {
  COLLECTION_METHOD,
  boardRecord,
  buildCheckFile,
  checkFilePath,
  classifyCheck,
  everyRequestFailed,
  newRequestStats,
  worstStatus,
} from '../../lib/board-checks.mjs';
import { paginateWorkday, paginateOracle } from '../sync-ats.mjs';
import { CONTRACTS, unexpectedPaths } from '../publication-contracts.mjs';

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
};

// ── 1. classification ────────────────────────────────────────────────────
eq('a board that threw is failed', classifyCheck({ settled: 'rejected' }), 'failed');
eq('a single-request board that answered is ok', classifyCheck({ settled: 'fulfilled', stats: newRequestStats() }), 'ok');
eq('an answered board with no stats is ok', classifyCheck({ settled: 'fulfilled' }), 'ok');
eq('every page answering is ok', classifyCheck({ settled: 'fulfilled', stats: { attempts: 7, failures: 0 } }), 'ok');
eq('some pages refusing is partial', classifyCheck({ settled: 'fulfilled', stats: { attempts: 7, failures: 2 } }), 'partial');
eq('every page refusing is failed, even if the fetcher returned', classifyCheck({ settled: 'fulfilled', stats: { attempts: 5, failures: 5 } }), 'failed');
eq('everyRequestFailed: all refused', everyRequestFailed({ attempts: 3, failures: 3 }), true);
eq('everyRequestFailed: one answered', everyRequestFailed({ attempts: 3, failures: 2 }), false);
eq('two boards for one firm: failed beats ok', worstStatus('ok', 'failed'), 'failed');
eq('two boards for one firm: partial beats ok', worstStatus('partial', 'ok'), 'partial');
eq('two boards for one firm: ok and ok is ok', worstStatus('ok', 'ok'), 'ok');
eq('everyRequestFailed: nothing asked', everyRequestFailed({ attempts: 0, failures: 0 }), false);

// ── 2. the paginators count what they asked for ──────────────────────────
// The bug this closes: a Workday site whose every request threw returned an
// empty list and counted as a healthy board with nothing open.
{
  const stats = newRequestStats();
  const seen = await paginateWorkday(async () => { throw new Error('503'); }, { queries: ['intern', 'graduate'], stats });
  eq('workday: a board refusing every query yields nothing', seen.size, 0);
  eq('workday: and every attempt is counted as failed', stats, { attempts: 2, failures: 2 });
  eq('workday: which classifies as failed, not as empty', classifyCheck({ settled: 'fulfilled', stats }), 'failed');
}
{
  const stats = newRequestStats();
  const page = (n, from) => ({ total: n, jobPostings: Array.from({ length: Math.min(20, n - from) }, (_, i) => ({ externalPath: `/job/${from + i}` })) });
  await paginateWorkday(async (q, offset) => {
    if (q === 'graduate') throw new Error('timeout');
    return page(30, offset);
  }, { queries: ['intern', 'graduate'], stats });
  eq('workday: one query refused is counted', stats, { attempts: 3, failures: 1 });
  eq('workday: which classifies as partial', classifyCheck({ settled: 'fulfilled', stats }), 'partial');
}
{
  const stats = newRequestStats();
  await paginateOracle(async () => ({ items: [{ requisitionList: [], TotalJobsCount: 0 }] }), { queries: ['intern'], stats });
  eq('oracle: a board that answers with nothing is a clean zero', classifyCheck({ settled: 'fulfilled', stats }), 'ok');
}
{
  const seen = await paginateWorkday(async () => { throw new Error('x'); }, { queries: ['intern'] });
  eq('the paginators still work with no stats object', seen.size, 0);
}

// ── 3. the record ───────────────────────────────────────────────────────
const firm = { firm: 'Nomura', ats: 'talnet', tier: 'Bulge Bracket' };
const roles = [
  { id: 'a1', vertical: 'Investment Banking' },
  { id: 'a2', vertical: 'Investment Banking' },
  { id: 'a3', vertical: 'Sales & Trading' },
];
eq('an ok board carries its count and its ids by seat',
  boardRecord({ firm, status: 'ok', roles: [roles[1], roles[2], roles[0]] }),
  { s: 'ok', ats: 'talnet', tier: 'Bulge Bracket', n: 3, roles: { 'Investment Banking': ['a1', 'a2'], 'Sales & Trading': ['a3'] } });
eq('an ok board with nothing open is a true zero',
  boardRecord({ firm, status: 'ok', roles: [] }),
  { s: 'ok', ats: 'talnet', tier: 'Bulge Bracket', n: 0, roles: {} });
eq('a role with no seat is filed under Other rather than dropped',
  boardRecord({ firm, status: 'ok', roles: [{ id: 'z' }] }).roles, { Other: ['z'] });
eq('a failed board has no count, only the carried ids and the reason',
  boardRecord({ firm, status: 'failed', carried: roles.slice(0, 1), reason: 'bot-check interstitial' }),
  { s: 'failed', ats: 'talnet', tier: 'Bulge Bracket', n: null, reason: 'bot-check interstitial', carried: ['a1'] });
eq('a firm with no tier records null rather than omitting it',
  boardRecord({ firm: { firm: 'X', ats: 'lever' }, status: 'ok', roles: [] }).tier, null);

// ── 4. the day's file ───────────────────────────────────────────────────
const file = buildCheckFile({
  date: '2026-09-23',
  checkedAt: '2026-09-23T06:00:00.000Z',
  parked: ['Zeta', 'Alpha'],
  boards: {
    Nomura: boardRecord({ firm, status: 'failed' }),
    Citi: boardRecord({ firm: { firm: 'Citi', ats: 'workday', tier: 'Bulge Bracket' }, status: 'partial', roles }),
    Stripe: boardRecord({ firm: { firm: 'Stripe', ats: 'greenhouse', tier: 'Fintech' }, status: 'ok', roles: [] }),
  },
});
eq('the file counts each status', file.counts, { ok: 1, partial: 1, failed: 1 });
eq('boards are sorted by firm so a day diffs cleanly', Object.keys(file.boards), ['Citi', 'Nomura', 'Stripe']);
eq('parked firms are named, sorted', file.parked, ['Alpha', 'Zeta']);
eq('the file is versioned', file.v, 1);
eq('the file names the collection method it was made under', file.method, COLLECTION_METHOD);
eq('the method is a date, so a bump reads as when the change landed', /^\d{4}-\d{2}-\d{2}[a-z]?$/.test(COLLECTION_METHOD), true);
eq('the path is one file per day', checkFilePath('2026-09-23'), 'data/board-checks/2026-09-23.json');
let threw = false;
try { checkFilePath('../../etc/passwd'); } catch { threw = true; }
eq('a path that is not a date is refused', threw, true);

// ── 5. the tracker producer may publish it, and only it ──────────────────
eq('the tracker run may publish a day of board checks', unexpectedPaths('tracker', ['data/board-checks/2026-09-23.json']), []);
eq('but not a file of any other name there',
  unexpectedPaths('tracker', ['data/board-checks/latest.json', 'data/board-checks/2026-09-23.json.bak']),
  ['data/board-checks/latest.json', 'data/board-checks/2026-09-23.json.bak']);
eq('and no other producer may', unexpectedPaths('open-data', ['data/board-checks/2026-09-23.json']), ['data/board-checks/2026-09-23.json']);
eq('the tracker contract still names the history', CONTRACTS.tracker.files.some((f) => f.path === 'data/tracker-history.json'), true);

console.log(`\n${pass}/${pass + fail} passed`);
if (fail) process.exit(1);
