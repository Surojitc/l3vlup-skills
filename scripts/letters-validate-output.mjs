#!/usr/bin/env node
// What must be true of data/letters.parsed.json before it is committed.
//
// The parsing run already refuses to write an unpublishable record, but the
// run and the commit are different moments and, in the workflow, different
// jobs on different machines. This is the check at the second moment: it
// reads only the file, knows nothing about how it was produced, and is the
// gate the write-enabled job passes before it is allowed to open anything.
//
// It answers three questions. Is every record inside the allowlist and free
// of prose? Does the file describe only documents the approved selection
// names, and no more than nine of them? And is the file the one the
// renderer would produce from those records — that is, did something write
// it by hand?
//
//   node scripts/letters-validate-output.mjs
//   node scripts/letters-validate-output.mjs --json path.json --md path.md

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildOutput, renderMarkdown, serialiseOutput, toPublicRecord, validatePublicRecord } from '../lib/letters-output.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MAX_DOCUMENTS = 9;

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const JSON_PATH = arg('--json', join(ROOT, 'data', 'letters.parsed.json'));
const MD_PATH = arg('--md', join(ROOT, 'data', 'letters.parsed.md'));
const SELECTION = join(ROOT, 'data', 'letters.selection.json');

export function validateOutputFiles({ jsonText, markdownText, approvedUrls }) {
  const problems = [];
  let output;
  try {
    output = JSON.parse(jsonText);
  } catch (err) {
    return [`the JSON does not parse: ${err.message}`];
  }

  const documents = output.documents || [];
  if (!Array.isArray(documents)) return ['documents is not a list'];
  if (documents.length > MAX_DOCUMENTS) problems.push(`${documents.length} documents, over the ${MAX_DOCUMENTS} approved for Phase 0`);

  for (const key of ['generatedAt', 'counts', 'requests', 'runtimeMs', 'mode']) {
    if (output[key] !== undefined) problems.push(`${key} describes a run, not a document, and must not be committed`);
  }

  const seen = new Set();
  for (const record of documents) {
    for (const p of validatePublicRecord(record)) problems.push(`${record.documentUrl || 'a record'}: ${p}`);
    if (!approvedUrls.has(record.documentUrl)) problems.push(`${record.documentUrl} is not in the approved selection`);
    if (seen.has(record.documentUrl)) problems.push(`${record.documentUrl} appears twice`);
    seen.add(record.documentUrl);
  }

  // The file must be what the renderer would write from these records. A
  // hand-edited line, a reordering or a stray field shows up here even if
  // every record passes on its own.
  const rebuilt = buildOutput(documents.map((d) => toPublicRecord(d)));
  if (serialiseOutput(rebuilt) !== jsonText) problems.push('the JSON is not what the renderer produces from its own records');
  if (markdownText !== undefined && renderMarkdown(rebuilt) !== markdownText) problems.push('the Markdown does not match the JSON beside it');

  return problems;
}

function main() {
  const approvedUrls = new Set(JSON.parse(readFileSync(SELECTION, 'utf8')).selection.map((s) => s.documentUrl));
  const problems = validateOutputFiles({
    jsonText: readFileSync(JSON_PATH, 'utf8'),
    markdownText: readFileSync(MD_PATH, 'utf8'),
    approvedUrls,
  });
  if (problems.length) {
    console.error(`${JSON_PATH} is not publishable:`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  const count = JSON.parse(readFileSync(JSON_PATH, 'utf8')).documents.length;
  console.log(`ok: ${count} record(s), all inside the allowlist, all approved, and the two files agree.`);
}

if (process.argv[1] && process.argv[1].endsWith('letters-validate-output.mjs')) main();
