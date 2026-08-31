/**
 * Eightfold.ai career sites.
 *
 * Millennium runs campus hiring here (campusjobs.mlp.com), and Eightfold is
 * common enough across funds that the family is worth having rather than the
 * one firm.
 *
 * The API is public JSON and pleasant, with one quirk that matters: `num` is
 * capped server-side at 10 regardless of what you ask for. Requesting 100
 * returns 10 and no error, so a naive single call silently collects a sixth of
 * the board — the same shape of silent-truncation bug as the per-firm cap.
 * Pagination is on `start` and is not optional.
 */

const PAGE = 10; // server-enforced; asking for more is ignored
const MAX_PAGES = 30;

export function eightfoldUrl(host, domain, start, num = PAGE) {
  return `https://${host}/api/apply/v2/jobs?domain=${encodeURIComponent(domain)}&start=${start}&num=${num}`;
}

/**
 * Page until the board runs out.
 *
 * `fetchPage(start, num)` is injected so the termination rules can be tested
 * without a live board. A deployment that ignores `start` replays page one, so
 * "this page added nothing new" is a stop condition rather than trusting
 * `count`.
 *
 * @returns {Map<string, object>} positions keyed by Eightfold's stable id
 */
export async function paginateEightfold(fetchPage, { maxPages = MAX_PAGES, page = PAGE } = {}) {
  const seen = new Map();
  let start = 0;
  for (let i = 0; i < maxPages; i++) {
    let data;
    try {
      data = await fetchPage(start, page);
    } catch {
      break;
    }
    const positions = data?.positions ?? [];
    if (positions.length === 0) break;

    let added = 0;
    for (const p of positions) {
      const id = p?.id ?? p?.ats_job_id ?? p?.display_job_id;
      if (id == null || seen.has(String(id))) continue;
      added++;
      seen.set(String(id), p);
    }
    if (added === 0) break;

    start += page;
    if (typeof data.count === 'number' && start >= data.count) break;
    if (positions.length < page) break;
  }
  return seen;
}

/** Normalise one Eightfold position into the shape toOpportunity() expects. */
export function eightfoldToJob(p, { host } = {}) {
  // t_create is epoch seconds. Guard the unit: a value in milliseconds would
  // date the posting to the year 58000 and sail through as a valid Date.
  let postedAt;
  const t = Number(p.t_create ?? p.t_update);
  if (Number.isFinite(t) && t > 1e8 && t < 4e9) postedAt = new Date(t * 1000).toISOString();

  return {
    id: String(p.id ?? p.ats_job_id ?? p.display_job_id),
    title: p.name ?? p.posting_name ?? '',
    // `locations` is an array when a role spans sites; `location` is the
    // pre-joined string and is what the board itself shows.
    location: p.location ?? (Array.isArray(p.locations) ? p.locations.join(', ') : ''),
    url: p.canonicalPositionUrl ?? (host ? `https://${host}/careers/job/${p.id}` : ''),
    department: p.department || p.business_unit || undefined,
    postedAt,
    description: p.job_description ?? '',
  };
}
