#!/usr/bin/env node
// Letters research, Phase 0: the final document selection.
//
// Exactly two documents per fund, chosen by rule from the enumeration
// report (data/letters.exhibits.json) and written as metadata to
// data/letters.selection.{json,md}. Where the index page did not label a
// candidate, `--validate` reads just enough of that one document to say
// what it is: the title and opening markers of an HTML page, or the first
// 256 KB of a PDF for its page geometry and metadata. At most four such
// GETs, one per candidate, sequential, no automatic retry, stop on 403 or
// 429, the identifiable SEC user agent, every attempt in the ledger, and
// the response body kept in memory only: never written, never quoted.
//
//   node scripts/select-letters.mjs               # selection from the index metadata alone
//   node scripts/select-letters.mjs --dry-run     # also lists the GETs --validate would make; writes nothing
//   node scripts/select-letters.mjs --validate    # makes those GETs, then writes the selection

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyHtmlHead, classifyPdfHead, selectFinal } from '../lib/letters-select.mjs';
import { appendLedger, ledgerSummary } from '../lib/letters-ledger.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXHIBITS = join(ROOT, 'data', 'letters.exhibits.json');
const REGISTRY = join(ROOT, 'data', 'letters.sources.json');
const DECISIONS = join(ROOT, 'data', 'letters.decisions.json');
const OUT_JSON = join(ROOT, 'data', 'letters.selection.json');
const OUT_MD = join(ROOT, 'data', 'letters.selection.md');
// Validation results persist here, keyed by document URL, so a re-run reuses
// them and never repeats a GET. Metadata only: status, type, title, class.
const VALIDATIONS = join(ROOT, 'data', 'letters.validations.json');

const UA = process.env.SEC_USER_AGENT || 'L3VLUP Research (contact: suro@l3vlup.com)';
const DRY = process.argv.includes('--dry-run');
const VALIDATE = process.argv.includes('--validate');
const MAX_VALIDATION_GETS = 4;
const PDF_HEAD_BYTES = 262_144;
const GAP_MS = 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const attempts = [];

/** One GET, no retry, body read only as far as classification needs and then dropped. */
async function validateOne(row) {
  await sleep(GAP_MS);
  const isPdf = row.format === 'pdf';
  const headers = { 'User-Agent': UA, Accept: isPdf ? 'application/pdf' : 'text/html' };
  if (isPdf) headers.Range = `bytes=0-${PDF_HEAD_BYTES - 1}`;
  const res = await fetch(row.documentUrl, { headers });
  const entry = { script: 'select-letters', url: row.documentUrl, status: res.status, attempt: 0, purpose: 'validation head read' };
  attempts.push(entry);
  appendLedger(entry);
  if (res.status === 403 || res.status === 429) throw new Error(`STOP: HTTP ${res.status} from ${row.documentUrl}`);
  if (!res.ok && res.status !== 206) return { status: res.status, classification: 'unavailable', evidence: `HTTP ${res.status}` };
  const contentType = res.headers.get('content-type') || null;
  const contentLength = Number(res.headers.get('content-length')) || null;
  let result;
  if (isPdf) {
    // Read at most the head, whether the server honoured the range or not.
    const reader = res.body.getReader();
    const chunks = [];
    let got = 0;
    while (got < PDF_HEAD_BYTES) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.length;
    }
    await reader.cancel().catch(() => {});
    result = classifyPdfHead(Buffer.concat(chunks).subarray(0, PDF_HEAD_BYTES));
    result.rangeHonoured = res.status === 206;
  } else {
    result = classifyHtmlHead(await res.text());
  }
  return { status: res.status, contentType, contentLength, ...result };
}

function mime(row) {
  return row.validation?.contentType || { pdf: 'application/pdf', html: 'text/html', inline_html: 'text/html (inline XBRL)', text: 'text/plain' }[row.format] || 'unknown';
}

