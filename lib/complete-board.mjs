/**
 * Complete-board collection: read every posting on a board, then classify
 * locally, and say whether the read can be shown to be complete.
 *
 * WHY
 * ---
 * Keyword search is fuzzy on both Workday and Oracle ("intern" matches
 * "internal" and "international"), so on a large board the keyword walk
 * downloads most of the board anyway and still stops at the per-query page
 * budget. The read-only audit of 26 September found JPMorgan, Barclays, ING and
 * Capital One partial every day for exactly that reason, with 188 relevant
 * roles never reaching the tracker. For those boards (registry `collect:
 * "complete"`) the collector now asks for the whole board with an empty search
 * and lets the existing early-career classifier decide, unchanged. The walk is
 * bounded by the board's own stated total, not by a global budget.
 *
 * WHEN A READ COUNTS AS COMPLETE
 * ------------------------------
 * Offset pagination over a live board is not a snapshot: a posting removed
 * above the cursor shifts every later posting up one place and one survivor is
 * never seen; a posting inserted above it shifts them down and one is seen
 * twice. Both platforms report the board's total on every page and order an
 * empty search newest first, so new postings land above the cursor and show up
 * as a duplicate. A pass is complete only when all of these hold:
 *
 *   - it ended on a terminal condition the board supplied: the offset reached
 *     the stated total, or an empty page (never our page cap, never a replay)
 *   - every page answered, after at most one retry each
 *   - every page stated the same total (the board did not move)
 *   - no posting was seen twice (nothing shifted under the cursor)
 *   - the number of distinct postings equals that total
 *
 * A pass that ends normally but fails one of the last three is re-walked once,
 * from the top, with a different page size. If the second pass is complete it
 * is the day's read. Otherwise the board is `ok` only by AGREEMENT: both passes
 * ended on the board's own terminal condition with no failed page, every page
 * of both stated one and the same total, and the two passes returned exactly
 * the same set of distinct postings. Anything else is `partial` with `why:
 * "unstable"`, which the Hiring Pulse excludes like every other partial.
 * Uncertainty is never promoted to `ok`.
 *
 * Why agreement is enough, and why the page size changes: JPMorgan's Oracle
 * board on 27 September stated 7,503 postings and served exactly 7,503 rows,
 * one of them a requisition repeated on the last page, on every walk, in
 * either sort order. Walks at 200 and at 125 a page repeated different rows
 * and returned the same 7,502 distinct requisitions, and their union was
 * 7,502: nothing is missing, the stated total counts one row twice. A shift
 * under the cursor, from movement or from ties in the sort, happens at a page
 * boundary, and changing the page size moves every boundary, so two passes of
 * different sizes that still return the identical set are not two samples of
 * the same accident.
 *
 * The residual case the rule cannot see is a removal above the cursor exactly
 * balanced by a posting inserted below it within the same walk, which the
 * newest-first order makes rare. It is written down rather than claimed away.
 *
 * WHAT THE TRACKER GETS
 * ---------------------
 * A complete pass: its postings. Two agreeing passes: the second pass's, which
 * are the first's. An unstable board: the union of both passes,
 * so a live role skipped by a shift in one pass still reaches the tracker (a
 * role that closed between passes may show for a day). A failed page ends the
 * walk and the board is partial for `failures`, as before.
 *
 * `fetchPage(offset, limit)` returns `{ total, rows }` and is injected so every
 * rule here is tested without a live board.
 */

export const COMPLETE_PASSES = 2;

/** The second pass's page size: different from the first, so its boundaries fall elsewhere. */
export const secondPageSize = (pageSize) => Math.max(1, Math.round(pageSize * 0.75));

/** One request, retried once on failure. Counts into `acc`. */
export async function withRetry(fn, acc, { retries = 1, delayMs = 1500, sleep = defaultSleep } = {}) {
  for (let attempt = 0; ; attempt++) {
    acc.requests = (acc.requests ?? 0) + 1;
    try {
      return { ok: true, value: await fn() };
    } catch (err) {
      if (attempt >= retries) return { ok: false, error: err };
      acc.retries = (acc.retries ?? 0) + 1;
      if (delayMs > 0) await sleep(delayMs);
    }
  }
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One pass over the board, top to bottom.
 *
 * The page cap is derived from the board's own first-page total (with room for
 * growth during the walk), so it bounds a misbehaving board without being a
 * budget on a healthy one. Reaching it is `terminal: "page-cap"`, a floor.
 */
