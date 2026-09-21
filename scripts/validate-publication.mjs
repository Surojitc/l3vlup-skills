#!/usr/bin/env node
/**
 * What a collection run is allowed to publish, and what it must never publish.
 *
 * WHY THIS EXISTS
 * ---------------
 * The daily collection used to push straight to `main`. On 18 September a
 * ruleset closed that door: every change to the default branch must now arrive
 * through a pull request, so the run of 19 September and every run after it
 * failed at the push and the site kept serving the feed of the 18th. The fix
 * is not to give the workflow a way around the rule. It is to make the
 * collection travel the same road as everything else, and a machine opening a
 * pull request into a protected branch every morning needs a harder guarantee
 * about its own contents than a person does.
 *
 * So the workflow stages EVERYTHING (`git add -A`) rather than the two
 * directories it expects to have written, and hands the staged list here. A
 * run that has touched a script, a workflow, a lockfile or a source registry
 * is a run that has done something nobody asked it to, and the difference
 * between `git add data/` and this check is the difference between not
 * committing that change and not knowing about it.
 *
 * WHAT IS CHECKED, AND WHY EACH ONE
 * ---------------------------------
 *   1. Every staged path is one of the generated-data files this workflow's
 *      own steps write. Anything else fails the run: nothing is published and
 *      no pull request is opened or updated.
 *   2. The feed parses, carries a plausible number of rows, and every row has
 *      the fields the site indexes it by. A feed that parses but has lost its
 *      `vertical` field would render a board of blanks.
 *   3. The feed is from this run, not a stale file left by a step that failed
 *      quietly.
 *   4. No vertical collapses. This is the check that would have caught the
 *      classification defect this guard was written alongside, had it gone the
 *      other way: a rule that accidentally swallowed a whole category would
 *      show here as a vertical losing most of its rows overnight.
 *
 * WHAT IS DELIBERATELY NOT CHECKED
 * --------------------------------
 * Row-level truth. Whether a deadline is real is the collector's problem and
 * the ledger's; this is the last gate before publication, and a gate that
 * tried to re-derive the data would be a second collector with a second set
 * of bugs. Everything here is a property of the file, not of the world.
 *
 * Pure functions, so the whole contract runs offline in
 * scripts/__tests__/validate-publication.test.mjs. The CLI at the bottom is a
 * thin wrapper that reads files and prints.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { CONTRACTS } from './publication-contracts.mjs';

/**
 * The files a collection run may change, each named with the step that writes
 * it. A new collector step means a new line in the contract table, on purpose:
 * the run should not be able to publish a file nobody has thought about.
 *
 * Read from that table rather than written out again here. Two copies of an
 * allowlist is two allowlists, and the one nobody looks at is the one that
 * goes stale.
 */
export const PUBLISHABLE = CONTRACTS.tracker.files.map((f) => ({
  pattern: f.pattern ?? new RegExp(`^${f.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`),
  what: f.label,
}));

/** The rows below which a feed is not worth publishing over a good one. */
export const MIN_ROWS = 200;
/** How far the total may move in a day, as a fraction of the previous total. */
export const MIN_RATIO = 0.6;
export const MAX_RATIO = 2.0;
/** A vertical this size is established enough that halving it is a defect. */
export const VERTICAL_FLOOR = 20;
export const VERTICAL_MIN_RATIO = 0.5;
/** How old the collector's own stamp may be before the file is stale. */
export const MAX_AGE_HOURS = 24;

/** The fields the site reads on every row. A row missing one renders wrong. */
const REQUIRED_FIELDS = ['id', 'firm', 'role', 'vertical', 'programmeType', 'location', 'region', 'level', 'status'];

/** Staged paths that are not generated data. Empty means the run is clean. */
export function unexpectedPaths(paths) {
  return paths.filter((p) => p && !PUBLISHABLE.some((a) => a.pattern.test(p)));
}

