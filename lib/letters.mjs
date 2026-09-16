// What the letters discovery reads out of an EDGAR submissions index.
//
// A fund's public writing reaches EDGAR three ways: an activist files its
// letter or deck as a DFAN14A or as an exhibit to a Schedule 13D; a
// registered fund files the manager's letter inside its shareholder report
// (N-CSR, N-CSRS). The submissions index at data.sec.gov lists every filing
// by one filer with its form, accession number, date and primary document,
// which is enough to say what exists without opening anything.
//
// Two honest limits. The index names the primary document only, so a letter
// filed as EX-99.1 behind a Schedule 13D cover is not visible here: the
// candidate carries the filing index URL and `exhibitsEnumerated: false`,
// and the parsing milestone reads the index. And "relevance" below is a
// reading of the form and the filer's own one-line description, not of the
// document: it decides the order of a review list, nothing more.
//
// Pure functions, no network, tested in scripts/__tests__/letters.test.mjs.

export const RELEVANCE = ['high', 'medium', 'low'];

const LETTER_WORDS = /\b(letter|presentation|deck|investor|white ?paper|proposal|slides|remarks|statement)\b/i;
const RELEASE_WORDS = /\b(press release|announce|announcement|statement of|nominat)/i;

/** Where a filing's primary document and its index sit on sec.gov. */
export function filingUrls(cik, accession, primaryDocument) {
  const dir = `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession.replace(/-/g, '')}`;
  return {
    indexUrl: `${dir}/${accession}-index.htm`,
    documentUrl: primaryDocument ? `${dir}/${primaryDocument}` : null,
  };
}

/** html, pdf, text or unknown, from the primary document's name. */
export function formatOf(primaryDocument) {
  const m = /\.([a-z0-9]+)$/i.exec(primaryDocument || '');
  const ext = (m?.[1] || '').toLowerCase();
  if (ext === 'htm' || ext === 'html' || ext === 'xml') return 'html';
  if (ext === 'pdf') return 'pdf';
  if (ext === 'txt') return 'text';
  return 'unknown';
}

/**
 * How likely a filing is to carry a thesis, from its form and description.
 * A shareholder report always carries the manager's letter. A DFAN14A is a
 * letter or a deck when the filer says so and a press release otherwise. A
 * Schedule 13D states a purpose in Item 4 and may attach a letter; its
 * amendments usually record a change in holding and nothing else.
 */
export function relevanceOf(form, description) {
  const d = description || '';
  if (/^N-CSR/.test(form)) return 'high';
  if (form === 'DFAN14A' || form === 'PX14A6G') {
    if (LETTER_WORDS.test(d) && !RELEASE_WORDS.test(d)) return 'high';
    return 'medium';
  }
  if (form === 'DEFC14A' || form === 'PREC14A') return 'medium';
  if (form === 'SC 13D') return 'medium';
  if (form === 'SC 13D/A') return LETTER_WORDS.test(d) ? 'medium' : 'low';
  return 'low';
}

/** The filer EDGAR says this index belongs to is the filer we meant. */
export function entityMatches(submissions, expectedName) {
  const name = String(submissions?.name || '').toUpperCase();
  return name.includes(String(expectedName || '').toUpperCase());
}

/**
 * The filings in the window, on the wanted forms, as candidates.
 *
 * `recentTruncated` is set when EDGAR's `recent` block does not reach back to
 * the start of the window and older filings sit in a further file. That file
 * is a second request, so it is reported rather than read.
 */
