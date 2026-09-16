// Every network attempt the letters scripts make, appended as one line to
// data/letters.requests.jsonl and committed with the reports, so the count
// of requests to sec.gov survives a re-run from cache. A failed attempt and
// its retry are two lines. Cache reads are not requests and are not here.

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const LEDGER = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'letters.requests.jsonl');

export function appendLedger(entry, path = LEDGER) {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
}
