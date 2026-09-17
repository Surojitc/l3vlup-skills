#!/usr/bin/env node
// Letters research: retrieval and deterministic parsing of the approved set.
//
// The first-cut production path, and it is meant to run in the public
// collector: fetch the approved documents from sec.gov, parse them where
// they land, publish measurements, and delete everything else before the
// process ends. No model runs here, no optical character recognition, no
// taxonomy. What reaches git is provenance and quality, never a letter.
//
// Two modes.
//
//   --mode ephemeral-sec   (default) A directory made for this run and
//                          removed at the end of it. Only documents the
//                          approved selection names, only on sec.gov.
//                          Needs no archive, so it runs anywhere: a laptop
//                          today, a GitHub runner tomorrow.
//
//   --mode local-private   Optional and not part of Phase 0. Keeps originals
//                          and extracted text, so it keeps the archive gate:
//                          a verified encrypted volume or it refuses.
//
//   node scripts/retrieve-letters.mjs --dry-run
//   node scripts/retrieve-letters.mjs
//   node scripts/retrieve-letters.mjs --mode local-private
//
// Cleanup runs from a finally block, from the signal handlers a cancellation
// sends, and after a parser is killed. It cannot run if the machine itself
// is destroyed; on a hosted runner that is what discards the disk anyway.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CAP_BYTES, FetchRefusal, fetchDocument } from '../lib/letters-fetch.mjs';
import { extractSections, PARSER as HTML_PARSER, PARSER_VERSION as HTML_VERSION } from '../lib/letters-html.mjs';
import { parsePdf } from '../lib/letters-pdf.mjs';
import { assess } from '../lib/letters-quality.mjs';
import { emptyOutput, SCHEMA_VERSION, toPublicRecord, unchanged, validatePublicRecord } from '../lib/letters-output.mjs';
import { approvedDocument, DEFAULT_MODE, onExitCleanup, resolveWorkspace, withWorkspace } from '../lib/letters-workspace.mjs';
import { emptyManifest, validateRow, writeManifestAtomic } from '../lib/letters-manifest.mjs';
import { appendLedger } from '../lib/letters-ledger.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SELECTION = join(ROOT, 'data', 'letters.selection.json');
const OUT_JSON = join(ROOT, 'data', 'letters.parsed.json');
const OUT_MD = join(ROOT, 'data', 'letters.parsed.md');
const UA = process.env.SEC_USER_AGENT || 'L3VLUP Research (contact: suro@l3vlup.com)';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const MODE = arg('--mode', DEFAULT_MODE);
const DRY = process.argv.includes('--dry-run');
const GAP_MS = 1500;
const MAX_DOCUMENTS = 9;
const MAX_REQUESTS = 9;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function approvedSelection() {
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

function markdown(output, mode) {
  const l = [
    '# Letters: deterministic parsing results',
    '',
    `Generated ${output.generatedAt} in ${mode} mode. Schema version ${output.schemaVersion}.`,
    '',
    'Measurements only. No original bytes, no extracted text, no excerpt and no generated analysis: the documents stay on sec.gov, and this file records what was read and how well.',
    '',
    '| Manager | Subject or period | Filed | Form | Bytes | Parser | Status | Units | Characters | Empty | Repeated edge | Discussion | Warnings |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const d of output.documents) {
    const q = d.quality || {};
    l.push(`| ${d.manager} | ${d.subjectOrPeriod} | ${d.filingDate} | ${d.form} | ${d.sourceBytes} | ${d.parser} ${d.parserVersion} | ${d.extractionStatus} | ${d.unitCount} ${d.units} | ${d.characterCount} | ${q.emptyUnitRatio ?? ''} | ${q.repeatedEdgeRatio ?? ''} | ${q.managerDiscussionPresent ? 'yes' : 'no'} | ${(d.warnings || []).length} |`);
  }
  l.push('', '## Warnings', '');
  for (const d of output.documents) for (const w of d.warnings || []) l.push(`- ${d.manager} ${d.filingDate}: ${w}`);
  if (!output.documents.some((d) => (d.warnings || []).length)) l.push('- none');
  return `${l.join('\n')}\n`;
}

async function run(place, documents) {
  const previous = existsSync(OUT_JSON) ? JSON.parse(readFileSync(OUT_JSON, 'utf8')) : null;
  const work = place.mode === 'local-private' ? place.scratch : place.workspace;
  const keep = place.retainsBytes ? place.root : null;
  if (keep) for (const dir of ['originals', 'text', 'structured']) mkdirSync(join(keep, dir), { recursive: true });

  const records = [];
  // local-private keeps bytes, so it keeps a manifest of what it kept: the
  // public record cannot carry a path, and a private archive nobody can
  // inventory is not an archive.
  const privateManifest = keep
    ? (existsSync(join(keep, 'manifest.json')) ? JSON.parse(readFileSync(join(keep, 'manifest.json'), 'utf8')) : emptyManifest())
    : null;
  let requests = 0;
  for (const d of documents) {
    const check = approvedDocument(d.documentUrl, documents);
    if (!check.ok) { console.error(`skip  ${d.manager}: ${check.reason}`); continue; }
    if (requests >= MAX_REQUESTS) { console.error(`stop  the ${MAX_REQUESTS} request ceiling is reached`); break; }
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
        onAttempt: ({ url, status }) => appendLedger({ script: 'retrieve-letters', url, status, attempt: 0, purpose: `approved document retrieval (${place.mode})` }),
      });
    } catch (err) {
      const refusal = err instanceof FetchRefusal ? err : new FetchRefusal('error', err.message);
      console.error(`FAIL  ${d.manager} ${d.filename}: ${refusal.message}`);
      records.push(toPublicRecord({
        schemaVersion: SCHEMA_VERSION, manager: d.manager, documentId: null, subjectOrPeriod: d.subjectOrPeriod, filingDate: d.filingDate,
        form: d.form, accession: d.accession, filingIndexUrl: d.filingIndexUrl, documentUrl: d.documentUrl, sourceBytes: null, sha256: null,
        mimeType: null, parser: null, parserVersion: null, extractionStatus: 'failed', units: null, unitCount: 0, characterCount: 0,
        quality: null, warnings: [refusal.message.slice(0, 480)], processedAt: new Date().toISOString(),
      }));
      if (refusal.stopRun) { console.error('The SEC refused the request. Stopping without a retry.'); break; }
      continue;
    }

    const hash = got.sha256;
    const scratchFile = join(work.path, `${hash}.${d.format}`);
    writeFileSync(scratchFile, got.body);

    const prior = previous?.documents?.find((x) => x.documentUrl === d.documentUrl);
    const sameSource = prior && prior.sha256 === hash && prior.extractionStatus === 'ok';
    let parsed;
    let quality;
    if (sameSource && prior.parser && prior.parserVersion === (d.format === 'pdf' ? prior.parserVersion : HTML_VERSION)) {
      console.log(`same  ${d.manager.padEnd(18)} unchanged source and parser; keeping the existing record`);
      records.push(prior);
      rmSync(scratchFile, { force: true });
      continue;
    }
    parsed = await parseDocument(d.format, scratchFile, got.body);
    quality = assess({ units: parsed.units, items: parsed.items, rawCharacters: got.bytes });

    if (keep) {
      writeFileSync(join(keep, 'originals', hash), got.body);
      writeFileSync(join(keep, 'text', `${hash}.txt`), parsed.items.map((i) => i.text).join('\n\n'), 'utf8');
      writeFileSync(join(keep, 'structured', `${hash}.json`), `${JSON.stringify({
        documentId: hash, units: parsed.units, parser: parsed.parser, parserVersion: parsed.parserVersion,
        items: parsed.items.map((i) => ({ index: i.index, tag: i.tag, chars: i.chars, sha256: createHash('sha256').update(i.text || '').digest('hex'), text: i.text })),
      }, null, 2)}\n`, 'utf8');
    }
    rmSync(scratchFile, { force: true });

    if (privateManifest) {
      const row = {
        manager: d.manager, documentId: hash, subjectOrPeriod: d.subjectOrPeriod, filingDate: d.filingDate, form: d.form,
        accession: d.accession, filingIndexUrl: d.filingIndexUrl, documentUrl: d.documentUrl, retrievedAt: new Date().toISOString(),
        httpStatus: got.status, contentType: got.contentType, expectedBytes: d.expectedBytes, actualBytes: got.bytes, sha256: hash,
        parser: parsed.parser, parserVersion: parsed.parserVersion, extractionStatus: parsed.status, units: parsed.units,
        unitCount: parsed.items.length, characterCount: quality.normalisedCharacters,
        warnings: [...got.warnings, ...(parsed.warnings || []), ...quality.warnings], originalRetained: true,
        rightsJudgement: 'SEC public record; excerpt-only display with a link to sec.gov',
        sourceClassification: d.form.startsWith('N-CSR') ? 'sec_shareholder_report' : 'sec_exhibit',
      };
      const rowProblems = validateRow(row);
      if (rowProblems.length) row.warnings.push(`manifest row problems: ${rowProblems.join('; ')}`);
      privateManifest.documents[hash] = row;
    }

    const record = toPublicRecord({
      schemaVersion: SCHEMA_VERSION,
      manager: d.manager,
      documentId: hash,
      subjectOrPeriod: d.subjectOrPeriod,
      filingDate: d.filingDate,
      form: d.form,
      accession: d.accession,
      filingIndexUrl: d.filingIndexUrl,
      documentUrl: d.documentUrl,
      sourceBytes: got.bytes,
      sha256: hash,
      mimeType: got.contentType,
      parser: parsed.parser,
      parserVersion: parsed.parserVersion,
      extractionStatus: parsed.status,
      units: parsed.units,
      unitCount: parsed.items.length,
      characterCount: quality.normalisedCharacters,
      quality: {
        emptyUnitRatio: quality.emptyUnitRatio,
        repeatedEdgeRatio: quality.repeatedEdgeRatio,
        replacementCharacters: quality.replacementCharacters,
        replacementRate: quality.replacementRate,
        tableRows: quality.tableRows,
        managerDiscussionPresent: quality.managerDiscussionPresent,
        managerDiscussionMarkers: quality.managerDiscussionMarkers,
      },
      warnings: [...got.warnings, ...(parsed.warnings || []), ...quality.warnings].map((w) => String(w).slice(0, 480)),
      processedAt: new Date().toISOString(),
    });
    const problems = validatePublicRecord(record);
    if (problems.length) throw new Error(`the record for ${d.documentUrl} is not publishable: ${problems.join('; ')}`);
    records.push(record);
    console.log(`${parsed.status === 'ok' ? 'ok   ' : 'FAIL '} ${d.manager.padEnd(18)} ${String(got.bytes).padStart(9)} bytes · ${parsed.items.length} ${parsed.units} · ${quality.normalisedCharacters} chars · ${record.warnings.length} warning(s)`);
  }

  if (privateManifest) writeManifestAtomic(join(keep, 'manifest.json'), privateManifest);

  const output = emptyOutput();
  output.generatedAt = new Date().toISOString();
  output.documents = records;
  output.counts = {
    documents: records.length,
    parsed: records.filter((r) => r.extractionStatus === 'ok').length,
    failed: records.filter((r) => r.extractionStatus !== 'ok').length,
    requests,
    unchanged: records.filter((r) => previous && unchanged(previous, r)).length,
  };
  return output;
}

