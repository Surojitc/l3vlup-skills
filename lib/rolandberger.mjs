/**
 * Roland Berger's own job list, read from its careers site.
 *
 * WHY THIS EXISTS
 * Roland Berger was read through SmartRecruiters' Posting API. That host's
 * robots.txt disallows every crawler except LinkedInBot (checked 27 November
 * 2026), and SmartRecruiters documents the API for its customers' own career
 * sites. So the API route is suspended, and this reads the employer's own
 * page instead: https://www.rolandberger.com/en/join/all-jobs, whose robots.txt
 * allows everything and which renders the whole list server-side.
 *
 * The page is a better source than the API was, in one respect. Each entry
 * carries the firm's own level ("consulting-internship",
 * "consulting-graduate-hire"), so a "Junior Consultant" that the title alone
 * cannot place is known to be a graduate seat because the employer says so.
 *
 * IDS DO NOT MOVE. Every entry links the SmartRecruiters posting a candidate
 * applies on, and its numeric id is the id the API returned. The registry row
 * keeps `idAts: "smartrecruiters"`, so a row's id, and the tracker URL pinned
 * to it, is the same whichever route read it.
 *
 * Pure: the fetch is the caller's. Tested against markup saved from the live
 * page in scripts/__tests__/rolandberger.test.mjs.
 */

const SENIOR_TITLE = /\b(senior|sr\.?|manager|lead|head|director|principal|partner|experienced|expert)\b/i;

export const ROLAND_BERGER_JOBS_URL = 'https://www.rolandberger.com/en/join/all-jobs';

const decode = (s) =>
  String(s)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#039;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ');
const text = (s) => decode(String(s).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

// "united-arab-emirates" -> "United Arab Emirates"; "usa" stays an acronym.
const COUNTRY_NAME = { usa: 'United States', 'greater-china': 'China', 'south-korea': 'South Korea' };
const countryName = (slug) =>
  COUNTRY_NAME[slug] ?? slug.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

/**
 * Whether the employer's own level says this is an early-career seat. Only when
 * every level the entry carries is one: an entry tagged both graduate and
 * experienced hire is left for the title to decide.
 */
export function rolandBergerLevelIsEarly(level) {
  const tokens = String(level || '').split(/\s+/).filter(Boolean);
  return tokens.length > 0 && tokens.every((t) => /(?:^|-)(?:internship|graduate-hire)$/.test(t));
}

/**
 * Every job on the page, in the collector's common job shape.
 * An entry without a SmartRecruiters apply link has no stable id and is skipped.
 */
export function parseRolandBergerJobs(html) {
  if (typeof html !== 'string' || !html) return [];
  const jobs = new Map();
  const item = /<li\s+data-country="([^"]*)"\s+data-level="([^"]*)"[^>]*>([\s\S]*?)<\/li>/g;
  for (const [, countries, level, body] of html.matchAll(item)) {
    const head = body.match(/<h1[^>]*class="headline"[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/);
    const apply = body.match(/href="(https:\/\/jobs\.smartrecruiters\.com\/RolandBerger\/(\d+)[^"?]*)[^"]*"/);
    if (!head || !apply) continue;
    const title = text(head[1]);
    const id = apply[2];
    if (!title || jobs.has(id)) continue;
    const city = text(body.match(/<p class="subline">([\s\S]*?)<\/p>/)?.[1] ?? '');
    const country = countries.split(/\s+/).filter(Boolean).map(countryName);
    // One named country goes beside the city; several are listed as they are.
    const location = [city, country.length === 1 && !city.toLowerCase().includes(country[0].toLowerCase()) ? country[0] : '']
      .filter(Boolean)
      .join(', ') || country.join(', ');
    const job = {
      id,
      title,
      location,
      url: `https://jobs.smartrecruiters.com/RolandBerger/${id}`,
      department: level.includes('corporate-functions') ? 'Corporate Functions' : 'Consulting',
      description: '',
    };
    // The level is the employer's, and it is sometimes wrong: "Senior
    // Consultant for cost/value management" is tagged graduate-hire. A title
    // that names seniority overrides it, and the ordinary title rules decide.
    if (rolandBergerLevelIsEarly(level) && !SENIOR_TITLE.test(title)) job.earlyCareerConfirmed = true;
    jobs.set(id, job);
  }
  return [...jobs.values()];
}
