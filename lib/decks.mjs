// Shared parsing and classification for the board-book index.
//
// Kept apart from the collector so the pieces that make judgements (which
// exhibit is a deck, what sector a code means, what a buyer's name says about
// the buyer) can be tested without touching the network.

// ── Header ──────────────────────────────────────────────────────────────────

/**
 * Decode the submission header page. EDGAR shows the SGML as escaped text,
 * so the tags only exist once entities are decoded, and stripping markup
 * before decoding deletes exactly the tags wanted.
 */
export function decodeHeader(html) {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function companyBlock(text) {
  const name = text.match(/COMPANY CONFORMED NAME:\s*(.+)/)?.[1]?.trim() ?? '';
  const cik = text.match(/CENTRAL INDEX KEY:\s*(\d+)/)?.[1]?.padStart(10, '0') ?? null;
  const sicLine = text.match(/STANDARD INDUSTRIAL CLASSIFICATION:\s*(.+)/)?.[1]?.trim() ?? '';
  const sic = sicLine.match(/\[(\d{4})\]/)?.[1] ?? null;
  const sicDescription = sicLine.replace(/\s*\[\d{4}\]\s*$/, '').trim() || null;
  const state = text.match(/STATE OF INCORPORATION:\s*(\S+)/)?.[1] ?? null;
  return { name, cik, sic, sicDescription, state };
}

/**
 * The parts of a submission header the index uses: the subject company
 * (the target), the filing persons (the buyer side), group members, and
 * every document with the <TYPE> the filer declared.
 */
export function parseHeader(html) {
  const text = decodeHeader(html);
  const headerEnd = text.indexOf('</SEC-HEADER>');
  const head = headerEnd > 0 ? text.slice(0, headerEnd) : text;

  // Sections begin with "SUBJECT COMPANY:" or "FILED BY:" (or "FILER:" on
  // some older submissions) and run to the next such heading.
  const sections = head.split(/\n(?=(?:SUBJECT COMPANY|FILED BY|FILER):)/);
  const subjects = [];
  const filers = [];
  for (const s of sections) {
    if (/^SUBJECT COMPANY:/.test(s)) subjects.push(companyBlock(s));
    else if (/^(FILED BY|FILER):/.test(s)) filers.push(companyBlock(s));
  }

  const groupMembers = [...head.matchAll(/GROUP MEMBERS:\s*(.+)/g)].map((m) => m[1].trim()).filter(Boolean);

  const documents = [];
  const re = /<TYPE>([^\n<]*)\n(?:<SEQUENCE>[^\n]*\n)?<FILENAME>([^\n<]+)(?:\n<DESCRIPTION>([^\n<]*))?/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const file = m[2].trim();
    documents.push({
      type: m[1].trim(),
      file,
      description: (m[3] ?? '').trim(),
      isPdf: /\.pdf$/i.test(file),
    });
  }

  return { subjects, filers, groupMembers, documents };
}

// ── Exhibits ────────────────────────────────────────────────────────────────

/**
 * Schedule 13E-3 letters its exhibits by what they are: (a) offer material,
 * (b) financing, (c) the adviser's own materials, (d) agreements. The letter
 * is the classification. Sequence numbers are as often Roman as Arabic, and
 * requiring one is what keeps "EX-FILING FEES" and a bare "EX-99" out.
 */
export function classifyExhibit(type) {
  const t = type.toUpperCase().replace(/[\s.]/g, '');
  const letter = t.match(/^EX-?(?:99)?[-_]?\(?([A-D])\)?\(?(?:\d+|[IVX]+)\)?/)?.[1] ?? null;
  switch (letter) {
    case 'C': return 'adviser';
    case 'A': return 'offer';
    case 'B': return 'financing';
    case 'D': return 'agreement';
    default: return 'other';
  }
}

// ── Text ────────────────────────────────────────────────────────────────────

