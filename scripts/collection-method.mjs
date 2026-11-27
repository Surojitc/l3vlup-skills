#!/usr/bin/env node
/**
 * Acknowledge the collection method the collector's code now implements.
 *
 *   node scripts/collection-method.mjs                      # what is running, and is it acknowledged?
 *   node scripts/collection-method.mjs --new-method --note "Workday budget raised to 900"
 *   node scripts/collection-method.mjs --same-method --note "comment-only edit to the region table"
 *
 * A fingerprint that already ran, unlabelled, and is no longer the code on disk:
 *
 *   node scripts/collection-method.mjs --fingerprint 948bc8e930f7addf --new-method --note "..."
 *   node scripts/collection-method.mjs --fingerprint 32d6b54d3df5155e --same-as f392f299234b1241 --note "..."
 *   node scripts/collection-method.mjs --fingerprint 32d6b54d3df5155e --same-as f392f299234b1241 --correct --note "..."
 *
 * And the published copy alone (the tracker collection runs this every day):
 *
 *   node scripts/collection-method.mjs --publish
 *
 * The collector fingerprints its method-sensitive files at run time
 * (lib/board-checks.mjs METHOD_FILES) and records the label a person gave
 * that fingerprint here, in lib/collection-method.json. Every edit to one of
 * those files produces a new fingerprint, and the person making it decides:
 *
 *   --new-method   the change can alter which roles a healthy board yields
 *                  (a filter, a classifier, a query, pagination, a budget).
 *                  Days either side of it are not compared.
 *   --same-method  it cannot (a comment, a log line, a refactor that moves no
 *                  role). The new fingerprint keeps the current label.
 *   --same-as <fp> it cannot, compared with the fingerprint named, whose
 *                  label it takes. For labelling history, where "the current
 *                  label" is not the predecessor's.
 *
 * `--correct` replaces a label already recorded, appending the correction to
 * its note. It exists because a `--same-method` taken while the predecessor
 * was unlabelled inherits whatever `current` happened to be, not the
 * predecessor's method (four fingerprints recorded on 20 November 2026).
 *
 * Every write also writes data/collection-methods.json, the copy of the
 * registry the site reads (lib/collection-methods.mjs says why), so the two
 * cannot be committed apart.
 *
 * Either way the decision and its note sit in the diff for a reviewer. Until
 * it is made, the day's checks are labelled `unacknowledged:<fingerprint>` and
 * compare with nothing, scripts/__tests__/collection-method.test.mjs fails on
 * every pushed branch (tests.yml), and the collection's board-check record
 * (scripts/check-board-checks.mjs) turns the run red.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { METHOD_FILES, methodFingerprint } from '../lib/board-checks.mjs';
import { PUBLISHED_PATH, REGISTRY_PATH, acknowledge, publishedRegistry, serialiseRegistry } from '../lib/collection-methods.mjs';

const ROOT = new URL('../', import.meta.url).pathname;
const RECORD = join(ROOT, REGISTRY_PATH);
const PUBLISHED = join(ROOT, PUBLISHED_PATH);

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const value = (n) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const record = JSON.parse(readFileSync(RECORD, 'utf8'));
const running = methodFingerprint((f) => readFileSync(join(ROOT, f), 'utf8'));

const publish = (r) => writeFileSync(PUBLISHED, publishedRegistry(r));

if (flag('publish')) {
  publish(record);
  console.log(`published ${REGISTRY_PATH} as ${PUBLISHED_PATH} (${Object.keys(record.fingerprints).length} fingerprints, current ${record.current})`);
  process.exit();
}

const modes = ['new-method', 'same-method'].filter(flag);
if (value('same-as')) modes.push('same-as');
if (modes.length === 0) {
  const known = record.fingerprints[running];
  console.log(`fingerprint ${running} over ${METHOD_FILES.join(', ')}`);
  if (known) {
    console.log(`acknowledged: method ${known.method} (${known.note})`);
  } else {
    console.log(`NOT acknowledged. Current method is ${record.current}. Re-run with --new-method, --same-method or --same-as <fp>, and --note.`);
    process.exitCode = 1;
  }
  process.exit();
}
if (modes.length > 1) {
  console.error(`choose one of --new-method, --same-method, --same-as (got ${modes.join(', ')})`);
  process.exit(2);
}

const fingerprint = value('fingerprint') ?? running;
let result;
try {
  result = acknowledge(record, {
    fingerprint,
    currentFingerprint: running,
    mode: { 'new-method': 'new', 'same-method': 'same', 'same-as': 'same-as' }[modes[0]],
    sameAs: value('same-as'),
    note: value('note'),
    correct: flag('correct'),
    today: new Date().toISOString().slice(0, 10),
  });
} catch (e) {
  console.error(e.message);
  process.exit(2);
}
if (!result.changed) {
  console.log(`${fingerprint} is already acknowledged as ${result.entry.method}; nothing to do (--correct replaces a label)`);
  process.exit();
}
writeFileSync(RECORD, serialiseRegistry(result.record));
publish(result.record);
console.log(`recorded ${fingerprint} as method ${result.entry.method}; current is ${result.record.current}; ${PUBLISHED_PATH} rewritten`);