export function verticalCounts(feed) {
  const counts = new Map();
  for (const row of feed?.opportunities ?? []) {
    const v = row?.vertical ?? '(none)';
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  return counts;
}

/**
 * Every vertical in either feed, with its movement, largest first. Used both
 * for the collapse check and for the table in the pull request body, so the
 * number a reviewer reads is the number the gate decided on.
 */
export function verticalMovement(prev, next) {
  const before = verticalCounts(prev);
  const after = verticalCounts(next);
  const names = Array.from(new Set([...before.keys(), ...after.keys()]));
  return names
    .map((name) => {
      const from = before.get(name) ?? 0;
      const to = after.get(name) ?? 0;
      return { name, from, to, delta: to - from };
    })
    .sort((a, b) => b.to - a.to || a.name.localeCompare(b.name));
}

/**
 * The publication invariants. `prev` may be null on a first run or when the
 * previous feed cannot be read; the relative checks are skipped rather than
 * failed, because "there is nothing to compare against" is not a defect.
 */
export function feedInvariants(next, prev, now = new Date()) {
  const problems = [];
  const rows = next?.opportunities;

  if (!Array.isArray(rows)) {
    problems.push('the feed has no opportunities array');
    return { problems, stats: { rows: 0, firms: 0, dated: 0, verticals: [] } };
  }
  if (rows.length < MIN_ROWS) problems.push(`only ${rows.length} rows, below the publication floor of ${MIN_ROWS}`);

  const missing = new Map();
  for (const row of rows) {
    for (const field of REQUIRED_FIELDS) {
      if (row?.[field] === undefined || row[field] === null || row[field] === '') {
        missing.set(field, (missing.get(field) ?? 0) + 1);
      }
    }
  }
  for (const [field, count] of missing) problems.push(`${count} row(s) missing ${field}`);

  const stamp = next?.generatedAt ? new Date(next.generatedAt) : null;
  if (!stamp || Number.isNaN(stamp.getTime())) {
    problems.push('the feed carries no readable generatedAt');
  } else {
    const ageHours = (now.getTime() - stamp.getTime()) / 3_600_000;
    if (ageHours > MAX_AGE_HOURS) problems.push(`the feed is ${Math.round(ageHours)}h old; a step may have failed quietly`);
    if (ageHours < -1) problems.push('the feed is stamped in the future');
  }

  const movement = verticalMovement(prev, next);
  const prevRows = prev?.opportunities?.length ?? 0;
  if (prevRows > 0) {
    const ratio = rows.length / prevRows;
    if (ratio < MIN_RATIO) problems.push(`rows fell from ${prevRows} to ${rows.length}, past the ${Math.round(MIN_RATIO * 100)}% floor`);
    if (ratio > MAX_RATIO) problems.push(`rows rose from ${prevRows} to ${rows.length}, past the ${MAX_RATIO}x ceiling`);
    for (const v of movement) {
      if (v.from >= VERTICAL_FLOOR && v.to < v.from * VERTICAL_MIN_RATIO) {
        problems.push(`${v.name} collapsed from ${v.from} to ${v.to}`);
      }
    }
  }

  return {
    problems,
    stats: {
      rows: rows.length,
      previousRows: prevRows,
      firms: new Set(rows.map((r) => r?.firm).filter(Boolean)).size,
      dated: rows.filter((r) => r?.closingDate).length,
      generatedAt: next?.generatedAt ?? null,
      verticals: movement,
    },
  };
}

/** The pull request body: what was collected, what moved, what was checked. */
export function publicationReport({ stats, staged, boards, runUrl, ref }) {
  const moved = stats.verticals.filter((v) => v.delta !== 0);
  const lines = [
    '## Daily data refresh',
    '',
    'Opened by the collection workflow. Every file below is generated; nothing here is hand-written.',
    '',
    '| | |',
    '|---|---|',
    `| Generated | ${stats.generatedAt ?? 'unknown'} |`,
    `| Roles | ${stats.rows}${stats.previousRows ? ` (was ${stats.previousRows})` : ''} |`,
    `| Firms | ${stats.firms} |`,
    `| Rows with a stated deadline | ${stats.dated} |`,
    // Every other row in this table is derived here, from the files
    // themselves. This one is the collecting job's word for how its own run
    // went, and that job reads 160 third-party careers pages. It is checked
    // for shape before it arrives and labelled for what it is; nothing in
    // the verdict, the allowlist, the branch, the title or the merge
    // decision reads it, and a reviewer should not treat it as checked.
    boards ? `| Boards *(collector-reported)* | ${boards} |` : null,
    ref ? `| Collected by | \`${ref}\` |` : null,
    `| Investment banking | ${stats.verticals.find((v) => v.name === 'Investment Banking')?.to ?? 0} |`,
    runUrl ? `| Run | ${runUrl} |` : null,
    '',
    boards
      ? 'The board result is reported by the collection job rather than measured here. It is checked for shape, not for truth, and no decision in this publication depends on it.'
      : null,
    boards ? '' : null,
    '### Files',
    '',
    ...staged.map((p) => `- \`${p}\``),
    '',
    '### Verticals that moved',
    '',
  ];
  if (moved.length === 0) {
    lines.push('None. Every vertical holds the count it had yesterday.');
  } else {
    lines.push('| Vertical | Before | After | Change |', '|---|---:|---:|---:|');
    for (const v of moved) lines.push(`| ${v.name} | ${v.from} | ${v.to} | ${v.delta > 0 ? '+' : ''}${v.delta} |`);
  }
  lines.push(
    '',
    '### Checks',
    '',
    '- Every staged path is a generated-data file this workflow writes.',
    `- The feed parses, carries at least ${MIN_ROWS} rows, and every row has the fields the site indexes it by.`,
    `- The feed is stamped within ${MAX_AGE_HOURS}h.`,
    `- No vertical of ${VERTICAL_FLOOR} rows or more lost half its rows.`,
    '',
    'A run that fails any of these opens nothing and publishes nothing.',
    '',
  );
  return lines.filter((l) => l !== null).join('\n');
}

// ── CLI ──────────────────────────────────────────────────────────────────
// node scripts/validate-publication.mjs --staged <file> --prev <file>
//                                       --next <file> [--report <file>]
//                                       [--boards "94/95"] [--run-url <url>]
//
// `--boards` is the one value this script does not work out for itself: it
// comes from the collecting job's log. It reaches the pull request body
// labelled as collector-reported and is read by nothing else here.
// Exits non-zero, loudly, on anything the workflow must not publish.

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

function readJson(path) {
  if (!path) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const stagedFile = arg('staged');
  const staged = stagedFile
    ? readFileSync(stagedFile, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean)
    : [];
  const nextPath = arg('next') ?? 'data/opportunities.auto.json';

  const fatal = [];

  const unexpected = unexpectedPaths(staged);
  if (unexpected.length) {
    fatal.push(
      `this run changed ${unexpected.length} file(s) outside the generated-data allowlist: ${unexpected.join(', ')}`,
    );
  }

  let next = null;
  try {
    next = JSON.parse(readFileSync(nextPath, 'utf8'));
  } catch (err) {
    fatal.push(`${nextPath} is not readable JSON: ${err.message}`);
  }

  let stats = null;
  if (next) {
    const verdict = feedInvariants(next, readJson(arg('prev')));
    stats = verdict.stats;
    fatal.push(...verdict.problems);
  }

  if (fatal.length) {
    for (const f of fatal) console.log(`::error::${f}`);
    console.error(`\nrefusing to publish: ${fatal.length} problem(s)`);
    process.exit(1);
  }

  console.log(
    `publishable: ${staged.length} generated file(s), ${stats.rows} roles across ${stats.firms} firms, ` +
      `generated ${stats.generatedAt}`,
  );
  for (const v of stats.verticals.filter((v) => v.delta !== 0)) {
    console.log(`  ${v.name}: ${v.from} -> ${v.to} (${v.delta > 0 ? '+' : ''}${v.delta})`);
  }

  const reportPath = arg('report');
  if (reportPath) {
    writeFileSync(
      reportPath,
      publicationReport({ stats, staged, boards: arg('boards'), runUrl: arg('run-url'), ref: arg('ref') }),
    );
    console.log(`report -> ${reportPath}`);
  }
}
