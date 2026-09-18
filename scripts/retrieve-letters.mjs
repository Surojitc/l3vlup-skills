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
//   node scripts/retrieve-letters.mjs --render-only
//   node scripts/retrieve-letters.mjs --mode local-private
//
// Cleanup runs from a finally block, from the signal handlers a cancellation
// sends, and after a parser is killed. It cannot run if the machine itself
// is destroyed; on a hosted runner that is what discards the disk anyway.
//
// The committed files are a function of the documents alone. Two runs that
// read the same bytes with the same parsers write the same bytes, so a diff
// on data/letters.parsed.json means a document changed and nothing else.
// Everything about the run itself — how many requests it made, how long it
// took, how much it carried forward — is printed and then forgotten.

import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CAP_BYTES, FetchRefusal, fetchDocument } from '../lib/letters-fetch.mjs';
import { extractSections, PARSER as HTML_PARSER, PARSER_VERSION as HTML_VERSION } from '../lib/letters-html.mjs';
import { parsePdf, PARSER_VERSION as PDF_VERSION } from '../lib/letters-pdf.mjs';
import { assess } from '../lib/letters-quality.mjs';
import {
  buildOutput,
  EXTRACTION_CONFIG_VERSION,
  preserveProcessedAt,
  renderMarkdown,
  SCHEMA_VERSION,
  serialiseOutput,
  toPublicRecord,
  validatePublicRecord,
} from '../lib/letters-output.mjs';
import { approvedDocument, DEFAULT_MODE, onExitCleanup, resolveWorkspace, withWorkspace } from '../lib/letters-workspace.mjs';
import { emptyManifest, validateRow, writeManifestAtomic } from '../lib/letters-manifest.mjs';
import { appendDurable, appendRunLog, renderRunSummary, runLogPath } from '../lib/letters-ledger.mjs';

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
const RENDER_ONLY = process.argv.includes('--render-only');
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

function readPrevious() {
  return existsSync(OUT_JSON) ? JSON.parse(readFileSync(OUT_JSON, 'utf8')) : null;
}

function writeOutput(output) {
  writeFileSync(OUT_JSON, serialiseOutput(output));
  writeFileSync(OUT_MD, renderMarkdown(output));
}

async function parseDocument(format, path, buf) {
  if (format === 'pdf') {
    const out = await parsePdf(path);
    return { ...out, items: (out.pages || []).map((p) => ({ index: p.page, tag: 'page', text: p.text, chars: p.chars })) };
  }
  const out = extractSections(buf.toString('utf8'));
  return { ...out, status: out.sections.length ? 'ok' : 'failed', parser: HTML_PARSER, parserVersion: HTML_VERSION, items: out.sections };
}

/**
 * Whether the record we already hold was made the same way we would make it
 * now: same bytes, same parser at the same version, same published shape and
 * the same parsing configuration. If so there is nothing to learn from
 * parsing it again, and re-parsing would only risk an unnecessary diff.
 */
function carriesForward(prior, format) {
  if (!prior || prior.extractionStatus !== 'ok') return false;
  return (
    prior.parserVersion === (format === 'pdf' ? PDF_VERSION : HTML_VERSION) &&
    prior.schemaVersion === SCHEMA_VERSION &&
    prior.extractionConfigVersion === EXTRACTION_CONFIG_VERSION
  );
}

/**
 * Write a line to the committed ledger, for the four reasons that earn one.
 *
 * Everything else a run does goes to the run log and the job summary. The
 * asymmetry is deliberate: nine identical 200s on every run tell nobody
 * anything and make every run look like a change, while a document that
 * appeared, moved or would not parse is exactly what somebody will want to
 * find in six months. A durable write always coincides with a change to the
 * published output, so the ledger never opens a pull request on its own.
 */
function recordMaterial(material, d, detail = {}) {
  appendDurable({
    script: 'retrieve-letters',
    url: d.documentUrl,
    status: detail.status ?? null,
    attempt: 0,
    material,
    observedIn: process.env.GITHUB_RUN_ID || 'local',
    manager: d.manager,
    accession: d.accession,
    purpose: `${material}: ${MATERIAL_NOTE[material]}`,
    ...detail,
  });
}

const MATERIAL_NOTE = {
  new_document: 'a document the committed output had not seen before',
  source_change: 'the bytes at an approved URL changed',
  error: 'a refusal, a non-200 or a parse failure worth investigating later',
  milestone_verification: 'a deliberate, named verification run',
};

