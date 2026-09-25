#!/usr/bin/env node
/**
 * How old the undated roles in the feed are, measured every way the data allows.
 *
 * WHY
 * The feed carries roughly a thousand live rows with no closing date, and the
 * site shows each as "Listed" for as long as its employer's board keeps it.
 * Before any rule decides when such a row is stale, this prints what each
 * candidate rule would actually touch, so the rule is chosen against counts
 * rather than intuition. It reads the committed files and writes nothing; the
 * tables in docs/role-lifecycle-telemetry-2026-09.md are its output.
 *
 * Run: node scripts/report-role-lifecycle.mjs [--today YYYY-MM-DD]
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  daysBetween,
  firstSeenIndex,
  inferCohortYear,
  postedAgeDays,
  sourceFamily,
} from '../lib/role-telemetry.mjs';
import { nonRoleReason } from '../lib/role-screen.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));

const feed = read('data/opportunities.auto.json');
const archive = read('data/tracker-archive.json').roles ?? {};
const snapshots = read('data/tracker-history.json').snapshots ?? [];

const argAt = process.argv.indexOf('--today');
// Measured against the day the feed was written, so the tables describe the
// feed as published rather than drifting with the day the script is run.
const today = argAt > 0 ? process.argv[argAt + 1] : String(feed.generatedAt).slice(0, 10);
const thisYear = Number(today.slice(0, 4));

const rows = feed.opportunities ?? [];
const undated = rows.filter((r) => !r.closingDate);
const historyFirst = firstSeenIndex(snapshots);

const table = (head, body) =>
  [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...body.map((r) => `| ${r.join(' | ')} |`)].join('\n');

function bucket(value, edges, none = 'unknown') {
  if (value === null || value === undefined) return none;
  for (let i = 0; i < edges.length - 1; i += 1) {
    if (value >= edges[i] && value < edges[i + 1]) {
      return edges[i + 1] === Infinity ? `${edges[i]}+` : `${edges[i]}-${edges[i + 1] - 1}`;
    }
  }
  return none;
}

function distribution(title, values, edges, none) {
  const counts = new Map();
  const labels = [];
  for (let i = 0; i < edges.length - 1; i += 1) {
    labels.push(edges[i + 1] === Infinity ? `${edges[i]}+` : `${edges[i]}-${edges[i + 1] - 1}`);
  }
  labels.push(none);
  for (const l of labels) counts.set(l, 0);
  for (const v of values) {
    const b = bucket(v, edges, none);
    counts.set(b, (counts.get(b) ?? 0) + 1);
  }
  const total = values.length;
  console.log(`\n### ${title}\n`);
  console.log(
    table(
      ['days', 'rows', 'share'],
      labels.map((l) => [l, counts.get(l), `${((100 * counts.get(l)) / total).toFixed(1)}%`])
    )
  );
}

const AGE = [0, 7, 14, 30, 60, 90, 180, 365, Infinity];

console.log(`# Role lifecycle telemetry, feed of ${today}\n`);
console.log(`Live rows: ${rows.length}. With no closing date: ${undated.length}.`);
console.log(`History: ${snapshots.length} snapshots, ${snapshots[0]?.date} to ${snapshots.at(-1)?.date}.`);

/* (a) days since first seen -------------------------------------------------- */
const fromHistory = undated.map((r) => daysBetween(historyFirst.get(r.id), today));
const fromArchive = undated.map((r) => daysBetween(archive[r.slug]?.firstSeen, today));
distribution('(a1) Days since first seen in tracker-history.json (floor: history starts 2026-08-18)', fromHistory, AGE, 'not in history');
distribution('(a2) Days since firstSeen in tracker-archive.json (floor: archive starts 2026-08-01)', fromArchive, AGE, 'not in archive');

/* (b) posted-date age -------------------------------------------------------- */
const posted = undated.map((r) => postedAgeDays(r.openingDate, today));
distribution('(b) Age of the ATS posted date (openingDate)', posted, AGE, 'no posted date');

const families = [...new Set(undated.map(sourceFamily))].sort();
console.log('\n### (b, d) Posted-date age by source family\n');
const POSTED = [0, 30, 90, 180, 365, Infinity];
const postedLabels = ['0-29', '30-89', '90-179', '180-364', '365+', 'no posted date'];
console.log(
  table(
    ['source', 'undated rows', ...postedLabels],
    families.map((f) => {
      const mine = undated.filter((r) => sourceFamily(r) === f);
      const counts = Object.fromEntries(postedLabels.map((l) => [l, 0]));
      for (const r of mine) counts[bucket(postedAgeDays(r.openingDate, today), POSTED, 'no posted date')] += 1;
      return [f, mine.length, ...postedLabels.map((l) => counts[l])];
    })
  )
);

