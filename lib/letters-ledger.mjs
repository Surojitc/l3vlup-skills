// The request record, in two halves, because they answer different questions.
//
// The tracked ledger at data/letters.requests.jsonl is durable evidence: the
// discovery and validation milestones, and the one production verification
// that proved the pipeline. It is committed, it is read in review, and it
// should stay small enough that a person can read it.
//
// Routine production polling is not that. Nine identical 200s every time the
// workflow runs tells nobody anything, and appending them to a tracked file
// makes every run look like a change — which is exactly the noise the
// deterministic output was built to remove. Those go to a run log: printed
// to the job summary, carried in a one-day artifact, and then gone.
//
// A request crosses back into the durable ledger only on a material event,
// and the list of those is closed and named below. Anything else is routine.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const LEDGER = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'letters.requests.jsonl');

/** Where routine attempts go. Untracked, run-scoped, discarded with the runner. */
export const RUN_LOG_ENV = 'LETTERS_RUN_LOG';
export function runLogPath(env = process.env) {
  return env[RUN_LOG_ENV] || join(tmpdir(), 'letters-requests.run.jsonl');
}

/**
 * The only reasons a request earns a line in the committed ledger.
 *
 * Closed on purpose. "It seemed worth keeping" is how an audit record turns
 * into a log file, and a log file nobody reads is not evidence of anything.
 */
export const MATERIAL_EVENTS = Object.freeze({
  new_document: 'a document the committed output had never seen before',
  source_change: 'the bytes at an approved URL changed: a new hash for a filing we already held',
  error: 'a refusal, a non-200 or a parse failure that a person should be able to investigate later',
  milestone_verification: 'a deliberate, named verification run, recorded once and by hand',
});

export const isMaterial = (kind) => Object.prototype.hasOwnProperty.call(MATERIAL_EVENTS, kind);

/** Append a line verbatim. The low-level write both halves are built on. */
export function appendLedger(entry, path = LEDGER) {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
}

/** A routine attempt: the run log, never the repository. */
export function appendRunLog(entry, path = runLogPath()) {
  return appendLedger(entry, path);
}

/**
 * A material attempt: the committed ledger, and only with a reason from the
 * closed list and a note of where it was observed. Refused otherwise, so a
 * caller cannot widen the policy by forgetting to name it.
 */
export function appendDurable(entry, path = LEDGER) {
  if (!isMaterial(entry.material)) {
    throw new Error(`${entry.material ?? 'an unnamed event'} is not a material event: ${Object.keys(MATERIAL_EVENTS).join(', ')}`);
  }
  if (!entry.observedIn) throw new Error('a durable entry must say where it was observed: a workflow run id, or "local"');
  return appendLedger(entry, path);
}

/**
 * What the ledger says was actually sent, split by how we know it.
 *
 * `observed` lines were written by a script at the moment of the attempt.
 * `reconstructed` lines were written after the fact, from the run output of
 * the first two milestones, and are marked in the file; they are evidence of
 * what happened, not an independent record of it, and the two are never
 * added together without saying so.
 */
export function ledgerSummary(path = LEDGER) {
  if (!existsSync(path)) return { observed: 0, reconstructed: 0, byScript: {}, note: null };
  const lines = readFileSync(path, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const note = lines.find((l) => l.note)?.note || null;
  const attempts = lines.filter((l) => l.status !== undefined);
  const byScript = {};
  for (const a of attempts) {
    const k = a.script;
    byScript[k] ||= { observed: 0, reconstructed: 0 };
    byScript[k][a.reconstructed ? 'reconstructed' : 'observed'] += 1;
  }
  return {
    observed: attempts.filter((a) => !a.reconstructed).length,
    reconstructed: attempts.filter((a) => a.reconstructed).length,
    byScript,
    note,
  };
}

/**
 * The run log as a table for the job summary.
 *
 * This is where a routine run's request detail is meant to be read: visible
 * for a day beside the run that made it, and not in the repository's history
 * for ever.
 */
export function renderRunSummary(path = runLogPath()) {
  if (!existsSync(path)) return '## Requests\n\nNo requests were made.\n';
  const rows = readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  if (!rows.length) return '## Requests\n\nNo requests were made.\n';
  const out = [
    `## Requests: ${rows.length}`,
    '',
    'Routine attempts, kept with this run and not committed. A request reaches',
    `the tracked ledger only on a material event: ${Object.keys(MATERIAL_EVENTS).join(', ')}.`,
    '',
    '| # | Time | Gap (ms) | Status | Host | Document |',
    '|---|---|---|---|---|---|',
  ];
  let previous = null;
  rows.forEach((r, i) => {
    const t = Date.parse(r.at);
    const gap = previous === null ? '' : t - previous;
    previous = t;
    let host = 'unparsed';
    let name = r.url;
    try {
      const u = new URL(r.url);
      host = u.hostname;
      name = u.pathname.split('/').pop();
    } catch { /* a malformed URL is still worth showing whole */ }
    out.push(`| ${i + 1} | ${r.at} | ${gap} | ${r.status} | ${host} | ${name} |`);
  });
  return `${out.join('\n')}\n`;
}
