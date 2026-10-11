/**
 * The suite list in scripts/run-collector-tests.mjs is complete, and the
 * collection and the pull-request check both call it.
 *
 *   node scripts/__tests__/collector-tests.test.mjs
 *
 * A suite added to scripts/__tests__ and to neither list would never run
 * before data is published; one listed here but deleted would fail every
 * run with a missing file. Both are caught here, by name.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';

let pass = 0;
let fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
  if (ok) pass += 1;
  else fail += 1;
};

const src = readFileSync('scripts/run-collector-tests.mjs', 'utf8');
const listed = [...src.matchAll(/^\s+'([a-z0-9-]+)',$/gm)].map((m) => m[1]);
eq('the runner lists suites', listed.length > 20, true);
eq('every listed suite exists', listed.filter((n) => !existsSync(`scripts/__tests__/${n}.test.mjs`)), []);
eq('no suite is listed twice', listed.filter((n, i) => listed.indexOf(n) !== i), []);

const build = readFileSync('.github/workflows/build-samples.yml', 'utf8');
const tests = readFileSync('.github/workflows/tests.yml', 'utf8');
eq('the collection runs the shared list', /run: node scripts\/run-collector-tests\.mjs/.test(build), true);
eq('and no longer keeps a copy of its own', /node scripts\/__tests__\/deadline-extract\.test\.mjs/.test(build), false);
eq('every pushed branch runs the same list before it can merge', [/^on:\n {2}push:\n {4}branches-ignore:\n {6}- main/m.test(tests), /run: node scripts\/run-collector-tests\.mjs/.test(tests)], [true, true]);

// Suites in the directory that no workflow runs, by the shared list or by
// name: each is either listed here or named in a workflow that runs it.
const workflows = readdirSync('.github/workflows').map((f) => readFileSync(`.github/workflows/${f}`, 'utf8')).join('\n');
const all = readdirSync('scripts/__tests__').filter((f) => f.endsWith('.test.mjs')).map((f) => f.replace(/\.test\.mjs$/, ''));
const unrun = all.filter((n) => !listed.includes(n) && !workflows.includes(`scripts/__tests__/${n}.test.mjs`));
console.log(`note  suites run by no workflow: ${unrun.length ? unrun.join(', ') : 'none'}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
