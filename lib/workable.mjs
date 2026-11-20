/**
 * Workable: the public careers widget, read as pure functions.
 *
 * WHY THIS EXISTS
 * ---------------
 * The November sweep (docs/coverage-expansion-2026-11.md, section 5) rendered
 * Capula Investment Management's careers page and found its roles on Workable
 * (capula-investment-management-ltd.workable.com). Hayfin's page names Workable
 * too. Both are firms this tracker wants, and Workable is common among UK funds
 * of that size. Workable publishes an unauthenticated widget endpoint that
 * returns the whole board on one request,
 *
 *     GET https://apply.workable.com/api/v1/widget/accounts/{account}
 *     { name, description, jobs: [ job, ... ] }
 *
 * where a job carries title, shortcode, department, url, shortlink,
 * application_url, published_on, created_at, city, state, country and
 * locations [{ city, region, country, countryCode, hidden }].
 *
 * HOW IT WAS VERIFIED
 * -------------------
 * Written against the documented widget schema while Workable was refusing
 * the session (Cloudflare 1015), then read live on 20 November 2026 once it
 * answered: Capula's board (18 entries for 15 postings, 5 early career, 1 experienced) and
 * Hayfin's (2 postings) carry exactly the documented keys. `workableToJobs`
 * still throws unless the answer has a `jobs` array, so a changed schema or a
 * rate limit reads as a failed board in the day's check, never as roles.
 *
 * ONE POSTING, SEVERAL ENTRIES
 * The live read showed what the schema does not say: a role open in several
 * cities is listed once per city under the same shortcode (Capula's 2027
 * Trading and Research Summer Internship: London, New York, Singapore, Hong
 * Kong). Read as four jobs it would be one posting collected four times, which
 * the collector reports as its own bug. Entries are merged by shortcode into
 * one job whose location names every city.
 */

export function workableUrl(account) {
  return `https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(account)}`;
}

function place(parts) {
  const clean = parts.map((x) => (x == null ? '' : String(x).trim())).filter(Boolean);
  return clean.filter((x, i) => clean.indexOf(x) === i).join(', ');
}

export function workableLocation(j) {
  const listed = (Array.isArray(j?.locations) ? j.locations : [])
    .filter((l) => l && !l.hidden)
    .map((l) => place([l.city, l.country]))
    .filter(Boolean);
  const unique = listed.filter((x, i) => listed.indexOf(x) === i);
  const where = unique.length ? unique.join('; ') : place([j?.city, j?.country]);
  return j?.telecommuting ? (where ? `${where} (Remote)` : 'Remote') : where;
}

/** Every job on a board as the collector's common job shape. Throws on an answer that is not a board. */
export function workableToJobs(board) {
  if (!board || !Array.isArray(board.jobs)) throw new Error('Workable answered without a jobs list: not the widget shape');
  const byCode = new Map();
  for (const j of board.jobs) {
    const title = String(j?.title ?? '').trim();
    const url = j?.url || j?.shortlink || j?.application_url;
    const id = j?.shortcode || j?.id;
    if (!title || !url || !id) continue;
    const key = String(id);
    const where = workableLocation(j);
    const seen = byCode.get(key);
    if (seen) {
      // The same posting listed again for another city: one job, every city.
      for (const w of where.split('; ')) if (w && !seen.places.includes(w)) seen.places.push(w);
      continue;
    }
    byCode.set(key, {
      places: where ? where.split('; ') : [],
      job: { id: key, title, url, department: j.department || undefined, postedAt: j.published_on || j.created_at || undefined, description: '' },
    });
  }
  return [...byCode.values()].map(({ places, job }) => ({
    id: job.id, title: job.title, location: places.join('; '), url: job.url,
    department: job.department, postedAt: job.postedAt, description: job.description,
  }));
}
