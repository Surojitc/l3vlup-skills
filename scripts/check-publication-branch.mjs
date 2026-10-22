#!/usr/bin/env node
/**
 * May the scheduled publication rewrite its own branch?
 *
 *   gh pr view "$open" --json commits > commits.json
 *   node scripts/check-publication-branch.mjs --producer open-data \
 *        --pr 192 --commits commits.json
 *
 * Run by the scheduled path of the shared publisher, from its checkout of
 * `main`, when an open pull request already sits on the contract's branch,
 * and before anything is pushed there. The publisher force-pushes that
 * branch, which is safe only while the scheduled path is its one author.
 *
 * Exit 0 when every commit on that pull request was made by a scheduled
 * publication collected by main, so updating it loses nothing anyone was
 * asked to read. Exit 1, naming each other commit, when any was not: the
 * branch and the pull request are then left exactly as they are, the run
 * goes red, and a person decides. The rule is foreignCommits() in
 * scripts/publication-contracts.mjs, and why it exists is written there.
 *
 * Reads one local file. Nothing from the network, nothing written.
 */
import { readFileSync } from 'node:fs';
import { CONTRACTS, foreignCommits } from './publication-contracts.mjs';

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

const producer = arg('producer');
if (!producer || !CONTRACTS[producer]) {
  console.error(`--producer must be one of: ${Object.keys(CONTRACTS).join(', ')}`);
  process.exit(2);
}
const pr = arg('pr');
if (!/^[1-9][0-9]*$/.test(pr ?? '')) {
  console.error('--pr must be a pull request number');
  process.exit(2);
}
const file = arg('commits');
if (!file) {
  console.error('--commits is required: the output of `gh pr view <n> --json commits`');
  process.exit(2);
}

// An unreadable answer is not a clean one: foreignCommits treats no commits
// as foreign, so a file that does not parse refuses rather than passes.
let commits = null;
try {
  commits = JSON.parse(readFileSync(file, 'utf8'))?.commits ?? null;
} catch {
  commits = null;
}

const foreign = foreignCommits(commits);
const branch = CONTRACTS[producer].branch;
if (foreign.length) {
  for (const c of foreign) console.log(`::error::#${pr} on ${branch} carries commit ${c.oid}, ${c.why}`);
  console.log(
    `::error::the scheduled publication did not make every commit on #${pr}, so it will not rewrite ${branch}, update #${pr} or merge it. ` +
      `It is left exactly as it is, for a person: merge it or close it once it has been read, and the next scheduled run publishes as usual.`,
  );
  process.exit(1);
}
console.log(`#${pr} on ${branch} holds only scheduled publications collected by main; it may be updated`);
