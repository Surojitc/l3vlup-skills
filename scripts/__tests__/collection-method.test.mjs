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
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { METHOD_FILES, methodFingerprint } from '../../lib/board-checks.mjs';
import { PUBLISHED_PATH, acknowledge, nextLabel, publishedRegistry } from '../../lib/collection-methods.mjs';

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

// ── the published copy ───────────────────────────────────────────────────
// The site resolves a day's method from its fingerprint through this file,
// so it is the registry itself, byte for byte, and never a second copy that
// can drift. scripts/collection-method.mjs writes both on every label.
const published = existsSync(join(ROOT, PUBLISHED_PATH)) ? readFileSync(join(ROOT, PUBLISHED_PATH), 'utf8') : null;
check(`${PUBLISHED_PATH} exists`, published !== null, 'run: node scripts/collection-method.mjs --publish');
check(`${PUBLISHED_PATH} equals lib/collection-method.json byte for byte`,
  published === readFileSync(join(ROOT, 'lib/collection-method.json'), 'utf8'),
  'run: node scripts/collection-method.mjs --publish');
check('the published copy is what publishedRegistry makes of the registry', published === publishedRegistry(record));
const parsed = published ? JSON.parse(published) : {};
check('it carries current and every fingerprint with method, note and recorded',
  typeof parsed.current === 'string' && Object.values(parsed.fingerprints ?? {}).every((e) => e.method && e.note && e.recorded));

// ── every day on file ran under a labelled fingerprint ───────────────────
// A day file is immutable, so a fingerprint left unlabelled costs every day
// it ran. In November 2026 three ran for seventeen days before anyone looked.
const DAYS = join(ROOT, 'data/board-checks');
const dayFiles = existsSync(DAYS) ? readdirSync(DAYS).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)) : [];
const unlabelled = [];
const noPrint = [];
for (const f of dayFiles) {
  const day = JSON.parse(readFileSync(join(DAYS, f), 'utf8'));
  if (!day.fingerprint) noPrint.push(f);
  else if (!record.fingerprints[day.fingerprint]) unlabelled.push(`${f}: ${day.fingerprint}`);
}
check('every day file carries the fingerprint of the code that collected it', noPrint.length === 0, noPrint.join(', '));
check('every fingerprint a day file carries is labelled', unlabelled.length === 0,
  `${unlabelled.join('; ')}. Label it: node scripts/collection-method.mjs --fingerprint <fp> --new-method|--same-as <fp> --note "..."`);

// ── labelling, as pure decisions ─────────────────────────────────────────
{
  const base = {
    current: '2026-10-24',
    fingerprints: {
      aaaaaaaaaaaaaaaa: { method: '2026-10-24', note: 'the old code', recorded: '2026-10-24' },
      bbbbbbbbbbbbbbbb: { method: '2026-10-24', note: 'same as aaaa, taken while cccc was unlabelled', recorded: '2026-11-20' },
    },
  };
  const opts = { currentFingerprint: 'bbbbbbbbbbbbbbbb', today: '2026-11-27', note: 'a change that counts differently' };
  const past = acknowledge(base, { ...opts, fingerprint: 'cccccccccccccccc', mode: 'new' });
  check('a past fingerprint takes a new label dated the day it is recorded', past.entry.method === '2026-11-27');
  check('...and labelling history leaves current alone while the running code keeps its label', past.record.current === '2026-10-24');
  const again = acknowledge(past.record, { ...opts, fingerprint: 'dddddddddddddddd', mode: 'new' });
  check('a second new method recorded the same day takes a letter', again.entry.method === '2026-11-27a');
  check('nextLabel skips every label taken', nextLabel(again.record, '2026-11-27') === '2026-11-27b');
  const refused = acknowledge(past.record, { ...opts, fingerprint: 'bbbbbbbbbbbbbbbb', mode: 'same-as', sameAs: 'cccccccccccccccc' });
  check('an existing label is not replaced without --correct', !refused.changed && refused.entry.method === '2026-10-24');
  const corrected = acknowledge(past.record, { ...opts, fingerprint: 'bbbbbbbbbbbbbbbb', mode: 'same-as', sameAs: 'cccccccccccccccc', correct: true, note: 'its predecessor was cccc' });
  check('--correct gives it the named fingerprint\'s label', corrected.entry.method === '2026-11-27');
  check('...keeps what was written and appends the correction', corrected.entry.note === 'same as aaaa, taken while cccc was unlabelled. Corrected 2026-11-27: its predecessor was cccc');
  check('...keeps the date the first decision was recorded', corrected.entry.recorded === '2026-11-20');
  check('...and current follows the running code\'s corrected label', corrected.record.current === '2026-11-27');
  check('the input record is never mutated', base.fingerprints.bbbbbbbbbbbbbbbb.method === '2026-10-24' && !base.fingerprints.cccccccccccccccc);
  const throws = (f) => { try { f(); return false; } catch { return true; } };
  check('--same-as an unlabelled fingerprint is refused', throws(() => acknowledge(base, { ...opts, fingerprint: 'eeeeeeeeeeeeeeee', mode: 'same-as', sameAs: 'ffffffffffffffff' })));
  check('--correct on a fingerprint with no label is refused', throws(() => acknowledge(base, { ...opts, fingerprint: 'eeeeeeeeeeeeeeee', mode: 'new', correct: true })));
  check('a note too short to review is refused', throws(() => acknowledge(base, { ...opts, fingerprint: 'eeeeeeeeeeeeeeee', mode: 'new', note: 'x' })));
  check('something that is not a fingerprint is refused', throws(() => acknowledge(base, { ...opts, fingerprint: 'not-a-print', mode: 'new' })));
}

console.log(`\n${pass}/${pass + fail} passed`);
if (fail) process.exit(1);
