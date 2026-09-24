#!/usr/bin/env node
/**
 * Has every source this producer owns actually been collected lately?
 *
 *   node scripts/check-freshness.mjs --producer open-data \
 *        [--summary "$GITHUB_STEP_SUMMARY"] [--output "$GITHUB_OUTPUT"] \
 *        [--since <when the collection began> --expect <path> ...]
 *
 * WHY THIS IS NOT THE PUBLICATION GATE
 * ------------------------------------
 * The gate checks what is being published. A collector that fails every
 * morning publishes nothing, so the gate has nothing to object to, and the
 * committed file ages behind a green tick. Three of `collect.yml`'s steps are
 * `continue-on-error`, which is right — one dead wire should not cost the
 * whole morning's collection — but it means a persistent failure looks
 * exactly like a quiet day.
 *
 * That is the same defect as a silently refused push, one step earlier in the
 * pipeline, so it gets the same answer: make it visible in the run's
 * conclusion, not in a log line nobody opens.
 *
 * WHAT IT READS
 * -------------
 * The working tree, after the collectors have run. A file this run rewrote
 * carries a fresh stamp; a file its collector failed on is still the copy
 * from `main`, carrying whatever stamp it was committed with. So this sees
 * committed state for exactly the sources that did not collect, which is the
 * set it exists to find.
 *
 * WHAT A RUN WAS DUE TO WRITE
 * ---------------------------
 * `--expect` names a file whose collector was due and ran this time, and
 * `--since` when the collection began. A file so named whose stamp predates
 * the run is degraded now, even inside its horizon, because its collector
 * was asked for it and did not deliver. Without this a monthly collector that
 * times out on the first reads as not-due for six weeks.
 *
 * WHAT IT DOES ABOUT IT
 * ---------------------
 * Nothing, here. It prints, writes the operator's table to the job summary,
 * and sets `blocking` and `degraded` as step outputs. Failing the run is a
 * separate job that runs after publication, so a stale calendar does not stop
 * a healthy deal tape from reaching the site: the publication still happens
 * and the run still goes red. Exit 0 unless the producer is unknown.
 */

import { readFileSync, appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { CONTRACTS, freshnessReport, freshnessSummary } from './publication-contracts.mjs';

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

function args(name) {
  const out = [];
  process.argv.forEach((a, i) => {
    if (a === `--${name}` && process.argv[i + 1]) out.push(process.argv[i + 1]);
  });
  return out;
}

const producer = arg('producer');
if (!producer || !CONTRACTS[producer]) {
  console.error(`--producer must be one of: ${Object.keys(CONTRACTS).join(', ')}`);
  process.exit(2);
}

/** The file as it stands on disk: undefined if absent, null if unparseable. */
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

/** When this file was last committed, for the few that carry no stamp. */
function committedAt(path) {
  try {
    const out = execFileSync('git', ['log', '-1', '--format=%cI', '--', path], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

const expected = args('expect');
const since = arg('since');
if (expected.length && (!since || Number.isNaN(new Date(since).getTime()))) {
  console.error('--expect needs --since, the time the collection began');
  process.exit(2);
}

const report = freshnessReport(producer, { read, committedAt, expected, since });

for (const s of report.sources) {
  const age = s.ageHours === undefined ? '' : ` (${s.ageHours}h)`;
  console.log(`${s.state.padEnd(8)} ${s.label}${age}${s.note ? ` — ${s.note}` : ''}`);
}

const summaryPath = arg('summary');
if (summaryPath) appendFileSync(summaryPath, freshnessSummary(producer, report));

const outputPath = arg('output');
if (outputPath) {
  appendFileSync(outputPath, `blocking=${report.blocking}\ndegraded=${report.degraded}\n`);
}

// Loud in the log either way; the run's conclusion is set by the job that
// reads `blocking` after publication.
for (const p of report.problems) console.log(`::error::${p}`);
if (report.degraded && !report.blocking) {
  for (const s of report.sources.filter((x) => x.state === 'degraded')) {
    console.log(`::warning::${s.label} is degraded — ${s.note ?? 'past its horizon'}`);
  }
}
console.log(report.blocking ? '\nA REQUIRED SOURCE IS STALE' : report.degraded ? '\nan optional source is degraded' : '\nevery source is within its horizon');
