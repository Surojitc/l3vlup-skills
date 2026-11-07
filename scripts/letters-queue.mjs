#!/usr/bin/env node
// Letters review queue: discovery's filings, classified, checked against the
// site's catalogue, and written as a list for a person to read.
//
// It publishes nothing and changes nothing the site reads. Its output is
// data/letters.review-queue.{json,md}: for each filing from an approved
// source that the site does not already hold (published, held back or
// excluded), its class (likely investor letter, presentation, proxy
// material, other) with the reasons, the document to open first, the sec.gov
// index link, and a catalogue record with the filing's facts filled in and
// every editorial field left for a person. See lib/letters-queue.mjs.
//
// What it reads, and how politely:
//   - the submissions indexes discover-letters.mjs cached under .cache/letters
//     (it makes no submissions request of its own and refuses to run without
//     them: run discovery first);
//   - data/letters.catalogue-keys.json, the site catalogue's ids, accessions
//     and URLs (scripts/letters-catalogue-keys.mjs writes it);
//   - filing index pages for solicitation and Schedule 13D filings, from
//     data/letters.exhibits.json and the .cache first, then at most
//     --max-indexes new ones from sec.gov, one a second, with the SEC's
//     requested User-Agent, stopping on the first 403 or 429. No exhibit,
//     report or PDF is ever opened, and no model is called.
//
//   node scripts/letters-queue.mjs                    # writes data/letters.review-queue.{json,md}
//   node scripts/letters-queue.mjs --max-indexes 0    # no request at all: classify on what is cached
//   node scripts/letters-queue.mjs --cache-only       # the same, said plainly
//   node scripts/letters-queue.mjs --dry-run          # prints the summary, writes nothing

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { activeSources, documentUrlFrom, entityMatches, parseFilingIndex, selectCandidates, authoritativeIndexUrl } from '../lib/letters.mjs';
import { buildQueue, indexesFromQueue, queueMarkdown } from '../lib/letters-queue.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY = join(ROOT, 'data', 'letters.sources.json');
const KEYS = join(ROOT, 'data', 'letters.catalogue-keys.json');
const EXHIBITS = join(ROOT, 'data', 'letters.exhibits.json');
const OUT_JSON = join(ROOT, 'data', 'letters.review-queue.json');
const OUT_MD = join(ROOT, 'data', 'letters.review-queue.md');
const CACHE = join(ROOT, '.cache', 'letters');

const UA = process.env.SEC_USER_AGENT || 'L3VLUP Research (contact: suro@l3vlup.com)';
const argv = process.argv.slice(2);
const DRY = argv.includes('--dry-run');
const CACHE_ONLY = argv.includes('--cache-only');
const maxArg = argv.indexOf('--max-indexes');
const MAX_INDEXES = CACHE_ONLY ? 0 : maxArg >= 0 ? Math.max(0, Number(argv[maxArg + 1]) || 0) : 20;
// One request a second: well inside the SEC's ten, and the house rule.
const GAP_MS = 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const requests = [];
let lastAt = 0;

async function fetchIndex(url) {
  const wait = Math.max(0, lastAt + GAP_MS - Date.now());
  if (wait > 0) await sleep(wait);
  lastAt = Date.now();
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html' } });
  requests.push({ url, status: res.status, at: new Date().toISOString() });
  if (res.status === 403 || res.status === 429) throw new Error(`STOP: HTTP ${res.status} from ${url}`);
  if (!res.ok) return null;
  return res.text();
}

/** The parsed index with absolute document URLs, the subject, and the folder EDGAR uses. */
function indexFromHtml(html, accession) {
  const idx = parseFilingIndex(html);
  const documents = idx.documents.map((d) => ({ ...d, url: documentUrlFrom(d.href) }));
  return { documents, subject: idx.subject, indexUrl: authoritativeIndexUrl(idx.documents, accession) };
}

/** Filing indexes already read by enumerate-letters.mjs, from its committed report. */
function indexesFromExhibits() {
  const out = new Map();
  if (!existsSync(EXHIBITS)) return out;
  const ex = JSON.parse(readFileSync(EXHIBITS, 'utf8'));
  for (const row of ex.shortlist || []) {
    if (!out.has(row.accession)) out.set(row.accession, { documents: [], subject: row.subjectCompany ? { name: row.subjectCompany, cik: row.subjectCik || null } : null, indexUrl: row.indexUrl });
    out.get(row.accession).documents.push({ seq: row.seq, description: row.exhibitDescription || '', filename: row.filename, type: row.exhibitType || '', size: row.size ?? null, url: row.documentUrl });
  }
  return out;
}

