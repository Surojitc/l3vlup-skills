/**
 * The collector's method is acknowledged.
 *
 *   node scripts/__tests__/collection-method.test.mjs
 *
 * Fails when a method-sensitive file (lib/board-checks.mjs METHOD_FILES) has
 * changed and nobody has said, in lib/collection-method.json, whether the
 * change can alter which roles a board yields. The collector does not depend
 * on this test to be safe: an unacknowledged run is labelled so that it
 * compares with nothing. This is what makes the gap visible before it is one.
 * The fix is one command: node scripts/collection-method.mjs.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { METHOD_FILES, methodFingerprint } from '../../lib/board-checks.mjs';

const ROOT = new URL('../../', import.meta.url).pathname;
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        ${detail}`}`);
  ok ? pass++ : fail++;
};

const record = JSON.parse(readFileSync(join(ROOT, 'lib/collection-method.json'), 'utf8'));
check('every method file exists', METHOD_FILES.every((f) => existsSync(join(ROOT, f))), METHOD_FILES.filter((f) => !existsSync(join(ROOT, f))).join(', '));
const fp = methodFingerprint((f) => readFileSync(join(ROOT, f), 'utf8'));
const entry = record.fingerprints?.[fp];
check(
  `the running fingerprint ${fp} is acknowledged`,
  Boolean(entry),
  `a method file changed. Run: node scripts/collection-method.mjs --new-method (or --same-method) --note "what changed"`
);
check('it maps to the current method, so a new label is not left behind by an old fingerprint',
  !entry || entry.method === record.current, `${entry?.method} vs current ${record.current}`);
const labels = Object.values(record.fingerprints ?? {});
check('every label is a date, with a letter if two landed on one day',
  labels.every((e) => /^\d{4}-\d{2}-\d{2}[a-z]?$/.test(e.method)), JSON.stringify(labels.map((e) => e.method)));
check('every acknowledgement says what changed', labels.every((e) => typeof e.note === 'string' && e.note.length >= 8));
check('the current method is one someone recorded', labels.some((e) => e.method === record.current));

console.log(`\n${pass}/${pass + fail} passed`);
if (fail) process.exit(1);
