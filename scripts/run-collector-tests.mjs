/**
 * The collector's own suites, run as one step that says which suite failed.
 *
 *   node scripts/run-collector-tests.mjs
 *
 * WHY THIS EXISTS
 * ---------------
 * The daily collection runs these before it reads a single board, and it
 * should: a regression in the deadline extractor or the publication gate
 * would put wrong data on the site. But from 10 to 11 October 2026 a test
 * fixture that #129 forgot to update failed the step three runs in a row, and
 * the only thing the run said was "Process completed with exit code 1" on a
 * step of twenty-two commands. Nothing had run them on the pull request
 * either, so the first anyone heard was a stale Sunday feed.
 *
 * So the list lives here, once, and two workflows call it: the collection
 * (build-samples.yml), and tests.yml on every branch pushed here, so a pull
 * request carries a result before it merges, which is where a broken suite
 * should be caught. Every suite runs even after one fails, and
 * each failure is printed as a GitHub error annotation naming the suite, so
 * the run's summary page says what broke without opening a log.
 *
 *   node scripts/run-collector-tests.mjs --producer tracker
 *
 * One suite here checks more than code: funds-explorer also holds every
 * committed 13F book to its history quarter, and that data is written by the
 * open-data collection (collect.yml), not by the tracker. On 17 November 2026
 * a stale 13F book left by the open-data run failed this step in the tracker
 * collection, and the day's jobs were not published although nothing about
 * them was wrong. So a suite whose subject is another producer's committed
 * data names that producer below, and `--producer` skips it, by name, in the
 * one workflow that cannot fix it. It is not skipped anywhere else: tests.yml
 * runs the whole list on every branch, and the producer that owns the data
 * runs the suite against what it is about to publish (collect.yml, "Check the
 * 13F data before it is published"). A code regression in one of these suites
 * is still caught before merge, and bad data is still refused, by its owner.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

export const SUITES = [
  'deadline-extract',
  'classify-programme',
  'classify-vertical',
  'workday-paginate',
  'workday-detail',
  'deadline-ledger',
  'oracle-paginate',
  'talnet',
  'title-brands',
  'eightfold-janestreet',
  'smartrecruiters',
  'recruitee-pinpoint',
  'workable',
  'employer-listings',
  'role-retention',
  'role-screen',
  'role-duplicates',
  'seniority',
  'early-career-recovery',
  'experienced-quality',
  'role-telemetry',
  'board-checks',
  'complete-board',
  'ats-discover',
  'slug-registry',
  'validate-publication',
  'publication-contracts',
  'publication-freshness',
  'publication-persistence',
  'publication-review',
  'workflow-permissions',
  'letters-queue',
  'data-health',
  'cusip-tickers',
  'market-reference',
  'fx-rates',
  'rights-register',
  'collector-tests',
  'precedent-transactions',
  'precedent-seed',
  // A Python suite: a name with no .test.mjs beside it runs as .test.py.
  'funds-explorer',
];

/**
 * Suites whose subject includes another producer's committed data, and that
 * producer. collector-tests.test.mjs holds each one to being run by its owner.
 */
export const DATA_OWNERS = {
  'funds-explorer': 'open-data',
};

/** The suites a producer's collection gates on: all of them, less another producer's data checks. */
export function suitesFor(producer) {
  if (!producer) return { run: SUITES, skipped: [] };
  const skipped = SUITES.filter((n) => DATA_OWNERS[n] && DATA_OWNERS[n] !== producer);
  return { run: SUITES.filter((n) => !skipped.includes(n)), skipped };
}

/** The file a suite name runs, and with what: .test.mjs under node, else .test.py under python3. */
function suiteCommand(name) {
  const mjs = `scripts/__tests__/${name}.test.mjs`;
  if (existsSync(mjs)) return [process.execPath, [mjs]];
  return ['python3', [`scripts/__tests__/${name}.test.py`]];
}

const at = process.argv.indexOf('--producer');
const producer = at > -1 ? process.argv[at + 1] : null;
if (at > -1 && !producer) {
  console.log('::error::--producer needs a name');
  process.exit(2);
}
const { run: suites, skipped } = suitesFor(producer);
for (const name of skipped) {
  console.log(`skip  ${name} (checks ${DATA_OWNERS[name]}'s committed data; gated where that data is collected)`);
}

const failed = [];
for (const name of suites) {
  const [cmd, args] = suiteCommand(name);
  const run = spawnSync(cmd, args, { encoding: 'utf8' });
  const out = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  if (run.status === 0) {
    console.log(`ok    ${name}`);
    continue;
  }
  failed.push(name);
  const lines = out.split('\n').filter((l) => /^FAIL\b|Error|error:/.test(l)).slice(0, 8);
  console.log(`FAIL  ${name} (exit ${run.status ?? 'signal ' + run.signal})`);
  for (const l of lines) console.log(`        ${l}`);
  // Annotations are one line each; keep the first failing case beside the suite.
  const first = (lines[0] ?? 'no FAIL line printed').replace(/[\r\n%]/g, ' ');
  console.log(`::error title=Collector suite failed: ${name}::${first}`);
}

console.log(`\n${suites.length - failed.length} of ${suites.length} suites passed${skipped.length ? ` (${skipped.length} left to its data's producer)` : ''}${failed.length ? `; failing: ${failed.join(', ')}` : ''}`);
process.exit(failed.length ? 1 : 0);
