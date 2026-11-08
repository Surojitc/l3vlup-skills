#!/usr/bin/env node
/**
 * Is what the collectors published actually fresh, and is it what the site
 * is serving?
 *
 *   node scripts/data-health.mjs [--summary "$GITHUB_STEP_SUMMARY"] [--site https://www.l3vlup.com]
 *
 * WHY
 * ---
 * Each collector checks itself, inside its own run. On 1 November 2026 a run
 * did three hours of work and published nothing, and nothing outside that
 * run said so; the site showed October's 13F books behind a page that looked
 * fine. This is the check from outside: once a day, against `main` as it is
 * and against the live site, with no stake in any run.
 *
 * WHAT FAILS IT (exit 1, so GitHub tells the repository owner)
 * ------------------------------------------------------------
 * - any producer with a stale source (its horizon has passed);
 * - a 13F source degraded or stale;
 * - the live 13F page serving a collection older than `main`'s by more than
 *   LAG_HOURS, once `main`'s copy has been there longer than the site's two
 *   hourly caches need to pick it up.
 *
 * Degraded sources elsewhere are named as warnings. It reads `main` and one
 * public page, and writes only the job summary.
 */

import { appendFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { CONTRACTS, freshnessReport } from './publication-contracts.mjs';
import { productionLag, letterFunnel } from '../lib/data-health.mjs';

const argv = process.argv.slice(2);
const arg = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const site = (arg('site') || 'https://www.l3vlup.com').replace(/\/$/, '');
const summary = arg('summary');

function read(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
function committedAt(path) {
  try {
    return execFileSync('git', ['log', '-1', '--format=%cI', '--', path], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
}

const failures = [];
const warnings = [];
const lines = ['## Data health', ''];

// 1. Every producer's sources, as main holds them.
lines.push('| Producer | Stale | Degraded |', '|---|---|---|');
for (const producer of Object.keys(CONTRACTS)) {
  const report = freshnessReport(producer, { read, committedAt, expected: [], since: undefined });
  const stale = report.sources.filter((s) => s.state === 'stale');
  const degraded = report.sources.filter((s) => s.state === 'degraded');
  lines.push(`| ${producer} | ${stale.map((s) => s.label).join(', ') || 'none'} | ${degraded.map((s) => s.label).join(', ') || 'none'} |`);
  for (const s of stale) failures.push(`${producer}: ${s.label} is stale (${s.ageHours}h)`);
  for (const s of degraded) {
    (/13F/.test(s.label) ? failures : warnings).push(`${producer}: ${s.label} is degraded${s.note ? `, ${s.note}` : ''}`);
  }
}

// 2. What the live site serves against what main holds.
const funds = read('data/funds.auto.json');
let live = null;
try {
  const res = await fetch(`${site}/intel/funds`, { headers: { 'User-Agent': 'l3vlup-data-health' } });
  const html = await res.text();
  const at = html.indexOf('data-funds-freshness');
  const m = at >= 0 ? /dateTime="([^"]+)"/.exec(html.slice(at, at + 4000)) : null;
  live = m ? m[1] : null;
  if (!res.ok) warnings.push(`${site}/intel/funds answered ${res.status}`);
} catch (e) {
  warnings.push(`could not read ${site}/intel/funds: ${e.message}`);
}
const lag = productionLag({ main: funds?.generatedAt, mainCommitted: committedAt('data/funds.auto.json'), live, now: new Date() });
lines.push('', `13F on main: ${funds?.generatedAt ?? 'unreadable'} · live: ${live ?? 'not found on the page'} · ${lag.verdict}`);
if (lag.problem) failures.push(lag.problem);
else if (lag.warning) warnings.push(lag.warning);

// 3. The letters funnel, for the record.
const funnel = letterFunnel(read('data/letters.review-queue.json'), read('data/letters.catalogue-keys.json'));
lines.push('', `Letters: ${funnel.published} published · ${funnel.queued} in the review queue (${funnel.likely} likely letters) · ${funnel.decided} decided`);

lines.push('');
for (const f of failures) lines.push(`- 🔴 ${f}`);
for (const w of warnings) lines.push(`- 🟡 ${w}`);
if (!failures.length && !warnings.length) lines.push('Everything is fresh and live.');
const text = `${lines.join('\n')}\n`;
console.log(text);
if (summary) appendFileSync(summary, text);
for (const w of warnings) console.log(`::warning::${w}`);
for (const f of failures) console.log(`::error::${f}`);
process.exit(failures.length ? 1 : 0);
