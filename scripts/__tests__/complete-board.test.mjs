/**
 * Complete-board collection (lib/complete-board.mjs): when a read of a whole
 * board may be called complete, and every way it must refuse to be.
 *
 * The boards here are simulated with the two properties the live Workday and
 * Oracle boards were measured to have on 27 September: every page states the
 * board's total, and an empty search is ordered newest first. The mutations
 * are applied between page requests, which is when a real board moves under a
 * walk.
 */
import { readFileSync } from 'node:fs';
import {
  walkOnce, walkCompleteBoard, passVerdict, withRetry, passesAgree, secondPageSize,
  COMPLETE_RETRY, COMPLETE_TIMEOUT_MS, readWasIncomplete,
} from '../../lib/complete-board.mjs';
import { checkVerdict, boardRecord, newRequestStats, METHOD_FILES, firmsToCarry } from '../../lib/board-checks.mjs';
import { retainRoles, RETENTION_DAYS } from '../../lib/role-retention.mjs';
import { paginateOracle } from '../sync-ats.mjs';

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `   got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
};

const NO_WAIT = { delayMs: 0 };
const idOf = (r) => r.id;

/**
 * A live board: `ids` newest first. `before(n)` runs before the n-th request
 * (0-based) and may mutate the list, the way postings open and close while a
 * walk is in progress.
 */
function liveBoard(n, { before } = {}) {
  const ids = Array.from({ length: n }, (_, i) => `R-${n - i}`);
  let calls = 0;
  const fetchPage = async (offset, limit) => {
    before?.(calls, ids);
    calls++;
    return { total: ids.length, rows: ids.slice(offset, offset + limit).map((id) => ({ id })) };
  };
  return { fetchPage, ids, calls: () => calls };
}

// ── a board that holds still is read completely ──────────────────────────
{
  const b = liveBoard(95);
  const { seen, diag } = await walkOnce(b.fetchPage, { pageSize: 20, idOf, retry: NO_WAIT });
  eq('a still board: every posting', seen.size, 95);
  eq('...ends on the stated total', diag.terminal, 'reached-total');
  eq('...with the diagnostics a reader needs', [diag.totalStart, diag.totalEnd, diag.pages, diag.raw, diag.unique, diag.duplicates, diag.moved], [95, 95, 5, 95, 95, 0, false]);
  eq('...and is complete', diag.verdict, 'complete');
}
{
  const b = liveBoard(40);
  const { diag } = await walkOnce(b.fetchPage, { pageSize: 20, idOf, retry: NO_WAIT });
  eq('an exact multiple of the page size needs no probe past the end', [diag.pages, diag.verdict], [2, 'complete']);
}
{
  const { diag } = await walkOnce(async () => ({ total: 0, rows: [] }), { pageSize: 20, idOf, retry: NO_WAIT });
  eq('an empty board is a complete read of nothing', [diag.unique, diag.terminal, diag.verdict], [0, 'empty-page', 'complete']);
}

// ── movement under the cursor is never called complete ───────────────────
{
  // A new posting arrives at the top after page 1: everything shifts down one
  // place, one posting is read twice, and the new one is never seen.
  const b = liveBoard(50, { before: (n, ids) => { if (n === 1) ids.unshift('NEW'); } });
  const { seen, diag } = await walkOnce(b.fetchPage, { pageSize: 20, idOf, retry: NO_WAIT });
  eq('an insertion above the cursor shows as a duplicate and a moved total', [diag.duplicates, diag.moved], [1, true]);
  eq('...the new posting was missed', seen.has('NEW'), false);
  eq('...so the pass is unstable, not complete', diag.verdict, 'unstable');
}
{
  // A posting already read closes: everything shifts up one place and one
  // survivor is skipped. Nothing is duplicated, so only the totals and the
  // count can say so.
  const b = liveBoard(50, { before: (n, ids) => { if (n === 1) ids.splice(3, 1); } });
  const { seen, diag } = await walkOnce(b.fetchPage, { pageSize: 20, idOf, retry: NO_WAIT });
  const skipped = b.ids.filter((id) => !seen.has(id));
  eq('a removal above the cursor skips a live posting', skipped.length, 1);
  eq('...and the pass is not called complete', diag.verdict, 'unstable');
}
{
  // Totals that agree but a count that does not: a board whose order is not
  // stable between requests (ties re-sorted) repeats one posting and hides
  // another without its total moving.
  let calls = 0;
  const ids = Array.from({ length: 30 }, (_, i) => `R-${i}`);
  const fetchPage = async (offset, limit) => {
    calls++;
    const order = calls === 2 ? [...ids.slice(0, 19), ids[20], ids[19], ...ids.slice(21)] : ids;
    return { total: 30, rows: order.slice(offset, offset + limit).map((id) => ({ id })) };
  };
  const { diag } = await walkOnce(fetchPage, { pageSize: 20, idOf, retry: NO_WAIT });
  eq('a reshuffle with a steady total is caught by the count', [diag.moved, diag.duplicates, diag.unique, diag.verdict], [false, 1, 29, 'unstable']);
}

// ── the second pass ──────────────────────────────────────────────────────
{
  // The board moves during the first pass only: the second pass is still and
  // is the day's read.
  const b = liveBoard(50, { before: (n, ids) => { if (n === 1) ids.unshift('NEW'); } });
  const stats = newRequestStats();
  const { postings, verdict } = await walkCompleteBoard(b.fetchPage, { pageSize: 20, idOf, stats, retry: NO_WAIT });
  eq('a board that moved once is re-walked and then complete', verdict, 'complete');
  eq('...the second pass sees the new posting', [postings.size, postings.has('NEW')], [51, true]);
  eq('...both passes are recorded', stats.walk.passes.map((p) => p.verdict), ['unstable', 'complete']);
  eq('...and the check is ok', checkVerdict({ settled: 'fulfilled', stats }), { status: 'ok' });
}
{
  // A board that moves during both passes is partial, and the tracker gets
  // the union, so a live posting skipped by one pass is not lost.
  let added = 0;
  const b = liveBoard(50, { before: (n, ids) => { if (n % 3 === 1) ids.unshift(`NEW-${added++}`); } });
  const stats = newRequestStats();
  const { postings, verdict } = await walkCompleteBoard(b.fetchPage, { pageSize: 20, idOf, stats, retry: NO_WAIT });
  eq('a board moving on both passes is unstable', verdict, 'unstable');
  eq('...and partial for that reason', checkVerdict({ settled: 'fulfilled', stats }), { status: 'partial', why: 'unstable' });
  eq('...the tracker gets both passes', postings.size >= 50, true);
  eq('...and never more than two passes', stats.walk.passes.length, 2);
}

// ── retries and failures ─────────────────────────────────────────────────
{
  const b = liveBoard(45);
  let failed = false;
  const flaky = async (o, l) => { if (o === 20 && !failed) { failed = true; throw new Error('timeout'); } return b.fetchPage(o, l); };
  const stats = newRequestStats();
  const { verdict } = await walkCompleteBoard(flaky, { pageSize: 20, idOf, stats, retry: NO_WAIT });
  eq('a page that fails once is retried and the read is complete', [verdict, stats.retries, stats.failures], ['complete', 1, 0]);
  eq('...an ok check', checkVerdict({ settled: 'fulfilled', stats }).status, 'ok');
}
{
  const b = liveBoard(45);
  const dead = async (o, l) => { if (o === 20) throw new Error('timeout'); return b.fetchPage(o, l); };
  const stats = newRequestStats();
  const { postings, verdict } = await walkCompleteBoard(dead, { pageSize: 20, idOf, stats, retry: NO_WAIT });
  // A complete read retries a page twice (COMPLETE_RETRY), so a dead page costs three attempts.
  eq('a page that never answers ends the walk as a failure', [verdict, stats.failures, stats.retries], ['failures', 1, 2]);
  eq('...it is not re-walked', stats.walk.passes.length, 1);
  eq('...and the check is partial, never ok', checkVerdict({ settled: 'fulfilled', stats }), { status: 'partial', why: 'failures' });
  eq('...keeping what it did read for the tracker', postings.size, 20);
}
{
  const stats = newRequestStats();
  await walkCompleteBoard(async () => { throw new Error('403'); }, { pageSize: 20, idOf, stats, retry: NO_WAIT });
  eq('a board refusing every request is failed', checkVerdict({ settled: 'fulfilled', stats }).status, 'failed');
}
{
  const acc = {};
  let n = 0;
  const r = await withRetry(async () => { n++; throw new Error('x'); }, acc, NO_WAIT);
  eq('one retry, never more', [r.ok, n, acc.requests, acc.retries], [false, 2, 2, 1]);
}

// ── boards that cannot prove anything ────────────────────────────────────
{
  const rows = (o, l) => Array.from({ length: Math.max(0, Math.min(l, 25 - o)) }, (_, i) => ({ id: `R-${o + i}` }));
  const { diag } = await walkOnce(async (o, l) => ({ rows: rows(o, l) }), { pageSize: 10, idOf, retry: NO_WAIT });
  eq('a board that states no total is never complete', [diag.unique, diag.terminal, diag.verdict], [25, 'short-page', 'unstable']);
}
{
  let calls = 0;
  const { diag } = await walkOnce(async () => { calls++; return { total: 500, rows: [{ id: 'a' }, { id: 'b' }] }; }, { pageSize: 2, idOf, retry: NO_WAIT });
  eq('a board ignoring the offset stops after the repeat and is not complete', [calls, diag.terminal, diag.verdict], [2, 'replay', 'replay']);
}
{
  // A board that states no total and never serves a short page would walk
  // forever. The hard page cap stops it, and a read the cap ended is a floor.
  let i = 0;
  const endless = async (_o, l) => ({ rows: Array.from({ length: l }, () => ({ id: `R-${i++}` })) });
  const stats = newRequestStats();
  const { verdict } = await walkCompleteBoard(endless, { pageSize: 20, idOf, stats, retry: NO_WAIT, hardMaxPages: 5 });
  eq('a board that never ends stops at the page cap', [verdict, stats.walk.passes[0].pages], ['budget', 5]);
  eq('...and is partial for budget', checkVerdict({ settled: 'fulfilled', stats }), { status: 'partial', why: 'budget' });
}
{
  // With a stated total the cap is derived from the first page's: this board
  // opens at 140 (1.25 x 140 + a page, over 20 a page, plus 2 = 12 pages) and
  // its total then runs away. It stops at 12 pages, not at 1,000.
  let calls = 0, i = 0;
  const runaway = async (_o, l) => { calls++; return { total: 40 + calls * 100, rows: Array.from({ length: l }, () => ({ id: `R-${i++}` })) }; };
  const { diag } = await walkOnce(runaway, { pageSize: 20, idOf, retry: NO_WAIT });
  eq('a runaway total is capped from the first page it stated', [diag.pages, diag.terminal, diag.verdict], [12, 'page-cap', 'budget']);
}
{
  // A server that quietly serves 100 where 200 were asked for costs pages,
  // never postings: the walk advances by what came back.
  const ids = Array.from({ length: 450 }, (_, i) => `R-${i}`);
  const capped = async (o, l) => ({ total: 450, rows: ids.slice(o, o + Math.min(l, 100)).map((id) => ({ id })) });
  const { diag } = await walkOnce(capped, { pageSize: 200, idOf, retry: NO_WAIT });
  eq('a lowered page size is followed, not skipped over', [diag.unique, diag.pages, diag.verdict], [450, 5, 'complete']);
}

// ── agreement: the JPMorgan case (27 September) ──────────────────────────
{
  // The board states N and serves exactly N rows, the last page repeating
  // one row: which row depends on the page size, the distinct set never does.
  const ids = Array.from({ length: 53 }, (_, i) => `R-${i}`);
  const padded = async (offset, limit) => {
    const all = [...ids, ids[ids.length - 1 - (limit % 3)]]; // a tail row served twice
    return { total: all.length, rows: all.slice(offset, offset + limit).map((id) => ({ id })) };
  };
  const stats = newRequestStats();
  const { postings, verdict } = await walkCompleteBoard(padded, { pageSize: 20, idOf, stats, retry: NO_WAIT });
  eq('a board padding its tail with a repeated row: first pass is not strictly complete', stats.walk.passes[0].verdict, 'unstable');
  eq('...the second pass uses a different page size', stats.walk.passes.map((p) => p.pageSize), [20, secondPageSize(20)]);
  eq('...both passes return the same distinct set, so the board is complete by agreement', [verdict, postings.size], ['agreed', 53]);
  eq('...and the check is ok', checkVerdict({ settled: 'fulfilled', stats }), { status: 'ok' });
}
{
  // Ties in the sort re-ordered at page boundaries: a posting straddling a
  // boundary is read twice and its neighbour never. Moving the boundaries
  // (the second pass's page size) loses a different posting, so the two sets
  // differ and the board is NOT called complete.
  const ids = Array.from({ length: 60 }, (_, i) => `R-${i}`);
  const tie = async (offset, limit) => {
    // At every boundary the first row of the page repeats the previous page's last.
    const rows = ids.slice(offset, offset + limit);
    if (offset > 0 && rows.length) rows[0] = ids[offset - 1];
    return { total: ids.length, rows: rows.map((id) => ({ id })) };
  };
  const stats = newRequestStats();
  const { verdict, postings } = await walkCompleteBoard(tie, { pageSize: 20, idOf, stats, retry: NO_WAIT });
  eq('a boundary shift that moves with the page size is never agreed', verdict, 'unstable');
  eq('...partial, unstable', checkVerdict({ settled: 'fulfilled', stats }), { status: 'partial', why: 'unstable' });
  eq('...and the tracker gets the union of what both passes saw', postings.size > stats.walk.passes[0].unique, true);
}
{
  const a = { failures: 0, terminal: 'reached-total', moved: false, totalStart: 5, totalEnd: 5 };
  const set = (...k) => new Map(k.map((x) => [x, {}]));
  eq('agreement needs identical sets', passesAgree([a, a], [set('a', 'b'), set('a', 'c')]), false);
  eq('agreement needs the same total on both passes', passesAgree([a, { ...a, totalStart: 6, totalEnd: 6 }], [set('a'), set('a')]), false);
  eq('agreement refuses a pass that moved', passesAgree([a, { ...a, moved: true }], [set('a'), set('a')]), false);
  eq('agreement refuses a pass with a failed page', passesAgree([a, { ...a, failures: 1, terminal: 'failure' }], [set('a'), set('a')]), false);
  eq('agreement refuses a pass ended by our cap', passesAgree([a, { ...a, terminal: 'page-cap' }], [set('a'), set('a')]), false);
  eq('agreement holds when everything matches', passesAgree([a, a], [set('a', 'b'), set('b', 'a')]), true);
}
{
  // A last page holding only rows already seen is not a replay of page one:
  // the walk ends on the board's total and is judged on its counts.
  const ids = Array.from({ length: 21 }, (_, i) => `R-${i}`);
  const f = async (o, l) => ({ total: 21, rows: (o === 20 ? [ids[5]] : ids.slice(o, o + l)).map((id) => ({ id })) });
  const { diag } = await walkOnce(f, { pageSize: 20, idOf, retry: NO_WAIT });
  eq('a last page of already-seen rows is not called a replay', [diag.terminal, diag.duplicates, diag.verdict], ['reached-total', 1, 'unstable']);
}

// ── the verdict table itself ─────────────────────────────────────────────
{
  const base = { terminal: 'reached-total', totalStart: 10, totalEnd: 10, moved: false, duplicates: 0, unique: 10 };
  eq('complete when every condition holds', passVerdict(base), 'complete');
  eq('a moved total is unstable', passVerdict({ ...base, moved: true }), 'unstable');
  eq('a duplicate is unstable', passVerdict({ ...base, duplicates: 1 }), 'unstable');
  eq('a count short of the total is unstable', passVerdict({ ...base, unique: 9 }), 'unstable');
  eq('a failure is a failure whatever else holds', passVerdict({ ...base, terminal: 'failure' }), 'failures');
}

// ── the record and the method ────────────────────────────────────────────
{
  const walk = { mode: 'complete', pageSize: 20, verdict: 'complete', passes: [{ totalStart: 3, totalEnd: 3 }] };
  const rec = boardRecord({ firm: { firm: 'X', ats: 'workday', collect: 'complete' }, status: 'ok', roles: [], walk });
  eq('the day file carries the walk diagnostics', rec.walk, walk);
  const plain = boardRecord({ firm: { firm: 'Y', ats: 'workday' }, status: 'ok', roles: [] });
  eq('a keyword board carries none', 'walk' in plain, false);
  const a = boardRecord({ firm: { firm: 'X', ats: 'workday', tenant: 't', site: 's' }, status: 'ok' }).cfg;
  const b = boardRecord({ firm: { firm: 'X', ats: 'workday', tenant: 't', site: 's', collect: 'complete' }, status: 'ok' }).cfg;
  eq('switching a board to complete collection changes its configuration hash', a !== b, true);
  eq('the walker is a method file', METHOD_FILES.includes('lib/complete-board.mjs'), true);
}


// ══ A complete read that stops part way (28 September, JPMorgan) ═════════
//
// Production run 36460556271: one deep JPMorgan page did not answer inside
// 12 s, twice, the walk ended there, the tracker got the 31 roles above the
// stop and lost the rest, and the publication gate refused the feed. Two
// layers: the transport waits longer on a complete read, and when a read
// still stops, what it never reached is carried, not closed.

const recordingSleep = () => {
  const waits = [];
  return { waits, sleep: async (ms) => { waits.push(ms); } };
};

// ── transport: complete reads only ───────────────────────────────────────
eq('complete read: 30 s per page, two retries after 5 s then 15 s',
   [COMPLETE_TIMEOUT_MS, COMPLETE_RETRY.retries, [...COMPLETE_RETRY.delayMs]], [30000, 2, [5000, 15000]]);
{
  // A JPMorgan-like board, 7,500 postings at 200 a page: page 30 is slow
  // twice (two timeouts) and answers on the third attempt.
  const b = liveBoard(7500);
  const slow = new Map();
  const jpm = async (o, l) => {
    if (o === 6000) {
      const n = (slow.get(o) ?? 0) + 1;
      slow.set(o, n);
      if (n <= 2) throw new Error('The operation was aborted due to timeout');
    }
    return b.fetchPage(o, l);
  };
  const { waits, sleep } = recordingSleep();
  const stats = newRequestStats();
  const { postings, verdict } = await walkCompleteBoard(jpm, { pageSize: 200, idOf, stats, retry: { sleep } });
  eq('JPMorgan-like: a deep page timing out twice no longer ends the read', [verdict, postings.size], ['complete', 7500]);
  eq('...two retries, waiting 5 s then 15 s', [stats.retries, waits], [2, [5000, 15000]]);
  eq('...an ok check', checkVerdict({ settled: 'fulfilled', stats }).status, 'ok');
}
{
  // Ordinary (keyword) boards keep one retry after 1.5 s, whatever changed above.
  const { waits, sleep } = recordingSleep();
  const acc = {};
  let n = 0;
  await withRetry(async () => { n++; throw new Error('x'); }, acc, { sleep });
  eq('ordinary boards: one retry after 1.5 s, unchanged', [n, waits], [2, [1500]]);

  const pw = recordingSleep();
  let calls = 0;
  const stats = newRequestStats();
  await paginateOracle(async () => { calls++; throw new Error('timeout'); }, { queries: ['intern'], page: 2, stats, retry: { sleep: pw.sleep } });
  eq('...the keyword Oracle walk still gives a page two attempts', [calls, pw.waits], [2, [1500]]);

  const src = readFileSync(new URL('../sync-ats.mjs', import.meta.url), 'utf8');
  eq('...and the ordinary timeout is still 12 s', /const TIMEOUT_MS = 12000;/.test(src), true);
  eq('...the longer timeout is chosen only for a complete read, on both platforms',
     (src.match(/f\.collect === 'complete' \? COMPLETE_TIMEOUT_MS : TIMEOUT_MS/g) ?? []).length, 2);
  eq('...and no request budget moved',
     ['WORKDAY_MAX_PAGES_PER_QUERY = 15', 'WORKDAY_MAX_POSTINGS_PER_FIRM = 600', 'ORACLE_MAX_PAGES_PER_QUERY = 8',
      'ORACLE_MAX_POSTINGS_PER_FIRM = 600', 'const POOL = 8;', 'const ORACLE_COMPLETE_PAGE = 200;'].every((t) => src.includes(t)), true);
}

// ── which reads carry ────────────────────────────────────────────────────
{
  const walk = (verdict) => ({ mode: 'complete', verdict });
  const checks = [
    { firm: { firm: 'Ok' }, status: 'ok', walk: walk('complete') },
    { firm: { firm: 'Agreed' }, status: 'ok', walk: walk('agreed') },
    { firm: { firm: 'Failed' }, status: 'failed' },
    { firm: { firm: 'Stopped' }, status: 'partial', why: 'failures', walk: walk('failures') },
    { firm: { firm: 'Capped' }, status: 'partial', why: 'budget', walk: walk('budget') },
    { firm: { firm: 'Replayed' }, status: 'partial', why: 'unstable', walk: walk('replay') },
    { firm: { firm: 'Unstable' }, status: 'partial', why: 'unstable', walk: walk('unstable') },
    { firm: { firm: 'KeywordPartial' }, status: 'partial', why: 'failures' },
    { firm: { firm: 'Ceiling' }, status: 'partial', why: 'ceiling', walk: walk('complete') },
  ];
  eq('carried: failed boards, and complete reads that stopped part way; nothing else',
     firmsToCarry(checks), ['Failed', 'Stopped', 'Capped', 'Replayed']);
  eq('readWasIncomplete needs a complete-board walk', [readWasIncomplete(undefined), readWasIncomplete({ verdict: 'failures' })], [false, false]);
}

// ── the whole path: walk, verdict, carry, record ─────────────────────────
//
// Yesterday's feed held 10 JPMorgan roles. Today the board holds 60 postings;
// the early-career ones are R-60..R-51 (above the stop) and R-20..R-11
// (below it). R-55 closed overnight. A page below offset 20 never answers.
const TODAY = '2026-09-29';
const pub = (id, o = {}) => ({ id: `oracle-jpm-${id}`, firm: 'JPMorgan Chase', vertical: 'Wealth Management', role: id, lastConfirmedAt: '2026-09-28', tags: ['Auto-sourced'], ...o });
const yesterday = ['R-58', 'R-56', 'R-55', 'R-52', 'R-19', 'R-17', 'R-15', 'R-14', 'R-12', 'R-11'].map((id) => pub(id));
const board = (live) => {
  const ids = Array.from({ length: 60 }, (_, i) => `R-${60 - i}`).filter((id) => live.has(id));
  return async (offset, limit) => ({ total: ids.length, rows: ids.slice(offset, offset + limit).map((id) => ({ id })) });
};
const everything = new Set(Array.from({ length: 60 }, (_, i) => `R-${60 - i}`).filter((id) => id !== 'R-55'));
const earlyCareer = (id) => { const n = Number(id.slice(2)); return (n >= 51 && n <= 60) || (n >= 11 && n <= 20); };

async function day(fetchPage, previous) {
  const stats = newRequestStats();
  const { postings } = await walkCompleteBoard(fetchPage, { pageSize: 20, idOf, stats, retry: { sleep: async () => {} } });
  const { status, why } = checkVerdict({ settled: 'fulfilled', stats });
  const collected = [...postings.keys()].filter(earlyCareer).map((id) => pub(id, { lastConfirmedAt: TODAY }));
  const check = { firm: { firm: 'JPMorgan Chase', ats: 'oracle' }, status, why, walk: stats.walk };
  const carried = retainRoles(previous, firmsToCarry([check]), TODAY, { collected: new Set(collected.map((o) => o.id)) });
  const record = boardRecord({ firm: check.firm, status, why, roles: collected, carried, walk: stats.walk });
  return { status, why, collected, carried, record };
}
{
  const good = board(everything);
  const stuck = async (o, l) => { if (o >= 20) throw new Error('The operation was aborted due to timeout'); return good(o, l); };
  const d = await day(stuck, yesterday);
  const ids = (rows) => rows.map((r) => r.role).sort();
  eq('stopped read: partial for failures, never ok', [d.status, d.why], ['partial', 'failures']);
  eq('...roles above the stop are today\'s observation', ids(d.collected), ['R-51', 'R-52', 'R-53', 'R-54', 'R-56', 'R-57', 'R-58', 'R-59', 'R-60']);
  eq('...previously published roles the read did not see are carried, not closed',
     ids(d.carried), ['R-11', 'R-12', 'R-14', 'R-15', 'R-17', 'R-19', 'R-55']);
  // R-55 closed overnight, in the part of the board the read did cover. A
  // stopped read cannot tell "closed above the stop" from "never reached"
  // (only posting dates could, and they tie and go missing), so it is carried
  // too, until the next complete read or RETENTION_DAYS, whichever is first.
  eq('...including one that closed above the stop: absence proves nothing on a read that stopped', d.carried.some((r) => r.role === 'R-55'), true);
  const both = d.collected.map((r) => r.id).filter((id) => d.carried.some((c) => c.id === id));
  eq('...no role is both collected and carried', both, []);
  eq('...carried rows are marked Unconfirmed and keep their last sighting',
     d.carried.every((r) => r.tags.includes('Unconfirmed') && r.lastConfirmedAt === '2026-09-28' && r.unconfirmedDays === 1), true);
  eq('...the day\'s record: partial, n counts only what was seen, carried beside it',
     [d.record.s, d.record.why, d.record.n, d.record.carried?.length ?? 0, Object.values(d.record.roles).flat().length], ['partial', 'failures', 9, 7, 9]);
  eq('...and its roles and carried ids never overlap',
     Object.values(d.record.roles).flat().filter((id) => (d.record.carried ?? []).includes(id)), []);

  // The next day the board reads in full, and R-17 and R-12 have closed.
  const live = new Set(everything); live.delete('R-17'); live.delete('R-12');
  const next = await day(board(live), [...d.collected, ...d.carried]);
  eq('a later complete read is ok and carries nothing', [next.status, next.carried.length], ['ok', 0]);
  eq('...so the roles that really closed are gone, R-55 included',
     ['R-17', 'R-12', 'R-55'].some((id) => next.collected.some((r) => r.role === id) || next.carried.some((r) => r.role === id)), false);
  eq('...and the carried roles still open are observed again', ['R-19', 'R-15', 'R-11'].every((id) => next.collected.some((r) => r.role === id)), true);
}
{
  // Carry expiry: a role last seen more than RETENTION_DAYS ago is dropped
  // even when the read stopped part way, so a board that keeps stopping cannot
  // keep a closed role alive.
  const stale = pub('R-19', { lastConfirmedAt: '2026-09-21' });
  const edge = pub('R-17', { lastConfirmedAt: '2026-09-22' });
  const stuck = async (o, l) => { if (o >= 20) throw new Error('timeout'); return board(everything)(o, l); };
  const d = await day(stuck, [stale, edge]);
  eq(`carry expiry: ${RETENTION_DAYS} days old is carried, ${RETENTION_DAYS + 1} is dropped`, d.carried.map((r) => r.role), ['R-17']);
}
{
  // Unstable after two passes that both reached the board's end: the tracker
  // gets their union, and a previously published role neither pass saw is
  // treated as closed, exactly as before this change.
  let calls = 0;
  const moving = async (o, l) => {
    calls++;
    const ids = Array.from({ length: 60 }, (_, i) => `R-${60 - i}`).filter((id) => everything.has(id) && id !== 'R-15');
    if (calls % 2 === 0) ids.unshift(`NEW-${calls}`);
    return { total: ids.length, rows: ids.slice(o, o + l).map((id) => ({ id })) };
  };
  const d = await day(moving, yesterday);
  eq('unstable two-pass read: partial, unstable', [d.status, d.why, d.record.walk.passes.length], ['partial', 'unstable', 2]);
  eq('...carries nothing: a role absent from both full passes is not held open', d.carried.length, 0);
  eq('...and the Pulse still excludes it (partial)', d.record.s, 'partial');
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
