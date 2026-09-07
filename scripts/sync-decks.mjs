#!/usr/bin/env node
// Banker board-book index — every Schedule 13E-3 since 2020, from EDGAR.
//
// Rebuilds data/decks.auto.json, which /intel/deal-decks reads. One row per
// going-private transaction, carrying the target, the buyer, the industry
// code, the transaction value from the filing-fee table, and every adviser
// exhibit (the banker's own board presentation) filed with it or with any
// amendment, each linked on sec.gov.
//
// Why these documents exist: Rule 13e-3 makes an affiliated buyer disclose
// every report its financial adviser gave the board, and Item 16 of the
// schedule makes them file those materials as exhibits. Exhibit letter (c)
// is the adviser's own work, so EX-99.(C)(2) is the deck itself, in full.
//
// Everything here is public and needs no key:
//
//   1. The quarterly form index lists every SC 13E3 and SC 13E3/A.
//   2. The submission header carries the subject company with its industry
//      code, the filing persons (the buyer), and the SGML <TYPE> of every
//      document, which is the only reliable exhibit classification.
//   3. index.json gives file sizes, which is how a deck is told from a cover
//      letter.
//   4. The filing-fee table (an EX-FILING FEES exhibit since 2022, the cover
//      of the primary document before that) states the transaction value.
//   5. The HTML adviser exhibits are read once for the analyses
//      they contain (DCF, trading comps, precedents, premiums paid, LBO and
//      so on) and for the adviser's name.
//
// Incremental like sync-precedents.mjs: filings already on file are kept,
// closed quarters are not re-read, and a steady-state run is one index read
// plus a handful of requests per new filing. FULL_REBUILD=1 starts over.
//
//   node scripts/sync-decks.mjs
//   FULL_REBUILD=1 node scripts/sync-decks.mjs
//   SINCE_YEAR=2018 node scripts/sync-decks.mjs
//   LIMIT=40 node scripts/sync-decks.mjs        # first 40 fresh filings only
//   REFRESH_VALUES=1 node scripts/sync-decks.mjs # re-read filings with no stated value

import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ANALYSES,
  ADVISERS,
  acquirerType,
  capSize,
  classifyExhibit,
  detectAdvisers,
  detectAnalyses,
  parseHeader,
  parseTransactionValue,
  rate,
  sectorOf,
  stripHtml,
} from '../lib/decks.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'data', 'decks.auto.json');
const ARCHIVES = 'https://www.sec.gov/Archives/edgar';

const UA = process.env.SEC_USER_AGENT || 'L3VLUP Research (contact: suro@l3vlup.com)';
const SINCE_YEAR = Number(process.env.SINCE_YEAR) || 2020;
const FULL_REBUILD = process.env.FULL_REBUILD === '1';
const LIMIT = Number(process.env.LIMIT) || Infinity;
/** Re-read filings on file that have no stated value, after a parser change. */
const REFRESH_VALUES = process.env.REFRESH_VALUES === '1';
const CONCURRENCY = 4;
const FORMS = new Set(['SC 13E3', 'SC 13E3/A']);

/** A (c) exhibit smaller than this is a cover letter or a consent, not a deck. */
const MIN_DECK_BYTES = 10_000;
/** The largest exhibit read for its contents. Bigger ones are image-heavy. */
const MAX_SCAN_BYTES = 3_000_000;
/** How many HTML adviser exhibits are read per filing. */
const SCAN_PER_FILING = 8;

// ── Fetch helpers ───────────────────────────────────────────────────────────

let requests = 0;
let bytes = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The SEC asks for no more than ten requests a second across all callers
// with the same user agent. Four workers and a short gap keep this near six.
const GAP_MS = 170;
let lastAt = 0;
async function throttle() {
  const wait = Math.max(0, lastAt + GAP_MS - Date.now());
  lastAt = Date.now() + wait;
  if (wait > 0) await sleep(wait);
}

async function sec(url, { asText = false, allow404 = false } = {}) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await throttle();
      requests += 1;
      const res = await fetch(url, { headers: { 'User-Agent': UA } });
      if (res.status === 404 && allow404) return null;
      if (res.status === 429 || res.status === 403 || res.status >= 500) {
        await sleep(2000 * (attempt + 1));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = asText ? await res.text() : await res.json();
      bytes += asText ? body.length : 0;
      return body;
    } catch (err) {
      if (attempt === 2) throw err;
      await sleep(700 * (attempt + 1));
    }
  }
  throw new Error(`gave up on ${url}`);
}

