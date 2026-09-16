#!/usr/bin/env node
// Letters research, Phase 0: exhibit enumeration.
//
// The discovery run listed filings; this reads each chosen filing's index
// page on sec.gov and lists the documents inside it, so the ten-document
// test set can be chosen from real titles and subject companies rather than
// from form types. It opens no exhibit and no report: the index page is the
// only thing fetched, at most MAX_INDEX_REQUESTS of them across every fund,
// cached under .cache/letters so a re-run makes no request at all.
//
// Which indexes to read is decided by lib/letters.mjs planIndexes from the
// submissions already cached by discover-letters.mjs; this script makes no
// submissions request and refuses to run without that cache.
//
// Stops on any 403 or 429 (no retry), and retries once, after a pause, on a
// network error or a 5xx. The report is written as far as the run got.
//
//   node scripts/enumerate-letters.mjs               # writes data/letters.exhibits.{json,md}
//   node scripts/enumerate-letters.mjs --dry-run     # prints, writes nothing
//   node scripts/enumerate-letters.mjs --cache-only  # never touches the network; a planned index not in the cache is reported, not fetched

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONTENT_RELEVANCE,
  activeSources,
  authoritativeIndexUrl,
  classifyDocument,
  documentUrlFrom,
  entityMatches,
  fetchGate,
  overFetchCap,
  parseFilingIndex,
  planIndexes,
  recommendTen,
  selectCandidates,
  sizeHint,
} from '../lib/letters.mjs';
import { appendLedger } from '../lib/letters-ledger.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY = join(ROOT, 'data', 'letters.sources.json');
const OUT_JSON = join(ROOT, 'data', 'letters.exhibits.json');
const OUT_MD = join(ROOT, 'data', 'letters.exhibits.md');
const CACHE = join(ROOT, '.cache', 'letters');

const UA = process.env.SEC_USER_AGENT || 'L3VLUP Research (contact: suro@l3vlup.com)';
const DRY = process.argv.includes('--dry-run');
const CACHE_ONLY = process.argv.includes('--cache-only');
const MAX_INDEX_REQUESTS = 15;
const PER_FUND = 3;
const GAP_MS = 250;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastAt = 0;
const requests = [];

/** One polite request, one controlled retry on a transient failure, no retry on 403 or 429. */
async function secText(url) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const wait = Math.max(0, lastAt + GAP_MS - Date.now());
    if (wait > 0) await sleep(wait);
    lastAt = Date.now();
    let res;
    try {
      res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html' } });
    } catch (err) {
      requests.push({ url, status: 'network-error', attempt, at: new Date().toISOString() });
      appendLedger({ script: 'enumerate-letters', url, status: 'network-error', attempt });
      if (attempt === 1) throw new Error(`STOP: ${err.message} from ${url} after one retry`);
      await sleep(2000);
      continue;
    }
    requests.push({ url, status: res.status, attempt, at: new Date().toISOString() });
    appendLedger({ script: 'enumerate-letters', url, status: res.status, attempt });
    if (res.status === 403 || res.status === 429) throw new Error(`STOP: HTTP ${res.status} from ${url}`);
    if (res.status >= 500 && attempt === 0) {
      await sleep(2000);
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return res.text();
  }
  throw new Error(`gave up on ${url}`);
}

async function indexPage(accession, url) {
  mkdirSync(CACHE, { recursive: true });
  const path = join(CACHE, `index-${accession}.htm`);
  if (existsSync(path)) {
    requests.push({ url: `cache:${path}`, status: 'cached', at: new Date().toISOString() });
    return readFileSync(path, 'utf8');
  }
  const attemptsMade = requests.filter((r) => typeof r.status === 'number' || r.status === 'network-error').length;
  const gate = fetchGate({ cacheOnly: CACHE_ONLY, attemptsMade, cap: MAX_INDEX_REQUESTS, what: 'filing-index request' });
  if (!gate.allowed) throw new Error(`STOP: ${gate.reason} (${accession})`);
  const html = await secText(url);
  writeFileSync(path, html);
  return html;
}

