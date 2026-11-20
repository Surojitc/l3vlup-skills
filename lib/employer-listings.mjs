/**
 * Roles an employer listed with us directly, read as pure functions.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every other row in the feed was read from an employer's own board this
 * morning. A few roles are on no public board at all: an off-cycle analyst
 * seat at a boutique, a fund's single intern, sent to us as a hiring brief
 * (L3vlup docs/employer-briefs-2026-10.md). Those briefs said a role "becomes
 * a listing only through the manual verified-listing route, with the
 * employer's written approval". This is that route.
 *
 * `data/opportunities.employer.json` is written by hand, after a person has
 * verified the organisation and the employer has approved the listing in
 * writing. Each entry is the role exactly as the employer approved it, the
 * day it was approved, and the day it expires.
 *
 * HOW IT DIFFERS FROM A COLLECTED ROW
 * -----------------------------------
 * - It is labelled. Its tags start with "Listed by the employer", never
 *   "Auto-sourced", so nobody reads it as something we found on a board.
 * - It expires. A board tells us daily whether a role is still open; a
 *   listing cannot, so it is published only until `expiresAt`, at most
 *   MAX_DAYS after the employer last confirmed it (`approvedAt`). To keep it
 *   up, the employer confirms again and both dates move. An expired listing
 *   leaves the feed and its URL is archived like any departed role.
 * - A collected row wins. If the employer's board later carries the same
 *   application link, the listing is dropped and the board's row stands.
 * - It is never sponsored and never ranked above anything: it is a row like
 *   the others, with a label.
 *
 * An entry that fails validation is reported and left out; one bad entry
 * never stops the collection or the other listings.
 */

export const LISTED_TAG = 'Listed by the employer';
export const MAX_DAYS = 60;

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const day = (s) => Date.parse(`${s}T00:00:00Z`);

const EXPERIENCED_TYPES = ['Lateral / Experienced', 'MBA Hire'];

/**
 * Check one entry against the feed's vocabulary. Returns the problems, empty
 * when the entry is publishable in shape (dates are judged separately).
 */
export function listingProblems(e, taxonomy) {
  const problems = [];
  const str = (k) => typeof e?.[k] === 'string' && e[k].trim().length > 0;
  for (const k of ['firm', 'role', 'location', 'applicationUrl']) if (!str(k)) problems.push(`${k} missing`);
  if (!taxonomy.verticals.includes(e?.vertical)) problems.push(`vertical "${e?.vertical}" not in the taxonomy`);
  if (![...taxonomy.programmeTypes, ...EXPERIENCED_TYPES].includes(e?.programmeType)) problems.push(`programmeType "${e?.programmeType}" not in the taxonomy`);
  if (!taxonomy.regions.includes(e?.region)) problems.push(`region "${e?.region}" not in the taxonomy`);
  if (!taxonomy.levels.includes(e?.level)) problems.push(`level "${e?.level}" not in the taxonomy`);
  if (str('applicationUrl')) {
    try {
      const u = new URL(e.applicationUrl);
      if (u.protocol !== 'https:') problems.push('applicationUrl is not https');
    } catch {
      problems.push('applicationUrl is not a URL');
    }
  }
  if (!ISO.test(e?.approvedAt ?? '')) problems.push('approvedAt is not YYYY-MM-DD');
  if (!ISO.test(e?.expiresAt ?? '')) problems.push('expiresAt is not YYYY-MM-DD');
  if (ISO.test(e?.approvedAt ?? '') && ISO.test(e?.expiresAt ?? '')) {
    const span = (day(e.expiresAt) - day(e.approvedAt)) / 86_400_000;
    if (span < 0) problems.push('expiresAt is before approvedAt');
    if (span > MAX_DAYS) problems.push(`expiresAt is more than ${MAX_DAYS} days after approvedAt`);
  }
  for (const k of ['closingDate', 'openingDate']) if (e?.[k] != null && !ISO.test(e[k])) problems.push(`${k} is not YYYY-MM-DD`);
  if (!/^[a-z0-9-]+$/.test(e?.key ?? '')) problems.push('key missing (lower-case letters, digits and hyphens: it pins the row\'s id and URL)');
  return problems;
}

/**
 * The listings to publish today, as feed rows, and what was left out and why.
 *
 * @param entries   the `listings` array of data/opportunities.employer.json
 * @param taxonomy  data/taxonomy.json
 * @param today     YYYY-MM-DD, the run day
 * @param collected rows already collected this run (a matching application
 *                  link means the board carries it, and the board wins)
 */
export function employerListings(entries, taxonomy, today, collected = []) {
  const rows = [];
  const skipped = [];
  const links = new Set(collected.map((o) => String(o.applicationUrl ?? '').replace(/\/+$/, '')).filter(Boolean));
  const keys = new Set();
  for (const e of Array.isArray(entries) ? entries : []) {
    const label = `${e?.firm ?? '?'} · ${e?.role ?? '?'}`;
    const problems = listingProblems(e, taxonomy);
    if (problems.length) { skipped.push({ label, reason: problems.join('; ') }); continue; }
    if (keys.has(e.key)) { skipped.push({ label, reason: `key "${e.key}" used twice` }); continue; }
    keys.add(e.key);
    if (day(today) < day(e.approvedAt)) { skipped.push({ label, reason: `approved for ${e.approvedAt}, not yet` }); continue; }
    if (day(today) > day(e.expiresAt)) { skipped.push({ label, reason: `expired ${e.expiresAt}` }); continue; }
    if (e.closingDate && day(today) > day(e.closingDate)) { skipped.push({ label, reason: `closed ${e.closingDate}` }); continue; }
    if (links.has(e.applicationUrl.replace(/\/+$/, ''))) { skipped.push({ label, reason: 'now on the employer\'s board, which wins' }); continue; }
    rows.push({
      id: `employer-${e.key}`,
      firm: e.firm.trim(),
      role: e.role.trim(),
      vertical: e.vertical,
      programmeType: e.programmeType,
      ...(e.tier ? { tier: e.tier } : {}),
      location: e.location.trim(),
      region: e.region,
      level: e.level,
      ...(e.openingDate ? { openingDate: e.openingDate } : {}),
      ...(e.closingDate ? { closingDate: e.closingDate, deadlineSource: 'employer' } : {}),
      status: 'Open',
      applicationUrl: e.applicationUrl,
      ...(e.recommendedPrepSlug ? { recommendedPrepSlug: e.recommendedPrepSlug } : {}),
      tags: [LISTED_TAG],
      listedUntil: e.expiresAt,
    });
  }
  return { rows, skipped };
}
