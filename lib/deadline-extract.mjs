/**
 * Pull an application deadline out of a job posting's own text.
 *
 * WHY THIS EXISTS
 * ---------------
 * A deadline tracker without deadlines is a list. Only 1 of 123 tracked roles
 * carried a closing date, because none of the four ATS providers reliably
 * expose one as structured data: Greenhouse has `application_deadline` and
 * almost nobody populates it, and Lever, Ashby and Workday have no field at
 * all. The dates do exist — they are written in the posting body, in prose.
 *
 * So we read the prose. Nothing here infers or estimates a date: a deadline is
 * returned only when the posting states one near a phrase that means "deadline",
 * which keeps the tracker factual and citable.
 *
 * Shared by scripts/sync-ats.mjs and its tests; plain .mjs so both can import it
 * without a build step.
 */

/** Phrases that mean "this is the closing date", not just any date in the text. */
const CUE = String.raw`(?:application(?:s)?\s+(?:close|closing|deadline|must\s+be\s+received)|closing\s+date|apply\s+by|applications?\s+due|deadline(?:\s+for\s+applications?)?|submit(?:\s+your\s+application)?\s+by|last\s+day\s+to\s+apply|final\s+deadline)`;

/** Rolling wording. Real, and worth recording as a status rather than a date. */
const ROLLING =
  /\b(?:rolling\s+basis|reviewed?\s+on\s+a\s+rolling|applications?\s+are\s+reviewed\s+as\s+(?:they\s+are\s+)?received|until\s+(?:the\s+)?(?:role|position)\s+is\s+filled|open\s+until\s+filled)\b/i;

const MONTHS = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9,
  september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

const MONTH_RE = Object.keys(MONTHS).join('|');

/** "31 October 2026" / "31st Oct 2026" — the British order. */
const DMY = new RegExp(
  String.raw`\b(\d{1,2})(?:st|nd|rd|th)?\s+(${MONTH_RE})\.?,?\s+(\d{4})\b`,
  'i'
);

/** "October 31, 2026" / "Oct 31 2026" — the American order. */
const MDY = new RegExp(
  String.raw`\b(${MONTH_RE})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b`,
  'i'
);

/** ISO: 2026-10-31. Unambiguous, so it is tried first. */
const ISO = /\b(\d{4})-(\d{2})-(\d{2})\b/;

/**
 * Numeric slash dates are genuinely ambiguous — 10/11/2026 is October 11th to a
 * US posting and 10 November to a UK one — so they are only read when the day
 * is above 12 and the order is therefore certain. Guessing would put wrong
 * dates on the site, which is worse than no date.
 */
const SLASH_UNAMBIGUOUS = /\b(\d{1,2})[/.](\d{1,2})[/.](\d{4})\b/;

