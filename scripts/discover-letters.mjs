#!/usr/bin/env node
// Letters research, Phase 0: discovery only.
//
// Lists the SEC-filed documents that may carry a fund's own investment
// writing, for the sources approved in data/letters.sources.json, and writes
// a review report. It downloads no document, parses no PDF, calls no model
// and creates no archive. One request per active source: the filer's
// submissions index on data.sec.gov, cached for a day under .cache/letters
// so a re-run costs nothing.
//
// It stops, with the report written as far as it got, on any 403 or 429 from
// the SEC, on a source whose rights or retrieval mode are not what the
// registry test requires, and on an index whose entity name is not the
// filer we meant (a mistyped CIK would otherwise list a stranger's filings).
//
//   node scripts/discover-letters.mjs            # writes data/letters.discovery.{json,md}
//   node scripts/discover-letters.mjs --dry-run  # reads and reports, writes nothing
//   FORCE=1 node scripts/discover-letters.mjs    # ignore the day-old cache

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { activeSources, capAcrossFunds, entityMatches, selectCandidates } from '../lib/letters.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY = join(ROOT, 'data', 'letters.sources.json');
const OUT_JSON = join(ROOT, 'data', 'letters.discovery.json');
const OUT_MD = join(ROOT, 'data', 'letters.discovery.md');
const CACHE = join(ROOT, '.cache', 'letters');

// The same user agent every SEC reader here sends: a name and a contact, which
// is what EDGAR asks for in return for no API key.
const UA = process.env.SEC_USER_AGENT || 'L3VLUP Research (contact: suro@l3vlup.com)';
const DRY = process.argv.includes('--dry-run');
const FORCE = process.env.FORCE === '1';
const CACHE_MS = 24 * 60 * 60 * 1000;
// Well under the SEC's ten a second, and the run is sequential anyway.
const GAP_MS = 250;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastAt = 0;
const log = { requests: [], stopped: null };

/** One polite request. No retry on 403 or 429: those are a signal to stop, not to push. */
async function secJson(url) {
  const wait = Math.max(0, lastAt + GAP_MS - Date.now());
  if (wait > 0) await sleep(wait);
  lastAt = Date.now();
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  log.requests.push({ url, status: res.status, at: new Date().toISOString() });
  if (res.status === 403 || res.status === 429) throw new Error(`STOP: HTTP ${res.status} from ${url}`);
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}

async function submissionsFor(cik) {
  mkdirSync(CACHE, { recursive: true });
  const path = join(CACHE, `submissions-${cik}.json`);
  if (!FORCE && existsSync(path) && Date.now() - statSync(path).mtimeMs < CACHE_MS) {
    log.requests.push({ url: `cache:${path}`, status: 'cached', at: new Date().toISOString() });
    return JSON.parse(readFileSync(path, 'utf8'));
  }
  const data = await secJson(`https://data.sec.gov/submissions/CIK${cik}.json`);
  writeFileSync(path, JSON.stringify(data));
  return data;
}

function markdown(report) {
  const lines = [
    '# Letters discovery report (Phase 0)',
    '',
    `Generated ${report.generatedAt}. Window since ${report.since}. ${report.requests.length} request(s), ${report.sources.length} source(s).`,
    'Nothing was downloaded, parsed or sent to a model. Document URLs point at sec.gov.',
    '',
    '| Fund | Form | Accession | Filed | Title | Document | Format | Retrieval | Rights | Duplicate key | Relevance |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const c of report.candidates) {
    const doc = c.documentUrl ? `[primary](${c.documentUrl}) · [index](${c.indexUrl})` : `[index](${c.indexUrl})`;
    lines.push(`| ${c.fund} | ${c.form} | ${c.accession} | ${c.filingDate} | ${c.title.replace(/\|/g, '/')} | ${doc} | ${c.format} | ${c.retrievalMode} | ${c.rightsJudgement} | ${c.duplicateKey} | ${c.relevance} |`);
  }
  lines.push('', '## Per source', '', '| Source | Entity on EDGAR | In window | Listed | Recent block truncated |', '|---|---|---|---|---|');
  for (const s of report.sources) lines.push(`| ${s.id} | ${s.entityName ?? 'n.a.'} | ${s.inWindow ?? 'n.a.'} | ${s.listed ?? 0} | ${s.recentTruncated ? 'yes' : 'no'} |`);
  lines.push('', '## Excluded sources', '', '| Domain | Fund | Reason |', '|---|---|---|');
  for (const e of report.excluded) lines.push(`| ${e.domain} | ${e.fund} | ${e.reason} |`);
  if (report.stopped) lines.push('', `**Stopped:** ${report.stopped}`);
  return `${lines.join('\n')}\n`;
}

async function main() {
  const registry = JSON.parse(readFileSync(REGISTRY, 'utf8'));
  const { active, problems } = activeSources(registry);
  if (problems.length) {
    console.error('Refusing to run: the registry has a source that may not be fetched.');
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }
  const now = new Date();
  const windowMonths = registry.windowMonths || 24;
  const cap = registry.maxCandidates || 30;
  const report = {
    generatedAt: now.toISOString(),
    phase: registry.phase,
    since: null,
    limits: { sources: active.length, requestsPerSource: 1, maxCandidates: cap, windowMonths },
    requests: log.requests,
    sources: [],
    candidates: [],
    excluded: registry.excluded || [],
    stopped: null,
  };
  const byFund = {};

  for (const s of active) {
    const row = { id: s.id, fund: s.fund, cik: s.cik, entityName: null, inWindow: null, listed: 0, recentTruncated: false };
    report.sources.push(row);
    let sub;
    try {
      sub = await submissionsFor(s.cik);
    } catch (err) {
      report.stopped = err.message;
      console.error(err.message);
      break;
    }
    row.entityName = sub.name || null;
    if (!entityMatches(sub, s.expectedName)) {
      report.stopped = `${s.id}: EDGAR names CIK ${s.cik} "${sub.name}", expected "${s.expectedName}". The CIK is wrong; nothing listed.`;
      console.error(report.stopped);
      break;
    }
    const sel = selectCandidates(sub, s, { now, windowMonths });
    report.since = sel.since;
    row.inWindow = sel.inWindow;
    row.recentTruncated = sel.recentTruncated;
    byFund[s.fund] = (byFund[s.fund] || []).concat(sel.candidates);
    console.log(`${s.id}: ${sub.name} · ${sel.inWindow} in window${sel.recentTruncated ? ' · older filings not read' : ''}`);
  }

  report.candidates = capAcrossFunds(byFund, cap);
  for (const row of report.sources) row.listed = report.candidates.filter((c) => c.sourceId === row.id).length;
  const total = Object.values(byFund).reduce((n, l) => n + l.length, 0);
  console.log(`${total} in window across ${Object.keys(byFund).length} fund(s) · ${report.candidates.length} listed (cap ${cap}) · ${log.requests.length} request(s)`);
  if (report.stopped) console.log(`STOPPED: ${report.stopped}`);

  if (DRY) {
    console.log(markdown(report));
  } else {
    writeFileSync(OUT_JSON, `${JSON.stringify(report, null, 2)}\n`);
    writeFileSync(OUT_MD, markdown(report));
    console.log(`wrote ${OUT_JSON}\nwrote ${OUT_MD}`);
  }
  if (report.stopped) process.exit(2);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
