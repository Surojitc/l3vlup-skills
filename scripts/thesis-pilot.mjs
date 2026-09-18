#!/usr/bin/env node
// The local pilot. The only command in this repository that can spend money.
//
//   npm run pilot:thesis -- --documents <id,id> --budget 3
//   npm run pilot:thesis -- --documents <id,id> --budget 3 --dry-run
//
// It refuses to start without both an explicit document allowlist and an
// explicit budget. Neither has a default that runs: naming the documents is
// how you say which two, and naming the budget is how you say you meant to
// spend. A flag you can forget is not a control.
//
// Everything it writes goes under .pilot/, which is gitignored. The source
// documents are fetched into a workspace made by mkdtemp and deleted when the
// run ends — on success, on failure, on a timeout, and on Ctrl-C — by the
// same helper the retrieval pipeline uses, so the tested path is the real
// path. Nothing is published; every claim lands in needs_review or
// issuer_unresolved for a person.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CAP_BYTES, FetchRefusal, fetchDocument } from '../lib/letters-fetch.mjs';
import { extractSections, PARSER_VERSION as HTML_VERSION } from '../lib/letters-html.mjs';
import { parsePdf } from '../lib/letters-pdf.mjs';
import { onExitCleanup, resolveWorkspace, withWorkspace } from '../lib/letters-workspace.mjs';
import { anthropicModel, preflightModel, realClient } from '../lib/thesis-anthropic.mjs';
import { emptyCostLedger, LIMITS, MODEL_ALLOWLIST, PILOT_BUDGET_USD, PILOT_MODEL } from '../lib/thesis-cost.mjs';
import { runDocument } from '../lib/thesis-runner.mjs';
import { emptyDecisionLog, renderReview, reviewCard } from '../lib/thesis-review.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, '.pilot');
const SELECTION = join(ROOT, 'data', 'letters.selection.json');
const TAXONOMY = join(ROOT, 'data', 'letters.taxonomy.json');

/** Parse argv, refusing anything that would let a run start by accident. */
export function parseArgs(argv) {
  const problems = [];
  const value = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
  };

  const documents = value('--documents');
  if (!documents) problems.push('--documents is required: name the documents to read, comma separated. There is no default, because a default would let a run start that nobody chose.');

  const budgetRaw = value('--budget');
  if (budgetRaw === null) problems.push(`--budget is required: name the ceiling in dollars. The pilot default is ${PILOT_BUDGET_USD}, but it must be said out loud.`);
  const budget = budgetRaw === null ? null : Number(budgetRaw);
  if (budgetRaw !== null && (!Number.isFinite(budget) || budget <= 0)) problems.push(`--budget ${budgetRaw} is not a positive number of dollars`);
  if (Number.isFinite(budget) && budget > LIMITS.hardStopUsd) {
    problems.push(`--budget ${budget} is over the $${LIMITS.hardStopUsd.toFixed(2)} milestone ceiling, which no run may raise`);
  }

  const model = value('--model') || PILOT_MODEL;
  if (!MODEL_ALLOWLIST[model]) problems.push(`--model ${model} is not on the allowlist: ${Object.keys(MODEL_ALLOWLIST).join(', ')}`);

  return {
    problems,
    documents: documents ? documents.split(',').map((s) => s.trim()).filter(Boolean) : [],
    budget,
    model,
    dryRun: argv.includes('--dry-run'),
  };
}

/** Resolve the named ids against the approved selection. Nothing else is reachable. */
export function resolveDocuments(ids, selection) {
  const bySlug = new Map();
  for (const s of selection) {
    const slug = `${s.fund}-${(s.subjectCompany || s.reportingPeriodOrCampaign || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}-${s.filingDate}`;
    bySlug.set(slug, s);
    bySlug.set(`${s.fund}-${s.filingDate}`, s);
    bySlug.set(s.accession, s);
  }
  const found = [];
  const missing = [];
  for (const id of ids) {
    const hit = bySlug.get(id);
    if (hit) found.push(hit); else missing.push(id);
  }
  return { found, missing, available: [...new Set([...bySlug.keys()])].sort() };
}

async function parseDocument(format, path, buf) {
  if (format === 'pdf') {
    const out = await parsePdf(path);
    return { units: out.units, status: out.status, text: (out.pages || []).map((p) => p.text).join('\n\n') };
  }
  const out = extractSections(buf.toString('utf8'));
  return { units: 'sections', status: out.sections.length ? 'ok' : 'failed', parserVersion: HTML_VERSION, text: out.sections.map((s) => s.text).join('\n\n') };
}

