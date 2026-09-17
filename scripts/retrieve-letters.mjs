#!/usr/bin/env node
// Letters research: retrieval and deterministic parsing of the approved set.
//
// Fetches the nine documents Suro approved, once each, and turns each into
// page-aware or section-aware text on the encrypted archive. It runs no
// model, no optical character recognition and no network request beyond the
// nine: everything it produces is a mechanical transformation of bytes the
// SEC published, and every one of those bytes stays out of git.
//
// Nothing happens until the archive checks out. LETTERS_ARCHIVE_ROOT must
// name an existing directory, outside this repository, not on scratch space,
// on a volume confirmed as encrypted. Any failure prints which condition
// failed and stops before a single request.
//
//   node scripts/retrieve-letters.mjs --dry-run   # preconditions and the plan; fetches nothing
//   node scripts/retrieve-letters.mjs             # retrieve, parse and write the archive
//   node scripts/retrieve-letters.mjs --forget-originals   # keep the text, drop the originals
//
// Re-running is cheap and safe: a document already in the manifest with a
// verified hash and a good extraction is skipped without a request.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ARCHIVE_ENV, archivePaths, resolveArchive } from '../lib/letters-archive.mjs';
import { CAP_BYTES, FetchRefusal, fetchDocument } from '../lib/letters-fetch.mjs';
import { extractSections, PARSER as HTML_PARSER, PARSER_VERSION as HTML_VERSION } from '../lib/letters-html.mjs';
import { parsePdf } from '../lib/letters-pdf.mjs';
import { assess } from '../lib/letters-quality.mjs';
import { alreadyRetrieved, emptyManifest, validateRow, writeManifestAtomic } from '../lib/letters-manifest.mjs';
import { appendLedger } from '../lib/letters-ledger.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SELECTION = join(ROOT, 'data', 'letters.selection.json');
const UA = process.env.SEC_USER_AGENT || 'L3VLUP Research (contact: suro@l3vlup.com)';
const DRY = process.argv.includes('--dry-run');
const FORGET = process.argv.includes('--forget-originals');
const GAP_MS = 1500;
const MAX_DOCUMENTS = 9;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (buf) => createHash('sha256').update(buf).digest('hex');

function plan() {
  const sel = JSON.parse(readFileSync(SELECTION, 'utf8'));
  return sel.selection.map((s) => ({
    manager: s.fund,
    subjectOrPeriod: s.subjectCompany || s.reportingPeriodOrCampaign,
    filingDate: s.filingDate,
    form: s.form,
    accession: s.accession,
    filingIndexUrl: s.filingIndexUrl,
    documentUrl: s.documentUrl,
    filename: s.filename,
    format: s.mimeType.includes('pdf') ? 'pdf' : 'html',
    expectedBytes: s.bytes,
    rightsJudgement: 'SEC public record; excerpt-only display with a link to sec.gov',
    sourceClassification: s.form.startsWith('N-CSR') ? 'sec_shareholder_report' : 'sec_exhibit',
  }));
}

async function parseDocument(format, path, buf) {
  if (format === 'pdf') {
    const out = await parsePdf(path);
    return { ...out, items: (out.pages || []).map((p) => ({ index: p.page, tag: 'page', text: p.text, chars: p.chars })) };
  }
  const out = extractSections(buf.toString('utf8'));
  return { ...out, status: out.sections.length ? 'ok' : 'failed', parser: HTML_PARSER, parserVersion: HTML_VERSION, items: out.sections };
}

