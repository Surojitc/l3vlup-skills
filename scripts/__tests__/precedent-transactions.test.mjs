/**
 * The precedent transactions collector's suites, which are Python, run from
 * the shared collector list.
 *
 *   node scripts/__tests__/precedent-transactions.test.mjs
 *
 * scripts/run-collector-tests.mjs runs .test.mjs suites, on every pushed
 * branch and before every collection, so the Python suites of
 * scripts/precedent_transactions are run from here: each
 * scripts/__tests__/precedent-*.test.py, in turn, every one even after one
 * fails. A suite added in that pattern runs with no change to this file.
 */

import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';

const suites = readdirSync('scripts/__tests__').filter((f) => /^precedent-.+\.test\.py$/.test(f)).sort();
let failed = 0;
for (const f of suites) {
  const run = spawnSync('python3', [`scripts/__tests__/${f}`], { encoding: 'utf8' });
  process.stdout.write(run.stdout ?? '');
  process.stderr.write(run.stderr ?? '');
  if (run.status !== 0) {
    failed += 1;
    console.log(`FAIL  ${f} exited ${run.status ?? 'on ' + run.signal}`);
  }
}
console.log(`\n${suites.length - failed} of ${suites.length} precedent suites passed`);
process.exit(failed || !suites.length ? 1 : 0);
