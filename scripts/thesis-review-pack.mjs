#!/usr/bin/env node
/**
 * Write the review pack and an empty decisions file for the pending claims.
 *
 *   npm run review:pack                      # data/thesis/claims.pending.json
 *   npm run review:pack -- --pending <path>
 *
 * Writes data/thesis/review.md (read it) and data/thesis/review.decisions.json
 * (fill it in). An existing decisions file is never overwritten: decisions a
 * person has already made are kept, and only claims new to the pending feed
 * are appended undecided.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { decisionsTemplate, reviewPack } from '../lib/thesis-reviewed.mjs';

const arg = (n) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : null; };
const pendingPath = arg('--pending') ?? 'data/thesis/claims.pending.json';
const pending = JSON.parse(readFileSync(pendingPath, 'utf8'));
const taxonomy = JSON.parse(readFileSync('data/letters.taxonomy.json', 'utf8'));

mkdirSync('data/thesis', { recursive: true });
writeFileSync('data/thesis/review.md', reviewPack(pending, taxonomy) + '\n');

const decisionsPath = 'data/thesis/review.decisions.json';
const fresh = decisionsTemplate(pending);
if (existsSync(decisionsPath)) {
  const kept = JSON.parse(readFileSync(decisionsPath, 'utf8'));
  const known = new Set(kept.decisions.map((d) => d.claimId));
  const added = fresh.decisions.filter((d) => !known.has(d.claimId));
  kept.decisions.push(...added);
  writeFileSync(decisionsPath, JSON.stringify(kept, null, 2) + '\n');
  console.log(`review pack written; ${added.length} new claim(s) appended to the existing decisions file`);
} else {
  writeFileSync(decisionsPath, JSON.stringify(fresh, null, 2) + '\n');
  console.log(`review pack and decisions file written for ${fresh.decisions.length} claim(s)`);
}