async function main() {
  const registry = JSON.parse(readFileSync(REGISTRY, 'utf8'));
  const { active, problems } = activeSources(registry);
  if (problems.length) {
    console.error('Refusing to run: the registry has a source that may not be fetched.');
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }
  if (!existsSync(KEYS)) {
    console.error(`Refusing to run: ${KEYS} is missing, so nothing could be checked against the catalogue. Run scripts/letters-catalogue-keys.mjs.`);
    process.exit(1);
  }
  const keys = JSON.parse(readFileSync(KEYS, 'utf8')).keys;
  const previous = existsSync(OUT_JSON) ? JSON.parse(readFileSync(OUT_JSON, 'utf8')) : null;
  const now = new Date();
  const sourcesById = Object.fromEntries(active.map((s) => [s.id, s]));

  const candidates = [];
  const sources = [];
  let since = null;
  for (const s of active) {
    const path = join(CACHE, `submissions-${s.cik}.json`);
    if (!existsSync(path)) {
      console.error(`Refusing to run: no cached submissions for ${s.id} (CIK ${s.cik}). Run scripts/discover-letters.mjs first.`);
      process.exit(1);
    }
    const sub = JSON.parse(readFileSync(path, 'utf8'));
    if (!entityMatches(sub, s.expectedName)) {
      console.error(`Refusing to run: ${s.id}: the cached index names "${sub.name}", expected "${s.expectedName}".`);
      process.exit(1);
    }
    const sel = selectCandidates(sub, s, { now, windowMonths: registry.windowMonths || 24 });
    since = sel.since;
    candidates.push(...sel.candidates);
    sources.push({ id: s.id, entityName: sub.name, inWindow: sel.inWindow, recentTruncated: sel.recentTruncated });
  }

  // Indexes: the committed enumeration and the last queue (both committed, so
  // the weekly runner has them), then the local cache, then a few new ones.
  const indexes = indexesFromExhibits();
  for (const [acc, idx] of indexesFromQueue(previous)) if (!indexes.has(acc)) indexes.set(acc, idx);
  mkdirSync(CACHE, { recursive: true });
  const wantsIndex = (c) => sourcesById[c.sourceId]?.sourceType === 'sec_exhibit';
  for (const c of candidates) {
    if (!wantsIndex(c) || indexes.has(c.accession)) continue;
    const path = join(CACHE, `index-${c.accession}.htm`);
    if (existsSync(path)) indexes.set(c.accession, indexFromHtml(readFileSync(path, 'utf8'), c.accession));
  }
  // Which new indexes are worth a request: not already in the catalogue,
  // solicitations before original 13Ds before amendments, newest first.
  const firstPass = buildQueue({ candidates, sourcesById, keys, indexes, previous, now });
  const rank = (f) => (/^(DFAN14A|PX14A6G)$/.test(f) ? 0 : /^(SC|SCHEDULE) 13D$/.test(f) ? 1 : /^(DEFC14A|PREC14A)$/.test(f) ? 3 : 2);
  const toRead = firstPass.entries
    .filter((e) => e.needsIndex)
    .sort((a, b) => rank(a.form) - rank(b.form) || b.filingDate.localeCompare(a.filingDate))
    .slice(0, MAX_INDEXES);
  let stopped = null;
  for (const e of toRead) {
    const c = candidates.find((x) => x.accession === e.accession && x.sourceId === e.sourceId);
    try {
      const html = await fetchIndex(c.indexUrl);
      if (!html) continue;
      writeFileSync(join(CACHE, `index-${c.accession}.htm`), html);
      indexes.set(c.accession, indexFromHtml(html, c.accession));
    } catch (err) {
      stopped = err.message;
      console.error(err.message);
      break;
    }
  }

  const queue = buildQueue({ candidates, sourcesById, keys, indexes, previous, now });
  const report = {
    generatedAt: now.toISOString(),
    since,
    sources: active.length,
    limits: { maxIndexRequests: MAX_INDEXES, gapMs: GAP_MS, windowMonths: registry.windowMonths || 24 },
    note: 'For review only. Classified from EDGAR metadata and filing index labels; no document was opened and no text was copied. Nothing here is published: the site publishes only a record a person has written into its catalogue.',
    catalogueKeysFrom: JSON.parse(readFileSync(KEYS, 'utf8')).from || null,
    perSource: sources,
    requests,
    stopped,
    ...queue,
  };
  const md = queueMarkdown(report);
  const c = queue.counts;
  const summary = [
    '## Letters: review queue',
    '',
    `${c.entries} filing(s) to review (${c.newSinceLastQueue} new since the last queue), ${c.duplicates} already in the catalogue. ${requests.length} filing index request(s) to sec.gov.`,
    '',
    '| Class | Entries |',
    '|---|---|',
    ...Object.entries(c.byClass).map(([k, n]) => `| ${k} | ${n} |`),
  ].join('\n');
  console.log(summary);
  if (stopped) console.log(`STOPPED: ${stopped}`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  if (!DRY) {
    writeFileSync(OUT_JSON, `${JSON.stringify(report, null, 2)}\n`);
    writeFileSync(OUT_MD, md);
    console.log(`wrote ${OUT_JSON}\nwrote ${OUT_MD}`);
  }
  if (stopped) process.exit(2);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