let report_capBytes = 15 * 1024 * 1024;
function rowOut(fund, g, sourcesById, notInspected) {
  const r = g.best;
  const alt = g.alternatives[0] || null;
  const why = r.likelyContent === 'shareholder_report'
    ? `the registrant's ${r.form} for the period ending ${r.reportingPeriod}: the primary document carries the manager's letter to shareholders`
    : r.likelyContent === 'letter' || r.likelyContent === 'presentation'
      ? `the index labels it "${r.exhibitDescription}"${r.subjectCompany ? ` on ${r.subjectCompany}` : ''}`
      : r.validation
        ? `unlabelled on the index; validation read its head: ${r.validation.classification}, ${r.validation.confidence}${r.validation.title ? `, titled "${r.validation.title}"` : ''} (${r.validation.evidence || 'no marker'})`
        : 'unlabelled on the index and not validated';
  return {
    fund,
    filingDate: r.filingDate,
    reportingPeriodOrCampaign: r.reportingPeriod || r.campaign,
    subjectCompany: r.subjectCompany || null,
    form: r.form,
    accession: r.accession,
    filingIndexUrl: r.indexUrl,
    documentUrl: r.documentUrl,
    filename: r.filename,
    mimeType: mime(r),
    bytes: r.size,
    capHeadroomBytes: report_capBytes - r.size,
    nearCap: report_capBytes - r.size < report_capBytes * 0.1,
    labelledDescription: r.exhibitDescription || null,
    validationMethod: r.validation
      ? `${r.format === 'pdf' ? `first ${r.validation.bytesInspected} bytes of the PDF, page geometry and metadata` : 'whole page, title and opening markers'} (HTTP ${r.validation.status}${r.validation.rangeHonoured ? ', range honoured' : ''})`
      : 'filing index description only; no document was read',
    managerAuthoredThesisMaterial: r.likelyContent === 'shareholder_report'
      ? 'yes: the manager\'s letter to shareholders is inside the report'
      : r.likelyContent === 'letter' || r.validation?.classification === 'letter'
        ? 'yes: a letter written by the manager'
        : r.likelyContent === 'presentation' || r.validation?.classification === 'presentation'
          ? 'yes: the manager\'s own presentation'
          : 'not established',
    why,
    campaignId: r.campaign || null,
    eligibility: g.exception ? 'exception' : 'yes',
    exceptionRequired: g.exception,
    alternativeCandidate: alt ? `${alt.filingDate} ${alt.form} ${alt.filename} (${(alt.size / 1048576).toFixed(1)} MB, ${alt.likelyContent})` : notInspected(fund, r.campaign) || 'none among the inspected indexes',
    validation: r.validation || null,
  };
}