export async function walkOnce(fetchPage, { pageSize, idOf, hardMaxPages = 1000, retry = {} } = {}) {
  const seen = new Map();
  const d = { requests: 0, retries: 0, failures: 0, pages: 0, raw: 0, duplicates: 0, totals: [], terminal: null };
  let offset = 0;
  let maxPages = hardMaxPages;
  let firstPage = null;
  for (;;) {
    if (d.pages >= maxPages) { d.terminal = 'page-cap'; break; }
    const res = await withRetry(() => fetchPage(offset, pageSize), d, retry);
    if (!res.ok) { d.failures += 1; d.terminal = 'failure'; d.error = String(res.error?.message ?? res.error).slice(0, 80); break; }
    d.pages += 1;
    const { total, rows = [] } = res.value ?? {};
    if (typeof total === 'number') {
      d.totals.push(total);
      if (d.pages === 1) maxPages = Math.min(hardMaxPages, Math.ceil((total * 1.25 + pageSize) / pageSize) + 2);
    }
    if (rows.length === 0) { d.terminal = 'empty-page'; break; }
    d.raw += rows.length;
    const ids = rows.map(idOf);
    for (let i = 0; i < rows.length; i++) {
      const id = ids[i];
      if (id == null) continue;
      if (seen.has(id)) d.duplicates += 1;
      else seen.set(id, rows[i]);
    }
    // A board ignoring the offset serves page one again: stop rather than
    // loop, and do not call the read complete. A later page that merely holds
    // postings already seen (a repeated row, a shift) is not that; it is
    // counted as duplicates and the walk goes on to the board's own end.
    const key = ids.join('\u0000');
    if (d.pages === 1) firstPage = key;
    else if (key === firstPage) { d.terminal = 'replay'; break; }
    // Advance by what came back, not by what was asked for: a server that
    // quietly lowers its page size must not make us skip postings.
    offset += rows.length;
    if (typeof total === 'number' && offset >= total) { d.terminal = 'reached-total'; break; }
    if (typeof total !== 'number' && rows.length < pageSize) { d.terminal = 'short-page'; break; }
  }
  d.pageSize = pageSize;
  d.unique = seen.size;
  d.totalStart = d.totals[0] ?? null;
  d.totalEnd = d.totals[d.totals.length - 1] ?? null;
  d.moved = d.totals.length > 0 && Math.min(...d.totals) !== Math.max(...d.totals);
  delete d.totals;
  d.verdict = passVerdict(d);
  return { seen, diag: d };
}

/**
 * complete  the pass can be shown to have read the whole board
 * unstable  it ended normally but the board moved, shifted or disagreed with
 *           its own total
 * failures  a page failed twice
 * budget    the derived page cap ended it
 * replay    the board ignored the offset
 */
export function passVerdict(d) {
  if (d.terminal === 'failure') return 'failures';
  if (d.terminal === 'page-cap') return 'budget';
  if (d.terminal === 'replay') return 'replay';
  if (d.totalStart == null) return 'unstable'; // no stated total: nothing to prove completeness against
  if (d.moved || d.duplicates > 0 || d.unique !== d.totalEnd) return 'unstable';
  if (d.terminal !== 'reached-total' && d.terminal !== 'empty-page') return 'unstable';
  return 'complete';
}

/**
 * Two passes agree when each ended on the board's own terminal condition with
 * no failed page, the board never moved (every page of both passes stated the
 * same total), and they returned exactly the same distinct postings.
 */
export function passesAgree(passes, sets) {
  if (passes.length < 2) return false;
  const [a, b] = passes;
  const ended = (d) => d.failures === 0 && (d.terminal === 'reached-total' || d.terminal === 'empty-page');
  if (!ended(a) || !ended(b) || a.moved || b.moved) return false;
  if (a.totalStart == null || a.totalStart !== b.totalStart || a.totalEnd !== b.totalEnd) return false;
  const [x, y] = sets;
  if (x.size !== y.size) return false;
  for (const k of x.keys()) if (!y.has(k)) return false;
  return true;
}

/**
 * Walk the whole board, re-walking once if the first pass could not be shown
 * complete for reasons of movement. Returns the postings to use and the
 * diagnostics for the day's board-check record.
 *
 * `stats` is the board's request accounting (lib/board-checks.mjs): pages
 * attempted, pages failed after their retry, and the flags the check verdict
 * reads (`capped`, `unstable`).
 */
export async function walkCompleteBoard(fetchPage, { pageSize, idOf, stats, retry, hardMaxPages } = {}) {
  const passes = [];
  const sets = [];
  let result;
  let union = new Map();
  for (let p = 0; p < COMPLETE_PASSES; p++) {
    const size = p === 0 ? pageSize : secondPageSize(pageSize);
    const { seen, diag } = await walkOnce(fetchPage, { pageSize: size, idOf, retry, hardMaxPages });
    passes.push(diag);
    sets.push(seen);
    for (const [k, v] of seen) if (!union.has(k)) union.set(k, v);
    if (stats) {
      stats.attempts += diag.pages + diag.failures;
      stats.failures += diag.failures;
      stats.retries = (stats.retries ?? 0) + diag.retries;
    }
    if (diag.verdict === 'complete') { result = { postings: seen, verdict: 'complete' }; break; }
    // Only movement earns a second look; a failed page, the cap or a replay
    // would fail the same way again and cost the board another walk.
    if (diag.verdict !== 'unstable') { result = { postings: union, verdict: diag.verdict }; break; }
  }
  // Neither pass was strictly complete: ok only if the two agree exactly.
  if (!result && passesAgree(passes, sets)) result = { postings: sets[1], verdict: 'agreed' };
  result ??= { postings: union, verdict: 'unstable' };
  if (stats) {
    if (result.verdict === 'budget') stats.capped = true;
    if (result.verdict === 'unstable' || result.verdict === 'replay') stats.unstable = true;
    stats.walk = { mode: 'complete', pageSize, verdict: result.verdict, passes };
  }
  return result;
}
