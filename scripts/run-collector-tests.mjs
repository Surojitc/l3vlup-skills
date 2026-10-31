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
 */

import { spawnSync } from 'node:child_process';

export const SUITES = [
  'deadline-extract',
  'classify-programme',
  'classify-vertical',
  'workday-paginate',
  'workday-detail',
  'deadline-ledger',
  'oracle-paginate',
  'talnet',
  'eightfold-janestreet',
  'role-retention',
  'role-screen',
  'role-duplicates',
  'seniority',
  'early-career-recovery',
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
  'market-reference',
  'fx-rates',
  'rights-register',
  'collector-tests',
  'precedent-transactions',
  'precedent-seed',
];

const failed = [];
for (const name of SUITES) {
  const file = `scripts/__tests__/${name}.test.mjs`;
  const run = spawnSync(process.execPath, [file], { encoding: 'utf8' });
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

console.log(`\n${SUITES.length - failed.length} of ${SUITES.length} suites passed${failed.length ? `; failing: ${failed.join(', ')}` : ''}`);
process.exit(failed.length ? 1 : 0);
