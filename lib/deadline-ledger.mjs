/**
 * A memory for deadlines.
 *
 * The collector rebuilds every role from the live boards on each run, which
 * means a deadline is only as durable as the HTTP request that found it. A
 * posting page that 403s, a timeout, a board that reorders — any of them drop a
 * date that was correct yesterday, and nothing carries it forward.
 *
 * That is how Citi went from five dated roles to zero and stayed there: the
 * five postings were still live and still carried `validThrough`, but they had
 * fallen out of the collated set, and once out there was nothing to remember
 * them by. The site-wide count stayed flat at 22 the whole time, so the loss
 * was invisible.
 *
 * A deadline is a fact with a natural expiry. Once we learn that a requisition
 * closes on a date, that stays true until the date passes or the role goes
 * away. This module stores those facts keyed by role id so coverage becomes
 * monotonic — it only ever improves within a role's life — instead of being
 * resampled from scratch every morning.
 *
 * It also stores the misses. Checking a posting page costs one GET, and most
 * postings carry no deadline at all; re-checking all of them daily is the bulk
 * of the enrichment budget spent on questions we have already answered. A miss
 * is recorded with an attempt count and re-checked on a widening backoff, so
 * the budget goes to roles we have never looked at.
 *
 * Misses are held **per source**, and that distinction is load-bearing. The
 * Workday detail endpoint and the posting page's JSON-LD answer different
 * questions about the same role: a requisition can carry no `endDate` and still
 * publish `validThrough` in its markup. A single shared miss key let the Workday
 * pass silence the JSON-LD pass for every role it had already asked about —
 * which is the same class of bug as the cap, one layer down.
 *
 * A found deadline is not per-source: once known it clears every miss for that
 * role, because there is nothing left to ask.
 */

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** Backoff schedule for re-checking a role that had no deadline last time. */
const RECHECK_BASE_DAYS = 3;
const RECHECK_MAX_DAYS = 21;

/** How long a role absent from the boards is kept before it is forgotten. */
const FORGET_AFTER_DAYS = 45;

export const LEDGER_VERSION = 1;

const isIso = (v) => typeof v === 'string' && ISO.test(v);

/** Misses are keyed by role and source; a deadline is keyed by role alone. */
const missKey = (id, source) => `${id}|${source}`;

function daysBetween(from, to) {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return Infinity;
  return Math.round((b - a) / 86400000);
}

/**
 * Read a ledger off disk content, discarding anything malformed rather than
 * trusting it. A corrupted ledger must degrade to "we know nothing", never to
 * a wrong date on a public page.
 */
export function loadLedger(raw) {
  const empty = { version: LEDGER_VERSION, updatedAt: null, entries: {}, misses: {} };
  if (!raw || typeof raw !== 'object') return empty;
  const out = { ...empty, updatedAt: isIso(raw.updatedAt) ? raw.updatedAt : null };
  for (const [id, e] of Object.entries(raw.entries ?? {})) {
    if (!id || !e || typeof e !== 'object') continue;
    if (!isIso(e.closingDate)) continue;
    out.entries[id] = {
      closingDate: e.closingDate,
      source: typeof e.source === 'string' ? e.source : 'unknown',
      firstSeen: isIso(e.firstSeen) ? e.firstSeen : null,
      lastConfirmed: isIso(e.lastConfirmed) ? e.lastConfirmed : null,
    };
  }
  for (const [id, m] of Object.entries(raw.misses ?? {})) {
    if (!id || !m || typeof m !== 'object') continue;
    if (!isIso(m.checkedAt)) continue;
    const attempts = Number.isInteger(m.attempts) && m.attempts > 0 ? m.attempts : 1;
    out.misses[id] = { checkedAt: m.checkedAt, attempts };
  }
  return out;
}

/**
 * The remembered deadline for a role, if it is still in the future.
 *
 * An expired date is not returned and not an error: a role whose deadline has
 * passed but which is still on the board is genuinely undated again, and
 * showing yesterday's date counting backwards is worse than showing none.
 */
export function ledgerDeadline(ledger, id, today) {
  const e = ledger?.entries?.[id];
  if (!e || !isIso(today)) return undefined;
  if (e.closingDate < today) return undefined;
  return { closingDate: e.closingDate, source: e.source };
}

/** Remember a deadline we just found, or re-confirm one we already had. */
export function recordHit(ledger, id, closingDate, source, today) {
  if (!isIso(closingDate) || !isIso(today)) return ledger;
  const prev = ledger.entries[id];
  ledger.entries[id] = {
    closingDate,
    source,
    firstSeen: prev?.firstSeen ?? today,
    lastConfirmed: today,
  };
  // A role that now has a date is no longer a miss for any source.
  for (const k of Object.keys(ledger.misses)) {
    if (k.slice(0, k.lastIndexOf('|')) === id) delete ledger.misses[k];
  }
  return ledger;
}

