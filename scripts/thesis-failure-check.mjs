#!/usr/bin/env node
// Refuse a failure report that is not safe to publish.
//
// Run by the job that produced it before the upload, for the same reason the
// feed is checked twice: a workflow artefact is permanent and public, and a
// failed run is exactly when the code paths that produce one are least
// exercised.
//
//   node scripts/thesis-failure-check.mjs .pilot/failure.json

import { readFileSync } from 'node:fs';
import { validateFailureReport } from '../lib/thesis-publish.mjs';

const path = process.argv[2];
if (!path) { console.error('usage: thesis-failure-check.mjs <failure.json>'); process.exit(2); }

let report;
try {
  report = JSON.parse(readFileSync(path, 'utf8'));
} catch (err) {
  console.error(`::error::${path} could not be read as JSON: ${err.message}`);
  process.exit(1);
}

const problems = validateFailureReport(report);
if (problems.length) {
  console.error(`::error::${path} is not safe to upload:`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`ok: ${report.reason}, $${(report.cost.actualUsd ?? 0).toFixed(4)} spent, ${report.cost.calls.length} call(s), no claims and no source text.`);
