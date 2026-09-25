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
  METHOD_FILES,
  boardConfigHash,
  boardRecord,
  checkVerdict,
  methodFingerprint,
  publishedView,
  resolveMethod,
  buildCheckFile,
  checkFilePath,
  classifyCheck,
  everyRequestFailed,
  newRequestStats,
  worstStatus,
} from '../../lib/board-checks.mjs';
import { paginateWorkday, paginateOracle } from '../sync-ats.mjs';
import { paginateEightfold } from '../../lib/eightfold.mjs';
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
eq('our budget ending the walk is partial, and says so',
  checkVerdict({ settled: 'fulfilled', stats: { attempts: 30, failures: 0, capped: true } }), { status: 'partial', why: 'budget' });
eq('the per-firm ceiling is partial, and says so',
  checkVerdict({ settled: 'fulfilled', stats: newRequestStats(), ceiling: true }), { status: 'partial', why: 'ceiling' });
eq('a failed request outranks the budget as the reason',
  checkVerdict({ settled: 'fulfilled', stats: { attempts: 5, failures: 1, capped: true } }), { status: 'partial', why: 'failures' });
eq('a clean walk is ok with no reason', checkVerdict({ settled: 'fulfilled', stats: { attempts: 3, failures: 0 } }), { status: 'ok' });
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

// The budget. A board that still has more when our page or posting budget
// runs out yields a count set by us, not by its hiring.
{
  const full = (n) => ({ total: 10_000, jobPostings: Array.from({ length: 20 }, (_, i) => ({ externalPath: `/job/${n}-${i}` })) });
  const stats = newRequestStats();
  await paginateWorkday(async (q, offset) => full(`${q}${offset}`), { queries: ['intern'], maxPages: 3, stats });
  eq('workday: every page full and the page budget gone is capped', stats.capped, true);
}
{
  const full = (n) => ({ total: 10_000, jobPostings: Array.from({ length: 20 }, (_, i) => ({ externalPath: `/job/${n}-${i}` })) });
  const stats = newRequestStats();
  await paginateWorkday(async (q, offset) => full(`${q}${offset}`), { queries: ['intern', 'graduate'], maxPostings: 40, stats });
  eq('workday: the posting budget reached is capped', stats.capped, true);
}
{
  const stats = newRequestStats();
  await paginateWorkday(async (q, offset) => ({ total: 30, jobPostings: Array.from({ length: Math.min(20, 30 - offset) }, (_, i) => ({ externalPath: `/j/${offset + i}` })) }), { queries: ['intern'], stats });
  eq('workday: a board read to its end is not capped', stats.capped ?? false, false);
}
{
  const stats = newRequestStats();
  const req = (n) => Array.from({ length: 25 }, (_, i) => ({ Id: `${n}-${i}` }));
  await paginateOracle(async (q, offset) => ({ items: [{ requisitionList: req(offset), TotalJobsCount: 9999 }] }), { queries: ['intern'], maxPages: 2, stats });
  eq('oracle: the page budget gone with more on the board is capped', stats.capped, true);
}
{
  const stats = newRequestStats();
  await paginateEightfold(async (start, num) => ({ count: 9999, positions: Array.from({ length: num }, (_, i) => ({ id: start + i })) }), { maxPages: 2, page: 10, stats });
  eq('eightfold: the page budget gone with more on the board is capped', stats.capped, true);
  const clean = newRequestStats();
  await paginateEightfold(async () => ({ count: 5, positions: [{ id: 1 }, { id: 2 }] }), { maxPages: 2, page: 10, stats: clean });
  eq('eightfold: a short board is not capped', clean.capped ?? false, false);
}

// ── 3. the record ───────────────────────────────────────────────────────
const firm = { firm: 'Nomura', ats: 'talnet', tier: 'Bulge Bracket' };
const roles = [
  { id: 'a1', vertical: 'Investment Banking' },
  { id: 'a2', vertical: 'Investment Banking' },
  { id: 'a3', vertical: 'Sales & Trading' },
];
const cfg = boardConfigHash(firm);
eq('an ok board carries its count and its ids by seat',
  boardRecord({ firm, status: 'ok', roles: [roles[1], roles[2], roles[0]] }),
  { s: 'ok', ats: 'talnet', tier: 'Bulge Bracket', cfg, n: 3, roles: { 'Investment Banking': ['a1', 'a2'], 'Sales & Trading': ['a3'] } });
eq('an ok board with nothing open is a true zero',
  boardRecord({ firm, status: 'ok', roles: [] }),
  { s: 'ok', ats: 'talnet', tier: 'Bulge Bracket', cfg, n: 0, roles: {} });