function writeOut(name, value) {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, name), typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.problems.length) {
    console.error('Refusing to start.\n');
    for (const p of args.problems) console.error(`  - ${p}`);
    console.error('\n  npm run pilot:thesis -- --documents starboard-value-2026-03-11,southeastern-2026-09-04 --budget 3');
    process.exit(2);
  }

  const selection = JSON.parse(readFileSync(SELECTION, 'utf8')).selection;
  const taxonomy = JSON.parse(readFileSync(TAXONOMY, 'utf8'));
  const { found, missing, available } = resolveDocuments(args.documents, selection);
  if (missing.length) {
    console.error(`Refusing to start: no approved document matches ${missing.join(', ')}.`);
    console.error('Approved identifiers:');
    for (const a of available) console.error(`  ${a}`);
    process.exit(2);
  }
  if (found.length > LIMITS.maxDocuments) {
    console.error(`Refusing to start: ${found.length} documents is over the ${LIMITS.maxDocuments} ceiling.`);
    process.exit(2);
  }

  console.log(`pilot: ${found.length} document(s), model ${args.model}, budget $${args.budget.toFixed(2)} of a $${LIMITS.hardStopUsd.toFixed(2)} milestone ceiling`);
  for (const d of found) console.log(`  ${d.fund.padEnd(18)} ${d.form.padEnd(8)} ${d.filingDate}  ${String(d.bytes).padStart(9)} bytes`);

  if (args.dryRun) {
    console.log('\nDry run: nothing fetched, no model called, no key read, nothing written.');
    return;
  }

  const client = await realClient();
  const pre = await preflightModel(args.model, { client });
  if (!pre.ok) {
    console.error(`\nRefusing to start: ${pre.reason}`);
    process.exit(3);
  }
  console.log(`  model confirmed by the API: ${pre.id}${pre.displayName ? ` (${pre.displayName})` : ''}${pre.maxInputTokens ? `, ${pre.maxInputTokens.toLocaleString()} input tokens` : ''}`);

  const place = resolveWorkspace({ mode: 'ephemeral-sec', repoRoot: ROOT });
  if (!place.ok) { console.error(`\nRefusing to start. ${place.refusal}`); process.exit(3); }
  const workspace = place.workspace;
  onExitCleanup(workspace);

  const model = anthropicModel({ modelId: args.model, taxonomy, client });
  let ledger = emptyCostLedger({ budgetUsd: args.budget });
  const decisionLog = existsSync(join(OUT, 'decisions.json'))
    ? JSON.parse(readFileSync(join(OUT, 'decisions.json'), 'utf8'))
    : emptyDecisionLog();
  const quoted = new Map();

  const { value: results, error, cleanup } = await withWorkspace(workspace, async () => {
    const out = [];
    for (const d of found) {
      const format = d.mimeType.includes('pdf') ? 'pdf' : 'html';
      console.log(`\nfetch  ${d.fund} ${d.filingDate}`);
      const got = await fetchDocument({
        url: d.documentUrl, expectedFormat: format, expectedBytes: d.bytes,
        cap: CAP_BYTES, userAgent: process.env.SEC_USER_AGENT || 'L3VLUP Research (contact: suro@l3vlup.com)',
      });
      const scratch = join(workspace.path, `${got.sha256}.${format}`);
      writeFileSync(scratch, got.body);
      const parsed = await parseDocument(format, scratch, got.body);
      rmSync(scratch, { force: true });
      if (parsed.status !== 'ok' || !parsed.text) { console.error(`  parse failed (${parsed.status}); skipping`); continue; }
      console.log(`  parsed ${parsed.text.length} characters; extracting`);

      const document = {
        documentId: d.accession, managerId: d.fund, accession: d.accession, form: d.form,
        filingDate: d.filingDate, documentUrl: d.documentUrl, sha256: got.sha256,
      };
      const run = await runDocument({
        model, modelId: args.model, document, manager: { managerId: d.fund, legalName: d.fund },
        sourceText: parsed.text, taxonomy, aliases: [],
        ledger, decisionLog, quotedWordsByDocument: quoted,
      });
      ledger = run.ledger;
      out.push({ document, run });
      console.log(`  ${run.claims.length} claim(s), ${run.dropped.length} dropped, ${run.strippedFields.length} field(s) stripped, $${ledger.estimatedUsd.toFixed(4)} spent`);
      if (ledger.stopped) { console.error(`  STOPPED: ${ledger.stopReason}`); break; }
    }
    return out;
  });

  console.log(cleanup.clean
    ? `\ncleanup: workspace removed (${cleanup.scratchFilesAtEnd} scratch file(s) at the end); no document or extracted text retained`
    : `\nCLEANUP FAILED: ${cleanup.remainingFiles} file(s) remain under ${workspace.path}`);
  if (!cleanup.clean) process.exitCode = 4;

  // Written whatever happened, so a failed or interrupted run still leaves
  // its cost and its partial results behind for a person to look at.
  const claims = (results || []).flatMap((r) => r.run.claims.map((c) => ({ ...c.claim, documentId: r.document.documentId })));
  writeOut('claims.json', { pilotVersion: 1, model: args.model, promptVersion: model.promptVersion, claims });
  writeOut('dropped.json', (results || []).flatMap((r) => r.run.dropped));
  writeOut('stripped.json', (results || []).flatMap((r) => r.run.strippedFields));
  writeOut('cost.json', { ...ledger, perCall: model.calls });
  writeOut('decisions.json', decisionLog);
  writeOut('review.md', renderReview((results || []).flatMap((r) => r.run.claims.map((c) => reviewCard(c.claim, {
    reference: c.reference.publicExcerpt ? { ...c.reference, excerpt: c.reference.publicExcerpt } : null,
    issuer: null, manager: { legalName: r.document.managerId }, position: null,
  })))));

  if (error) { console.error(`\n${error instanceof FetchRefusal ? error.message : error}`); process.exit(1); }

  console.log(`\n${claims.length} claim(s) awaiting review in .pilot/review.md`);
  console.log(`estimated $${ledger.estimatedUsd.toFixed(4)} · actual $${ledger.actualUsd.toFixed(4)} of $${ledger.budgetUsd.toFixed(2)}`);
  console.log('Nothing is published. Every claim is needs_review or issuer_unresolved until a person decides.');
}

if (process.argv[1] && process.argv[1].endsWith('thesis-pilot.mjs')) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
