#!/usr/bin/env node
// Validate a set of proposed claims against the contract. No model, no network.
//
// This is the gate that will sit between extraction and review. It reads
// claims, the closed taxonomy and the transient source text, and reports
// what may proceed. A claim whose evidence does not match is dropped here
// and never sent back to be repaired.
//
//   node scripts/thesis-validate.mjs --claims claims.json --source text.txt
//   node scripts/thesis-validate.mjs --fixtures     # the committed fixtures

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateClaim } from '../lib/thesis-schema.mjs';
import { reassemblyProblems, verifyEvidence } from '../lib/thesis-evidence.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (n, f) => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : f; };

export function validateBatch({ claims, evidence, sourceText, taxonomy, sourceLength = null }) {
  const byId = new Map(evidence.map((e) => [e.evidenceId, e]));
  const results = [];
  for (const claim of claims) {
    const reference = byId.get(claim.evidenceRef) || null;
    const verdict = reference ? verifyEvidence(reference, sourceText) : { state: 'unverified', problems: ['no evidence reference'] };
    const withState = { ...claim, evidenceState: verdict.state };
    const problems = [...validateClaim(withState, { taxonomy }), ...verdict.problems.map((p) => `evidence: ${p}`)];
    results.push({ claimId: claim.claimId, evidenceState: verdict.state, problems, mayEnterReview: problems.length === 0 });
  }
  const verified = results.filter((r) => r.mayEnterReview).map((r) => byId.get(claims.find((c) => c.claimId === r.claimId)?.evidenceRef)).filter(Boolean);
  const reassembly = reassemblyProblems(verified, { sourceLength });
  return { results: results.sort((a, b) => a.claimId.localeCompare(b.claimId)), reassembly };
}

function main() {
  const taxonomy = JSON.parse(readFileSync(join(ROOT, 'data', 'letters.taxonomy.json'), 'utf8'));
  let claims; let evidence; let sourceText;
  if (process.argv.includes('--fixtures')) {
    const f = JSON.parse(readFileSync(join(ROOT, 'data', 'fixtures', 'thesis', 'fixtures.json'), 'utf8'));
    sourceText = readFileSync(join(ROOT, 'data', 'fixtures', 'thesis', 'source-text.txt'), 'utf8');
    evidence = f.evidence;
    claims = [{
      claimId: 'c-fixture-1', managerId: f.manager.managerId, documentId: f.document.documentId,
      filingDate: f.document.filingDate, kind: 'statement', stance: 'long',
      paraphrase: 'Margins should improve as the second production line fills.',
      evidenceRef: 'e-1', evidenceState: 'unverified', tags: ['driver.margin_inflection'],
      provenance: 'model', model: 'claude-haiku-4-5-20251001', promptVersion: 'thesis-extract-v1',
      reviewStatus: 'pending',
    }];
  } else {
    claims = JSON.parse(readFileSync(arg('--claims'), 'utf8'));
    evidence = JSON.parse(readFileSync(arg('--evidence'), 'utf8'));
    sourceText = readFileSync(arg('--source'), 'utf8');
  }
  const { results, reassembly } = validateBatch({ claims, evidence, sourceText, taxonomy, sourceLength: sourceText.length });
  for (const r of results) {
    console.log(`${r.mayEnterReview ? 'ok   ' : 'DROP '} ${r.claimId}  evidence ${r.evidenceState}`);
    for (const p of r.problems) console.log(`        ${p}`);
  }
  for (const p of reassembly) console.log(`REASSEMBLY  ${p}`);
  const dropped = results.filter((r) => !r.mayEnterReview).length;
  console.log(`\n${results.length - dropped} of ${results.length} may enter review; ${dropped} dropped. No model was called.`);
  if (reassembly.length) process.exit(1);
}

if (process.argv[1] && process.argv[1].endsWith('thesis-validate.mjs')) main();
