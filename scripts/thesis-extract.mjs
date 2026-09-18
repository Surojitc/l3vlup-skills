#!/usr/bin/env node
// Drive the extraction runner against the committed fixtures and a fake model.
//
// There is no real model here and no way to reach one: the runner takes a
// `propose` function, and this passes it the deterministic fake. Running it
// costs nothing and contacts nobody.
//
//   node scripts/thesis-extract.mjs

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeModel } from '../lib/thesis-model.mjs';
import { runDocument } from '../lib/thesis-runner.mjs';
import { emptyCostLedger } from '../lib/thesis-cost.mjs';
import { emptyDecisionLog, renderReview, reviewCard } from '../lib/thesis-review.mjs';
import { positionContext } from '../lib/security-master.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const F = JSON.parse(readFileSync(join(ROOT, 'data', 'fixtures', 'thesis', 'fixtures.json'), 'utf8'));
const SOURCE = readFileSync(join(ROOT, 'data', 'fixtures', 'thesis', 'source-text.txt'), 'utf8');
const TAXONOMY = JSON.parse(readFileSync(join(ROOT, 'data', 'letters.taxonomy.json'), 'utf8'));
const PROPOSALS = JSON.parse(readFileSync(join(ROOT, 'data', 'fixtures', 'thesis', 'model-proposals.json'), 'utf8'));

const model = fakeModel({ responses: PROPOSALS });
const out = await runDocument({
  model, modelId: 'claude-haiku-4-5',
  document: F.document, manager: F.manager, sourceText: SOURCE,
  taxonomy: TAXONOMY, aliases: F.aliases,
  ledger: emptyCostLedger(), decisionLog: emptyDecisionLog(),
});

console.log(`document ${out.documentId}`);
console.log(`  ${out.claims.length} claim(s) reached review, ${out.dropped.length} dropped, ${out.strippedFields.length} field(s) stripped`);
for (const d of out.dropped) console.log(`  DROP ${d.chunkId}: ${d.reason}`);
for (const s of out.strippedFields) console.log(`  STRIP ${s.chunkId}: ${s.field} — ${s.reason}`);
console.log(`  ${out.quotedWords} of 50 cumulative words quoted`);
console.log(`  estimated spend $${out.ledger.estimatedUsd.toFixed(4)} of $${out.ledger.budgetUsd.toFixed(2)}${out.ledger.stopped ? ` — STOPPED: ${out.ledger.stopReason}` : ''}`);
console.log('  no model was called: the runner was driven by the deterministic fake\n');

const byId = new Map(out.claims.map((r) => [r.reference.evidenceId, r.reference]));
process.stdout.write(renderReview(out.claims.map((r) => reviewCard(r.claim, {
  reference: r.reference.publicExcerpt ? { ...byId.get(r.reference.evidenceId), excerpt: r.reference.publicExcerpt } : null,
  issuer: r.claim.issuerId ? F.issuers.find((i) => i.issuerId === r.claim.issuerId) : null,
  manager: F.manager,
  position: positionContext(F.positions[1], { asOf: '2026-09-18' }),
}))));