/**
 * Remember that one source looked and found nothing, so that source looks less
 * often next time. Other sources are unaffected — see the note at the top.
 */
export function recordMiss(ledger, id, today, source) {
  if (!isIso(today) || !source) return ledger;
  if (ledger.entries[id]) return ledger; // already known; nothing to record
  const k = missKey(id, source);
  const prev = ledger.misses[k];
  ledger.misses[k] = { checkedAt: today, attempts: (prev?.attempts ?? 0) + 1 };
  return ledger;
}

/**
 * How long to wait before re-checking a role that had no deadline. Widens with
 * each empty attempt: a posting that has said nothing four times running is
 * unlikely to start on the fifth, and the budget is better spent elsewhere.
 */
export function recheckDelayDays(attempts) {
  const n = Number.isInteger(attempts) && attempts > 0 ? attempts : 1;
  return Math.min(RECHECK_BASE_DAYS * 2 ** (n - 1), RECHECK_MAX_DAYS);
}

/**
 * Should this role be spent budget on today?
 *
 * No, if we already know its deadline. No, if we checked recently and found
 * nothing. Yes otherwise — including the first time we ever see it, which is
 * the case that matters most.
 */
export function needsCheck(ledger, id, today, source) {
  if (!isIso(today) || !source) return false;
  if (ledgerDeadline(ledger, id, today)) return false;
  const miss = ledger?.misses?.[missKey(id, source)];
  if (!miss) return true;
  return daysBetween(miss.checkedAt, today) >= recheckDelayDays(miss.attempts);
}

/**
 * Forget what is no longer useful: deadlines that have passed, and roles that
 * have been off the boards long enough to be gone rather than briefly missing.
 *
 * The grace period is the point. A role absent for one run is usually a fetch
 * that failed, not a role that closed — dropping it immediately would undo the
 * durability this module exists to provide.
 */
export function pruneLedger(ledger, liveIds, today, { forgetAfterDays = FORGET_AFTER_DAYS } = {}) {
  if (!isIso(today)) return ledger;
  const live = liveIds instanceof Set ? liveIds : new Set(liveIds ?? []);
  for (const [id, e] of Object.entries(ledger.entries)) {
    if (e.closingDate < today) {
      delete ledger.entries[id];
      continue;
    }
    if (live.has(id)) continue;
    const since = e.lastConfirmed ?? e.firstSeen;
    if (!since || daysBetween(since, today) > forgetAfterDays) delete ledger.entries[id];
  }
  for (const [k, m] of Object.entries(ledger.misses)) {
    const id = k.slice(0, k.lastIndexOf('|'));
    if (live.has(id)) continue;
    if (daysBetween(m.checkedAt, today) > forgetAfterDays) delete ledger.misses[k];
  }
  return ledger;
}

/** Stable on-disk form: keys sorted so a no-change run produces no diff. */
export function serialiseLedger(ledger, today) {
  const sort = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return {
    version: LEDGER_VERSION,
    updatedAt: isIso(today) ? today : ledger.updatedAt,
    entries: sort(ledger.entries),
    misses: sort(ledger.misses),
  };
}

/**
 * Order roles for enrichment when the budget cannot cover all of them.
 *
 * The budget is spent on the audience this site serves: a Bulge Bracket
 * investment banking summer analyst deadline is worth more than a graduate
 * software engineering one, and both are worth more than a role we could not
 * classify. Within a rank, the newest posting goes first — a deadline is most
 * useful while there is still time to act on it.
 */
const CORE_FINANCE = new Set([
  'Investment Banking',
  'Sales & Trading',
  'Quant',
  'Equity Research',
  'Corporate Banking',
  'Wealth Management',
  'Corporate Development',
]);
const PRIORITY_TIERS = new Set(['Bulge Bracket', 'Elite Boutique', 'Tracked']);

export function enrichmentRank(role) {
  const vertical = CORE_FINANCE.has(role.vertical) ? 0 : role.vertical === 'Other' ? 2 : 1;
  const tier = PRIORITY_TIERS.has(role.tier) ? 0 : 1;
  return vertical * 2 + tier;
}

export function orderForEnrichment(roles) {
  return [...roles].sort((a, b) => {
    const r = enrichmentRank(a) - enrichmentRank(b);
    if (r !== 0) return r;
    // Newest first; roles with no posting date sort last.
    const ad = a.openingDate ?? '';
    const bd = b.openingDate ?? '';
    if (ad !== bd) return bd.localeCompare(ad);
    return String(a.id).localeCompare(String(b.id));
  });
}
