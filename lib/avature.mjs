/**
 * Avature career sites: Deloitte US, Bloomberg, Two Sigma and others.
 *
 * WHY THIS READER
 * Avature serves the same server-rendered search page for every tenant:
 * `{host}/{locale}/careers/SearchJobs/?search={term}&jobOffset={n}`, ten
 * results a page, each an <article class="article--result" data-total="N">
 * with a title link ending in the job id and a subtitle of spans (brand,
 * entity, location). The tenants' robots.txt allow `/careers` and disallow
 * only `/careers/*qtvc=` (checked 27 November 2026 on apply.deloitte.com,
 * bloomberg.avature.net and careers.twosigma.com), so the search pages are
 * read and nothing carrying qtvc ever is.
 *
 * The per-search RSS feed (`SearchJobs/{term}/feed/`) was the first choice,
 * being made for syndication, but it ignores the search term and carries no
 * location, so it cannot select campus roles.
 *
 * Pure: the fetch is the caller's. Tested against markup saved from a live page.
 */

export const AVATURE_PAGE = 10;

const decode = (s) =>
  String(s)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#039;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ');
const text = (s) => decode(String(s).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

/** The search URL for one page. Never carries qtvc, which robots.txt disallows. */
export function avatureSearchUrl({ host, locale = 'en_US', portal = 'careers' }, term, offset = 0) {
  return `https://${host}${locale ? `/${locale}` : ''}/${portal}/SearchJobs/?search=${encodeURIComponent(term)}&jobOffset=${offset}`;
}

/**
 * One results page: its stated total and its jobs.
 * Location is the last subtitle span; brand and entity, where present, come
 * before it. "Multiple Locations" is kept as written.
 */
export function parseAvatureSearch(html) {
  if (typeof html !== 'string' || !html) return { total: 0, jobs: [] };
  const jobs = [];
  let total = 0;
  // Tenants differ in the class list ("article--result" at Deloitte, "article
  // article--result" at Bloomberg) and in whether they state a total.
  for (const [article] of html.matchAll(/<article class="[^"]*\barticle--result\b[\s\S]*?<\/article>/g)) {
    const t = article.match(/data-total="(\d+)"/);
    if (t) total = Math.max(total, Number(t[1]));
    const link = article.match(/<a\b[^>]*\bhref="([^"]*\/JobDetail\/[^"]*?\/(\d+))"[^>]*>([\s\S]*?)<\/a>/);
    if (!link) continue;
    const spans = [...article.matchAll(/<span(?:\s[^>]*)?>([\s\S]*?)<\/span>/g)].map((m) => text(m[1])).filter(Boolean);
    jobs.push({
      id: link[2],
      title: text(link[3]),
      location: spans.length ? spans[spans.length - 1] : '',
      url: decode(link[1]),
      department: spans.length > 2 ? spans[1] : undefined,
      description: '',
    });
  }
  return { total, jobs };
}

/**
 * Whether a page is the bare site shell rather than a results page: no result
 * article and no list controls. A first page like that means the template has
 * changed, which must read as a failed board, never as a firm with nothing
 * open. From l3vlup-skills #361 (the other Avature reader, superseded by this).
 */
export function isAvatureEmptyShell(html) {
  return !/article--result|list-controls/.test(String(html || ''));
}