export function selectCandidates(submissions, source, { now = new Date(), windowMonths = 24 } = {}) {
  const r = submissions?.filings?.recent || {};
  const forms = r.form || [];
  const wanted = new Set(source.forms || []);
  const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - windowMonths, now.getUTCDate()));
  const sinceIso = since.toISOString().slice(0, 10);

  const candidates = [];
  const seen = new Set();
  let oldestSeen = null;
  for (let i = 0; i < forms.length; i += 1) {
    const filed = r.filingDate?.[i] || '';
    if (!oldestSeen || filed < oldestSeen) oldestSeen = filed;
    if (!wanted.has(forms[i]) || filed < sinceIso) continue;
    const accession = r.accessionNumber?.[i];
    if (!accession || seen.has(accession)) continue; // an index can repeat a filing; one accession is one filing
    seen.add(accession);
    const primaryDocument = r.primaryDocument?.[i] || null;
    const description = r.primaryDocDescription?.[i] || null;
    const { indexUrl, documentUrl } = filingUrls(source.cik, accession, primaryDocument);
    // A solicitation or a Schedule 13D is stored under the SUBJECT company's
    // CIK folder, which the submissions index does not name, so a document
    // path built from the filer's CIK is a guess and is not written. The
    // filing index page names the folder; enumeration reads it from there.
    const inferable = source.sourceType !== 'sec_exhibit';
    candidates.push({
      fund: source.fund,
      sourceId: source.id,
      form: forms[i],
      accession,
      filingDate: filed,
      reportDate: r.reportDate?.[i] || null,
      title: description || `${forms[i]} filed ${filed}`,
      primaryDocument,
      documentUrl: inferable ? documentUrl : null,
      documentUrlNote: inferable ? null : 'not inferable from the filer CIK; the filing index names the folder',
      indexUrl,
      format: formatOf(primaryDocument),
      exhibitsEnumerated: false,
      retrievalMode: source.retrievalMode,
      rightsJudgement: source.rightsJudgement,
      duplicateKey: accession,
      contentHash: null,
      relevance: relevanceOf(forms[i], description),
    });
  }
  const moreFiles = Array.isArray(submissions?.filings?.files) && submissions.filings.files.length > 0;
  const recentTruncated = moreFiles && !!oldestSeen && oldestSeen > sinceIso;
  return { candidates, recentTruncated, since: sinceIso, inWindow: candidates.length };
}

/**
 * At most `cap` candidates across funds, taken a round at a time so one
 * prolific filer cannot crowd the others out. Within a fund the order is
 * relevance first, then a round across filing months, newest month first:
 * an activist files a dozen DFAN14As in the fortnight before a vote, and a
 * list that took the newest twelve would be one campaign twelve times over.
 */
export function orderWithinFund(list) {
  const rank = (c) => RELEVANCE.indexOf(c.relevance);
  const byMonth = new Map();
  for (const c of [...list].sort((a, b) => rank(a) - rank(b) || b.filingDate.localeCompare(a.filingDate))) {
    const key = `${c.relevance}:${c.filingDate.slice(0, 7)}`;
    if (!byMonth.has(key)) byMonth.set(key, []);
    byMonth.get(key).push(c);
  }
  const out = [];
  for (const level of RELEVANCE) {
    const months = Array.from(byMonth.entries()).filter(([k]) => k.startsWith(`${level}:`)).map(([, v]) => v);
    let took = true;
    while (took) {
      took = false;
      for (const m of months) {
        const next = m.shift();
        if (next) {
          out.push(next);
          took = true;
        }
      }
    }
  }
  return out;
}

export function capAcrossFunds(byFund, cap) {
  const queues = Object.entries(byFund).map(([fund, list]) => ({ fund, list: orderWithinFund(list) }));
  const out = [];
  let took = true;
  while (out.length < cap && took) {
    took = false;
    for (const q of queues) {
      if (out.length >= cap) break;
      const next = q.list.shift();
      if (next) {
        out.push(next);
        took = true;
      }
    }
  }
  return out;
}

/** The registry rows that may be fetched, and the reason any may not. */
export function activeSources(registry) {
  const problems = [];
  const active = [];
  for (const s of registry.sources || []) {
    if (s.status !== 'active') continue;
    if (s.retrievalMode !== 'automated_sec') problems.push(`${s.id}: retrievalMode ${s.retrievalMode} is not automated_sec`);
    else if (s.rightsJudgement !== 'sec_public_record') problems.push(`${s.id}: rightsJudgement ${s.rightsJudgement} is not sec_public_record`);
    else if (!/^\d{10}$/.test(s.cik || '')) problems.push(`${s.id}: cik must be ten digits`);
    else if (!s.expectedName) problems.push(`${s.id}: expectedName is required`);
    else active.push(s);
  }
  return { active, problems };
}

// ── Exhibit enumeration: the filing index page ──────────────────────────────
//
// A filing's index page on sec.gov lists every document in the submission
// with the type the filer declared, a description, the filename and the
// size, and above the table names the filer and, for a solicitation or a
// Schedule 13D, the subject company with its CIK. That page is the only
// thing the enumeration reads: one request per filing, no exhibit opened.