async function pool(items, size, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (cursor < items.length) {
        const i = cursor;
        cursor += 1;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

// ── The filing list ─────────────────────────────────────────────────────────

function quartersFrom(year) {
  const now = new Date();
  const out = [];
  for (let y = year; y <= now.getUTCFullYear(); y += 1) {
    for (const q of [1, 2, 3, 4]) {
      if (y === now.getUTCFullYear() && q > Math.floor(now.getUTCMonth() / 3) + 1) break;
      out.push([y, q]);
    }
  }
  return out;
}

const quarterKey = ([y, q]) => `${y}Q${q}`;

async function filingsIn(year, quarter) {
  const text = await sec(`${ARCHIVES}/full-index/${year}/QTR${quarter}/form.idx`, { asText: true, allow404: true });
  if (!text) return [];
  const out = [];
  for (const line of text.split('\n')) {
    const form = line.slice(0, 12).trim().toUpperCase();
    if (!FORMS.has(form)) continue;
    const filed = line.match(/\d{4}-\d{2}-\d{2}/)?.[0];
    const path = line.match(/edgar\/data\/\d+\/\S+/)?.[0];
    if (!filed || !path) continue;
    const cik = path.match(/edgar\/data\/(\d+)\//)?.[1];
    const accession = path.split('/').pop()?.replace(/\.txt$/, '');
    if (!cik || !accession) continue;
    const fallbackName = line.slice(12, line.indexOf(filed) > 12 ? line.indexOf(filed) : 74).replace(/\s+\d+\s*$/, '').trim();
    out.push({ form, cik: cik.padStart(10, '0'), filed, accession, fallbackName });
  }
  return out;
}

// ── One filing ──────────────────────────────────────────────────────────────

async function resolve(f) {
  const bare = f.accession.replace(/-/g, '');
  const base = `${ARCHIVES}/data/${Number(f.cik)}/${bare}`;

  const [headerHtml, idx] = await Promise.all([
    sec(`${base}/${f.accession}-index-headers.html`, { asText: true, allow404: true }),
    sec(`${base}/index.json`, { allow404: true }),
  ]);
  if (!headerHtml) return { skip: true, accession: f.accession, cik: f.cik, reason: 'No submission header on file.' };

  const header = parseHeader(headerHtml);
  const sizes = new Map();
  for (const it of idx?.directory?.item ?? []) sizes.set(it.name, Number(it.size ?? 0) || 0);

  const docs = header.documents.map((d) => ({ ...d, bytes: sizes.get(d.file) ?? 0, klass: classifyExhibit(d.type) }));
  const decks = docs.filter((d) => d.klass === 'adviser' && d.bytes >= MIN_DECK_BYTES && /\.(pdf|htm|html|txt)$/i.test(d.file));

  // The subject company block is the target. On a combined SC TO-T / SC 13E3
  // the header repeats it once per form; either copy will do.
  const subject = header.subjects.find((s) => s.cik === f.cik) ?? header.subjects[0] ?? null;
  const targetName = (subject?.name || f.fallbackName || '').trim();

  // Filing persons other than the target itself are the buyer side. Merger
  // subs and shells formed for the deal are kept in `vehicles` so the buyer
  // list reads as the sponsor or parent rather than "Bravo Merger Sub".
  const filers = header.filers.filter((p) => p.cik !== f.cik && p.name);
  const groupMembers = header.groupMembers;

  let transactionValue = null;
  let valueSource = null;
  let advisers = [];
  let analyses = {};
  let scanned = 0;

  // The value the filer put on the deal for the fee calculation. An
  // EX-FILING FEES exhibit carries it from 2022; before that it is on the
  // cover page of the primary document. Read on the initial schedule and on
  // any filing that carries a deck; a bare amendment rarely restates it.
  if (decks.length > 0 || f.form === 'SC 13E3') {
    const feeDoc = docs.find((d) => /^EX-FILING FEES/i.test(d.type));
    const primary = docs.find((d) => /^SC (13E3|TO-T|TO-I|14D9)/i.test(d.type) && /\.(htm|html|txt)$/i.test(d.file)) ?? docs[0];
    for (const cand of [feeDoc, primary].filter(Boolean)) {
      if (cand.bytes > MAX_SCAN_BYTES) continue;
      const html = await sec(`${base}/${cand.file}`, { asText: true, allow404: true });
      if (!html) continue;
      const v = parseTransactionValue(stripHtml(html));
      if (v !== null) {
        transactionValue = v;
        valueSource = cand === feeDoc ? 'EX-FILING FEES' : 'cover page';
        break;
      }
    }
  }

  if (decks.length > 0) {
    // Read the readable decks for what they contain. The fairness
    // opinion presentation is usually the largest and the most complete.
    const readable = decks
      .filter((d) => !d.isPdf && d.bytes <= MAX_SCAN_BYTES)
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, SCAN_PER_FILING);
    const found = new Set();
    for (const d of readable) {
      const html = await sec(`${base}/${d.file}`, { asText: true, allow404: true });
      if (!html) continue;
      scanned += 1;
      const text = stripHtml(html);
      for (const k of detectAnalyses(text)) analyses[k] = true;
      for (const a of detectAdvisers(text.slice(0, 12_000))) found.add(a);
      d.advisers = detectAdvisers(text.slice(0, 12_000));
      d.analyses = detectAnalyses(text);
    }
    advisers = [...found];
  }

  return {
    skip: false,
    form: f.form,
    filed: f.filed,
    accession: f.accession,
    filingUrl: `${base}/${f.accession}-index.htm`,
    target: {
      name: targetName,
      cik: f.cik,
      sic: subject?.sic ?? null,
      sicDescription: subject?.sicDescription ?? null,
      state: subject?.state ?? null,
    },
    filers: filers.map((p) => p.name),
    groupMembers,
    transactionValue,
    valueSource,
    advisers,
    analyses: Object.keys(analyses),
    scanned,
    decks: decks.map((d) => ({
      id: `${f.accession}:${d.file}`,
      exhibit: d.type,
      description: d.description || null,
      url: `${base}/${d.file}`,
      bytes: d.bytes,
      isPdf: d.isPdf,
      advisers: d.advisers ?? [],
      analyses: d.analyses ?? [],
    })),
  };
}

// ── Transactions from filings ───────────────────────────────────────────────

/**
 * A target's Schedule 13E-3 and its amendments are one transaction. The same
 * company can be taken private twice across six years (rarely, but it
 * happens), so filings more than 400 days after the first in a group start
 * a new one.
 */
function groupTransactions(filings) {
  const byCik = new Map();
  for (const f of [...filings].sort((a, b) => (a.filed < b.filed ? -1 : 1))) {
    if (!byCik.has(f.target.cik)) byCik.set(f.target.cik, []);
    byCik.get(f.target.cik).push(f);
  }

  const out = [];
  for (const list of byCik.values()) {
    let group = null;
    for (const f of list) {
      const days = group ? (Date.parse(f.filed) - Date.parse(group[0].filed)) / 86_400_000 : Infinity;
      if (!group || days > 400) {
        group = [f];
        out.push(group);
      } else {
        group.push(f);
      }
    }
  }
  return out.map(buildTransaction);
}

/** Names the buyer side prefers to be known by, deal vehicles last. */
function orderBuyers(names) {
  const seen = new Set();
  const clean = [];
  for (const n of names) {
    const key = n.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!key || seen.has(key)) continue;
    seen.add(key);
    clean.push(n);
  }
  const vehicle = (n) => /merger sub|mergersub|bidco|topco|midco|holdco|acquisition (sub|corp|co|company|llc|inc)|newco|parent,? (inc|llc)|purchaser/i.test(n);
  return [...clean.filter((n) => !vehicle(n)), ...clean.filter(vehicle)];
}

function buildTransaction(group) {
  const first = group[0];
  const decks = group.flatMap((f) => f.decks.map((d) => ({ ...d, filed: f.filed, accession: f.accession, form: f.form })));
  const buyers = orderBuyers(group.flatMap((f) => [...f.filers, ...f.groupMembers]));
  const advisers = [...new Set(group.flatMap((f) => f.advisers))].sort();
  const analyses = [...new Set(group.flatMap((f) => f.analyses))].sort();
  // Later amendments can restate the fee; the first stated value is the
  // announcement-time one, which is what a reader compares against.
  const valued = group.find((f) => f.transactionValue !== null);
  const value = valued?.transactionValue ?? null;
  const target = group.find((f) => f.target.sic)?.target ?? first.target;
  const sector = sectorOf(target.sic);
  const readable = decks.filter((d) => !d.isPdf).length;
  const rating = rate({ decks: decks.length, readable, analyses: analyses.length, valued: value !== null });

  return {
    id: first.accession,
    announced: first.filed,
    year: Number(first.filed.slice(0, 4)),
    quarter: `${first.filed.slice(0, 4)}Q${Math.floor((Number(first.filed.slice(5, 7)) - 1) / 3) + 1}`,
    target: {
      name: target.name,
      cik: target.cik,
      sic: target.sic,
      sicDescription: target.sicDescription,
      state: target.state,
    },
    sector,
    buyers,
    buyerType: acquirerType(buyers, target.name),
    advisers,
    transactionValue: value,
    valueSource: valued?.valueSource ?? null,
    capSize: capSize(value),
    analyses,
    rating: rating.grade,
    ratingScore: rating.score,
    filings: group.map((f) => ({ form: f.form, filed: f.filed, accession: f.accession, filingUrl: f.filingUrl })),
    decks,
    hasDecks: decks.length > 0,
  };
}

// ── Run ─────────────────────────────────────────────────────────────────────

function readExisting() {
  if (FULL_REBUILD || !existsSync(OUT)) return { filings: [], skipped: [], indexedThrough: null };
  try {
    const parsed = JSON.parse(readFileSync(OUT, 'utf8'));
    return {
      filings: Array.isArray(parsed.filings) ? parsed.filings : [],
      skipped: Array.isArray(parsed.skipped) ? parsed.skipped : [],
      indexedThrough: typeof parsed.indexedThrough === 'string' ? parsed.indexedThrough : null,
    };
  } catch {
    console.warn('Existing index could not be read; rebuilding from scratch.');
    return { filings: [], skipped: [], indexedThrough: null };
  }
}

async function main() {
  const existing = readExisting();
  const known = new Map(existing.filings.map((r) => [r.accession, r]));
  const skipped = new Map(existing.skipped.map((s) => [s.accession, s]));
  console.log(`${known.size} filings already on file, ${skipped.size} previously found unusable.`);

  const all = quartersFrom(SINCE_YEAR);
  const from = existing.indexedThrough;
  const quarters = from && !REFRESH_VALUES ? all.filter((q) => quarterKey(q) >= from) : all;

  const lists = [];
  for (const [y, q] of quarters) lists.push(...(await filingsIn(y, q)));
  console.log(`${lists.length} Schedule 13E-3 filings and amendments across ${quarters.length} quarters.`);

  const stale = (f) => REFRESH_VALUES && known.get(f.accession)?.transactionValue == null && f.form === 'SC 13E3';
  const fresh = lists.filter((f) => (!known.has(f.accession) || stale(f)) && !skipped.has(f.accession)).slice(0, LIMIT);
  console.log(`${fresh.length} to resolve.`);

  let done = 0;
  const started = Date.now();
  const outcomes = (await pool(fresh, CONCURRENCY, async (f) => {
    let row = null;
    try {
      row = await resolve(f);
    } catch (err) {
      console.warn(`  ${f.accession} (${f.fallbackName}): ${err.message}`);
    }
    done += 1;
    if (done % 50 === 0) {
      const rate = done / ((Date.now() - started) / 60_000);
      console.log(`  ${done}/${fresh.length} · ${requests} requests · ${(bytes / 1e6).toFixed(0)} MB · ${rate.toFixed(0)}/min`);
    }
    return row;
  })).filter(Boolean);

  for (const r of outcomes) {
    if (r.skip) skipped.set(r.accession, { accession: r.accession, cik: r.cik, reason: r.reason });
    else known.set(r.accession, r);
  }

  const filings = [...known.values()].sort((a, b) => (a.filed < b.filed ? 1 : -1));
  const transactions = groupTransactions(filings).sort((a, b) => (a.announced < b.announced ? 1 : -1));
  const skipList = [...skipped.values()].sort((a, b) => (a.accession < b.accession ? -1 : 1));
  const indexedThrough = quarters.length > 0 ? quarterKey(quarters[quarters.length - 1]) : existing.indexedThrough;

  const withDecks = transactions.filter((t) => t.hasDecks).length;
  const deckCount = transactions.reduce((n, t) => n + t.decks.length, 0);
  const valued = transactions.filter((t) => t.transactionValue !== null).length;

  writeFileSync(
    OUT,
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        since: SINCE_YEAR,
        indexedThrough,
        method: {
          source: 'SEC EDGAR: quarterly form index, submission headers, index.json, filing-fee tables, adviser exhibits',
          transactionValue: 'As stated in the filing-fee table, USD millions. Estimated by the filer for the fee only.',
          capSize: 'Micro < $250M · Small $250M–1B · Mid $1–5B · Large $5–20B · Mega > $20B, on transaction value',
          rating: 'A–D teaching-value grade from exhibit count, readability, analyses detected and a disclosed value. Not a judgement of the advice.',
          buyerType: 'Heuristic on the filing persons\' names: sponsor, strategic, management or founder, controlling holder.',
          analyses: ANALYSES.map((a) => a.key),
          advisers: ADVISERS.map((a) => a.name),
        },
        counts: { transactions: transactions.length, withDecks, decks: deckCount, valued, filings: filings.length },
        transactions,
        filings,
        skipped: skipList,
      },
      null,
      0,
    )}\n`,
  );

  console.log(
    `Wrote ${transactions.length} transactions (${withDecks} with adviser decks, ${deckCount} decks, ${valued} with a stated value) ` +
    `from ${filings.length} filings, ${skipList.length} skipped, in ${requests} requests and ${(bytes / 1e6).toFixed(0)} MB.`,
  );

  if (filings.length < existing.filings.length) {
    console.error('The index shrank, which should not happen on an incremental run.');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
