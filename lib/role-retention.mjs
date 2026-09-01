/**
 * Keeping roles when a board stops answering.
 *
 * A board can fail for reasons that have nothing to do with the roles on it: a
 * timeout, a 500, a bot gate. When that happens the collector currently drops
 * every role that firm had, and the site loses them the moment the commit
 * lands. The collapse guard does not help — it only catches the whole run
 * collapsing, not one firm vanishing out of ninety.
 *
 * That is not hypothetical. tal.net serves its boards to a residential address
 * and blocks datacentre ranges, so Morgan Stanley, Nomura and BlackRock — 76
 * roles, and Nomura's 24 stated deadlines — collate locally and have never once
 * survived a CI run.
 *
 * A role that answered yesterday is far more likely to still be open than to
 * have closed in the same hour its board started refusing us, so the last known
 * set is carried forward for a bounded window and clearly marked. Stale beats
 * absent, but only if the staleness is visible.
 *
 * The distinction that matters: this applies to a board that FAILED. A board
 * that answered and returned nothing has told us something true, and its roles
 * are dropped exactly as before.
 */

/** How long a role may be carried without being re-confirmed. */
export const RETENTION_DAYS = 7;

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const isIso = (v) => typeof v === 'string' && ISO.test(v);

function daysBetween(from, to) {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return Infinity;
  return Math.round((b - a) / 86400000);
}

/**
 * When was this role last actually seen on a board?
 *
 * Roles collated before this field existed have no value, so the previous
 * file's own timestamp stands in: it is when that data was written, which is
 * the latest the role can have been confirmed.
 */
export function lastConfirmed(role, fallback) {
  if (isIso(role?.lastConfirmedAt)) return role.lastConfirmedAt;
  if (typeof role?.lastConfirmedAt === 'string' && role.lastConfirmedAt.length >= 10) {
    const d = role.lastConfirmedAt.slice(0, 10);
    if (isIso(d)) return d;
  }
  return isIso(fallback) ? fallback : undefined;
}

/**
 * Roles to carry forward from the previous run.
 *
 * @param previousRoles the last published set
 * @param failedFirms   firms whose board threw this run — NOT firms that
 *                      answered with nothing
 * @param today         ISO date of this run
 */
export function retainRoles(previousRoles, failedFirms, today, opts = {}) {
  const { retentionDays = RETENTION_DAYS, fallbackConfirmedAt } = opts;
  if (!isIso(today)) return [];
  const failed = failedFirms instanceof Set ? failedFirms : new Set(failedFirms ?? []);
  if (failed.size === 0) return [];

  const out = [];
  for (const role of previousRoles ?? []) {
    if (!role || !failed.has(role.firm)) continue;

    const since = lastConfirmed(role, fallbackConfirmedAt);
    if (!since) continue; // no idea how old this is; do not guess
    const age = daysBetween(since, today);
    if (age > retentionDays) continue;

    // A closed role is not worth carrying however fresh the record is.
    if (isIso(role.closingDate) && role.closingDate < today) continue;

    const tags = Array.isArray(role.tags) ? role.tags.filter((t) => t !== 'Unconfirmed') : [];
    out.push({
      ...role,
      tags: [...tags, 'Unconfirmed'],
      // Read by the site to show how stale the row is. Named for what it means
      // rather than when it happened, so a UI does not have to compute it.
      unconfirmedSince: since,
      unconfirmedDays: age,
      lastConfirmedAt: since,
    });
  }
  return out;
}