async function main() {
  const documents = approvedSelection();
  if (documents.length > MAX_DOCUMENTS) throw new Error(`the selection holds ${documents.length} documents, over the ${MAX_DOCUMENTS} approved`);

  const place = resolveWorkspace({ mode: MODE, repoRoot: ROOT });
  console.log(`mode: ${MODE}${place.ok ? '' : ' — REFUSED'}`);
  for (const c of place.checks || []) console.log(`  ${c.ok ? 'ok ' : 'no '} ${c.name}: ${c.detail}`);
  if (!place.ok) {
    console.error(`\nRefusing to fetch anything. ${place.refusal}`);
    if (MODE === 'local-private') console.error('local-private keeps documents, so it needs a verified encrypted archive. The default mode, ephemeral-sec, keeps nothing and needs none.');
    process.exit(3);
  }

  const workspace = place.mode === 'local-private' ? place.scratch : place.workspace;
  onExitCleanup(workspace);

  if (DRY) {
    console.log(`\nDry run in ${MODE}: ${documents.length} documents planned, nothing fetched.`);
    for (const d of documents) console.log(`  ${d.manager.padEnd(18)} ${d.format.padEnd(4)} ${String(d.expectedBytes).padStart(9)} ${d.documentUrl}`);
    workspace.cleanup();
    return;
  }

  const { value: output, error, cleanup } = await withWorkspace(workspace, () => run(place, documents));
  if (cleanup.clean) {
    console.log(`cleanup: workspace removed (${cleanup.scratchFilesAtEnd} scratch file(s) at the end)`);
  } else {
    console.error(`CLEANUP FAILED: ${cleanup.remainingFiles} file(s) remain under ${workspace.path}`);
    process.exitCode = 4;
  }
  if (error) { console.error(error); process.exit(1); }

  writeFileSync(OUT_JSON, `${JSON.stringify(output, null, 2)}\n`);
  writeFileSync(OUT_MD, markdown(output, MODE));
  console.log(`\n${output.counts.parsed} of ${output.counts.documents} parsed · ${output.counts.requests} request(s) · wrote ${OUT_JSON} and ${OUT_MD}`);
  if (place.retainsBytes) console.log(`Originals and text retained on the archive at ${place.root} (never committed).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
