#!/usr/bin/env node
/**
 * Put back any published observation this run rewrote, before it is staged.
 *
 *   node scripts/keep-published-observations.mjs --producer tracker
 *
 * A path the producer's contract marks `immutable` (today, the dated
 * data/board-checks/YYYY-MM-DD.json) is written once. A same-UTC-day rerun of
 * the collector writes that day's file again; this restores main's copy, so
 * the rerun still publishes the refreshed feed and everything else, and the
 * day's first published observation stands. Without it the gate would refuse
 * the whole rerun (scripts/publication-contracts.mjs, immutableProblems),
 * which is safe but would cost the feed refresh.
 *
 * Run by the collecting job before `git add -A`, and by the publisher after it
 * unpacks the handoff, because main may have gained the day's file while the
 * collection was running. Only files git already tracks at HEAD are touched:
 * a new date is left exactly as the collector wrote it. The gate still
 * refuses a rewrite that reaches it, so this step is a convenience in front
 * of the rule, not the rule.
 *
 * Reads nothing from the network and writes only inside the working tree.
 */
import { execFileSync } from 'node:child_process';
import { CONTRACTS, immutablePaths } from './publication-contracts.mjs';

const i = process.argv.indexOf('--producer');
const producer = i > -1 ? process.argv[i + 1] : undefined;
if (!producer || !CONTRACTS[producer]) {
  console.error(`--producer must be one of: ${Object.keys(CONTRACTS).join(', ')}`);
  process.exit(2);
}

// Tracked files that differ from HEAD in the working tree or the index.
const changed = execFileSync('git', ['diff', '--name-only', 'HEAD'], { encoding: 'utf8' })
  .split('\n')
  .map((l) => l.trim())
  .filter(Boolean);
const kept = immutablePaths(producer, changed);
for (const path of kept) {
  execFileSync('git', ['checkout', 'HEAD', '--', path], { stdio: 'inherit' });
  console.log(`::notice::${path} is already published on main; kept main's copy (a dated observation is written once)`);
}
if (!kept.length) console.log('no published observation was rewritten');
