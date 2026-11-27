/**
 * The employer permission register for republishing job descriptions.
 *
 * WHY
 * ---
 * Google's JobPosting markup needs "the full description of the job" shown on
 * the page, and lists "job postings on behalf of an organization or company
 * without authorization" as misrepresentation. No applicant tracking system's
 * terms license a third party to republish its customers' postings (read
 * 27 November 2026, L3VLUP docs/jobposting-2026-11.md). So the only basis is the
 * employer's own written permission, recorded here, one record per employer.
 *
 * A RECORD
 * --------
 *   id          stable, e.g. "perm-2026-12-jump-trading"
 *   employer    the firm exactly as the feed names it
 *   systems     the job systems the grant covers, e.g. ["greenhouse"]; ["*"] for all
 *   scope       what was granted: must include "republish-description"
 *   attribution how the page must credit it: "employer-name-and-link"
 *   granted     ISO date the written grant was given
 *   expires     ISO date it lapses (at most 12 months after `granted`)
 *   withdrawn   ISO date, when the employer withdrew; null otherwise
 *   evidence    where the written grant is filed (a reference, never a person's details)
 *
 * Expiry and withdrawal are honoured at both ends: the collector stops reading
 * the employer the day a record lapses, and the site stops showing what was
 * already published, because the manifest it reads carries the active records.
 *
 * Pure: no I/O.
 */

export const REQUIRED_SCOPE = 'republish-description';
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const MAX_TERM_DAYS = 366;

/** Problems with one record, empty when it is well formed. */
export function recordProblems(r) {
  const p = [];
  if (!r || typeof r !== 'object') return ['not an object'];
  if (!/^perm-[a-z0-9-]+$/.test(r.id ?? '')) p.push('id must look like perm-<date>-<firm>');
  if (!r.employer) p.push('employer is required');
  if (!Array.isArray(r.systems) || !r.systems.length) p.push('systems must name at least one job system, or "*"');
  if (!Array.isArray(r.scope) || !r.scope.includes(REQUIRED_SCOPE)) p.push(`scope must include "${REQUIRED_SCOPE}"`);
  if (!r.attribution) p.push('attribution is required');
  if (!ISO.test(r.granted ?? '')) p.push('granted must be an ISO date');
  if (!ISO.test(r.expires ?? '')) p.push('expires must be an ISO date');
  if (ISO.test(r.granted ?? '') && ISO.test(r.expires ?? '')) {
    const term = (Date.parse(r.expires) - Date.parse(r.granted)) / 86_400_000;
    if (term <= 0) p.push('expires must be after granted');
    if (term > MAX_TERM_DAYS) p.push('a grant is recorded for at most twelve months, then renewed');
  }
  if (r.withdrawn != null && !ISO.test(r.withdrawn)) p.push('withdrawn must be an ISO date or null');
  if (!r.evidence) p.push('evidence (where the written grant is filed) is required');
  return p;
}

/** Problems with the whole register: each record's, and no employer twice, no id twice. */
export function registerProblems(register) {
  const list = register?.permissions;
  if (!Array.isArray(list)) return ['permissions must be an array'];
  const out = [];
  const ids = new Set();
  const live = new Map();
  for (const r of list) {
    for (const q of recordProblems(r)) out.push(`${r?.id ?? '(no id)'}: ${q}`);
    if (ids.has(r?.id)) out.push(`${r.id}: id used twice`);
    ids.add(r?.id);
  }
  for (const r of active(list, new Date('2000-01-01'), { ignoreDates: true })) {
    if (live.has(r.employer)) out.push(`${r.employer}: more than one record not withdrawn`);
    live.set(r.employer, r.id);
  }
  return out;
}

/** The records in force at `now`: granted, not expired, not withdrawn. */
export function active(list, now = new Date(), { ignoreDates = false } = {}) {
  const day = now.toISOString().slice(0, 10);
  return (list ?? []).filter((r) => recordProblems(r).length === 0 && !r.withdrawn && (ignoreDates || (r.granted <= day && day < r.expires)));
}

/** The active record covering an employer and job system, or null. */
export function permissionFor(list, employer, system, now = new Date()) {
  return active(list, now).find((r) => r.employer === employer && (r.systems.includes('*') || r.systems.includes(system))) ?? null;
}

/** What the manifest carries, so the site can honour expiry and withdrawal at render. */
export function manifestPermissions(list, now = new Date()) {
  return active(list, now).map(({ id, employer, systems, attribution, granted, expires }) => ({ id, employer, systems, attribution, granted, expires }));
}

/** The shard of an opportunity id: the site's FNV-1a rule (L3VLUP lib/job-descriptions.ts), kept identical. */
export function shardOf(id) {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 24) & 0xff).toString(16).padStart(2, '0');
}

/**
 * The files to publish: { 'index.json': manifest, '<shard>.json': entries }.
 * `captured` is [{ id, employer, system, sourceUrl, html }] from the run; only
 * entries with an active permission survive, each stamped with its permission.
 */
export function descriptionFiles(captured, list, now = new Date()) {
  const shards = {};
  for (const c of captured) {
    const perm = permissionFor(list, c.employer, c.system, now);
    if (!perm || !c.html) continue;
    const s = shardOf(c.id);
    (shards[s] ??= {})[c.id] = { system: c.system, sourceUrl: c.sourceUrl, fetchedAt: now.toISOString(), html: c.html, permission: perm.id, employer: c.employer };
  }
  const files = { 'index.json': { generatedAt: now.toISOString(), shards: Object.keys(shards).sort(), permissions: manifestPermissions(list, now) } };
  for (const [s, entries] of Object.entries(shards)) files[`${s}.json`] = entries;
  return files;
}
