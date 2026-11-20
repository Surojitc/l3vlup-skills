/**
 * Pinpoint: the public postings feed, read as pure functions.
 *
 * WHY THIS EXISTS
 * ---------------
 * Cinven, a European buyout firm with a London and Frankfurt investment team,
 * posts its private equity internships on Pinpoint, found by rendering its
 * careers page in the November sweep (docs/coverage-expansion-2026-11.md).
 * Pinpoint is common among UK firms of that size. Every career site it hosts
 * serves the whole board as JSON on one request,
 *
 *     GET https://{company}.pinpointhq.com/postings.json
 *     { data: [ posting, ... ] }
 *
 * where a posting carries id, title, url, deadline_at, employment_type,
 * location { city, name, province } and job { department { name } }.
 *
 * THE TRAP: AN ACCOUNT THAT ONLY HOLDS SAMPLE POSTINGS
 * -----------------------------------------------------
 * A subdomain nobody has claimed answers 404. But a Pinpoint account that has
 * been opened and never used (a trial, a sales demonstration) answers 200 with
 * Pinpoint's sample board: three or four postings ("Head of DEI - UK",
 * "Marketing Manager", "Customer Service Rep", "Marketing Executive",
 * sometimes with the firm's name spliced in) in London, Paris and New York,
 * on requisitions 0001 to 0003. In the November sweep that made Atomico,
 * Maven Securities, Graham Capital, Teza, Kraken, AJ Bell and Baillie Gifford
 * all look like Pinpoint employers with roles. So a Pinpoint row is admitted
 * only from a link on the employer's own careers page, never from a guessed
 * token, and `isPinpointSample` refuses a board made of the sample, so an
 * account that is opened but not yet used reads as a failed board rather
 * than as four invented roles.
 *
 * Verified against Cinven on 20 November 2026.
 */

export function pinpointUrl(company) {
  return `https://${encodeURIComponent(company)}.pinpointhq.com/postings.json`;
}

// The sample board's fingerprint, as served on 20 November 2026: every
// posting on requisition 0001, 0002 or 0003, in London, Paris or New York.
// A real board can share one of these; it cannot be made of nothing else.
const SAMPLE_REQUISITION = /^000[1-3]$/;
const SAMPLE_CITY = /^(london|paris|new york)$/i;

export function isPinpointSample(postings) {
  const list = Array.isArray(postings) ? postings : [];
  if (!list.length || list.length > 6) return false;
  return list.every((p) =>
    SAMPLE_REQUISITION.test(String(p?.job?.requisition_id ?? '')) &&
    SAMPLE_CITY.test(String(p?.location?.name ?? p?.location?.city ?? '').trim()));
}

export function pinpointLocation(loc) {
  if (!loc || typeof loc !== 'object') return '';
  const parts = [loc.city, loc.province, loc.name].map((x) => (x == null ? '' : String(x).trim())).filter(Boolean);
  return parts.filter((x, i) => parts.indexOf(x) === i).join(', ');
}

/** Every posting on a board as the collector's common job shape. Throws on the sample board. */
export function pinpointToJobs(board) {
  const data = Array.isArray(board?.data) ? board.data : [];
  if (isPinpointSample(data)) throw new Error('Pinpoint served its sample board: the account holds no real postings');
  return data
    .filter((p) => p && p.id != null && String(p.title ?? '').trim() && p.url)
    .map((p) => ({
      id: String(p.id),
      title: String(p.title).trim(),
      location: pinpointLocation(p.location),
      url: p.url,
      department: p.job?.department?.name || undefined,
      deadline: p.deadline_at || undefined,
      description: [p.description, p.key_responsibilities, p.skills_knowledge_expertise].filter(Boolean).join(' '),
    }));
}
