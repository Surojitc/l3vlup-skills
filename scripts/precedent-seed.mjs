#!/usr/bin/env node
/**
 * Which dataset the precedent collector starts from: published main, or a
 * seed, applied to the checkout before any collector runs.
 *
 *   node scripts/precedent-seed.mjs --ref "$GITHUB_REF" --run-id "$GITHUB_RUN_ID" \
 *        --review true|false|'' --seed '' | <branch> --record "$RUNNER_TEMP/precedent-start.json"
 *
 * THE FINDING
 * -----------
 * On 22 October 2026 controlled review runs of collect.yml were dispatched
 * from branches carrying an earlier run's data/precedent-transactions.auto.json,
 * meant as the starting state. The collecting job checks out `ref: main`, on
 * purpose (a queued run must collect against current data), so every one of
 * them started from the file published on 11 October and the seed was
 * ignored. Each run re-read every row under the new reader versions, oldest
 * filing first, inside fixed per-pass budgets, and stopped short of the same
 * rows every time: progress across review runs could not accumulate.
 *
 * WHAT THIS DOES
 * --------------
 * With no seed, nothing is changed: the record says the run starts from
 * published main, at the checkout's commit, with the precedent file's
 * generatedAt and sha256.
 *
 * With `--seed <branch>`, a branch of this repository:
 *
 *   1. publicationTarget() in scripts/publication-contracts.mjs must say the
 *      run is a review run. A seeded run that is not is refused before
 *      anything is fetched, so a seed can never reach the scheduled branch or
 *      an automatic merge. (The publisher refuses it a second time, on the
 *      file's own record: seedPublicationProblems.)
 *   2. The branch is fetched, one commit deep, and only the blobs at
 *      SEED_PATHS are read out of it with `git ls-tree` and `git cat-file`.
 *      Each must be a regular file, parse as JSON and carry the top-level keys
 *      its collector reads. Nothing else of the branch is read, written or
 *      checked out: no script, no workflow, no other data file.
 *   3. Only then are both files written over main's copies, and the working
 *      tree is checked to differ from main in those paths and no others.
 *
 * The record goes to `--record`, outside the checkout (the collecting job
 * stages every changed file, so a record inside it would be published), and
 * the precedent collector copies it into the file it writes as `startedFrom`
 * (PRECEDENTS_STARTED_FROM, database.started_from).
 *
 * WHAT A SEEDED RUN'S DIFF IS AGAINST
 * -----------------------------------
 * The precedent guard's baseline is the file on disk when the collector first
 * reads it (database.load_stored), and after this step that is the seed. So
 * every figure the guard keeps, every refusal it makes and every revision it
 * records is relative to the seed, not to main. The review pull request's
 * diff is against main, because the publisher rebuilds on main: it shows the
 * seed's changes and the run's together, and the body says so.
 *
 * Step outputs on stdout (`seeded`, `record`, `commit`, `sha256`,
 * `generated_at`); everything for a person on stderr. Exits 1 on any refusal,
 * having written nothing into the checkout.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SEED_PATHS, publicationTarget, seedBranchProblems } from './publication-contracts.mjs';

const PRECEDENTS = 'data/precedent-transactions.auto.json';
const MERGER_INDEX = 'data/merger-index.auto.json';
const BIG = 512 * 1024 * 1024;

/** The top-level shape each seed file must have, which is what its collector reads it by. */
export function seedFileProblems(path, raw) {
  let v;
  try {
    v = JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw));
  } catch (e) {
    return [`${path} in the seed is not JSON: ${String(e.message).slice(0, 80)}`];
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return [`${path} in the seed is not a JSON object`];
  const problems = [];
  const stamp = (k) => {
    if (typeof v[k] !== 'string' || Number.isNaN(new Date(v[k]).getTime())) problems.push(`${path} in the seed has no readable ${k}`);
  };
  const object = (k) => {
    if (!v[k] || typeof v[k] !== 'object' || Array.isArray(v[k])) problems.push(`${path} in the seed has no ${k} object`);
  };
  stamp('generatedAt');
  if (path === PRECEDENTS) {
    object('method');
    object('counts');
    if (!Array.isArray(v.transactions)) {
      problems.push(`${path} in the seed has no transactions array`);
    } else {
      if (v.transactions.length === 0) problems.push(`${path} in the seed holds no transactions`);
      const ids = new Set();
      let bad = 0;
      let dup = 0;
      for (const r of v.transactions) {
        if (!r || typeof r !== 'object' || typeof r.id !== 'string' || !r.id) bad += 1;
        else if (ids.has(r.id)) dup += 1;
        else ids.add(r.id);
      }
      if (bad) problems.push(`${path} in the seed has ${bad} transaction(s) with no id`);
      if (dup) problems.push(`${path} in the seed has ${dup} transaction id(s) twice`);
    }
  } else if (path === MERGER_INDEX) {
    if (typeof v.source !== 'string') problems.push(`${path} in the seed has no source`);
    object('quarters');
    if (v.quarters && typeof v.quarters === 'object' && !Array.isArray(v.quarters)) {
      const odd = Object.entries(v.quarters).filter(([q, rows]) => !/^\d{4}Q[1-4]$/.test(q) || !Array.isArray(rows));
      if (odd.length) problems.push(`${path} in the seed has ${odd.length} quarter(s) that are not a quarter's list of filings`);
    }
  } else {
    problems.push(`${path} is not a file a seed may replace`);
  }
  return problems;
}

