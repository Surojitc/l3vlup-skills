#!/usr/bin/env node
/**
 * Is the Hiring Pulse's record whole? Missing days, unlabelled fingerprints,
 * an unpublished registry, a stale record and a collapse in coverage
 * (lib/board-check-health.mjs says what each means and why).
 *
 *   node scripts/check-board-checks.mjs [--through today|yesterday|YYYY-MM-DD] \
 *        [--running] [--summary "$GITHUB_STEP_SUMMARY"] [--output "$GITHUB_OUTPUT"]
 *
 * `--through` is the last date a file is due for: `today` inside the tracker
 * collection, which has just written today's; `yesterday` from outside it,
 * because GitHub starts the morning schedule as late as the evening.
 * `--running` also requires the code on disk to be a labelled method, which
 * is what the collection that ran it needs to know.
 *
 * Like the freshness sweep, it never fails the step that runs it: the
 * collection publishes first, and its `board-checks` job reads the
 * `board_checks` output and turns the run red after. Every problem is an
 * error annotation here, so the run's summary page names it. Exit 2 only on
 * bad arguments.
 */

import { appendFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { methodFingerprint } from '../lib/board-checks.mjs';
import { boardCheckHealth, healthSummary } from '../lib/board-check-health.mjs';
import { PUBLISHED_PATH, REGISTRY_PATH } from '../lib/collection-methods.mjs';

const ROOT = new URL('../', import.meta.url).pathname;
const argv = process.argv.slice(2);
const arg = (n) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

/** Everything the check reads, from a repository checkout. Shared with scripts/data-health.mjs. */
export function readRecord(root = ROOT, { running = false } = {}) {
  const dir = join(root, 'data/board-checks');
  const days = existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
        .map((f) => {
          let file = null;
          try {
            file = JSON.parse(readFileSync(join(dir, f), 'utf8'));
          } catch {
            /* unreadable: reported as such */
          }
          return { date: f.slice(0, 10), file };
        })
    : [];
  const registryText = readFileSync(join(root, REGISTRY_PATH), 'utf8');
  const publishedText = existsSync(join(root, PUBLISHED_PATH)) ? readFileSync(join(root, PUBLISHED_PATH), 'utf8') : null;
  return {
    days,
    registry: JSON.parse(registryText),
    publishedMatches: publishedText === registryText,
    currentFingerprint: running ? methodFingerprint((f) => readFileSync(join(root, f), 'utf8')) : undefined,
  };
}

/** `today`, `yesterday` or a date, as a date. */
export function resolveThrough(value, now = new Date()) {
  const today = now.toISOString().slice(0, 10);
  if (!value || value === 'today') return today;
  if (value === 'yesterday') return new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  return null;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const through = resolveThrough(arg('through'));
  if (!through) {
    console.error('--through must be today, yesterday or YYYY-MM-DD');
    process.exit(2);
  }
  const running = argv.includes('--running');
  const result = boardCheckHealth({ ...readRecord(ROOT, { running }), through, now: new Date() });

  console.log(`board-check record through ${through}: newest ${result.latest} (${result.ageHours}h), ` +
    `${result.coverage ? `${result.coverage.ok} boards ok against a median of ${result.coverage.median}` : 'no coverage baseline'}`);
  for (const p of result.problems) console.log(`::error title=Board-check record: ${p.code}::${p.detail.replace(/[\r\n%]/g, ' ')}`);
  if (!result.problems.length) console.log('the board-check record is whole');

  const summary = arg('summary');
  if (summary) appendFileSync(summary, healthSummary(result));
  const output = arg('output');
  if (output) appendFileSync(output, `board_checks=${result.problems.length ? 'problems' : 'ok'}\n`);
}
