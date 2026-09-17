// Every network attempt the letters scripts make, appended as one line to
// data/letters.requests.jsonl and committed with the reports, so the count
// of requests to sec.gov survives a re-run from cache. A failed attempt and
// its retry are two lines. Cache reads are not requests and are not here.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const LEDGER = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'letters.requests.jsonl');

export function appendLedger(entry, path = LEDGER) {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
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