async function main() {
  const documents = plan();
  if (documents.length > MAX_DOCUMENTS) throw new Error(`the plan holds ${documents.length} documents, over the ${MAX_DOCUMENTS} approved`);

  const archive = resolveArchive({ repoRoot: ROOT });
  console.log(`archive precondition: ${archive.ok ? 'passed' : 'REFUSED'}`);
  for (const c of archive.checks) console.log(`  ${c.ok ? 'ok ' : 'no '} ${c.name}: ${c.detail}`);
  if (!archive.ok) {
    console.error(`\nRefusing to fetch anything. ${archive.refusal}`);
    console.error(`Set ${ARCHIVE_ENV} to a directory on the encrypted archive volume and run this on the machine that holds it.`);
    console.log(`\nThe plan, unchanged, is ${documents.length} documents:`);
    for (const d of documents) console.log(`  ${d.manager.padEnd(18)} ${d.filingDate} ${d.form.padEnd(8)} ${String(d.expectedBytes).padStart(9)} ${d.format.padEnd(4)} ${d.documentUrl}`);
    process.exit(3);
  }

  const paths = archivePaths(archive.root, '');
  for (const dir of ['originals', 'text', 'structured', 'review']) mkdirSync(join(archive.root, dir), { recursive: true });
  const manifestPath = paths.manifest;
  const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : emptyManifest();

  if (DRY) {
    console.log(`\nDry run: ${documents.length} documents planned, nothing fetched.`);
    for (const d of documents) console.log(`  ${d.manager.padEnd(18)} ${d.format.padEnd(4)} ${String(d.expectedBytes).padStart(9)} ${d.documentUrl}`);
    return;
  }

  const rows = [];
  let requests = 0;
  for (const d of documents) {
    const known = Object.values(manifest.documents).find((r) => r.documentUrl === d.documentUrl && r.extractionStatus === 'ok');
    if (known && alreadyRetrieved(manifest, known.sha256) && existsSync(archivePaths(archive.root, known.sha256).text)) {
      console.log(`skip  ${d.manager} ${d.filename}: already retrieved and parsed, hash ${known.sha256.slice(0, 12)}`);
      rows.push(known);
      continue;
    }
    if (requests) await sleep(GAP_MS);
    let got;
    try {
      requests += 1;
      got = await fetchDocument({
        url: d.documentUrl,
        expectedFormat: d.format,
        expectedBytes: d.expectedBytes,
        cap: CAP_BYTES,
        userAgent: UA,
        onAttempt: ({ url, status }) => appendLedger({ script: 'retrieve-letters', url, status, attempt: 0, purpose: 'approved document retrieval' }),
      });
    } catch (err) {
      const refusal = err instanceof FetchRefusal ? err : new FetchRefusal('error', err.message);
      console.error(`stop  ${d.manager} ${d.filename}: ${refusal.message}`);
      if (refusal.stopRun) { console.error('The SEC refused the request. Stopping without a retry.'); break; }
      rows.push({ ...d, documentId: null, sha256: null, extractionStatus: 'failed', warnings: [refusal.message], retrievedAt: new Date().toISOString(), httpStatus: null, contentType: null, actualBytes: null, parser: null, parserVersion: null, units: null, unitCount: 0, characterCount: 0, originalRetained: false });
      continue;
    }

    const hash = got.sha256;
    const p = archivePaths(archive.root, hash);
    writeFileSync(p.original, got.body);
    const parsed = await parseDocument(d.format, p.original, got.body);
    const quality = assess({ units: parsed.units, items: parsed.items, rawCharacters: got.bytes });
    const text = parsed.items.map((i) => i.text).join('\n\n');
    writeFileSync(p.text, text, 'utf8');
    writeFileSync(p.structured, `${JSON.stringify({
      documentId: hash,
      units: parsed.units,
      parser: parsed.parser,
      parserVersion: parsed.parserVersion,
      items: parsed.items.map((i) => ({ index: i.index, tag: i.tag, chars: i.chars, sha256: sha(i.text || ''), text: i.text })),
    }, null, 2)}\n`, 'utf8');
    if (FORGET) rmSync(p.original, { force: true });

    const row = {
      manager: d.manager,
      documentId: hash,
      subjectOrPeriod: d.subjectOrPeriod,
      filingDate: d.filingDate,
      form: d.form,
      accession: d.accession,
      filingIndexUrl: d.filingIndexUrl,
      documentUrl: d.documentUrl,
      retrievedAt: new Date().toISOString(),
      httpStatus: got.status,
      contentType: got.contentType,
      expectedBytes: d.expectedBytes,
      actualBytes: got.bytes,
      sha256: hash,
      parser: parsed.parser,
      parserVersion: parsed.parserVersion,
      extractionStatus: parsed.status,
      units: parsed.units,
      unitCount: parsed.items.length,
      characterCount: quality.normalisedCharacters,
      warnings: [...got.warnings, ...(parsed.warnings || []), ...quality.warnings],
      originalRetained: !FORGET,
      rightsJudgement: d.rightsJudgement,
      sourceClassification: d.sourceClassification,
    };
    const problems = validateRow(row);
    if (problems.length) row.warnings.push(`manifest row problems: ${problems.join('; ')}`);
    manifest.documents[hash] = row;
    rows.push(row);
    console.log(`${parsed.status === 'ok' ? 'ok   ' : 'FAIL '} ${d.manager.padEnd(18)} ${String(got.bytes).padStart(9)} bytes · ${parsed.items.length} ${parsed.units} · ${quality.normalisedCharacters} chars · ${row.warnings.length} warning(s)`);
  }

  writeManifestAtomic(manifestPath, manifest);

  // The review report holds short samples and lives only on the archive.
  const report = ['# Letters retrieval review', '', `Generated ${new Date().toISOString()}. Local only: this file lives on the encrypted archive and is never committed.`, ''];
  for (const r of rows) {
    report.push(`## ${r.manager} · ${r.subjectOrPeriod} · ${r.form} ${r.filingDate}`);
    report.push(`${r.extractionStatus} · ${r.unitCount} ${r.units} · ${r.characterCount} characters · ${r.actualBytes} bytes · ${r.sha256 ? r.sha256.slice(0, 16) : 'no hash'}`);
    if (r.warnings?.length) report.push(`warnings: ${r.warnings.join('; ')}`);
    const structured = r.sha256 ? archivePaths(archive.root, r.sha256).structured : null;
    if (structured && existsSync(structured)) {
      const items = JSON.parse(readFileSync(structured, 'utf8')).items.slice(0, 3);
      for (const i of items) report.push(`  - ${r.units.slice(0, -1)} ${i.index}: ${(i.text || '').slice(0, 300)}`);
    }
    report.push('');
  }
  writeFileSync(join(archive.root, 'review', 'report.md'), report.join('\n'), 'utf8');

  console.log(`\n${rows.filter((r) => r.extractionStatus === 'ok').length} of ${documents.length} parsed · ${requests} document request(s) · manifest ${manifestPath}`);
  console.log(`Review report written to ${join(archive.root, 'review', 'report.md')} (archive only, never committed).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
