/**
 * Recruitee: the public careers-site API, read as pure functions.
 *
 * WHY THIS EXISTS
 * ---------------
 * The November sweep (docs/coverage-expansion-2026-11.md) rendered the careers
 * pages earlier sweeps could not read and found PAI Partners, a large-cap
 * European buyout firm, posting its investment, valuation and fund internships
 * on Recruitee and nowhere else the collector reads. bunq posts there too.
 * Recruitee publishes an unauthenticated JSON endpoint for exactly this use,
 *
 *     GET https://{company}.recruitee.com/api/offers/
 *     { offers: [ offer, ... ] }
 *
 * one request for the whole board, where an offer carries id, title,
 * company_name, location, city, country, locations [{ city, country }],
 * careers_url (the employer's own careers domain where it has one),
 * published_at, close_at, department and status.
 *
 * WHAT IT DOES AND DOES NOT DO
 * ----------------------------
 * - The endpoint answers a renamed company with a 302 to its current
 *   subdomain (paipartners → paipartnerssas). The registry stores the
 *   subdomain the redirect lands on, so a daily read costs one request.
 * - It keeps only `status: published` and drops a title the employer has
 *   marked closed ("CLOSED: Munich Investment Group Internship …"). PAI leaves
 *   such notices published to say when the next window opens; read as a
 *   posting it would be listed as open months early.
 * - It does not trust `employment_type_code` or `experience_code`: the title
 *   rules decide, as they do for every other board.
 * - It refuses an offer filed under another company name than the board's own
 *   first offer, the same rule that keeps a portfolio board off a fund's row.
 *
 * Verified against PAI Partners and bunq on 20 November 2026.
 */

export function recruiteeUrl(company) {
  return `https://${encodeURIComponent(company)}.recruitee.com/api/offers/`;
}

const CLOSED_TITLE = /^\s*\(?\s*closed\b/i;

export function recruiteeLocation(o) {
  const places = (Array.isArray(o?.locations) ? o.locations : [])
    .map((l) => [l?.city, l?.country].map((x) => (x == null ? '' : String(x).trim())).filter(Boolean).join(', '))
    .filter(Boolean);
  const unique = places.filter((x, i) => places.indexOf(x) === i);
  if (unique.length) return unique.join('; ');
  const one = [o?.city, o?.country].map((x) => (x == null ? '' : String(x).trim())).filter(Boolean).join(', ');
  return one || String(o?.location ?? '').trim();
}

/** Recruitee writes "2026-11-13 14:53:05 UTC"; the collector reads ISO dates. */
export function recruiteeDate(value) {
  if (!value) return undefined;
  const iso = String(value).trim().replace(' UTC', 'Z').replace(' ', 'T');
  return Number.isNaN(Date.parse(iso)) ? undefined : iso;
}

/**
 * Every offer on a board as the collector's common job shape. `board` is the
 * parsed JSON; offers that are unpublished, marked closed, untitled or filed
 * under another company are left out.
 */
export function recruiteeToJobs(board) {
  const offers = Array.isArray(board?.offers) ? board.offers : [];
  const own = String(offers.find((o) => o?.company_name)?.company_name ?? '').toLowerCase();
  return offers
    .filter((o) => o && o.id != null && String(o.status ?? 'published') === 'published')
    .filter((o) => !own || String(o.company_name ?? own).toLowerCase() === own)
    .map((o) => ({ o, title: String(o.title ?? '').trim() }))
    .filter(({ title }) => title && !CLOSED_TITLE.test(title))
    .map(({ o, title }) => ({
      id: String(o.id),
      title,
      location: recruiteeLocation(o),
      url: o.careers_url || o.careers_apply_url,
      department: o.department || undefined,
      deadline: o.close_at || undefined,
      postedAt: recruiteeDate(o.published_at),
      description: String(o.description ?? '') + ' ' + String(o.requirements ?? ''),
    }))
    .filter((j) => j.url);
}