export function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/(p|div|li|h[1-6]|tr|br|td|th)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&rsquo;|&lsquo;|&#8217;|&#8216;/g, "'")
    .replace(/&quot;|&ldquo;|&rdquo;|&#8220;|&#8221;/g, '"')
    .replace(/&#8212;|&mdash;/g, ' - ')
    .replace(/&[a-z]+;|&#\d+;/gi, ' ')
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

/**
 * The transaction value from a filing-fee table, in USD millions.
 *
 * Two layouts. Since 2022 the EX-FILING FEES exhibit reads
 * "Transaction Valuation ... Fee Rate ... Amount of Filing Fee ...
 * Fees to Be Paid $ 20,072,133.27 0.00013810 $ 2,771.96". Before that the
 * cover page reads "CALCULATION OF FILING FEE Transaction Valuation* Amount
 * of Filing Fee** $ 535,900,072 $ 69,559.83". In both the first dollar
 * amount after the words "Transaction Valuation" is the value, and the fee
 * that follows is three or four orders of magnitude smaller, which is the
 * check that the right number was taken.
 */
export function parseTransactionValue(text) {
  const at = text.search(/transaction valuation/i);
  if (at < 0) return null;
  const window = text.slice(at, at + 1500);
  const amounts = [...window.matchAll(/\$\s*([\d,]+(?:\.\d+)?)/g)]
    .map((m) => Number(m[1].replace(/,/g, '')))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (amounts.length === 0) return null;
  // Fee tables sometimes lead with "N/A" or a per-share price. Take the first
  // amount that is at least a million and is followed by something far
  // smaller, or failing that the largest amount in the window.
  for (let i = 0; i < amounts.length; i += 1) {
    const v = amounts[i];
    const next = amounts[i + 1];
    if (v >= 1e6 && (next === undefined || next < v / 100)) return Math.round(v / 1e6);
  }
  const max = Math.max(...amounts);
  return max >= 1e6 ? Math.round(max / 1e6) : null;
}

// ── Cover title ─────────────────────────────────────────────────────────────

/**
 * What a banker would call the document, read off its first slide.
 *
 * These exhibits are slide images with the slide's own text laid underneath in
 * white, so the pages are searchable on EDGAR. The first page carries the real
 * title: a code name for the deal, what the document is, who it was prepared
 * for, and the date of the meeting. "EX-99.(C)(4)" tells a reader nothing;
 * "Project Eclipse: discussion materials for the Board of Directors, 21 April
 * 2026" tells them what they are about to open.
 *
 * The read is deliberately narrow. Nothing is quoted verbatim from the cover,
 * because the layer is a soup: the same words arrive letter-spaced ("D I S C U
 * S S I O N"), doubled where two text layers overlap, or run together where a
 * slide's lines were concatenated without a space ("Project ECLIPSEDiscussion
 * Materials"). Instead the phrases a board book actually uses are looked for,
 * spaces removed on both sides so the spacing cannot matter, and the title is
 * rebuilt from the parts that were recognised. A cover that matches nothing
 * yields null, which is the right answer: on this page a wrong name is worse
 * than no name, and the exhibit number is always there to fall back on.
 *
 * Confidentiality boilerplate is never part of a name. It is not stripped
 * afterwards, it is simply never matched: "Privileged & Confidential",
 * "Preliminary Draft", "Subject to Further Review" and the rest are not on
 * the phrase lists, so they cannot reach the title.
 */

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MONTH_RE = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';

/**
 * What the document is, as the cover says it, with the reading label and how
 * much the phrase carries on its own. A strong phrase names the document by
 * itself. A weak one ("presentation", "materials", "update") is a word every
 * deck uses in its disclaimer, so it only becomes a title when the cover also
 * gave up a code name or the committee it was written for.
 */
const COVER_KINDS = [
  ['nonbindingproposalsummary', 'non-binding proposal summary', 2],
  ['discussionmaterials', 'discussion materials', 2],
  ['discussiondocument', 'discussion document', 2],
  ['presentationmaterials', 'presentation materials', 2],
  ['boardmaterials', 'board materials', 2],
  ['organizationalmaterials', 'organisational materials', 2],
  ['organisationalmaterials', 'organisational materials', 2],
  ['fairnessopinion', 'fairness opinion', 2],
  ['fairnessanalysis', 'fairness analysis', 2],
  ['valuationanalysis', 'valuation analysis', 2],
  ['valuationsummary', 'valuation summary', 2],
  ['preliminaryvaluation', 'preliminary valuation', 2],
  ['financialanalysis', 'financial analysis', 2],
  ['processupdate', 'process update', 2],
  ['proposalresponse', 'proposal response', 2],
  ['situationupdate', 'situation update', 2],
  ['projectupdate', 'project update', 2],
  ['statusupdate', 'status update', 2],
  ['boardupdate', 'board update', 2],
  ['update', 'update', 1],
  ['presentation', 'presentation', 1],
  ['materials', 'materials', 1],
];

/** Who the deck was written for. Longest reading first, so the fuller name wins. */
const COVER_AUDIENCES = [
  ['specialcommitteeoftheboardofdirectors', 'the Special Committee of the Board of Directors'],
  ['specialcommitteeofboardofdirectors', 'the Special Committee of the Board of Directors'],
  ['specialcommitteeofindependentdirectors', 'the Special Committee of Independent Directors'],
  ['independenttransactioncommittee', 'the Independent Transaction Committee'],
  ['transactioncommittee', 'the Transaction Committee'],
  ['specialcommittee', 'the Special Committee'],
  ['auditcommittee', 'the Audit Committee'],
  ['independentcommittee', 'the Independent Committee'],
  ['conflictscommittee', 'the Conflicts Committee'],
  ['strategiccommittee', 'the Strategic Committee'],
  ['independentdirectors', 'the Independent Directors'],
  ['boardofdirectors', 'the Board of Directors'],
];

/**
 * Words that cannot be a deal's code name. A cover reads "Project Eclipse
 * Discussion Materials", and with the spacing as unreliable as it is, the word
 * after "Project" is as likely to be the next thing on the slide as the name.
 *
 * The second half of the list is what a deck calls itself once the code name
 * is out of the way. Advisers write "Project Alpha Supplemental Discussion
 * Materials" and "Project Kona Updated Materials", and without these words a
 * two-word name like "Project Northern Lights" cannot be told apart from a
 * one-word name followed by an adjective.
 */
const NOT_A_CODE_NAME = new Set([
  'discussion', 'materials', 'presentation', 'presentations', 'board', 'directors', 'committee', 'special', 'update',
  'summary', 'overview', 'analysis', 'analyses', 'confidential', 'draft', 'preliminary', 'private', 'strictly',
  'privileged', 'proposal', 'response', 'opinion', 'the', 'and', 'for', 'to', 'of', 'a', 'an', 'is', 'was', 'prepared',
  'project', 'projects', 'team', 'status', 'process', 'situation', 'valuation', 'financial', 'fairness', 'document',
  'documents', 'meeting', 'agenda', 'contents', 'table', 'appendix', 'executive', 'disclaimer',
  'supplemental', 'supplementary', 'updated', 'revised', 'refreshed', 'additional', 'supporting', 'reference',
  'report', 'weekly', 'daily', 'monthly', 'quarterly', 'price', 'pricing', 'finance', 'highly', 'indications',
  'interest', 'further', 'final', 'initial', 'interim', 'current', 'latest', 'review', 'considerations',
  'perspectives', 'illustrative', 'selected', 'summarised', 'summarized',
  ...MONTHS,
]);

/**
 * The readable text of the first page.
 *
 * EDGAR serves the exhibit with its SGML wrapper, so the document opens with
 * the filer's own <TYPE>, <FILENAME> and <DESCRIPTION> lines and then the HTML
 * title, all of which repeat the exhibit number. Those are dropped along with
 * the exhibit tag printed in the corner of the first slide, because none of
 * them is the cover, and a description that repeats "EX-99.(C)(4)" would only
 * teach the reader what they already know.
 */
export function coverText(html) {
  const body = html.includes('<TEXT>') ? html.slice(html.indexOf('<TEXT>') + 6) : html;
  let text = stripHtml(body);
  text = text.replace(/^(?:\s*(?:EX(?:HIBIT)?[^\n]{0,120}|\d{1,3}|[\w.-]+\.html?)\n)+/i, '');
  text = text.replace(/\bexhibit\s*(?:99)?\s*\.?\s*[-(]\s*[a-d]\s*\)?\s*[-(]?\s*[\divxlc]+\s*\)?(?:\s*\(\s*[a-z]\s*\))?/gi, ' ');
  text = text.replace(/\bexhibit\s*(?:99)?\s*\.?\s*\(?\s*[a-d]\s*\)\s*/gi, ' ');
  return text.replace(/\s+/g, ' ').trim().slice(0, 900);
}

/**
 * Letters and digits only, with each kept character's index back into the
 * source. Taking the spacing out is what makes "D I S C U S S I O N M AT E R I
 * A L S" and "ECLIPSEDiscussion" the same string to match against; the index
 * map is what lets a match be placed back on the page afterwards.
 */
function flattenText(s) {
  let flat = '';
  const map = [];
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i].toLowerCase();
    if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')) {
      flat += c;
      map.push(i);
    }
  }
  return { flat, map };
}

