#!/usr/bin/env node
// Render the local review cards from the committed fixtures. No model, no network.
//
//   node scripts/thesis-review.mjs

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { positionContext } from '../lib/security-master.mjs';
import { renderReview, reviewCard } from '../lib/thesis-review.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const F = JSON.parse(readFileSync(join(ROOT, 'data', 'fixtures', 'thesis', 'fixtures.json'), 'utf8'));

const claims = [
  { claimId: 'c-1', managerId: F.manager.managerId, documentId: 'doc-1', filingDate: F.document.filingDate,
    kind: 'statement', stance: 'long', paraphrase: 'Margins should improve as the second production line fills.',
    evidenceRef: 'e-1', evidenceState: 'verified', tags: ['driver.margin_inflection'], provenance: 'model',
    model: 'claude-haiku-4-5-20251001', promptVersion: 'thesis-extract-v1', reviewStatus: 'pending',
    catalysts: [{ description: 'August results should show the margin turn', expectedBy: '2026-08-31', dateIsExplicit: true }],
    risks: [{ description: 'Two customers are most of revenue' }] },
  { claimId: 'c-2', managerId: F.manager.managerId, documentId: 'doc-1', filingDate: F.document.filingDate,
    kind: 'inference', stance: 'unclear', paraphrase: 'The position is likely to be sized up if the margin turn lands.',
    evidenceRef: 'e-1', evidenceState: 'verified', tags: [], provenance: 'model',
    model: 'claude-haiku-4-5-20251001', promptVersion: 'thesis-extract-v1', reviewStatus: 'pending' },
];

const byId = new Map(F.evidence.map((e) => [e.evidenceId, e]));
const cards = claims.map((c) => reviewCard(c, {
  reference: byId.get(c.evidenceRef),
  issuer: F.issuers[0],
  manager: F.manager,
  position: positionContext(F.positions[1], { asOf: '2026-09-18' }),
}));
process.stdout.write(renderReview(cards));
