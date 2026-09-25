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
 *   ok       every listing request answered and the board, not our budget,
 *            ended the walk. `n` is the complete count, and 0 is a true zero:
 *            the board holds no early-career role we collate.
 *   partial  the board answered, but `n` is a floor rather than a census, for
 *            exactly one of three reasons, recorded in `why`:
 *              failures  at least one listing request failed and at least
 *                        one succeeded (a Workday query dying on page 3)
 *              budget    our page or posting budget ended the walk while the
 *                        board still had more (Workday and Oracle stop at 600
 *                        postings per firm, Eightfold at its page limit)
 *              ceiling   more early-career roles than PER_FIRM_CEILING
 *   failed   no listing request answered, or the fetcher threw. `n` is null,
 *            and any roles on the site for this firm today were carried
 *            forward, not seen (`carried`).
 *
 * WHAT DOES NOT MAKE A CHECK PARTIAL
 * ----------------------------------
 * Only the listing decides which roles exist. A failed detail page (tal.net's
 * per-role page, the Workday detail pass, the JobPosting deadline pass) costs
 * a deadline or a location, never a role, so it leaves the check `ok`.
 *
 * ELIGIBILITY
 * -----------
 * Only `ok` is comparable. A partial count moves with how many of our requests
 * happened to fail or how far the budget reached, which is a fact about us, so
 * no measure may use it, not even as a lower bound: a floor compared with a
 * floor has no sign. Partial and failed boards are excluded from every
 * comparison, and the number excluded, by reason, is part of the result.
 *
 * WHY A FILE PER DAY
 * ------------------
 * The measure needs a year of these to say anything year on year, and the
 * tracker history is capped at 120 days and already read by programme pages.
 * One small append-only file per day (data/board-checks/YYYY-MM-DD.json) keeps
 * history out of every page render, diffs cleanly, and never rewrites a day
 * that has already been published.
 */

import { createHash } from 'node:crypto';

export const CHECK_VERSION = 1;

/**
 * The collection method, and why nobody has to remember to bump it.
 *
 * Two days collected under different methods are not compared, even for the
 * same firm. The backtest that motivated this found sixteen unchanged firms
 * "up 118%" in the week Workday pagination landed and the per-firm cap came
 * off; Citi went from 10 roles to 62 with no change in Citi's hiring.
 *
 * A hand-maintained version constant fails exactly when it matters: the one
 * change someone forgets to bump is a comparison published across a method
 * change. So the collector fingerprints its own method-sensitive source at
 * run time (METHOD_FILES) and looks the fingerprint up in
 * lib/collection-method.json, where every fingerprint ever run is mapped to
 * a method label by a person. A fingerprint nobody has acknowledged is
 * recorded as `unacknowledged:<fingerprint>`, which equals no other label, so
 * that day compares with nothing. Forgetting costs a gap in the Pulse, never a
 * wrong number. `node scripts/collection-method.mjs` says what to record, and
 * scripts/__tests__/collection-method.test.mjs fails until someone has.
 */
export const METHOD_FILES = [
  'scripts/sync-ats.mjs',
  'lib/board-checks.mjs',
  'lib/eightfold.mjs',
  'lib/janestreet.mjs',
  'lib/talnet.mjs',
];

/**
 * sha256 over the method files, each prefixed by its path and length so a
 * byte moving between files still changes the fingerprint. First 16 hex.
 *
 * @param read (path) => string, injected so the test needs no filesystem
 */
export function methodFingerprint(read, files = METHOD_FILES) {
  const h = createHash('sha256');
  for (const f of files) {
    const body = read(f);
    h.update(`${f}\0${Buffer.byteLength(body)}\0`);
    h.update(body);
  }
  return h.digest('hex').slice(0, 16);
}

/** The label a person gave this fingerprint, or one that compares with nothing. */
export function resolveMethod(fingerprint, record) {
  const entry = record?.fingerprints?.[fingerprint];
  return entry?.method ?? `unacknowledged:${fingerprint}`;
}

/**
 * Which board a firm's check read. A firm whose registry row changes (a new
 * Workday site, another token) is a different board from that day on, and is
 * not compared across the change even when the collector is unchanged. Tier
 * and name are not part of it: they move the firm between groups, not what
 * its board yields.
 */
export function boardConfigHash(row) {
  const { firm: _firm, tier: _tier, ...board } = row ?? {};
  const canonical = JSON.stringify(Object.fromEntries(Object.entries(board).sort(([a], [b]) => a.localeCompare(b))));
  return createHash('sha256').update(canonical).digest('hex').slice(0, 10);
}

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
export function classifyCheck({ settled, stats, ceiling = false }) {
  return checkVerdict({ settled, stats, ceiling }).status;
}

/** Status and, for a partial check, the one reason it is partial. */
export function checkVerdict({ settled, stats, ceiling = false }) {
  if (settled !== 'fulfilled') return { status: 'failed' };
  const attempts = stats?.attempts ?? 0;
  const failures = stats?.failures ?? 0;
  if (attempts > 0 && failures >= attempts) return { status: 'failed' };
  // Order matters only for the label: any of the three makes `n` a floor.
  if (failures > 0) return { status: 'partial', why: 'failures' };
  if (stats?.capped) return { status: 'partial', why: 'budget' };
  if (ceiling) return { status: 'partial', why: 'ceiling' };
  return { status: 'ok' };
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
/**
 * The rows a board contributed, as the feed finally published them.
 *
 * A board's rows are captured when its fetch settles, but later steps change
 * what is published: lib/role-screen.mjs drops records that are not roles
 * (an "INVITE ONLY ... Networking Event" at IMC on 25 September) and cleans
 * titles, and a cleaned title can be classified differently. The day's file
 * must describe exactly what the feed carries, so every row is replaced by its
 * final published version, and a row the feed no longer carries is counted as
 * screened rather than kept.
 *
 * @param rows        rows captured for the board (collected or carried)
 * @param publishedById Map of id -> the row as published
 */
export function publishedView(rows = [], publishedById) {
  const kept = [];
  let screened = 0;
  for (const r of rows) {
    const published = publishedById.get(String(r.id));
    if (published) kept.push(published);
    else screened += 1;
  }
  return { rows: kept, screened };
}

export function boardRecord({ firm, status, why, roles = [], carried = [], reason, screened = 0 }) {
  const record = { s: status, ats: firm.ats, tier: firm.tier ?? null, cfg: boardConfigHash(firm) };
  if (status === 'partial' && why) record.why = why;
  // Rows the board returned that the feed does not publish (not roles). Kept
  // as a count so a board whose total fell because of screening, not hiring,
  // can be told apart when reading a day on its own.
  if (screened) record.screened = screened;
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
export function buildCheckFile({ date, checkedAt, boards, parked = [], method, fingerprint }) {
  const counts = { ok: 0, partial: 0, failed: 0 };
  for (const b of Object.values(boards)) counts[b.s] = (counts[b.s] ?? 0) + 1;
  return {
    v: CHECK_VERSION,
    method,
    fingerprint,
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