eq('a partial board says why', boardRecord({ firm, status: 'partial', why: 'budget', roles }).why, 'budget');
eq('an ok board carries no why', 'why' in boardRecord({ firm, status: 'ok', why: 'budget', roles }), false);
eq('a changed board (another Workday site) has another configuration',
  boardConfigHash({ firm: 'Citi', ats: 'workday', tenant: 'citi', site: 'campus' }) === boardConfigHash({ firm: 'Citi', ats: 'workday', tenant: 'citi', site: 'lateral' }), false);
eq('renaming or re-tiering a firm is not a new board',
  boardConfigHash({ firm: 'Citi', tier: 'Bulge Bracket', ats: 'workday', site: 'campus' }), boardConfigHash({ firm: 'Citigroup', tier: 'Other', ats: 'workday', site: 'campus' }));
eq('key order does not change the configuration',
  boardConfigHash({ ats: 'workday', site: 'a', tenant: 'b' }), boardConfigHash({ tenant: 'b', site: 'a', ats: 'workday' }));
eq('a role with no seat is filed under Other rather than dropped',
  boardRecord({ firm, status: 'ok', roles: [{ id: 'z' }] }).roles, { Other: ['z'] });
eq('a failed board has no count, only the carried ids and the reason',
  boardRecord({ firm, status: 'failed', carried: roles.slice(0, 1), reason: 'bot-check interstitial' }),
  { s: 'failed', ats: 'talnet', tier: 'Bulge Bracket', cfg, n: null, reason: 'bot-check interstitial', carried: ['a1'] });
eq('a firm with no tier records null rather than omitting it',
  boardRecord({ firm: { firm: 'X', ats: 'lever' }, status: 'ok', roles: [] }).tier, null);

// ── 3b. the record describes what the feed publishes ─────────────────────
// The case that found this: on 25 September IMC's board returned an
// "INVITE ONLY ... London Networking Event", the non-role screen dropped it
// from the feed, and the day's file still counted it.
{
  const captured = [
    { id: 'imc-1', vertical: 'Quant', role: 'Quant Trader Intern' },
    { id: 'imc-2', vertical: 'Other', role: 'INVITE ONLY | EU Campus | London Networking Event 1 Oct' },
    { id: 'imc-3', vertical: 'Other', role: 'Software Engineer Intern [REQ-123]' },
  ];
  const published = new Map([
    ['imc-1', captured[0]],
    ['imc-3', { id: 'imc-3', vertical: 'Software Engineering', role: 'Software Engineer Intern' }],
  ]);
  const view = publishedView(captured, published);
  eq('a screened row is dropped and counted', view.screened, 1);
  eq('a kept row is the published version, seat included', view.rows.map((r) => [r.id, r.vertical]), [['imc-1', 'Quant'], ['imc-3', 'Software Engineering']]);
  const rec = boardRecord({ firm, status: 'ok', roles: view.rows, screened: view.screened });
  eq('the record counts only what is published', rec.n, 2);
  eq('and says how many were screened', rec.screened, 1);
  eq('no screening, no field', 'screened' in boardRecord({ firm, status: 'ok', roles: [] }), false);
  eq('ids are compared as strings', publishedView([{ id: 7 }], new Map([['7', { id: 7, vertical: 'Quant' }]])).rows.length, 1);
}

// ── 4. the day's file ───────────────────────────────────────────────────
const file = buildCheckFile({
  method: '2026-09-24',
  fingerprint: 'abc',
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
eq('the file names the collection method and fingerprint it was made under', [file.method, file.fingerprint], ['2026-09-24', 'abc']);

// ── the method, read off the code rather than remembered ─────────────────
{
  const files = { a: 'const PAGE = 20;', b: 'x' };
  const fp = (over = {}) => methodFingerprint((f) => ({ ...files, ...over })[f], ['a', 'b']);
  eq('the fingerprint is stable', fp(), fp());
  eq('any edit to a method file changes it', fp({ a: 'const PAGE = 25;' }) === fp(), false);
  eq('bytes moving between files change it', fp({ a: 'const PAGE = 20;x', b: '' }) === fp(), false);
  eq('an acknowledged fingerprint resolves to its label', resolveMethod('f1', { fingerprints: { f1: { method: '2026-09-24' } } }), '2026-09-24');
  eq('an unacknowledged one compares with nothing', resolveMethod('f2', { fingerprints: { f1: { method: '2026-09-24' } } }), 'unacknowledged:f2');
  eq('no record at all is unacknowledged too', resolveMethod('f3', null), 'unacknowledged:f3');
  eq('the method files include the collector and the classification rules',
    ['scripts/sync-ats.mjs', 'lib/board-checks.mjs'].every((f) => METHOD_FILES.includes(f)), true);
}
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
