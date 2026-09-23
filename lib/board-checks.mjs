/**
 * What each board check actually established, one record per firm per run.
 *
 * WHY THIS EXISTS
 * ---------------
 * The tracker history records which role ids were on the board each day. That
 * is enough to say "this role was first seen on the 3rd", and not enough to
 * say anything about hiring, because three different events all look like a
 * firm with fewer roles:
 *
 *   1. the firm closed roles (a fact about hiring),
 *   2. the board refused us (a fact about our collector), and
 *   3. some of the board's pages refused us (the same, but quieter).
 *
 * Worse, (2) does not even look like a drop in the history: a failed board's
 * last known roles are carried forward for up to a week (lib/role-retention.mjs)
 * and those carried ids are written into the snapshot beside the ones seen
 * this morning. And (3) could look like a healthy empty board: the paginated
 * fetchers end a query quietly when a page throws, so a Workday site whose
 * every request failed used to answer "0 roles" and count as ok.
 *
 * A hiring measure has to exclude every observation it cannot compare, so the
 * collector writes down, per firm, which of those it was. The status is about
 * the check, never about the firm:
 *
 *   ok       every request answered. `n` is the complete count, and 0 is a
 *            true zero: the board holds no early-career role we collate.
 *   partial  at least one request answered and at least one did not. `n` is a
 *            lower bound, and the observation is not comparable.
 *   failed   nothing answered. `n` is absent, and any roles on the site for
 *            this firm today were carried forward, not seen (`carried`).
 *
 * WHY A FILE PER DAY
 * ------------------
 * The measure needs a year of these to say anything year on year, and the
 * tracker history is capped at 120 days and already read by programme pages.
 * One small append-only file per day (data/board-checks/YYYY-MM-DD.json) keeps
 * history out of every page render, diffs cleanly, and never rewrites a day
 * that has already been published.
 */

export const CHECK_VERSION = 1;

/**
 * The collection method, bumped by hand whenever a change alters WHICH roles
 * a healthy board yields: a filter, a classifier, pagination, a cap, a query
 * list. Not for a comment, a log line or a new firm (a new firm is simply not
 * comparable until it has two days).
 *
 * Two days under different methods are not compared, even for the same firm.
 * The backtest that motivated this found sixteen unchanged firms "up 118%" in
 * the week Workday pagination landed and the per-firm cap came off; Citi went
 * from 10 roles to 62 with no change in Citi's hiring. Format: the date of the
 * change, with a letter if two land on one day.
 */
export const COLLECTION_METHOD = '2026-09-23';

/**
 * Request accounting for one board. Single-request fetchers throw on failure
 * and never touch it; the paginated ones count every page they asked for.
 */
export function newRequestStats() {
  return { attempts: 0, failures: 0 };
}

/**
 * Classify one board check.
 *
 * @param {{ settled: 'fulfilled'|'rejected', stats?: {attempts:number,failures:number} }} input
 */
export function classifyCheck({ settled, stats }) {
  if (settled !== 'fulfilled') return 'failed';
  const attempts = stats?.attempts ?? 0;
  const failures = stats?.failures ?? 0;
  if (attempts > 0 && failures >= attempts) return 'failed';
  if (failures > 0) return 'partial';
  return 'ok';
}

const SEVERITY = { ok: 0, partial: 1, failed: 2 };

/**
 * One firm, two boards (none today, but the registry permits it): the day's
 * record is only as good as the worse of the two checks.
 */
export function worstStatus(a, b) {
  return SEVERITY[b] > SEVERITY[a] ? b : a;
}

/**
 * True when every request a paginated fetcher made was refused. The caller
 * throws, so the board lands with the failed boards (and its roles are carried
 * forward) rather than reading as a board that answered with nothing.
 */
export function everyRequestFailed(stats) {
  return (stats?.attempts ?? 0) > 0 && stats.failures >= stats.attempts;
}

/**
 * The record of one board for the day's file.
 *
 * @param firm       registry row: { firm, ats, tier }
 * @param status     from classifyCheck
 * @param roles      opportunities observed on the board this run (not carried)
 * @param carried    opportunities carried forward for this firm
 * @param reason     why a failed board failed, trimmed
 */
export function boardRecord({ firm, status, roles = [], carried = [], reason }) {
  const record = { s: status, ats: firm.ats, tier: firm.tier ?? null };
  if (status === 'failed') {
    record.n = null;
    if (reason) record.reason = String(reason).slice(0, 80);
  } else {
    record.n = roles.length;
    // Ids grouped by seat, so both the count per seat and the roles that
    // opened or closed in it can be read off two days' files with nothing
    // else joined in. Sorted, so an unchanged board diffs as unchanged.
    const bySeat = {};
    for (const o of roles) (bySeat[o.vertical ?? 'Other'] ??= []).push(String(o.id));
    record.roles = Object.fromEntries(
      Object.entries(bySeat)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([seat, ids]) => [seat, ids.sort()])
    );
  }
  if (carried.length) record.carried = carried.map((o) => String(o.id));
  return record;
}

/**
 * The whole day's file.
 *
 * `boards` is keyed by firm name, which is what the feed's `firm` field
 * carries and what the site joins company pages on.
 */
export function buildCheckFile({ date, checkedAt, boards, parked = [] }) {
  const counts = { ok: 0, partial: 0, failed: 0 };
  for (const b of Object.values(boards)) counts[b.s] = (counts[b.s] ?? 0) + 1;
  return {
    v: CHECK_VERSION,
    method: COLLECTION_METHOD,
    date,
    checkedAt,
    counts,
    parked: [...parked].sort(),
    boards: Object.fromEntries(Object.entries(boards).sort(([a], [b]) => a.localeCompare(b))),
  };
}

/** The file a given run day is written to, relative to the repository root. */
export function checkFilePath(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`not an ISO date: ${date}`);
  return `data/board-checks/${date}.json`;
}