async function run(place, documents) {
  const previous = readPrevious();
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
  const stats = { requests: 0, carriedForward: 0, parsed: 0, failed: 0 };
  for (const d of documents) {
    const check = approvedDocument(d.documentUrl, documents);
    if (!check.ok) { console.error(`skip  ${d.manager}: ${check.reason}`); continue; }
    if (stats.requests >= MAX_REQUESTS) { console.error(`stop  the ${MAX_REQUESTS} request ceiling is reached`); break; }
    if (stats.requests) await sleep(GAP_MS);

    let got;
    try {
      stats.requests += 1;
      got = await fetchDocument({
        url: d.documentUrl,
        expectedFormat: d.format,
        expectedBytes: d.expectedBytes,
        cap: CAP_BYTES,
        userAgent: UA,
        onAttempt: ({ url, status }) => appendRunLog({ script: 'retrieve-letters', url, status, attempt: 0, purpose: `approved document retrieval (${place.mode})` }),
      });
    } catch (err) {
      const refusal = err instanceof FetchRefusal ? err : new FetchRefusal('error', err.message);
      console.error(`FAIL  ${d.manager} ${d.filename}: ${refusal.message}`);
      stats.failed += 1;
      recordMaterial('error', d, { detail: refusal.message.slice(0, 300), code: refusal.code });
      records.push(preserveProcessedAt(previous, toPublicRecord({
        schemaVersion: SCHEMA_VERSION, manager: d.manager, documentId: null, subjectOrPeriod: d.subjectOrPeriod, filingDate: d.filingDate,
        form: d.form, accession: d.accession, filingIndexUrl: d.filingIndexUrl, documentUrl: d.documentUrl, sourceBytes: null, sha256: null,
        mimeType: null, parser: null, parserVersion: null, extractionConfigVersion: EXTRACTION_CONFIG_VERSION, extractionStatus: 'failed',
        units: null, unitCount: 0, characterCount: 0,
        quality: null, warnings: [refusal.message.slice(0, 480)], processedAt: new Date().toISOString(),
      })));
      if (refusal.stopRun) { console.error('The SEC refused the request. Stopping without a retry.'); break; }
      continue;
    }

    const hash = got.sha256;
    const scratchFile = join(work.path, `${hash}.${d.format}`);
    writeFileSync(scratchFile, got.body);

    const prior = previous?.documents?.find((x) => x.documentUrl === d.documentUrl);
    if (!prior) recordMaterial('new_document', d, { sha256: hash, bytes: got.bytes });
    else if (prior.sha256 !== hash) recordMaterial('source_change', d, { was: prior.sha256, now: hash, bytes: got.bytes });
    if (prior && prior.sha256 === hash && carriesForward(prior, d.format)) {
      console.log(`same  ${d.manager.padEnd(18)} unchanged source, parser and configuration; keeping the existing record`);
      stats.carriedForward += 1;
      stats.parsed += 1;
      records.push(prior);
      rmSync(scratchFile, { force: true });
      continue;
    }
    const parsed = await parseDocument(d.format, scratchFile, got.body);
    const quality = assess({ units: parsed.units, items: parsed.items, rawCharacters: got.bytes });
    if (parsed.status === 'ok') stats.parsed += 1;
    else { stats.failed += 1; recordMaterial('error', d, { detail: `extraction ${parsed.status}`, sha256: hash }); }

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
      extractionConfigVersion: EXTRACTION_CONFIG_VERSION,
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
    records.push(preserveProcessedAt(previous, record));
    console.log(`${parsed.status === 'ok' ? 'ok   ' : 'FAIL '} ${d.manager.padEnd(18)} ${String(got.bytes).padStart(9)} bytes · ${parsed.items.length} ${parsed.units} · ${quality.normalisedCharacters} chars · ${record.warnings.length} warning(s)`);
  }

  if (privateManifest) writeManifestAtomic(join(keep, 'manifest.json'), privateManifest);

  return { output: buildOutput(records), stats };
}

/**
 * A stored record's parsing configuration, for records written before there
 * was one to record.
 *
 * Configuration version 1 is the definition of what the parsers did on the
 * day this field was added, so a record made by that same code was made at
 * version 1 and may say so. The guard matters: once the configuration moves
 * to 2, a record that does not name its version was made by something else
 * and must be re-parsed rather than relabelled.
 */
function withConfigVersion(record) {
  if (record.extractionConfigVersion != null) return record;
  if (EXTRACTION_CONFIG_VERSION !== 1) return record;
  return { ...record, extractionConfigVersion: 1 };
}

/**
 * Rebuild both committed files from the records already on disk.
 *
 * The one path that touches no network at all. It exists so the rendering
 * can be proved stable without asking the SEC for the same nine documents
 * again, and so a change to the Markdown table can be applied without a
 * retrieval run.
 */
function renderOnly() {
  const previous = readPrevious();
  if (!previous) { console.error(`there is nothing to render: ${OUT_JSON} does not exist`); process.exit(2); }
  const records = (previous.documents || []).map((d) => toPublicRecord(withConfigVersion(d)));
  for (const record of records) {
    const problems = validatePublicRecord(record);
    if (problems.length) throw new Error(`the stored record for ${record.documentUrl} is not publishable: ${problems.join('; ')}`);
  }
  writeOutput(buildOutput(records));
  console.log(`render-only: rebuilt ${OUT_JSON} and ${OUT_MD} from ${records.length} stored record(s). No requests made.`);
}

async function main() {
  if (RENDER_ONLY) { renderOnly(); return; }

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

  const startedAt = Date.now();
  const { value, error, cleanup } = await withWorkspace(workspace, () => run(place, documents));
  if (cleanup.clean) {
    console.log(`cleanup: workspace removed (${cleanup.scratchFilesAtEnd} scratch file(s) at the end)`);
  } else {
    console.error(`CLEANUP FAILED: ${cleanup.remainingFiles} file(s) remain under ${workspace.path}`);
    process.exitCode = 4;
  }
  if (error) { console.error(error); process.exit(1); }

  writeOutput(value.output);

  // The run report, printed and not committed. None of this belongs in a
  // file that should only change when a document does.
  const { requests, carriedForward, parsed, failed } = value.stats;
  console.log(`\n${parsed} of ${value.output.documents.length} parsed, ${failed} failed · ${requests} request(s) · ${carriedForward} carried forward unchanged · ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);

  // The request detail belongs beside the run that made it, not in the
  // repository's history. On a runner this reaches the job summary; locally
  // it is a file under the temp directory that nothing tracks.
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, renderRunSummary());
    console.log('request detail written to the job summary');
  } else {
    console.log(`request detail written to ${runLogPath()} (untracked)`);
  }
  console.log(`wrote ${OUT_JSON} and ${OUT_MD}`);
  if (place.retainsBytes) console.log(`Originals and text retained on the archive at ${place.root} (never committed).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
