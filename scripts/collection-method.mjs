#!/usr/bin/env node
/**
 * Acknowledge the collection method the collector's code now implements.
 *
 *   node scripts/collection-method.mjs                      # what is running, and is it acknowledged?
 *   node scripts/collection-method.mjs --new-method --note "Workday budget raised to 900"
 *   node scripts/collection-method.mjs --same-method --note "comment-only edit to the region table"
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
 *
 * Either way the decision and its note sit in the diff for a reviewer. Until
 * it is made, the day's checks are labelled `unacknowledged:<fingerprint>` and
 * compare with nothing, and scripts/__tests__/collection-method.test.mjs fails.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { METHOD_FILES, methodFingerprint } from '../lib/board-checks.mjs';

const ROOT = new URL('../', import.meta.url).pathname;
const RECORD = join(ROOT, 'lib/collection-method.json');

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const value = (n) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const record = JSON.parse(readFileSync(RECORD, 'utf8'));
const fingerprint = methodFingerprint((f) => readFileSync(join(ROOT, f), 'utf8'));
const known = record.fingerprints[fingerprint];

if (!flag('new-method') && !flag('same-method')) {
  console.log(`fingerprint ${fingerprint} over ${METHOD_FILES.join(', ')}`);
  if (known) {
    console.log(`acknowledged: method ${known.method} (${known.note})`);
  } else {
    console.log(`NOT acknowledged. Current method is ${record.current}. Re-run with --new-method or --same-method, and --note.`);
    process.exitCode = 1;
  }
  process.exit();
}

const note = value('note');
if (!note || note.length < 8) {
  console.error('--note is required: say what changed, in words a reviewer can check against the diff');
  process.exit(2);
}
if (known) {
  console.log(`already acknowledged as ${known.method}; nothing to do`);
  process.exit();
}

let method = record.current;
if (flag('new-method')) {
  const today = new Date().toISOString().slice(0, 10);
  const taken = new Set(Object.values(record.fingerprints).map((e) => e.method));
  method = today;
  for (let i = 0; taken.has(method); i += 1) method = `${today}${String.fromCharCode(97 + i)}`;
  record.current = method;
}
record.fingerprints[fingerprint] = { method, note, recorded: new Date().toISOString().slice(0, 10) };
writeFileSync(RECORD, JSON.stringify(record, null, 2) + '\n');
console.log(`recorded ${fingerprint} as method ${method}`);
