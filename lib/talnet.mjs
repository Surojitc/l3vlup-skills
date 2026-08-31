/**
 * tal.net (Oleeo) campus boards.
 *
 * This is where the elite boutiques and several bulge brackets recruit, and
 * nothing else here reaches them: Morgan Stanley, Nomura and BlackRock all run
 * their campus hiring on tal.net rather than on any ATS with a JSON API.
 *
 * There is no API. The board is a server-rendered table, which makes this the
 * only HTML parser in the collector — justified by what it unlocks, and kept
 * narrow: two functions, both pure, both tested against saved real markup.
 *
 * What makes it worth the fragility is the detail page. tal.net renders an
 * explicit `Deadline: 30/09/2026, 23:55` — a stated, hard application deadline
 * rather than a `validThrough` inferred for SEO. Those are the scarcest field
 * on the tracker and almost nothing else publishes them.
 *
 * Not every tenant is reachable. Roughly half serve an interstitial bot check
 * instead of the board; those are recorded as parked registry rows rather than
 * worked around. The reachable ones serve the table to a plain GET.
 */

/**
 * Does this response body look like the bot-check interstitial rather than a
 * board?
 *
 * Gated tenants answer 200 with roughly 4.8KB of "confirm you're a real
 * person"; a real board is 60-136KB. The caller needs to tell those apart,
 * because parsing the gate yields zero rows and zero rows reads as a firm with
 * nothing open. Both signals are checked: the wording, and the size, since a
 * reworded gate would still be far too small to be a board.
 */
export function isTalnetGate(html) {
  if (typeof html !== 'string') return true;
  if (/confirm you'?re a real person|Quick Check Needed/i.test(html)) return true;
  return html.length < 10000 && !/class="subject"/.test(html);
}

/** The board URL. `brand` varies per tenant; brand-4 is the common one. */
export function talnetBoardUrl(host, brand = 'brand-4') {
  if (!host) return null;
  return `https://${host}/vx/lang-en-GB/mobile-0/appcentre-ext/${brand}/candidate/jobboard/vacancy/1/adv/`;
}

const strip = (s) => s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

function decode(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#3[49];/g, "'")
    .replace(/&#x27;/g, "'");
}

/**
 * Pull the vacancy rows out of a board page.
 *
 * Each row is an `<a class="subject">` carrying a stable numeric opportunity id
 * in its href, followed by cells holding the location. Tenants render the anchor
 * twice — once for the desktop table and once for the mobile list — so rows are
 * deduped on that id rather than counted.
 */
export function parseTalnetBoard(html) {
  if (typeof html !== 'string' || !html) return [];
  const seen = new Map();
  const re =
    /<a class="subject"[^>]*href="([^"]*\/opp\/(\d+)-[^"]*)"[^>]*>([\s\S]*?)<\/a>([\s\S]{0,400}?)<\/tr>/g;
  for (const m of html.matchAll(re)) {
    const [, url, id, titleHtml, rest] = m;
    if (seen.has(id)) continue;
    const title = decode(strip(titleHtml));
    if (!title) continue;
    const cells = [...rest.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)]
      .map((c) => decode(strip(c[1])))
      .filter(Boolean);
    seen.set(id, { id, url: decode(url), title, location: cells[0] ?? '' });
  }
  return [...seen.values()];
}

/**
 * The stated deadline on a vacancy detail page.
 *
 * tal.net writes `Deadline: 30/09/2026, 23:55` — day-first, which is the whole
 * reason this is parsed here rather than handed to `new Date()`. Node reads
 * "30/09/2026" as invalid and, worse, would read "05/09/2026" as 9 May. A
 * silently transposed deadline is the one error that must not reach a page, so
 * the components are taken positionally and validated.
 */
export function parseTalnetDeadline(html, { now = new Date() } = {}) {
  if (typeof html !== 'string') return undefined;
  const m = html.match(/Deadline:\s*(\d{2})\/(\d{2})\/(\d{4})/i);
  if (!m) return undefined;
  const [, dd, mm, yyyy] = m;
  const day = Number(dd);
  const month = Number(mm);
  const year = Number(yyyy);
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  const date = new Date(Date.UTC(year, month - 1, day));
  // Round-trips only if the day-month pair is real: 31/02 would roll into March.
  if (date.getUTCDate() !== day || date.getUTCMonth() !== month - 1) return undefined;
  const iso = date.toISOString().slice(0, 10);
  const today = now.toISOString().slice(0, 10);
  if (iso < today) return undefined; // already closed
  const ceiling = new Date(date);
  ceiling.setUTCFullYear(ceiling.getUTCFullYear() - 2);
  if (ceiling > now) return undefined; // implausibly far out; treat as a placeholder
  return iso;
}
