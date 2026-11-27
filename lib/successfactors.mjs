/**
 * SAP SuccessFactors career sites: EY and EY-Parthenon, Fitch and others.
 *
 * WHY THIS READER
 * Every SuccessFactors career site serves the same server-rendered search,
 * `{host}/{site}/search/?q={term}&startrow={n}`, 25 rows a page, each a
 * <tr class="data-row"> with a jobTitle-link ending in the job id and a
 * jobLocation span, under a label "Results 1 – 25 of N". Its robots.txt
 * disallows the apply, talent-community, email and /services/ paths, never
 * the search (careers.ey.com, read 27 November 2026), and the reader touches
 * nothing else.
 *
 * Search is fuzzy (a query for "intern" returns managers too); the collector's
 * early-career filter, not the query, decides what is published.
 *
 * Pure: the fetch is the caller's. Tested against rows saved from a live page.
 */

export const SUCCESSFACTORS_PAGE = 25;

const decode = (s) =>
  String(s)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#039;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ');
const text = (s) => decode(String(s).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

const COUNTRY = new Intl.DisplayNames(['en'], { type: 'region' });
/**
 * "Dublin, IE" -> "Dublin, Ireland". The sites write the country as an ISO
 * code, which the collector's region rules cannot read ("IE" is not Europe to
 * them), so a Dublin or Geneva graduate programme was published as US.
 */
export function spellCountry(location) {
  const parts = String(location || '').split(',').map((p) => p.trim()).filter(Boolean);
  const i = parts.findIndex((p, k) => k > 0 && /^[A-Z]{2}$/.test(p));
  if (i < 0) return parts.join(', ');
  let name;
  try {
    name = COUNTRY.of(parts[i]);
  } catch {
    name = undefined;
  }
  return name && name !== parts[i] ? [...parts.slice(0, i), name].join(', ') : parts.join(', ');
}

export function successFactorsSearchUrl({ host, site = '' }, term, startrow = 0) {
  const base = site ? `https://${host}/${site}` : `https://${host}`;
  return `${base}/search/?q=${encodeURIComponent(term)}&startrow=${startrow}`;
}

/** One results page: the stated total and its jobs. */
export function parseSuccessFactorsSearch(html, host = '') {
  if (typeof html !== 'string' || !html) return { total: 0, jobs: [] };
  const total = Number(html.match(/Results\s*<b>[^<]*<\/b>\s*of\s*<b>([\d,]+)<\/b>/)?.[1]?.replace(/,/g, '') ?? 0);
  const jobs = [];
  const seen = new Set();
  for (const [row] of html.matchAll(/<tr class="data-row[\s\S]*?<\/tr>/g)) {
    const link = row.match(/<a\b[^>]*\bhref="([^"]*\/job\/[^"]*?\/(\d+)\/?)"[^>]*>([\s\S]*?)<\/a>/);
    if (!link || seen.has(link[2])) continue;
    seen.add(link[2]);
    const href = decode(link[1]);
    jobs.push({
      id: link[2],
      title: text(link[3]),
      location: spellCountry(text(row.match(/<span class="jobLocation">([\s\S]*?)<\/span>/)?.[1] ?? '')),
      url: href.startsWith('http') ? href : `https://${host}${href}`,
      description: '',
    });
  }
  return { total, jobs };
}