/** generatedAt and sha256 of a file's bytes, or nulls when there is none. */
export function describe(bytes) {
  if (!bytes) return { generatedAt: null, sha256: null };
  let generatedAt = null;
  try {
    const g = JSON.parse(bytes.toString('utf8')).generatedAt;
    generatedAt = typeof g === 'string' ? g : null;
  } catch {
    generatedAt = null;
  }
  return { generatedAt, sha256: createHash('sha256').update(bytes).digest('hex') };
}

function gitIn(cwd) {
  return (args, opts = {}) => execFileSync('git', args, { cwd, maxBuffer: BIG, stdio: ['ignore', 'pipe', 'pipe'], ...opts });
}

/** Paths that differ from HEAD in the working tree, untracked ones included. */
function changedPaths(git) {
  const out = git(['status', '--porcelain=v1', '-z', '--untracked-files=all']).toString('utf8');
  return out.split('\0').filter(Boolean).map((e) => e.slice(3));
}

/**
 * Apply a seed to the checkout at `cwd`, or record that there is none.
 * Returns `{ problems }` on a refusal, having written nothing, else
 * `{ problems: [], seeded, record }`.
 */
export function applySeed({ cwd, seed = '', ref, runId, review, remote = 'origin' }) {
  const git = gitIn(cwd);
  const target = publicationTarget('open-data', { ref, runId, review, seed });
  if (target.problems.length) return { problems: target.problems };
  const head = git(['rev-parse', 'HEAD']).toString('utf8').trim();

  if (!target.seeded) {
    const file = join(cwd, PRECEDENTS);
    const main = describe(existsSync(file) ? readFileSync(file) : null);
    return { problems: [], seeded: false, record: { dataset: 'published main', ref: 'refs/heads/main', commit: head, ...main, run: String(runId) } };
  }

  const problems = seedBranchProblems(seed);
  if (problems.length) return { problems };
  if (changedPaths(git).length) return { problems: ['the checkout already differs from main before the seed is applied; nothing has been changed'] };

  // One commit, by its branch name, into FETCH_HEAD: no local branch is
  // made, nothing is checked out, and no tag comes with it.
  try {
    git(['fetch', '--no-tags', '--no-recurse-submodules', '--depth=1', remote, `refs/heads/${seed}`]);
  } catch (e) {
    return { problems: [`the seed branch ${seed} could not be fetched from this repository: ${String(e.stderr || e.message).trim().split('\n').pop().slice(0, 160)}`] };
  }
  const commit = git(['rev-parse', '--verify', 'FETCH_HEAD^{commit}']).toString('utf8').trim();

  const blobs = {};
  for (const path of SEED_PATHS) {
    const entry = git(['ls-tree', '-z', commit, '--', path]).toString('utf8').split('\0').filter(Boolean);
    const m = entry.length === 1 ? entry[0].match(/^(\d{6}) (\w+) ([0-9a-f]{40,64})\t(.+)$/) : null;
    if (!m || m[4] !== path) {
      problems.push(`the seed ${seed} has no ${path}`);
      continue;
    }
    if (m[1] !== '100644' || m[2] !== 'blob') {
      problems.push(`${path} in the seed is not a regular file (mode ${m[1]}, ${m[2]})`);
      continue;
    }
    const bytes = git(['cat-file', 'blob', m[3]]);
    const p = seedFileProblems(path, bytes);
    if (p.length) problems.push(...p);
    else blobs[path] = bytes;
  }
  if (problems.length) return { problems };

  for (const path of SEED_PATHS) writeFileSync(join(cwd, path), blobs[path]);
  const changed = changedPaths(git);
  const stray = changed.filter((p) => !SEED_PATHS.includes(p));
  if (stray.length) return { problems: [`applying the seed changed more than its two files: ${stray.join(', ')}`] };

  const precedents = describe(blobs[PRECEDENTS]);
  const index = describe(blobs[MERGER_INDEX]);
  return {
    problems: [],
    seeded: true,
    changed,
    record: {
      dataset: 'seed',
      ref: `refs/heads/${seed}`,
      commit,
      ...precedents,
      mergerIndex: index,
      main: head,
      run: String(runId),
    },
  };
}