/** The earliest phrase from a table, the longest reading winning a tie. */
function firstPhrase(flat, table) {
  let best = null;
  for (const row of table) {
    const at = flat.indexOf(row[0]);
    if (at < 0) continue;
    if (!best || at < best.at || (at === best.at && row[0].length > best.len)) {
      best = { at, len: row[0].length, label: row[1], strength: row[2] ?? 0 };
    }
  }
  return best;
}

const titleCase = (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
// A slide's own dashes come through as a run ("Project Kernel---Discussion"),
// while a name like Shangri-la keeps its single one.
const trimWord = (w) => (w ?? '').replace(/^[^A-Za-z]+/, '').split(/-{2,}/)[0].replace(/[^A-Za-z'’-]+$/, '').replace(/-+$/, '');

/** "ECLIPSEDiscussion" is a code name and the next line, run together. */
function splitRunOn(token) {
  return token.match(/^([A-Z][A-Z0-9]+)(?=[A-Z][a-z])/)?.[1]
    ?? token.match(/^([A-Z][a-z]+)(?=[A-Z])/)?.[1]
    ?? token;
}

function isCodeName(name) {
  if (!/^[A-Za-z][A-Za-z'’-]{2,19}$/.test(name)) return false;
  return !NOT_A_CODE_NAME.has(name.toLowerCase());
}

/**
 * The deal's code name and where it sits on the page. Advisers give every
 * live deal one, and it is the single most recognisable thing on the cover.
 * A second word is taken only for the "Project Northern Lights" shape: both
 * words capitalised the same way, and the word after them one that belongs to
 * the document's own description rather than to the name.
 */
export function findProjectName(text) {
  const m = text.match(/\bproject\s+(\S+)(?:\s+(\S+))?(?:\s+(\S+))?/i);
  if (!m) return null;
  const one = splitRunOn(trimWord(m[1]));
  if (!isCodeName(one)) return null;
  const two = trimWord(m[2]);
  const three = trimWord(m[3]);
  const pair = /^[A-Z][a-z]+$/.test(one) && /^[A-Z][a-z]+$/.test(two) && isCodeName(two)
    && (three === '' || NOT_A_CODE_NAME.has(three.toLowerCase()));
  return { name: pair ? `${titleCase(one)} ${titleCase(two)}` : titleCase(one), at: m.index };
}

/**
 * The date on the cover, as the day the board saw the materials.
 *
 * A cover can carry more than one: the meeting date next to the title, a
 * stale date left in the template, a projection year in a footnote. The one
 * printed with the title is the one wanted, so the search prefers the first
 * date after the title and only falls back to the nearest one before it.
 * Anything later than the filing date is a misread and is dropped.
 */
export function findCoverDate(text, { anchor = 0, filedOn = null } = {}) {
  const found = [];
  const add = (at, y, m, d) => {
    if (!(y >= 1995 && y <= 2100) || m < 1 || m > 12) return;
    if (d !== null && (d < 1 || d > 31)) return;
    found.push({ at, y, m, d });
  };
  const monthNumber = (s) => MONTHS.findIndex((m) => m.startsWith(s.toLowerCase().replace('.', '').slice(0, 3))) + 1;

  for (const m of text.matchAll(new RegExp(`\\b(${MONTH_RE})\\.?\\s+(\\d{1,2})\\s*(?:st|nd|rd|th)?\\s*,?\\s*(\\d{4})\\b`, 'gi'))) {
    add(m.index, Number(m[3]), monthNumber(m[1]), Number(m[2]));
  }
  for (const m of text.matchAll(new RegExp(`\\b(\\d{1,2})\\s+(${MONTH_RE})\\.?,?\\s+(\\d{4})\\b`, 'gi'))) {
    add(m.index, Number(m[3]), monthNumber(m[2]), Number(m[1]));
  }
  for (const m of text.matchAll(new RegExp(`\\b(${MONTH_RE})\\.?,?\\s+(\\d{4})\\b`, 'gi'))) {
    add(m.index, Number(m[2]), monthNumber(m[1]), null);
  }
  if (found.length === 0) {
    // A cover set letter by letter ("Janu a ry 11, 2024") only reads once the
    // spacing is out. Numeric-only dates are left alone: 09.11.2025 is the
    // ninth of November or the eleventh of September depending on the desk
    // that made the slide, and a wrong date is a wrong name.
    const { flat, map } = flattenText(text);
    for (const m of flat.matchAll(new RegExp(`(${MONTHS.join('|')})(\\d{1,2})(\\d{4})`, 'g'))) {
      add(map[m.index], Number(m[3]), MONTHS.indexOf(m[1]) + 1, Number(m[2]));
    }
    for (const m of flat.matchAll(new RegExp(`(${MONTHS.join('|')})(\\d{4})`, 'g'))) {
      add(map[m.index], Number(m[2]), MONTHS.indexOf(m[1]) + 1, null);
    }
  }
  if (found.length === 0) return null;

  const rank = (c) => [c.at >= anchor ? 0 : 1, Math.abs(c.at - anchor), c.d === null ? 1 : 0];
  found.sort((a, b) => {
    const [ax, ay, az] = rank(a);
    const [bx, by, bz] = rank(b);
    return ax - bx || ay - by || az - bz;
  });
  const best = found[0];
  if (filedOn) {
    const filed = Date.parse(filedOn);
    const when = Date.UTC(best.y, best.m - 1, best.d ?? 1);
    if (Number.isFinite(filed) && when > filed + 86_400_000) return null;
  }
  const month = titleCase(MONTHS[best.m - 1]);
  return best.d === null ? `${month} ${best.y}` : `${best.d} ${month} ${best.y}`;
}

/**
 * The cover of one adviser exhibit, rebuilt from the parts that were
 * recognised. Returns nulls throughout when the first page gave nothing
 * certain, which is every scanned PDF and every deck whose opening page is a
 * disclaimer or a bare image.
 */
export function extractCoverTitle(html, { filedOn = null } = {}) {
  const nothing = { coverTitle: null, projectName: null, documentKind: null, preparedFor: null, coverDate: null };
  const text = coverText(html);
  if (text.length < 20) return nothing;

  // The title, the committee and the date are all on the first slide. Reading
  // further finds the disclaimer, where every one of these words also appears.
  const opening = text.slice(0, 420);
  const { flat, map } = flattenText(opening);
  const kind = firstPhrase(flat, COVER_KINDS);
  if (!kind) return nothing;
  const audience = firstPhrase(flat, COVER_AUDIENCES);
  const project = findProjectName(opening);
  if (kind.strength === 1 && !audience && !project) return nothing;

  const anchor = project ? Math.min(project.at, map[kind.at]) : map[kind.at];
  const date = findCoverDate(opening, { anchor, filedOn });
  const what = audience ? `${kind.label} for ${audience.label}` : kind.label;
  let title = project ? `Project ${project.name}: ${what}` : what.charAt(0).toUpperCase() + what.slice(1);
  if (date) title += `, ${date}`;

  return {
    coverTitle: title,
    projectName: project ? project.name : null,
    documentKind: kind.label,
    preparedFor: audience ? audience.label : null,
    coverDate: date,
  };
}

// ── Analyses ────────────────────────────────────────────────────────────────

/**
 * The analyses a board book is built from, each with the phrases advisers
 * use for it. Detection is a phrase count on the deck's text, so a deck that
 * mentions a method once in a disclaimer is not credited with it.
 */
export const ANALYSES = [
  { key: 'dcf', label: 'DCF', patterns: [/discounted cash flow/gi, /\bDCF\b/g], min: 2 },
  { key: 'trading-comps', label: 'Trading comps', patterns: [/selected (public(ly traded)? )?compan(y|ies)/gi, /comparable compan(y|ies)/gi, /trading (comparables|multiples|comps)/gi, /public(ly)? (market )?trading analysis/gi], min: 2 },
  { key: 'precedents', label: 'Precedent transactions', patterns: [/precedent transaction/gi, /selected (precedent )?transactions/gi, /comparable transactions/gi], min: 2 },
  { key: 'premiums-paid', label: 'Premiums paid', patterns: [/premiums? paid/gi, /premium analysis/gi, /premia/gi], min: 2 },
  { key: 'lbo', label: 'LBO / ability to pay', patterns: [/leveraged buy-?out/gi, /\bLBO\b/g, /ability[- ]to[- ]pay/gi, /sponsor (ability|analysis)/gi], min: 2 },
  { key: 'sotp', label: 'Sum-of-the-parts', patterns: [/sum[- ]of[- ]the[- ]parts/gi, /\bSOTP\b/g], min: 2 },
  { key: '52-week', label: '52-week range', patterns: [/52[- ]week/gi, /fifty[- ]two[- ]week/gi], min: 2 },
  { key: 'analyst-targets', label: 'Analyst price targets', patterns: [/analyst price target/gi, /price targets?/gi, /research analyst/gi], min: 2 },
  { key: 'football-field', label: 'Football field', patterns: [/football field/gi, /valuation summary/gi, /summary of (financial )?analys[ei]s/gi, /implied (equity )?value per share/gi], min: 2 },
  { key: 'wacc', label: 'WACC', patterns: [/\bWACC\b/g, /weighted average cost of capital/gi, /cost of equity/gi], min: 2 },
  { key: 'sensitivity', label: 'Sensitivity', patterns: [/sensitivit(y|ies)/gi], min: 2 },
  { key: 'accretion-dilution', label: 'Accretion / dilution', patterns: [/accretion/gi, /accretive/gi, /dilutive/gi], min: 3 },
  { key: 'projections', label: 'Management projections', patterns: [/management (projections|forecasts|case|plan)/gi, /projected (financial|revenue)/gi, /financial projections/gi], min: 2 },
  { key: 'process', label: 'Process summary', patterns: [/process (summary|overview|update)/gi, /summary of (the )?(sale )?process/gi, /parties contacted/gi, /indications? of interest/gi], min: 2 },
];

export function detectAnalyses(text) {
  const out = [];
  for (const a of ANALYSES) {
    let n = 0;
    for (const p of a.patterns) n += (text.match(p) ?? []).length;
    if (n >= a.min) out.push(a.key);
  }
  return out;
}

// ── Advisers ────────────────────────────────────────────────────────────────

/** The banks whose names are looked for at the top of a deck. */
export const ADVISERS = [
  { name: 'Goldman Sachs', re: /goldman,? sachs/i },
  { name: 'Morgan Stanley', re: /morgan stanley/i },
  { name: 'J.P. Morgan', re: /j\.?\s?p\.?\s?morgan/i },
  { name: 'Bank of America', re: /bofa securities|bank of america|merrill lynch/i },
  { name: 'Citi', re: /citigroup|\bciti\b/i },
  { name: 'Barclays', re: /barclays/i },
  { name: 'Credit Suisse', re: /credit suisse/i },
  { name: 'UBS', re: /\bUBS\b/ },
  { name: 'Deutsche Bank', re: /deutsche bank/i },
  { name: 'Jefferies', re: /jefferies/i },
  { name: 'Wells Fargo', re: /wells fargo/i },
  { name: 'RBC Capital Markets', re: /\bRBC\b/ },
  { name: 'BMO Capital Markets', re: /\bBMO\b/ },
  { name: 'Scotiabank', re: /scotia/i },
  { name: 'TD Cowen', re: /\bTD (securities|cowen)|cowen and company|\bcowen\b/i },
  { name: 'Evercore', re: /evercore/i },
  { name: 'Lazard', re: /lazard/i },
  { name: 'Centerview', re: /centerview/i },
  { name: 'Moelis', re: /moelis/i },
  { name: 'PJT Partners', re: /\bPJT\b/ },
  { name: 'Perella Weinberg', re: /perella weinberg/i },
  { name: 'Guggenheim', re: /guggenheim/i },
  { name: 'Rothschild', re: /rothschild/i },
  { name: 'Houlihan Lokey', re: /houlihan lokey/i },
  { name: 'Duff & Phelps / Kroll', re: /duff\s*&\s*phelps|\bkroll\b/i },
  { name: 'William Blair', re: /william blair/i },
  { name: 'Raymond James', re: /raymond james/i },
  { name: 'Stifel', re: /\bstifel\b/i },
  { name: 'Piper Sandler', re: /piper sandler|piper jaffray/i },
  { name: 'Baird', re: /robert w\.? baird|\bbaird\b/i },
  { name: 'Truist', re: /truist|suntrust robinson/i },
  { name: 'Qatalyst', re: /qatalyst/i },
  { name: 'Allen & Company', re: /allen\s*&\s*company/i },
  { name: 'LionTree', re: /liontree/i },
  { name: 'Greenhill', re: /greenhill/i },
  { name: 'Leerink', re: /leerink/i },
  { name: 'Craig-Hallum', re: /craig-hallum/i },
  { name: 'Oppenheimer', re: /oppenheimer/i },
  { name: 'Needham', re: /needham/i },
  { name: 'Canaccord', re: /canaccord/i },
  { name: 'Nomura', re: /nomura/i },
  { name: 'Mizuho', re: /mizuho/i },
  { name: 'Macquarie', re: /macquarie/i },
  { name: 'B. Riley', re: /b\.? riley/i },
  { name: 'Roth', re: /roth capital|roth mkm/i },
  { name: 'Northland', re: /northland/i },
  { name: 'Ducera', re: /ducera/i },
  { name: 'Solomon Partners', re: /solomon partners|pj solomon/i },
  { name: 'Ardea', re: /ardea partners/i },
  { name: 'Kroll', re: /\bkroll\b/i },
  { name: 'Stout', re: /stout risius|\bstout\b/i },
  { name: 'Valuation Research', re: /valuation research/i },
  { name: 'Marshall & Stevens', re: /marshall\s*&\s*stevens/i },
];

/**
 * The adviser named in the opening pages. The disclaimer names the bank
 * three or four times on the first page, so requiring two mentions in the
 * opening stretch keeps out a bank that is merely quoted as an analyst.
 */
export function detectAdvisers(opening) {
  const out = [];
  for (const a of ADVISERS) {
    const n = (opening.match(new RegExp(a.re.source, `${a.re.flags.replace('g', '')}g`)) ?? []).length;
    if (n >= 2) out.push(a.name);
  }
  // "Duff & Phelps / Kroll" and "Kroll" overlap by design; keep the merged one.
  return out.includes('Duff & Phelps / Kroll') ? out.filter((n) => n !== 'Kroll') : out;
}

// ── Sectors ─────────────────────────────────────────────────────────────────

export const SECTORS = [
  'Technology',
  'Healthcare',
  'Financials',
  'Real Estate',
  'Energy',
  'Materials',
  'Industrials',
  'Consumer & Retail',
  'Media & Telecom',
  'Business Services',
  'Utilities',
  'Other',
];

/** A broad sector for an SEC industry code, the cut PitchBook calls "industry". */
export function sectorOf(sic) {
  const n = Number(sic);
  if (!Number.isFinite(n) || n <= 0) return 'Other';
  if (n === 6770 || n === 9995) return 'Other';
  if ([2834, 2835, 2836, 8731].includes(n)) return 'Healthcare';
  if ((n >= 3840 && n <= 3851) || (n >= 8000 && n <= 8099) || n === 5047 || n === 5122) return 'Healthcare';
  if ((n >= 3570 && n <= 3579) || (n >= 3600 && n <= 3699) || (n >= 7370 && n <= 7379) || n === 3812 || n === 3577) return 'Technology';
  if ((n >= 4800 && n <= 4899) || (n >= 2710 && n <= 2749) || (n >= 7800 && n <= 7841)) return 'Media & Telecom';
  if (n >= 4900 && n <= 4999) return 'Utilities';
  if ((n >= 6500 && n <= 6599) || n === 6798) return 'Real Estate';
  if (n >= 6000 && n <= 6799) return 'Financials';
  if (n === 1311 || (n >= 1380 && n <= 1389) || (n >= 2900 && n <= 2999) || n === 4610 || n === 4922 || n === 4923 || n === 5171 || n === 5172) return 'Energy';
  if ((n >= 1000 && n <= 1099) || (n >= 1200 && n <= 1299) || (n >= 1400 && n <= 1499) || (n >= 2800 && n <= 2899) || (n >= 3300 && n <= 3399) || (n >= 2400 && n <= 2499) || (n >= 2600 && n <= 2699) || (n >= 3000 && n <= 3099)) return 'Materials';
  if ((n >= 1500 && n <= 1799) || (n >= 3100 && n <= 3999) || (n >= 4000 && n <= 4799) || (n >= 5000 && n <= 5199)) return 'Industrials';
  if ((n >= 100 && n <= 999) || (n >= 2000 && n <= 2399) || (n >= 5200 && n <= 5999) || (n >= 7000 && n <= 7299) || (n >= 7900 && n <= 7999) || (n >= 8200 && n <= 8299)) return 'Consumer & Retail';
  if ((n >= 7300 && n <= 7399) || (n >= 8100 && n <= 8999)) return 'Business Services';
  return 'Other';
}

// ── Size ────────────────────────────────────────────────────────────────────

export const CAP_SIZES = ['Micro', 'Small', 'Mid', 'Large', 'Mega', 'Undisclosed'];

/** Size bucket on transaction value in USD millions. */
export function capSize(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'Undisclosed';
  if (value < 250) return 'Micro';
  if (value < 1000) return 'Small';
  if (value < 5000) return 'Mid';
  if (value < 20_000) return 'Large';
  return 'Mega';
}

// ── Buyer type ──────────────────────────────────────────────────────────────

export const BUYER_TYPES = ['Financial sponsor', 'Strategic', 'Management / founder', 'Controlling holder', 'Acquisition vehicle', 'Unclassified'];

const SPONSOR = /\b(capital|partners|fund|equity|investors?|investments?|advis[oe]rs|asset management|private equity|ventures|holdings?,? l\.?p\.?|l\.?p\.?$|management,? l\.?l\.?c|opportunities|growth)\b/i;
const CORPORATE = /\b(inc\.?|corp\.?|corporation|company|co\.?|plc|ltd\.?|limited|ag|s\.?a\.?|n\.?v\.?|gmbh|s\.?p\.?a\.?|holdings?|group|industries|technologies|systems|international|pharmaceuticals?|therapeutics|energy|bank|insurance|trust)\b/i;
const VEHICLE = /merger sub|mergersub|bidco|topco|midco|holdco|acquisition (sub|corp|co|company|llc|inc)|newco|purchaser/i;
const PERSON = /^[A-Z][a-z]+(?:\s[A-Z]\.?)?(?:\s[A-Z][a-z'-]+){1,2}(?:,? (jr|sr|ii|iii|iv)\.?)?$/;
const TRUST = /family|trust|estate|living|revocable|foundation/i;

/**
 * What kind of buyer the filing persons are. A heuristic on names, and
 * recorded as one: the sponsor's name is usually in the list, a strategic
 * files under its own name, and a founder files as a person.
 */
export function acquirerType(buyers, targetName) {
  const names = buyers.filter((n) => !VEHICLE.test(n));
  const targetKey = (targetName || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
  let sponsor = 0;
  let strategic = 0;
  let person = 0;
  let holder = 0;
  for (const n of names) {
    const key = n.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (targetKey && key.startsWith(targetKey)) continue; // the target filing for itself
    if (PERSON.test(n.trim()) || TRUST.test(n)) person += 1;
    else if (SPONSOR.test(n)) sponsor += 1;
    else if (CORPORATE.test(n)) strategic += 1;
    else holder += 1;
  }
  if (sponsor > 0 && sponsor >= strategic) return 'Financial sponsor';
  if (strategic > 0) return 'Strategic';
  if (person > 0) return 'Management / founder';
  if (holder > 0) return 'Controlling holder';
  // Only a "Merger Sub" or an "Acquisition Company, LLC" filed: the sponsor
  // or parent behind it is named in the offer document, not in the header.
  if (buyers.length > 0 && names.length === 0) return 'Acquisition vehicle';
  return 'Unclassified';
}

// ── Rating ──────────────────────────────────────────────────────────────────

/**
 * A teaching-value grade for the transaction's materials. It rewards the
 * things that make a set of decks useful to a reader: several exhibits (so
 * the price can be followed across meetings), readable HTML rather than a
 * scanned PDF, breadth of analysis, and a stated value to anchor multiples.
 * It says nothing about the quality of the advice.
 */
export function rate({ decks, readable, analyses, valued }) {
  if (decks === 0) return { score: 0, grade: null };
  let score = 0;
  score += Math.min(decks, 5) * 8; // up to 40
  score += Math.min(analyses, 8) * 5; // up to 40
  score += readable > 0 ? 10 : 0;
  score += valued ? 10 : 0;
  const grade = score >= 70 ? 'A' : score >= 50 ? 'B' : score >= 30 ? 'C' : 'D';
  return { score, grade };
}