function cachedSubmissions(cik) {
  const path = join(CACHE, `submissions-${cik}.json`);
  if (!existsSync(path)) throw new Error(`no cached submissions for CIK ${cik}; run discover-letters.mjs first`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

function markdown(report) {
  const l = [
    '# Letters exhibit enumeration (Phase 0)',
    '',
    `Generated ${report.generatedAt}. ${report.requestsMade} filing-index request(s) to sec.gov, ${report.cacheHits} from cache. No exhibit or report was opened.`,
    '',
    '## Shortlist',
    '',
    '| Fund | Filed | Form | Accession | Index | Campaign / period | Subject company | Exhibit type | Description | Filename | Document URL | Likely content | Relevance | Reason | Ambiguity | Eligible |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  ];
  const routine = report.shortlist.filter((r) => r.thesisRelevance === 'none');
  for (const r of report.shortlist) {
    if (r.thesisRelevance === 'none') continue;
    l.push(`| ${r.fund} | ${r.filingDate} | ${r.form} | ${r.accession} | [index](${r.indexUrl}) | ${r.campaign || r.reportingPeriod || ''} | ${r.subjectCompany || ''} | ${r.exhibitType} | ${(r.exhibitDescription || '').replace(/\|/g, '/')} | ${r.filename} | ${r.documentUrl ? `[doc](${r.documentUrl})` : ''} | ${r.likelyContent} | ${r.thesisRelevance} | ${r.reason} | ${r.limitation || ''} | ${r.eligible} |`);
  }
  const routineTypes = {};
  for (const r of routine) routineTypes[r.exhibitType] = (routineTypes[r.exhibitType] || 0) + 1;
  l.push('', `${routine.length} routine documents omitted from the table (in the JSON): ${Object.entries(routineTypes).map(([t, n]) => `${t} ${n}`).join(', ')}.`);
  l.push('', '## Recommended ten', '');
  for (const rec of report.recommended) {
    l.push(`- **${rec.fund}**${rec.shortfall ? ` (${rec.shortfall})` : ''}`);
    for (const p of rec.picks) l.push(`  - ${p.filingDate} ${p.form} ${p.subjectCompany ? `on ${p.subjectCompany} ` : ''}${p.reportingPeriod ? `period ${p.reportingPeriod} ` : ''}· ${p.likelyContent} · ${p.documentUrl || p.indexUrl}`);
  }
  l.push('', '## Not inspected (budget)', '');
  for (const n of report.notInspected) l.push(`- ${n.fund} ${n.filingDate} ${n.form} ${n.accession}: ${n.reason}`);
  if (report.stopped) l.push('', `**Stopped:** ${report.stopped}`);
  return `${l.join('\n')}\n`;
}

async function main() {
  const registry = JSON.parse(readFileSync(REGISTRY, 'utf8'));
  const { active, problems } = activeSources(registry);
  if (problems.length) {
    console.error('Refusing to run: the registry has a source that may not be fetched.');
    process.exit(1);
  }
  const sourcesById = Object.fromEntries(active.map((s) => [s.id, s]));
  const now = new Date();
  const byFund = {};
  for (const s of active) {
    const sub = cachedSubmissions(s.cik);
    if (!entityMatches(sub, s.expectedName)) throw new Error(`${s.id}: cached index names "${sub.name}", expected "${s.expectedName}"`);
    byFund[s.fund] = selectCandidates(sub, s, { now, windowMonths: registry.windowMonths || 24 }).candidates;
  }
  const plan = planIndexes(byFund, sourcesById, PER_FUND);
  if (plan.length > MAX_INDEX_REQUESTS) throw new Error(`plan has ${plan.length} indexes, over the ${MAX_INDEX_REQUESTS} cap`);
  console.log(`plan: ${plan.length} filing indexes (cap ${MAX_INDEX_REQUESTS}), ${PER_FUND} per fund`);

  const report = {
    generatedAt: now.toISOString(),
    limits: { maxIndexRequests: MAX_INDEX_REQUESTS, perFund: PER_FUND, retries: 1, fetchCapBytes: 15 * 1024 * 1024 },
    note: 'Index URLs are the folder EDGAR itself uses for the filing, read from the page. Every network attempt, including a failed one and its retry, is appended to data/letters.requests.jsonl; the requests array below is this run only.',
    requests,
    requestsMade: 0,
    cacheHits: 0,
    inspected: [],
    shortlist: [],
    recommended: [],
    notInspected: [],
    stopped: null,
  };
  const planned = new Set(plan.map((p) => p.accession));
  for (const [fund, list] of Object.entries(byFund)) {
    for (const c of list) {
      if (planned.has(c.accession)) continue;
      const isReport = sourcesById[c.sourceId]?.sourceType === 'sec_shareholder_report';
      if (isReport || c.form === 'DFAN14A' || c.form === 'DEFC14A') {
        report.notInspected.push({ fund, filingDate: c.filingDate, form: c.form, accession: c.accession, indexUrl: c.indexUrl, reason: isReport ? 'fourth report of four; the request cap allows three per fund' : 'same campaign as an inspected filing, or outside the three per fund' });
      }
    }
  }

  for (const p of plan) {
    let html;
    try {
      html = await indexPage(p.accession, p.indexUrl);
    } catch (err) {
      report.stopped = err.message;
      console.error(err.message);
      for (const rest of plan.slice(plan.indexOf(p))) {
        report.notInspected.push({ fund: rest.fund, filingDate: rest.filingDate, form: rest.form, accession: rest.accession, indexUrl: rest.indexUrl, reason: `planned but not read: ${err.message}` });
      }
      break;
    }
    const idx = parseFilingIndex(html);
    const isReport = sourcesById[p.sourceId]?.sourceType === 'sec_shareholder_report';
    const subject = idx.subject?.name || null;
    const indexUrl = authoritativeIndexUrl(idx.documents, p.accession) || p.indexUrl;
    const inspected = { fund: p.fund, form: p.form, accession: p.accession, filingDate: p.filingDate, requestedIndexUrl: p.indexUrl, indexUrl, why: p.why, campaign: p.campaign || null, periodOfReport: idx.periodOfReport, subjectCompany: subject, subjectCik: idx.subject?.cik || null, filer: idx.filer?.name || null, documents: idx.documents.length };
    report.inspected.push(inspected);
    console.log(`${p.fund} ${p.form} ${p.filingDate}: ${idx.documents.length} documents${subject ? ` · subject ${subject}` : ''}${idx.periodOfReport ? ` · period ${idx.periodOfReport}` : ''}`);
    for (const d of idx.documents) {
      const likely = classifyDocument(d, p.form, { siblings: idx.documents });
      const relevance = CONTENT_RELEVANCE[likely] || 'review';
      const isPrimary = d.seq === '1' || d.type === p.form;
      const format = d.inline ? 'inline_html' : /\.pdf$/i.test(d.filename) ? 'pdf' : /\.(htm|html)$/i.test(d.filename) ? 'html' : /\.txt$/i.test(d.filename) ? 'text' : 'other';
      const hint = likely === 'unclassified' ? sizeHint(d) : null;
      const reason = `${likely.replace(/_/g, ' ')} by declared type "${d.type}"${d.description ? ` and description "${d.description}"` : ', no description'}${hint ? `; ${hint}` : ''}`;
      let limitation = null;
      if (likely === 'unclassified') limitation = 'no description on the index; the document kind is unknown until opened';
      if (likely === 'solicitation_cover') limitation = 'the primary document is usually the cover legend; the exhibit carries the content';
      if (!subject && !isReport) limitation = (limitation ? `${limitation}; ` : '') + 'no subject company on the index page';
      const eligible = relevance === 'none' ? 'no' : relevance === 'review' ? 'review' : format === 'other' ? 'review' : 'yes';
      const overCap = overFetchCap(d.size);
      if (overCap) limitation = (limitation ? `${limitation}; ` : '') + 'over the 15 MB Phase 0 fetch cap; needs an explicit exception';
      report.shortlist.push({
        fund: p.fund, sourceId: p.sourceId, filingDate: p.filingDate, form: p.form, accession: p.accession, indexUrl,
        campaign: p.campaign || null, reportingPeriod: isReport ? idx.periodOfReport : null, subjectCompany: subject, subjectCik: idx.subject?.cik || null,
        exhibitType: d.type, exhibitDescription: d.description || null, filename: d.filename, seq: d.seq, size: d.size,
        documentUrl: documentUrlFrom(d.href),
        format, isPrimary, overFetchCap: overCap, likelyContent: likely, thesisRelevance: relevance, reason, limitation, eligible,
      });
    }
  }
  report.requestsMade = requests.filter((r) => typeof r.status === 'number' || r.status === 'network-error').length;
  report.cacheHits = requests.filter((r) => r.status === 'cached').length;
  report.recommended = recommendTen(report.shortlist, sourcesById);
  console.log(`${report.shortlist.length} documents listed from ${report.inspected.length} indexes · ${report.requestsMade} request(s), ${report.cacheHits} cached`);
  if (DRY) console.log(markdown(report));
  else {
    writeFileSync(OUT_JSON, `${JSON.stringify(report, null, 2)}\n`);
    writeFileSync(OUT_MD, markdown(report));
    console.log(`wrote ${OUT_JSON}\nwrote ${OUT_MD}`);
  }
  if (report.stopped) process.exit(2);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
