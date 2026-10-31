#!/usr/bin/env node
/**
 * Refresh data/fx.auto.json from the European Central Bank's euro reference
 * rates (docs: the header of lib/fx-rates.mjs says what is checked and why).
 *
 *   node scripts/fx-rates.mjs [--out data/fx.auto.json]
 *        [--url https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml]
 *        [--xml fixture.xml]      read this file instead of the network (tests)
 *        [--retry-ms 2000]        the pause between fetch attempts (tests shorten it)
        [--now 2026-11-02T08:00:00Z]   the clock (tests only; no workflow passes it)
 *
 * Fetches one small public XML file, no key and no account. Validates it
 * against the rules in lib/fx-rates.mjs and the file already published, and
 * only then writes. On any failure it writes NOTHING (not an empty file, not
 * a partial one, not a new timestamp), prints every reason to stderr and
 * exits 1, so the workflow goes red and the last valid table stays in place.
 * The write is a rename of a finished temporary file, so even a crash cannot
 * leave half a table behind.
 *
 * Exit codes: 0 written or already current, 1 refused (reasons on stderr),
 * 2 bad arguments.
 */

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { ECB_URL, refresh } from '../lib/fx-rates.mjs';

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

const out = resolve(arg('out') ?? 'data/fx.auto.json');
const url = arg('url') ?? ECB_URL;
const xmlFile = arg('xml');
const retryMs = Number(arg('retry-ms') ?? 2000);
const nowArg = arg('now');
const now = nowArg === undefined ? new Date() : new Date(nowArg);
if (!Number.isFinite(retryMs) || retryMs < 0) {
  console.error(`--retry-ms must be a non-negative number`);
  process.exit(2);
}
if (Number.isNaN(now.getTime()) || (nowArg !== undefined && !/^\d{4}-\d{2}-\d{2}T/.test(nowArg))) {
  console.error(`--now must be an ISO timestamp, got ${JSON.stringify(nowArg)}`);
  process.exit(2);
}

function refuse(problems) {
  for (const p of problems) console.error(`fx-rates: refused: ${p}`);
  console.error(`fx-rates: nothing was written; ${existsSync(out) ? 'the last published table stands' : 'there is no published table yet'}`);
  process.exit(1);
}

/** Up to three attempts at a transient failure; a clean answer that is wrong is not retried. */
async function fetchXml() {
  let last = 'no attempt made';
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const res = await fetch(url, { headers: { Accept: 'application/xml, text/xml' }, signal: AbortSignal.timeout(30_000) });
      if (res.ok) return await res.text();
      last = `HTTP ${res.status}`;
      if (res.status < 500) break; // a 4xx will not get better on retry
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
    }
    if (attempt < 3) await new Promise((r) => setTimeout(r, retryMs));
  }
  return { error: `could not fetch ${url}: ${last}` };
}

let prev = null;
if (existsSync(out)) {
  try {
    prev = JSON.parse(readFileSync(out, 'utf8'));
  } catch {
    prev = {}; // present but unreadable: not a usable baseline, said below
  }
}

const body = xmlFile ? readFileSync(xmlFile, 'utf8') : await fetchXml();
if (typeof body !== 'string') refuse([body.error]);

const result = refresh({ xml: body, now, prev });
if (!result.ok) refuse(result.problems);
for (const w of result.warnings) console.warn(`fx-rates: warning: ${w}`);

if (result.unchanged) {
  console.log(`fx-rates: ${result.fx.asOf} is already published; nothing to write`);
  process.exit(0);
}

mkdirSync(dirname(out), { recursive: true });
const tmp = `${out}.tmp-${process.pid}`;
try {
  writeFileSync(tmp, `${JSON.stringify(result.fx, null, 2)}\n`);
  renameSync(tmp, out);
} catch (e) {
  rmSync(tmp, { force: true });
  console.error(`fx-rates: could not write ${out}: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
}
const { asOf, perUsd } = result.fx;
console.log(`fx-rates: wrote ${out}: ${asOf}, EUR ${perUsd.EUR}, GBP ${perUsd.GBP} per US dollar`);
