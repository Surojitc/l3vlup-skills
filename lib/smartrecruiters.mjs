/**
 * SmartRecruiters: the public Posting API, read as pure functions.
 *
 * WHY THIS EXISTS
 * ---------------
 * The October sweeps (docs/tracker-expansion-2026-10.md, batch 2, and
 * docs/coverage-expansion-2026-10.md, section 3b) found employers the tracker
 * wants on SmartRecruiters and nowhere else: PA Consulting, whose industrial
 * placements and graduate schemes are UK campus seats, Evelyn Partners (20
 * postings), and single postings at WTW, Stifel and Tikehau. Both notes named
 * it the cheapest next adapter, because unlike iCIMS, SuccessFactors, Phenom
 * and Avature it is not a page to scrape: it is a documented, unauthenticated
 * JSON API that SmartRecruiters publishes for exactly this use,
 *
 *     GET https://api.smartrecruiters.com/v1/companies/{company}/postings
 *         ?limit=100&offset=N
 *     { offset, limit, totalFound, content: [ posting, ... ] }
 *
 * where a posting carries id, name (the title), company { identifier, name },
 * location { city, region, country, remote, fullLocation }, releasedDate and,
 * where the employer fills it, experienceLevel { id, label }.
 *
 * WHAT IT DOES NOT DO
 * -------------------
 * - It never asks for a posting's detail page, so it costs one request per
 *   hundred postings and carries no body text: a SmartRecruiters row has no
 *   prose deadline until the enrichment pass is extended to it, which is a
 *   separate, measured change.
 * - It does not trust `experienceLevel`. Employers set "Entry Level" on
 *   experienced roles often enough that the title rules decide, as they do
 *   for every other board.
 * - It refuses a posting filed under another company identifier, the same
 *   rule that rejected boards answering under another organisation's name in
 *   the October sweep.
 *
 * Built against the documented schema on 17 November 2026, from a session
 * with no network: the fixtures in scripts/__tests__/smartrecruiters.test.mjs
 * are written from that schema, not recorded. No registry row uses this until
 * a verification read has measured a real board (see the batch report).
 */

export const SMARTRECRUITERS_PAGE = 100; // the API's maximum
export const SMARTRECRUITERS_MAX_POSTINGS = 600; // the per-firm budget the Workday and Oracle readers keep

export function smartRecruitersUrl(company, offset = 0, limit = SMARTRECRUITERS_PAGE) {
  return `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(company)}/postings?limit=${limit}&offset=${offset}`;
}

/** The public page a candidate applies from, on SmartRecruiters' own host. */
export function smartRecruitersJobUrl(company, id) {
  return `https://jobs.smartrecruiters.com/${encodeURIComponent(company)}/${encodeURIComponent(id)}`;
}

/**
 * Every posting on a board, keyed by id. `fetchPage(offset, limit)` returns the
 * parsed JSON; it is injected so the stopping rules can be tested without a
 * board. The walk ends at an empty page, at totalFound, at the budget, or at
 * a page that adds nothing new (a server ignoring `offset` would otherwise
 * replay page one until the budget ran out).
 */
export async function paginateSmartRecruiters(fetchPage, opts = {}) {
  const { limit = SMARTRECRUITERS_PAGE, maxPostings = SMARTRECRUITERS_MAX_POSTINGS, stats } = opts;
  const seen = new Map();
  let offset = 0;
  for (;;) {
    if (seen.size >= maxPostings) {
      if (stats) stats.capped = true;
      break;
    }
    if (stats) stats.attempts = (stats.attempts ?? 0) + 1;
    const page = await fetchPage(offset, limit);
    const content = Array.isArray(page?.content) ? page.content : [];
    if (content.length === 0) break;
    let added = 0;
    for (const p of content) {
      const id = p?.id == null ? '' : String(p.id);
      if (!id || seen.has(id)) continue;
      seen.set(id, p);
      added++;
      if (seen.size >= maxPostings) break;
    }
    if (added === 0) break;
    offset += content.length;
    const total = Number(page?.totalFound);
    if (Number.isFinite(total) && offset >= total) break;
  }
  return seen;
}

// SmartRecruiters gives the country as a lower-case ISO code. The region
// rules read place names, so the codes the tracker's regions turn on are
// spelled out; any other code is passed through and counted as unmatched by
// the region classifier, as an unknown place is anywhere else.
const COUNTRY = {
  gb: 'United Kingdom', uk: 'United Kingdom', ie: 'Ireland', us: 'United States', ca: 'Canada',
  de: 'Germany', fr: 'France', nl: 'Netherlands', be: 'Belgium', lu: 'Luxembourg', ch: 'Switzerland',
  es: 'Spain', it: 'Italy', se: 'Sweden', dk: 'Denmark', no: 'Norway', fi: 'Finland', pl: 'Poland',
  at: 'Austria', pt: 'Portugal', sg: 'Singapore', hk: 'Hong Kong', jp: 'Japan', in: 'India',
  au: 'Australia', ae: 'United Arab Emirates', sa: 'Saudi Arabia', qa: 'Qatar',
};

export function smartRecruitersLocation(loc) {
  if (!loc || typeof loc !== 'object') return '';
  if (loc.fullLocation) return String(loc.fullLocation);
  const country = loc.country ? COUNTRY[String(loc.country).toLowerCase()] ?? String(loc.country) : '';
  const parts = [loc.city, loc.region, country].map((x) => (x == null ? '' : String(x).trim())).filter(Boolean);
  // A region that repeats the city ("London, London") says nothing twice.
  const unique = parts.filter((x, i) => parts.indexOf(x) === i);
  const place = unique.join(', ');
  return loc.remote ? (place ? `${place} (Remote)` : 'Remote') : place;
}

/**
 * A posting as the collector's common job shape, or null when it is not the
 * configured employer's own (a different company identifier) or has no title.
 */
export function smartRecruitersToJob(p, f) {
  const company = String(f?.token ?? '');
  const own = String(p?.company?.identifier ?? company);
  if (!company || own.toLowerCase() !== company.toLowerCase()) return null;
  const title = String(p?.name ?? '').trim();
  if (!title || p?.id == null) return null;
  return {
    id: String(p.id),
    title,
    location: smartRecruitersLocation(p.location),
    url: smartRecruitersJobUrl(own, p.id),
    department: p?.department?.label || p?.function?.label || undefined,
    postedAt: p?.releasedDate || undefined,
    description: '',
  };
}