function main() {
  const args = process.argv.slice(2);
  const arg = (name) => {
    const i = args.indexOf(`--${name}`);
    return i > -1 ? args[i + 1] : undefined;
  };
  const cwd = process.cwd();
  const recordPath = arg('record');
  if (!recordPath || !isAbsolute(recordPath)) {
    console.error('::error::--record must be an absolute path');
    process.exit(2);
  }
  const rel = relative(cwd, resolve(recordPath));
  if (!rel.startsWith('..') && !isAbsolute(rel)) {
    console.error('::error::--record must be outside the checkout, or the collection would publish it');
    process.exit(2);
  }
  const result = applySeed({ cwd, seed: arg('seed') ?? '', ref: arg('ref'), runId: arg('run-id'), review: arg('review') });
  if (result.problems.length) {
    for (const p of result.problems) console.error(`::error::${p}`);
    console.error('the precedent collector was not started: a seed that cannot be applied exactly is applied not at all');
    process.exit(1);
  }
  const r = result.record;
  writeFileSync(recordPath, `${JSON.stringify(r, null, 1)}\n`);
  if (result.seeded) {
    console.error(`seeded from ${r.ref} at ${r.commit}: ${PRECEDENTS} generated ${r.generatedAt}, sha256 ${r.sha256}; ${MERGER_INDEX} sha256 ${r.mergerIndex.sha256}`);
    console.error('the precedent guard\'s baseline is this seed, so this run\'s revisions are relative to it; the review pull request\'s diff is against main');
  } else {
    console.error(`starting from published main at ${r.commit}: ${PRECEDENTS} generated ${r.generatedAt}, sha256 ${r.sha256}`);
  }
  for (const [k, v] of [['seeded', String(result.seeded)], ['record', recordPath], ['commit', r.commit], ['sha256', r.sha256 ?? ''], ['generated_at', r.generatedAt ?? '']]) {
    if (/[\r\n]/.test(v)) {
      console.error(`::error::${k} is not a single line`);
      process.exit(1);
    }
    console.log(`${k}=${v}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