/* (c) recruiting year in the title ------------------------------------------ */
console.log('\n### (c) Recruiting year named in the title\n');
const cohort = undated.map((r) => ({ r, ...inferCohortYear(r.role) }));
const yearBucket = (y) => (y === null ? 'none' : y < thisYear ? `past (< ${thisYear})` : y === thisYear ? `${thisYear}` : `${thisYear + 1}+`);
const yearCounts = {};
for (const c of cohort) yearCounts[yearBucket(c.cohortYear)] = (yearCounts[yearBucket(c.cohortYear)] ?? 0) + 1;
console.log(table(['cohort year', 'rows'], Object.entries(yearCounts).sort().map(([k, v]) => [k, v])));
const past = cohort.filter((c) => c.cohortYear !== null && c.cohortYear < thisYear);
console.log(`\nRows naming only past years (${past.length}):\n`);
console.log(
  table(
    ['slug', 'title', 'source', 'posted', 'first seen'],
    past
      .sort((a, b) => a.r.slug.localeCompare(b.r.slug))
      .map(({ r }) => [r.slug, r.role.replace(/\|/g, '/'), sourceFamily(r), r.openingDate ?? '-', archive[r.slug]?.firstSeen ?? historyFirst.get(r.id) ?? '-'])
  )
);
const summer = cohort.filter((c) => c.cohortYear === thisYear && /\bsummer\b/i.test(c.r.role));
console.log(`\nRows whose latest year is ${thisYear} and which say "summer": ${summer.length}`);

/* (d) source ------------------------------------------------------------------ */
console.log('\n### (d) Source family\n');
console.log(
  table(
    ['source', 'live rows', 'undated', 'undated share'],
    families.map((f) => {
      const all = rows.filter((r) => sourceFamily(r) === f).length;
      const u = undated.filter((r) => sourceFamily(r) === f).length;
      return [f, all, u, `${((100 * u) / all).toFixed(0)}%`];
    })
  )
);

/* candidate rules ------------------------------------------------------------ */
console.log('\n### Candidate rules: undated live rows each would touch\n');
const atLeast = (values, n) => values.filter((v) => v !== null && v >= n).length;
const THRESHOLDS = [7, 14, 30, 60, 90, 180, 365];
const carried = rows.filter((r) => (r.tags ?? []).includes('Unconfirmed'));
console.log(
  table(
    ['rule', ...THRESHOLDS.map((t) => `>= ${t}d`)],
    [
      ['carried from a failed board (unconfirmedDays)', ...THRESHOLDS.map((t) => carried.filter((r) => (r.unconfirmedDays ?? 0) >= t).length)],
      ['in the feed since (history firstSeen)', ...THRESHOLDS.map((t) => atLeast(fromHistory, t))],
      ['in the feed since (archive firstSeen)', ...THRESHOLDS.map((t) => atLeast(fromArchive, t))],
      ['posted-date age', ...THRESHOLDS.map((t) => atLeast(posted, t))],
    ]
  )
);
console.log(`\nPast year in title, no later year: ${past.length}.`);
console.log(`Past year in title AND posted >= 180 days ago: ${past.filter(({ r }) => (postedAgeDays(r.openingDate, today) ?? -1) >= 180).length}.`);

/* absence: how often a role leaves and comes back ---------------------------- */
console.log('\n### Absence spells in the history (a role missing from a snapshot, then back)\n');
const present = snapshots.map((s) => new Set(s.ids ?? []));
const allIds = new Set(snapshots.flatMap((s) => s.ids ?? []));
const gaps = [];
let departed = 0;
for (const id of allIds) {
  let seen = false;
  let run = 0;
  for (let i = 0; i < present.length; i += 1) {
    if (present[i].has(id)) {
      if (seen && run > 0) gaps.push(run);
      seen = true;
      run = 0;
    } else if (seen) run += 1;
  }
  if (seen && run > 0) departed += 1;
}
const gapCounts = {};
for (const g of gaps) {
  const k = g >= 7 ? '7+' : String(g);
  gapCounts[k] = (gapCounts[k] ?? 0) + 1;
}
console.log(`Ids ever seen: ${allIds.size}. Currently absent after being seen: ${departed}. Absences that ended with the role returning: ${gaps.length}.\n`);
console.log(table(['snapshots missing before it returned', 'returns'], Object.entries(gapCounts).sort().map(([k, v]) => [k, v])));

/* what the non-role screen would remove, for the record ---------------------- */
const screened = rows.filter((r) => nonRoleReason(r.role));
console.log(`\nRows the non-role screen removes from this feed: ${screened.length} (${screened.map((r) => r.slug).join(', ')}).`);