let notInspectedFor = () => null;
function markdown(report) {
  const l = [
    '# Letters Phase 0: final document selection',
    '',
    `Generated ${report.generatedAt}. ${report.validationGets} validation GET(s) made this run (cap ${MAX_VALIDATION_GETS}); bodies were not stored. No document was fetched for parsing.`,
    '',
    `Fetch cap: ${report.limits.fetchCapBytes} bytes (15 MiB), the threshold as it has been applied since the Phase 0 plan. Nothing above it is eligible, so no row below carries a size exception. Headroom is printed per row; a row marked near the cap is within 10% of it, and one of them is above 15,000,000 decimal bytes while below 15 MiB, so the binary reading is doing real work there.`,
    '',
    `Network attempts on the ledger: ${report.ledger.observed} observed (written as they happened) and ${report.ledger.reconstructed} reconstructed after the fact from run output, never added together as one figure.`,
    '',
  ];
  l.push('| Fund | Subject / period | Campaign | Filed | Form | Accession | Index | Document | Filename | Type | Bytes | Headroom | Index description | Validation | Why it qualifies | Manager-authored thesis material | Eligibility |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of report.selection) l.push(`| ${r.fund} | ${r.subjectCompany || r.reportingPeriodOrCampaign} | ${r.campaignId || 'n.a.'} | ${r.filingDate} | ${r.form} | ${r.accession} | [index](${r.filingIndexUrl}) | [doc](${r.documentUrl}) | ${r.filename} | ${r.mimeType} | ${r.bytes} | ${r.capHeadroomBytes}${r.nearCap ? ' (near cap)' : ''} | ${r.labelledDescription || 'none'} | ${r.validationMethod} | ${r.why} | ${r.managerAuthoredThesisMaterial} | ${r.eligibility} |`);
  l.push('', '## Refused by decision', '');
  for (const d of report.decisions.refused) l.push(`- ${d.filename} (${d.accession}): ${d.reason}`);
  l.push('', '## Shortfalls', '');
  for (const f of report.funds) if (f.shortfall) l.push(`- **${f.fund}**: ${f.shortfall}. ${f.remedy || notInspectedFor(f.fund) || 'no further candidate listed'}`);
  if (!report.funds.some((f) => f.shortfall)) l.push('- none: ten documents, two per fund, every one under the cap.');
  l.push('', '## Validation reads on file', '');
  for (const v of report.validationsOnFile) l.push(`- ${v.fund} ${v.filename}: ${v.at}, HTTP ${v.status}, ${v.contentType || ''}, ${v.classification} (${v.confidence})${v.title ? `, title "${v.title}"` : ''}; ${v.evidence || ''}`);
  if (!report.validationsOnFile.length) l.push('- none');
  if (report.stopped) l.push('', `**Stopped:** ${report.stopped}`);
  return `${l.join('\n')}\n`;
}

async function main() {
  const exhibits = JSON.parse(readFileSync(EXHIBITS, 'utf8'));
  report_capBytes = exhibits.limits.fetchCapBytes;
  const registry = JSON.parse(readFileSync(REGISTRY, 'utf8'));
  const decisions = existsSync(DECISIONS) ? JSON.parse(readFileSync(DECISIONS, 'utf8')) : { approved: [], refused: [] };
  const sourcesById = Object.fromEntries(registry.sources.map((s) => [s.id, s]));
  const stored = existsSync(VALIDATIONS) ? JSON.parse(readFileSync(VALIDATIONS, 'utf8')) : { validations: {} };
  const shortlist = exhibits.shortlist.map((r) => ({ ...r, validation: stored.validations[r.documentUrl]?.result || null }));
  const inspectedAcc = new Set(exhibits.inspected.map((i) => i.accession));
  // An alternative for an activist pick comes from the same campaign; for a fund, another period; for a missing second campaign, another campaign.
  const notInspected = (fund, campaignKey) => {
    const camps = exhibits.campaigns?.[fund];
    if (camps) {
      const same = camps.find((c) => c.key === campaignKey);
      const pool = same ? same.filings.filter((f) => f.form === 'DFAN14A' && !inspectedAcc.has(f.accession)) : [];
      if (pool.length) return `same campaign, not inspected: ${pool.map((f) => `${f.filingDate} ${f.form} ${f.accession}`).slice(0, 3).join('; ')} (one index request each)`;
      const other = camps.filter((c) => c.key !== campaignKey && !c.filings.some((f) => inspectedAcc.has(f.accession)))[0];
      if (other) return `another campaign, not inspected: ${other.filings[0].filingDate} ${other.filings[0].form} ${other.filings[0].accession} (one index request)`;
    }
    const n = exhibits.notInspected.find((x) => x.fund === fund && /N-CSR/.test(x.form));
    return n ? `another period, not inspected: ${n.filingDate} ${n.form} ${n.accession} (one index request)` : null;
  };

  let funds = selectFinal(shortlist, sourcesById, decisions);
  const report = { decisions: { decidedAt: decisions.decidedAt, approved: decisions.approved?.length || 0, refused: decisions.refused || [] }, generatedAt: new Date().toISOString(), limits: { maxValidationGets: MAX_VALIDATION_GETS, pdfHeadBytes: PDF_HEAD_BYTES, fetchCapBytes: exhibits.limits.fetchCapBytes }, validationGets: 0, validations: [], funds: [], selection: [], stopped: null };

  const queue = () => funds.flatMap((f) => f.needsValidation.map((r) => ({ fund: f.fund, row: r })));
  if (DRY || VALIDATE) {
    console.log(`validation candidates: ${queue().map((q) => `${q.fund} ${q.row.filename} (${(q.row.size / 1048576).toFixed(2)} MB${q.row.overFetchCap ? ', over cap' : ''})`).join('; ') || 'none'}`);
  }
  if (VALIDATE) {
    let done = 0;
    for (let round = 0; round < 2 && done < MAX_VALIDATION_GETS; round += 1) {
      for (const q of queue()) {
        if (done >= MAX_VALIDATION_GETS) break;
        const target = shortlist.find((r) => r.accession === q.row.accession && r.filename === q.row.filename);
        if (target.validation) continue;
        try {
          target.validation = await validateOne(target);
        } catch (err) {
          report.stopped = err.message;
          break;
        }
        done += 1;
        stored.validations[target.documentUrl] = { fund: q.fund, filename: target.filename, at: new Date().toISOString(), result: target.validation };
        writeFileSync(VALIDATIONS, `${JSON.stringify({ note: 'Head reads of unlabelled candidates: metadata only, never the body. Reused on every run so no document is read twice.', validations: stored.validations }, null, 2)}\n`);
        report.validations.push({ fund: q.fund, filename: target.filename, documentUrl: target.documentUrl, result: target.validation });
        console.log(`validated ${q.fund} ${target.filename}: ${target.validation.classification}${target.validation.title ? ` "${target.validation.title}"` : ''}`);
      }
      if (report.stopped) break;
      funds = selectFinal(shortlist, sourcesById, decisions);
    }
    report.validationGets = done;
  }
  notInspectedFor = (fund) => notInspected(fund, null);
  report.funds = funds.map((f) => {
    // A group whose best document a head read left unsettled is the nearest thing to a second pick.
    const weak = f.groups.find((g) => g.best.validation?.confidence === 'weak' && !f.picks.some((p) => p.key === g.key));
    const remedy = f.shortfall && weak
      ? `Nearest candidate: ${weak.best.filename} (${weak.best.size} bytes, ${weak.best.subjectCompany || weak.best.reportingPeriod}, campaign ${weak.key}), which the head read left unsettled: ${weak.best.validation.evidence}. One deeper read of that same document would settle it.`
      : null;
    return { fund: f.fund, isReport: f.isReport, shortfall: f.shortfall, picks: f.picks.length, remedy, nextCandidate: f.shortfall ? notInspected(f.fund, null) : null };
  });
  report.ledger = ledgerSummary();
  report.validationsOnFile = Object.values(stored.validations).map((v) => ({ fund: v.fund, filename: v.filename, at: v.at, status: v.result.status, classification: v.result.classification, confidence: v.result.confidence, evidence: v.result.evidence, title: v.result.title, contentType: v.result.contentType }));
  report.selection = funds.flatMap((f) => f.picks.map((g) => rowOut(f.fund, g, sourcesById, notInspected)));
  console.log(`${report.selection.length} documents selected across ${funds.length} funds · ${report.validationGets} validation GET(s)`);
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
