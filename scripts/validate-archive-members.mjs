#!/usr/bin/env node
/**
 * May this archive be unpacked into the working tree?
 *
 *   tar -tf  publishable.tar              > members.txt
 *   tar -tvf publishable.tar | cut -c1    > types.txt
 *   node scripts/validate-archive-members.mjs --producer ats-registry \
 *        --members members.txt --types types.txt
 *
 * Run by the privileged publisher, from its own checkout of `main`, before a
 * single byte of the handoff is written to disk.
 *
 * WHY IT IS A SEPARATE STEP FROM THE GATE
 * ---------------------------------------
 * The gate reads the git index, so it can only judge files that are already
 * in the working tree. `tar` will follow a `..` segment or a symlink out of
 * that tree and write into the runner's home directory, where nothing the
 * gate does afterwards can find it, let alone undo it. Anything the archive
 * gets to write before it has been judged is a decision the archive made
 * rather than a decision the repository made.
 *
 * WHOSE CODE DECIDES
 * ------------------
 * This file and scripts/publication-contracts.mjs are read from the
 * publisher's checkout of `main` and never from the handoff. That is the
 * whole point of the step: unprivileged collection proposes bytes, and only
 * code and policy already on `main` decides whether those bytes are safe.
 * An earlier draft of the publisher ran a gate copied into the artifact by
 * the producer, which let a producer bring its own judge.
 *
 * Exit 0 and say nothing useful, or exit 1 having named every problem. There
 * is no third outcome and no flag that softens it.
 */

import { readFileSync } from 'node:fs';
import { CONTRACTS, archiveMemberProblems } from './publication-contracts.mjs';

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

const producer = arg('producer');
if (!producer || !CONTRACTS[producer]) {
  console.error(`--producer must be one of: ${Object.keys(CONTRACTS).join(', ')}`);
  process.exit(2);
}

const lines = (path) =>
  readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l !== '');

const membersPath = arg('members');
if (!membersPath) {
  console.error('--members is required: the output of `tar -tf`');
  process.exit(2);
}
const members = lines(membersPath).map((l) => l.replace(/\/+$/, ''));

// One character per member, in the same order, from `tar -tvf`. Optional so
// the policy can be exercised on paths alone; the workflow always passes it.
const typesPath = arg('types');
const types = typesPath ? lines(typesPath).map((l) => l.slice(0, 1)) : null;

const problems = archiveMemberProblems(producer, members, types);

if (problems.length) {
  for (const p of problems) console.log(`::error::${p}`);
  console.error(`\nrefusing to unpack the ${producer} archive: ${problems.length} problem(s)`);
  console.error('nothing has been written to the working tree');
  process.exit(1);
}

console.log(`the ${producer} archive may be unpacked: ${members.length} plain file(s), all inside its allowlist`);
for (const m of members) console.log(`  ${m}`);
