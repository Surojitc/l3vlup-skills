#!/usr/bin/env node
/**
 * Build data/thesis.reviewed.json from the pending claims and a person's
 * decisions. The site reads that file over DATA_BASE_URL.
 *
 *   npm run build:thesis-reviewed -- --check   # report problems, write nothing
 *   npm run build:thesis-reviewed              # write the feed if it is clean
 *
 * Exits 1 and writes nothing if any decision or any accepted claim breaks a
 * rule (lib/thesis-reviewed.mjs `checkReviewedFeed`, which mirrors the site's
 * fail-closed `checkFeed`). Nothing here can accept a claim: only the
 * decisions file, which a person fills in, says yes.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { buildReviewedFeed } from '../lib/thesis-reviewed.mjs';

const pending = JSON.parse(readFileSync('data/thesis/claims.pending.json', 'utf8'));
const decisions = JSON.parse(readFileSync('data/thesis/review.decisions.json', 'utf8'));
const taxonomy = JSON.parse(readFileSync('data/letters.taxonomy.json', 'utf8'));
const { feed, problems } = buildReviewedFeed(pending, decisions, taxonomy);
if (problems.length) {
  console.error(`not written: ${problems.length} problem(s)\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
if (process.argv.includes('--check')) {
  console.log(`clean: ${feed.claims.length} claim(s) would be published`);
} else {
  writeFileSync('data/thesis.reviewed.json', JSON.stringify(feed, null, 2) + '\n');
  console.log(`data/thesis.reviewed.json written: ${feed.claims.length} claim(s), ${feed.taxonomy.length} tag(s)`);
}