/** Text without tags or entities, for a page that is data, never code. */
function plain(html) {
  return String(html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The filing index page, read for its document table, its period of report,
 * and the companies named above the table with their roles.
 */
export function parseFilingIndex(html) {
  const docs = [];
  const tables = String(html || '').match(/<table[^>]*class="tableFile"[^>]*>[\s\S]*?<\/table>/gi) || [];
  for (const table of tables) {
    const rows = table.match(/<tr[\s\S]*?<\/tr>/gi) || [];
    for (const row of rows) {
      const cells = (row.match(/<td[\s\S]*?<\/td>/gi) || []).map((c) => c);
      if (cells.length < 5) continue;
      const href = cells[2].match(/href="([^"]+)"/i)?.[1] || null;
      const anchor = cells[2].match(/<a[^>]*>([\s\S]*?)<\/a>/i)?.[1];
      const filename = plain(anchor || '') || (href ? href.split('/').pop() : '');
      docs.push({
        seq: plain(cells[0]),
        description: plain(cells[1]),
        filename,
        href,
        inline: /ix\?doc=/i.test(href || ''),
        type: plain(cells[3]),
        size: Number(plain(cells[4]).replace(/\D/g, '')) || null,
      });
    }
  }
  const companies = [];
  const spans = String(html || '').match(/<span class="companyName">[\s\S]*?<\/span>/gi) || [];
  for (const span of spans) {
    const text = plain(span);
    const role = /\(Subject\)/i.test(text) ? 'subject' : /\(Filed by\)|\(Filer\)/i.test(text) ? 'filer' : 'other';
    const name = text.replace(/\((Subject|Filed by|Filer)\)[\s\S]*$/i, '').trim();
    const cik = span.match(/CIK=(\d{10})/i)?.[1] || span.match(/(\d{10})\s*\(see all company filings\)/i)?.[1] || null;
    companies.push({ name, role, cik });
  }
  const info = (label) => {
    const m = String(html || '').match(new RegExp(`<div class="infoHead">\\s*${label}\\s*</div>\\s*<div class="info">([^<]*)</div>`, 'i'));
    return m ? plain(m[1]) : null;
  };
  return {
    documents: docs,
    companies,
    subject: companies.find((c) => c.role === 'subject') || null,
    filer: companies.find((c) => c.role === 'filer') || null,
    periodOfReport: info('Period of Report'),
    filingDate: info('Filing Date'),
    acceptedAt: info('Accepted'),
  };
}

const CONTENT_RULES = [
  ['routine', /^(GRAPHIC|XML|ZIP|JSON|EXCEL|EX-101|EX-FILING FEES|EX-99\.CERT|EX-99\.906|EX-99\.CODE|COVER)/i, 'type'],
  ['routine', /^complete submission text file$/i, 'description'],
  ['routine', /\b(cover letter|filing fee|certification|code of ethics|graphic|xbrl|power of attorney|joint filing|form of proxy card|proxy card)\b/i, 'description'],
  ['letter', /\b(letter|memo|memorandum|open letter|remarks|statement of|comment)\b/i, 'description'],
  ['presentation', /\b(presentation|deck|slides|investor day|white ?paper)\b/i, 'description'],
  ['press_release', /\b(press release|announce|announcement|release)\b/i, 'description'],
  ['proxy_material', /\b(proxy statement|preliminary proxy|definitive proxy|solicitation|fight letter|proxy)\b/i, 'description'],
  ['shareholder_report', /\b(annual report|semi-?annual report|shareholder report|n-csr)\b/i, 'description'],
];

/**
 * What a listed document most likely is, from its declared type and
 * description alone. A blank description on a DFAN14A or SC 13D primary
 * document stays 'unclassified'; nothing is read off a filename, which is a
 * law firm's matter number and a date, not a title.
 */
export function classifyDocument(doc, form, { siblings = [] } = {}) {
  const type = doc.type || '';
  const desc = doc.description || '';
  for (const [kind, re, field] of CONTENT_RULES) {
    if (re.test(field === 'type' ? type : desc)) return kind;
  }
  if (/^N-CSR/.test(form)) return /^N-CSR/.test(type) ? 'shareholder_report' : 'routine';
  if (/^(DEFC14A|PREC14A)$/.test(type)) return 'proxy_material';
  if (/^SC 13D/.test(type)) return 'schedule_13d';
  // A DFAN14A's primary document is a cover legend when an exhibit carries
  // the content, and is the content itself when it is the only document.
  if (type === 'DFAN14A' && doc.seq === '1' && !desc) {
    const others = siblings.filter((d) => d !== doc && d.seq && d.seq !== '1' && !/^GRAPHIC/i.test(d.type || ''));
    return others.length ? 'solicitation_cover' : 'unclassified';
  }
  return 'unclassified';
}

/** A reading of an unlabelled exhibit's size, stated as a hint and nothing more. */
export function sizeHint(doc) {
  if (!doc.size) return null;
  if (/\.pdf$/i.test(doc.filename || '') && doc.size >= 2_000_000) return 'a PDF this large is usually a presentation';
  if (/\.pdf$/i.test(doc.filename || '')) return 'a PDF this size is usually a letter';
  if (doc.size < 60_000) return 'a short HTML document: a letter, a release or a cover';
  return null;
}

export const CONTENT_RELEVANCE = {
  letter: 'high',
  presentation: 'high',
  shareholder_report: 'high',
  unclassified: 'review',
  proxy_material: 'medium',
  schedule_13d: 'medium',
  press_release: 'medium',
  solicitation_cover: 'low',
  routine: 'none',
};

const RECOMMEND_RANK = { high: 0, review: 1, medium: 2, low: 3, none: 4 };

/**
 * Two documents per fund. For an activist, from two different campaigns:
 * labelled letters and presentations first, then unlabelled exhibits the
 * reviewer must open, then schedules and covers, newest first within a
 * rank. For a registered fund, the newest report and then the earliest
 * inspected one, so the pair spans the longest period a change in language
 * could show across; both are always the manager's own report, so recency
 * and distance are the only things to trade. A fund with fewer than two
 * suitable documents is reported as short, never padded.
 */
export function recommendTen(rows, sourcesById) {
  const out = [];
  const byFund = {};
  for (const r of rows) (byFund[r.fund] ||= []).push(r);
  for (const [fund, list] of Object.entries(byFund)) {
    const isReport = sourcesById[list[0].sourceId]?.sourceType === 'sec_shareholder_report';
    const eligible = list
      .filter((r) => r.eligible !== 'no')
      .sort((a, b) => RECOMMEND_RANK[a.thesisRelevance] - RECOMMEND_RANK[b.thesisRelevance] || b.filingDate.localeCompare(a.filingDate));
    const seen = new Set();
    const picks = [];
    const order = isReport && eligible.length > 1 ? [eligible[0], ...[...eligible.slice(1)].sort((a, b) => (a.reportingPeriod || '').localeCompare(b.reportingPeriod || ''))] : eligible;
    for (const r of order) {
      const key = isReport ? r.reportingPeriod : r.campaign;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      picks.push(r);
      if (picks.length === 2) break;
    }
    if (isReport) picks.sort((a, b) => a.filingDate.localeCompare(b.filingDate));
    out.push({ fund, picks, shortfall: picks.length < 2 ? `only ${picks.length} suitable ${isReport ? 'reporting period' : 'campaign'}(s) among the inspected indexes` : null });
  }
  return out;
}

/**
 * A campaign key for an activist filing. The filer agent's filename carries
 * a matter number shared by every filing in one engagement; where the name
 * has none, filings within 45 days of each other share a key. The key groups
 * filings; it never names the subject, which the index page states.
 */
export function campaignKey(candidate) {
  const m = /^(?:dfan14a|defc14a|prec14a|sc13da?\d*|px14a6g)(\d{8})/i.exec(candidate.primaryDocument || '');
  if (m) return `matter:${m[1]}`;
  return `date:${candidate.filingDate.slice(0, 7)}`;
}

const ACTIVIST_PREFERENCE = ['DFAN14A', 'DEFC14A', 'PREC14A', 'PX14A6G', 'SC 13D', 'SC 13D/A'];

/**
 * Filings grouped into campaigns. A matter-numbered filename is the key
 * where there is one; a filing whose name carries none (a different law
 * firm filed it) joins the matter campaign whose dates surround it, within
 * 45 days, and otherwise groups with its own month.
 */
export function groupCampaigns(list) {
  const groups = new Map();
  for (const c of list) {
    const k = campaignKey(c);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(c);
  }
  const span = (cs) => {
    const dates = cs.map((c) => Date.parse(c.filingDate));
    return { min: Math.min(...dates) - 45 * 86_400_000, max: Math.max(...dates) + 45 * 86_400_000 };
  };
  const matters = Array.from(groups.entries()).filter(([k]) => k.startsWith('matter:'));
  for (const [k, cs] of Array.from(groups.entries())) {
    if (!k.startsWith('date:')) continue;
    const home = matters.find(([, ms]) => {
      const { min, max } = span(ms);
      return cs.every((c) => Date.parse(c.filingDate) >= min && Date.parse(c.filingDate) <= max);
    });
    if (home) {
      home[1].push(...cs);
      groups.delete(k);
    }
  }
  return Array.from(groups.entries())
    .map(([key, cs]) => ({ key, filings: cs.sort((a, b) => a.filingDate.localeCompare(b.filingDate)) }))
    .sort((a, b) => (b.filings.length >= 2) - (a.filings.length >= 2) || b.filings.at(-1).filingDate.localeCompare(a.filings.at(-1).filingDate));
}


/**
 * Which filing indexes to read for each fund, inside a request budget.
 *
 * Activists: one per campaign, engagements with several filings before
 * one-off filings and newer before older, taking the campaign's first
 * DFAN14A (the document that opens an engagement is the letter or the deck;
 * the last is usually a press release about the vote), else the best form
 * available; then, budget allowing, a second document from the largest
 * campaign: the DFAN14A a different filer agent lodged, if there is one,
 * else the last. Registered funds: the two most recent annual reports, a
 * year apart, then the newest semi-annual.
 */
export function planIndexes(byFund, sourcesById, perFund) {
  const plan = [];
  for (const [fund, list] of Object.entries(byFund)) {
    const source = sourcesById[list[0]?.sourceId] || {};
    const picks = [];
    if (source.sourceType === 'sec_shareholder_report') {
      const annual = list.filter((c) => c.form === 'N-CSR').sort((a, b) => b.filingDate.localeCompare(a.filingDate));
      const semi = list.filter((c) => c.form === 'N-CSRS').sort((a, b) => b.filingDate.localeCompare(a.filingDate));
      for (const c of [...annual.slice(0, 2), ...semi.slice(0, 1), ...annual.slice(2), ...semi.slice(1)]) {
        if (picks.length < perFund) picks.push({ ...c, why: c.form === 'N-CSR' ? 'annual report' : 'newest semi-annual report' });
      }
    } else {
      const campaigns = groupCampaigns(list);
      for (const camp of campaigns) {
        if (picks.length >= perFund) break;
        const best = ACTIVIST_PREFERENCE.map((f) => camp.filings.find((c) => c.form === f)).find(Boolean);
        if (best) picks.push({ ...best, campaign: camp.key, why: `first ${best.form} of campaign ${camp.key} (${camp.filings.length} filings)` });
      }
      const largest = [...campaigns].sort((a, b) => b.filings.length - a.filings.length)[0];
      if (largest && picks.length < perFund) {
        const taken = (c) => picks.some((p) => p.accession === c.accession);
        const other = largest.filings.find((c) => c.form === 'DFAN14A' && !taken(c) && campaignKey(c) !== largest.key);
        const last = [...largest.filings].reverse().find((c) => c.form === 'DFAN14A' && !taken(c));
        const pick = other || last;
        if (pick) picks.push({ ...pick, campaign: largest.key, why: other ? `a DFAN14A another filer agent lodged in the largest campaign ${largest.key}` : `last DFAN14A of the largest campaign ${largest.key}` });
      }
    }
    for (const p of picks) plan.push({ fund, ...p });
  }
  return plan;
}

// ── URLs EDGAR states, request gating, size caps ────────────────────────────

/** The absolute sec.gov URL of a document link as the index page printed it, inline viewer prefix removed. */
export function documentUrlFrom(href) {
  if (!href) return null;
  const path = href.replace(/^\/ix\?doc=/i, '');
  return new URL(path, 'https://www.sec.gov/').toString();
}

/**
 * The index URL under the folder EDGAR itself uses for the filing, read
 * from the document links on the page: for a solicitation that is the
 * subject company's CIK, not the filer's. Null when the page has no links.
 */
export function authoritativeIndexUrl(documents, accession) {
  const href = (documents || []).map((d) => d.href).find((h) => h && /\/Archives\/edgar\/data\/\d+\//i.test(h));
  if (!href) return null;
  const m = /\/Archives\/edgar\/data\/(\d+)\/(\d{18})\//i.exec(href);
  if (!m) return null;
  return `https://www.sec.gov/Archives/edgar/data/${m[1]}/${m[2]}/${accession}-index.htm`;
}

/**
 * Whether one more network request may be made. A cache-only run may make
 * none; otherwise the cap counts every attempt already made, a retried
 * failure included.
 */
export function fetchGate({ cacheOnly = false, attemptsMade = 0, cap = 0, what = 'request' } = {}) {
  if (cacheOnly) return { allowed: false, reason: `cache-only run; ${what} not in the cache` };
  if (attemptsMade >= cap) return { allowed: false, reason: `${cap} ${what}s already attempted (a retried failure counts twice)` };
  return { allowed: true, reason: null };
}

/** The bytes a Phase 0 fetch may not exceed, and whether a listed document is over it. */
export const FETCH_CAP_BYTES = 15 * 1024 * 1024;
export function overFetchCap(size, cap = FETCH_CAP_BYTES) {
  return typeof size === 'number' && size > cap;
}
