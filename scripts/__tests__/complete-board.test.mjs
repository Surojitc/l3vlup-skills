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
import { walkOnce, walkCompleteBoard, passVerdict, withRetry, passesAgree, secondPageSize } from '../../lib/complete-board.mjs';
import { checkVerdict, boardRecord, newRequestStats, METHOD_FILES } from '../../lib/board-checks.mjs';

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
  eq('a page that fails twice ends the walk as a failure', [verdict, stats.failures, stats.retries], ['failures', 1, 1]);
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

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
