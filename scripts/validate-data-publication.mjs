#!/usr/bin/env node
/**
 * The last gate before any collection is published, for every producer.
 *
 *   node scripts/validate-data-publication.mjs --producer open-data \
 *        --staged staged.txt [--report body.md] [--ref main] [--run-url URL]
 *
 * Reads the staged list and the working tree, reads the previous copy of each
 * file straight out of `git show HEAD:<path>`, and asks
 * scripts/publication-contracts.mjs whether what is about to be committed is
 * publishable. Exits non-zero, loudly, on anything it is not: nothing is
 * pushed, no pull request is opened, and the run goes red.
 *
 * Going red is the point. The workflow this replaces reported success every
 * morning while its push was refused, because a `git push` inside a retry
 * loop leaves the loop's exit status to whatever ran last. Two days of stale
 * calendar, deal tape and news map sat behind a green tick. Every failure
 * path here ends in exit 1.
 *
 * The IO lives here and the decisions live in the contract module, so the
 * whole contract runs offline in the test suite beside it.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { CONTRACTS, contractProblems, publicationReport } from './publication-contracts.mjs';

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

const producer = arg('producer');
if (!producer || !CONTRACTS[producer]) {
  console.error(`--producer must be one of: ${Object.keys(CONTRACTS).join(', ')}`);
  process.exit(2);
}

const stagedFile = arg('staged');
const staged = stagedFile
  ? readFileSync(stagedFile, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean)
  : [];

/** The file as this run wrote it: undefined if absent, null if unparseable. */
function read(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * The copy already on this branch. A file this run is adding for the first
 * time has no previous copy, and `git show` says so on stderr rather than by
 * a distinguishable code, so anything that does not come back cleanly is
 * treated as "nothing to compare against" and the relative checks are skipped.
 */
function readPrev(path) {
  try {
    return JSON.parse(execFileSync('git', ['show', `HEAD:${path}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024 }));
  } catch {
    return null;
  }
}

const { problems, stats } = contractProblems(producer, { staged, read, readPrev });

if (problems.length) {
  for (const p of problems) console.log(`::error::${p}`);
  console.error(`\nrefusing to publish ${producer}: ${problems.length} problem(s)`);
  process.exit(1);
}

console.log(`publishable (${producer}): ${staged.length} generated file(s)`);
for (const s of stats) {
  const moved = s.before === null || s.before === undefined ? '' : ` (was ${s.before})`;
  console.log(`  ${s.name}: ${s.entries ?? 'ok'}${moved}`);
}

const reportPath = arg('report');
if (reportPath) {
  writeFileSync(
    reportPath,
    publicationReport({ producer, stats, staged, runUrl: arg('run-url'), ref: arg('ref'), extra: arg('extra') }),
  );
  console.log(`report -> ${reportPath}`);
}
