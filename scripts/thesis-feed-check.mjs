#!/usr/bin/env node
// Refuse a feed that is not publishable. Run twice: by the job that made it
// and by the job that is about to commit it.
//
//   node scripts/thesis-feed-check.mjs .pilot/feed.json

import { readFileSync } from 'node:fs';
import { validateFeed } from '../lib/thesis-publish.mjs';

const path = process.argv[2];
if (!path) { console.error('usage: thesis-feed-check.mjs <feed.json>'); process.exit(2); }

let feed;
try {
  feed = JSON.parse(readFileSync(path, 'utf8'));
} catch (err) {
  console.error(`::error::${path} could not be read as JSON: ${err.message}`);
  process.exit(1);
}

const problems = validateFeed(feed);
if (problems.length) {
  console.error(`::error::${path} is not publishable:`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`ok: ${feed.claims.length} claim(s), all needs_review or issuer_unresolved, no source text, within every quotation cap.`);
