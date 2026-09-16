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
  let oldestSeen = null;
  for (let i = 0; i < forms.length; i += 1) {
    const filed = r.filingDate?.[i] || '';
    if (!oldestSeen || filed < oldestSeen) oldestSeen = filed;
    if (!wanted.has(forms[i]) || filed < sinceIso) continue;
    const accession = r.accessionNumber?.[i];
    if (!accession) continue;
    const primaryDocument = r.primaryDocument?.[i] || null;
    const description = r.primaryDocDescription?.[i] || null;
    const { indexUrl, documentUrl } = filingUrls(source.cik, accession, primaryDocument);
    candidates.push({
      fund: source.fund,
      sourceId: source.id,
      form: forms[i],
      accession,
      filingDate: filed,
      reportDate: r.reportDate?.[i] || null,
      title: description || `${forms[i]} filed ${filed}`,
      primaryDocument,
      documentUrl,
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
