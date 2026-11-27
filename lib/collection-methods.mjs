/**
 * The collection-method registry: how a fingerprint is labelled, and the copy
 * of the registry the site reads.
 *
 * lib/board-checks.mjs explains why a run's method is a fingerprint of the
 * collector's own code, labelled by a person in lib/collection-method.json.
 * This module holds the two things that registry needed and did not have.
 *
 * 1. A PUBLISHED COPY. A day file records the method its run could resolve
 *    when it ran. A fingerprint labelled later (98d917eca505441d ran from 13
 *    October and was labelled on the 24th) leaves its earlier days reading
 *    `unacknowledged:<fp>` for ever, because day files are immutable history
 *    and are never rewritten. So the registry is published beside them, as
 *    data/collection-methods.json, and the site resolves each day's method
 *    from its `fingerprint` through `fingerprints[fp].method`, falling back to
 *    the file's own `method`. The copy is the registry byte for byte: one
 *    source, no second vocabulary, and a test holds them equal.
 *
 * 2. LABELLING A FINGERPRINT THAT ALREADY RAN. scripts/collection-method.mjs
 *    could only label the code on disk. Three fingerprints ran unlabelled for
 *    seventeen days in November 2026 (the suite that would have failed was in
 *    no workflow's list), and by the time anyone looked, the code had moved
 *    on. `acknowledge` takes the fingerprint to label explicitly, can give it
 *    the method of another fingerprint (`sameAs`), and can correct a label
 *    that was resolved against the wrong predecessor (`correct`), saying so
 *    in the note rather than replacing what was written.
 *
 * `current` is always the method of the code on disk when that code is
 * labelled, so labelling history never moves it and correcting the running
 * code's label moves it with the correction.
 *
 * Pure: the CLI reads and writes the files.
 */

export const REGISTRY_PATH = 'lib/collection-method.json';
export const PUBLISHED_PATH = 'data/collection-methods.json';

/** The registry as written to disk: two-space JSON and a trailing newline. */
export function serialiseRegistry(record) {
  return JSON.stringify(record, null, 2) + '\n';
}

/** The published copy: the registry itself, byte for byte. */
export function publishedRegistry(record) {
  return serialiseRegistry(record);
}

const FP = /^[0-9a-f]{16}$/;
const LABEL = /^\d{4}-\d{2}-\d{2}[a-z]?$/;

/** A label for a new method recorded `today`, distinct from every label taken. */
export function nextLabel(record, today) {
  const taken = new Set(Object.values(record.fingerprints ?? {}).map((e) => e.method));
  let method = today;
  for (let i = 0; taken.has(method); i += 1) method = `${today}${String.fromCharCode(97 + i)}`;
  return method;
}

/**
 * Record a decision about one fingerprint. Returns { record, entry, changed }
 * or throws with a message for the person running the CLI.
 *
 * @param record              the registry as read
 * @param fingerprint         the fingerprint being labelled
 * @param currentFingerprint  the fingerprint of the code on disk
 * @param mode                'new' (a new method), 'same' (the current
 *                            method) or 'same-as' (the method of `sameAs`)
 * @param note                what changed, in words a reviewer can check
 * @param correct             replace an existing label, keeping its note
 * @param today               ISO date the decision is recorded
 */
export function acknowledge(record, { fingerprint, currentFingerprint, mode, sameAs, note, correct = false, today }) {
  if (!FP.test(String(fingerprint))) throw new Error(`not a fingerprint: ${fingerprint}`);
  if (!note || note.length < 8) throw new Error('--note is required: say what changed, in words a reviewer can check against the diff');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(today))) throw new Error(`not an ISO date: ${today}`);
  const next = { ...record, fingerprints: { ...(record.fingerprints ?? {}) } };
  const existing = next.fingerprints[fingerprint];
  if (existing && !correct) return { record, entry: existing, changed: false };
  if (!existing && correct) throw new Error(`${fingerprint} has no label to correct`);

  let method;
  if (mode === 'new') method = nextLabel(next, today);
  else if (mode === 'same') method = record.current;
  else if (mode === 'same-as') {
    const source = next.fingerprints[sameAs];
    if (!source) throw new Error(`--same-as ${sameAs} has no label`);
    if (sameAs === fingerprint) throw new Error('a fingerprint cannot take its own label');
    method = source.method;
  } else throw new Error(`unknown mode: ${mode}`);
  if (!LABEL.test(String(method))) throw new Error(`not a method label: ${method}`);

  const entry = existing
    ? { method, note: `${existing.note}${/[.!?]$/.test(existing.note) ? '' : '.'} Corrected ${today}: ${note}`, recorded: existing.recorded }
    : { method, note, recorded: today };
  next.fingerprints[fingerprint] = entry;
  // `current` follows the code on disk. Labelling a fingerprint that ran in
  // the past leaves it alone unless that past code is still what runs.
  const running = next.fingerprints[currentFingerprint];
  if (running) next.current = running.method;
  return { record: next, entry, changed: true };
}