function iso(y, m, d) {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  // Rejects 31 February and friends, which Date would silently roll forward.
  if (dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

function parseDate(text) {
  let m;
  if ((m = ISO.exec(text))) return iso(+m[1], +m[2], +m[3]);
  if ((m = DMY.exec(text))) return iso(+m[3], MONTHS[m[2].toLowerCase()], +m[1]);
  if ((m = MDY.exec(text))) return iso(+m[3], MONTHS[m[1].toLowerCase()], +m[2]);
  if ((m = SLASH_UNAMBIGUOUS.exec(text))) {
    const a = +m[1];
    const b = +m[2];
    if (a > 12 && b <= 12) return iso(+m[3], b, a); // day/month/year
    if (b > 12 && a <= 12) return iso(+m[3], a, b); // month/day/year
    return null; // both plausible — refuse to guess
  }
  return null;
}

/** Strip HTML and decode the entities ATS payloads arrive with. */
export function toPlainText(input) {
  if (!input) return '';
  return String(input)
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * @param {string} text  Posting body, HTML or plain.
 * @param {object} [opts]
 * @param {Date}   [opts.now]        Reference date; a deadline in the past is stale, not a deadline.
 * @param {number} [opts.maxMonths]  Reject dates implausibly far out (default 24).
 * @returns {{ closingDate?: string, rolling?: boolean }}
 */
export function extractDeadline(text, opts = {}) {
  const plain = toPlainText(text);
  if (!plain) return {};

  const now = opts.now ?? new Date();
  const maxMonths = opts.maxMonths ?? 24;

  // Only look at text near a deadline cue. A posting is full of dates — start
  // dates, programme dates, incorporation years — and any of them would be
  // wrong here.
  const cueRe = new RegExp(`${CUE}[^.!?]{0,90}`, 'gi');
  for (const window of plain.match(cueRe) ?? []) {
    const date = parseDate(window);
    if (!date) continue;
    const dt = new Date(`${date}T00:00:00Z`);
    if (dt < new Date(now.toISOString().slice(0, 10))) continue; // already passed
    const limit = new Date(now);
    limit.setUTCMonth(limit.getUTCMonth() + maxMonths);
    if (dt > limit) continue; // implausibly far out
    return { closingDate: date };
  }

  if (ROLLING.test(plain)) return { rolling: true };
  return {};
}

/**
 * Apply hand-entered deadlines over whatever the sync scraped.
 *
 * Match order: an exact `id` wins; otherwise `firm` plus an optional
 * `rolePattern` substring, which is how one bank-wide deadline covers a whole
 * programme. Rows whose date has already passed are skipped, so the file can
 * accumulate history without going stale on the site.
 *
 * @param {Array<{id:string,firm:string,role:string,closingDate?:string}>} roles  mutated in place
 * @param {Array<{id?:string,firm?:string,rolePattern?:string,closingDate?:string}>} manual
 * @param {string} today  ISO date
 * @returns {number} how many roles were given a date
 */
export function applyManualDeadlines(roles, manual, today) {
  let applied = 0;
  for (const entry of manual ?? []) {
    if (!entry?.closingDate || entry.closingDate < today) continue;
    for (const role of roles) {
      const byId = entry.id && role.id === entry.id;
      const byFirm =
        !entry.id &&
        entry.firm &&
        role.firm?.toLowerCase() === entry.firm.toLowerCase() &&
        (!entry.rolePattern || role.role?.toLowerCase().includes(entry.rolePattern.toLowerCase()));
      if (byId || byFirm) {
        role.closingDate = entry.closingDate;
        applied++;
      }
    }
  }
  return applied;
}

/**
 * Read a deadline out of a posting page's JobPosting structured data.
 *
 * This is the reliable route, and it exists because of Google rather than any
 * generosity from the ATS vendors: `validThrough` is required for a posting to
 * be eligible for job rich results, so any employer who wants that traffic
 * publishes the date as machine-readable JSON-LD. (This site does the same in
 * app/tracker/[slug]/page.tsx, which is how we know the field is widely used.)
 *
 * Prose extraction stays as the fallback for postings with no markup.
 *
 * @param {string} html  The posting page's HTML.
 * @returns {{ closingDate?: string }}
 */
export function extractJsonLdDeadline(html) {
  if (!html) return {};
  const blocks = String(html).match(
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  );
  if (!blocks) return {};

  for (const block of blocks) {
    const body = block.replace(/^<script[^>]*>/i, '').replace(/<\/script>$/i, '');
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      continue; // a malformed block on the page is not our problem
    }
    // Payloads arrive as a single object, an array, or an @graph wrapper.
    const candidates = [];
    const push = (node) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) return node.forEach(push);
      if (Array.isArray(node['@graph'])) node['@graph'].forEach(push);
      candidates.push(node);
    };
    push(parsed);

    for (const node of candidates) {
      const type = node['@type'];
      const isJob = Array.isArray(type) ? type.includes('JobPosting') : type === 'JobPosting';
      if (!isJob || !node.validThrough) continue;
      // validThrough may be a bare date or a full timestamp.
      const date = String(node.validThrough).slice(0, 10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(date)) return { closingDate: date };
    }
  }
  return {};
}
