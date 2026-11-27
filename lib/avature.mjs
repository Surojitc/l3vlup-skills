/**
 * Avature career sites: the search results page, read into rows.
 *
 * WHY AN HTML READER
 * ------------------
 * Avature has no public job API. Its career sites render a server-side search
 * page, `/{locale}/careers/SearchJobs/{keyword}?jobOffset=N`, ten results a
 * page whatever page size is asked for, each result an <article> with the job
 * title linked to `/careers/JobDetail/{slug}/{id}` and a subtitle of
 * "Brand | Legal entity | Location". The RSS feed at `SearchJobs/feed/` is
 * capped at 20 items (HSBC's board, probed 31 August 2026), so it cannot carry
 * a programme board. The site's robots.txt allows `/careers` (Deloitte US,
 * read 27 November 2026).
 *
 * Deloitte US is the first board read this way: its 2027 summer and campus
 * programmes are published there and nowhere the collector already reads.
 *
 * Pure: the fetching, pacing and the cap live in scripts/sync-ats.mjs.
 */

const decode = (s) =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** The search URL for one keyword and offset. */
export function avatureSearchUrl(host, keyword, offset = 0, locale = 'en_US') {
  if (!host || !keyword) return null;
  const q = encodeURIComponent(keyword.trim());
  return `https://${host}/${locale}/careers/SearchJobs/${q}?jobOffset=${offset}`;
}

/**
 * The rows on one results page, and the total the page states.
 * `total` is null when the page states none, which a caller must read as
 * "stop", never as zero results.
 */
export function parseAvatureResults(html) {
  const rows = [];
  let total = null;
  const articles = String(html || '').split(/<article\b/).slice(1);
  for (const a of articles) {
    const t = a.match(/data-total="(\d+)"/);
    if (t && total === null) total = Number(t[1]);
    const link = a.match(/<a\s+href="([^"]*\/careers\/JobDetail\/[^"]*?\/(\d+))"[^>]*>([\s\S]*?)<\/a>/);
    if (!link) continue;
    const spans = [...(a.match(/article__header__text__subtitle">([\s\S]*?)<\/div>/)?.[1] ?? '').matchAll(/<span>([\s\S]*?)<\/span>/g)].map((m) => decode(m[1]));
    rows.push({
      id: link[2],
      title: decode(link[3]),
      url: link[1],
      // "Brand | Legal entity | Location": the last span is the place.
      location: spans.length ? spans[spans.length - 1] : '',
      entity: spans.length > 2 ? spans[1] : '',
    });
  }
  return { total, rows };
}

/** An Avature site answering with no results block at all: a changed page or a bot check. */
export function isAvatureEmptyShell(html) {
  return !/article--result|list-controls/.test(String(html || ''));
}
