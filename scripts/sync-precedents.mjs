#!/usr/bin/env node
// Precedent transaction index — refresh from EDGAR.
//
// Rebuilds data/precedents.auto.json, which /labs/comps reads to score
// precedent transactions against a target. One row per company that filed a
// Schedule 13E-3, the form a target files when it is taken private by an
// affiliate, carrying the industry code and the last full year it reported
// before the filing.
//
// Everything here is public and needs no key: the quarterly form index lists
// the filings, the submissions API gives the industry code, and the XBRL
// company-concept API gives the figures as the company itself tagged them.
//
// Incremental in three ways, because the cheapest request is the one not made:
//
//   1. Rows already in the committed file are kept.
//   2. Filings that resolved to nothing are remembered, so a filer with no
//      industry code is looked at once rather than on every run for ever.
//   3. Quarterly indexes are read from the last one seen, not from the start.
//      A closed quarter's index does not change, so re-reading five years of
//      them every week is twenty-odd requests for a known answer. The quarter
//      recorded is re-read (it was probably still open when it was recorded)
//      along with everything after it.
//
// A steady-state refresh is therefore a single index read plus four requests
// per genuinely new filing. Pass FULL_REBUILD=1 to forget all of it and start
// over, which is also what to do after changing SINCE_YEAR downwards.
//
//   node scripts/sync-precedents.mjs
//   FULL_REBUILD=1 node scripts/sync-precedents.mjs
//   SINCE_YEAR=2018 node scripts/sync-precedents.mjs

import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'data', 'precedents.auto.json');
const ARCHIVES = 'https://www.sec.gov/Archives/edgar';

// The SEC asks automated readers to identify themselves with a contact
// address, and throttles anyone who does not.
const UA = process.env.SEC_USER_AGENT || 'L3VLUP Research (contact: suro@l3vlup.com)';

const SINCE_YEAR = Number(process.env.SINCE_YEAR) || 2021;
const FULL_REBUILD = process.env.FULL_REBUILD === '1';
const CONCURRENCY = 4;

// ── Fetch helpers ───────────────────────────────────────────────────────────

let requests = 0;

async function sec(url, { asText = false, allow404 = false } = {}) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      requests += 1;
      const res = await fetch(url, { headers: { 'User-Agent': UA } });
      if (res.status === 404 && allow404) return null;
      if (res.status === 429 || res.status >= 500) {
        await sleep(1500 * (attempt + 1));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return asText ? res.text() : res.json();
    } catch (err) {
      if (attempt === 2) throw err;
      await sleep(700 * (attempt + 1));
    }
  }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
      // A quarter that has not started yet has no index file.
      if (y === now.getUTCFullYear() && q > Math.floor(now.getUTCMonth() / 3) + 1) break;
      out.push([y, q]);
    }
  }
  return out;
}

/**
 * Schedule 13E-3 filings in one quarter.
 *
 * Only the form type in the master index is reliably column-aligned: the
 * company name pushes the later columns around from one year to the next, and
 * reading the date by column silently truncates it to a year and a month. The
 * date, the CIK and the path are matched by shape instead.
 */
async function filingsIn(year, quarter) {
  const text = await sec(`${ARCHIVES}/full-index/${year}/QTR${quarter}/form.idx`, { asText: true, allow404: true });
  if (!text) return [];
  const out = [];
  for (const line of text.split('\n')) {
    if (line.slice(0, 12).trim().toUpperCase() !== 'SC 13E3') continue;
    const filed = line.match(/\d{4}-\d{2}-\d{2}/)?.[0];
    const path = line.match(/edgar\/data\/\d+\/\S+/)?.[0];
    if (!filed || !path) continue;
    const cik = path.match(/edgar\/data\/(\d+)\//)?.[1];
    const accession = path.split('/').pop()?.replace(/\.txt$/, '');
    if (!cik || !accession) continue;
    const fallbackName = line.slice(12, line.indexOf(filed) > 12 ? line.indexOf(filed) : 74).trim();
    out.push({ cik: cik.padStart(10, '0'), filed, accession, fallbackName });
  }
  return out;
}

// ── Company figures, as the company tagged them ─────────────────────────────

const REVENUE_TAGS = [
  'RevenueFromContractWithCustomerExcludingAssessedTax',
  'Revenues',
  'SalesRevenueNet',
  'RevenueFromContractWithCustomerIncludingAssessedTax',
];
const EBIT_TAGS = ['OperatingIncomeLoss'];
const DA_TAGS = [
  'DepreciationDepletionAndAmortization',
  'DepreciationAndAmortization',
  'DepreciationAmortizationAndAccretionNet',
];

/**
 * The most recent annual figure for a concept, from the company's own filings.
 *
 * Annual is established by the length of the period rather than by trusting a
 * fiscal-year label: a 10-K carries quarterly facts too, and a fourth quarter
 * mistaken for a year understates revenue fourfold.
 */
async function annualConcept(cik, tags) {
  for (const tag of tags) {
    const data = await sec(`https://data.sec.gov/api/xbrl/companyconcept/CIK${cik}/us-gaap/${tag}.json`, { allow404: true });
    const rows = data?.units?.USD;
    if (!Array.isArray(rows)) continue;
    const annual = rows.filter((u) => {
      if (!u.form?.startsWith('10-K') || !u.start || !u.end) return false;
      const days = (Date.parse(u.end) - Date.parse(u.start)) / 86_400_000;
      return Number.isFinite(days) && Math.abs(days - 365) < 40;
    });
    if (annual.length === 0) continue;
    annual.sort((a, b) => (a.end < b.end ? 1 : -1));
    return { value: annual[0].val, end: annual[0].end, tag };
  }
  return null;
}

async function resolve(filing) {
  const submissions = await sec(`https://data.sec.gov/submissions/CIK${filing.cik}.json`, { allow404: true });
  const [revenue, ebit, da] = await Promise.all([
    annualConcept(filing.cik, REVENUE_TAGS),
    annualConcept(filing.cik, EBIT_TAGS),
    annualConcept(filing.cik, DA_TAGS),
  ]);

  const sic = submissions?.sic?.trim() || null;
  if (!sic) {
    // Nothing to score against, and nothing that a later run would find:
    // a filer either has an industry code on file or does not. Recorded as
    // skipped so the next run does not spend four requests learning this
    // again. A transport failure throws instead, and is retried.
    return { skip: true, accession: filing.accession, cik: filing.cik, reason: 'No industry code on file with the SEC.' };
  }

  // EBITDA is built rather than taken: no filer tags "EBITDA", because it is
  // not a GAAP measure. Operating income plus depreciation and amortisation is
  // the standard construction, and the tags used are recorded on the row so a
  // reader can check it.
  const ebitda = ebit && da ? ebit.value + da.value : null;

  return {
    skip: false,
    cik: filing.cik,
    name: (submissions?.name || filing.fallbackName || '').trim(),
    sic,
    sicDescription: submissions?.sicDescription?.trim() || null,
    announced: filing.filed,
    accession: filing.accession,
    filingUrl: `${ARCHIVES}/data/${Number(filing.cik)}/${filing.accession.replace(/-/g, '')}/${filing.accession}-index.htm`,
    revenue: revenue ? Math.round(revenue.value / 1e6) : null,
    revenueAsOf: revenue?.end ?? null,
    ebitda: ebitda !== null ? Math.round(ebitda / 1e6) : null,
    ebitdaBasis: ebit && da ? `${ebit.tag} plus ${da.tag}, FY to ${ebit.end}` : null,
  };
}

// ── Run ─────────────────────────────────────────────────────────────────────

function readExisting() {
  if (FULL_REBUILD || !existsSync(OUT)) return { items: [], skipped: [], indexedThrough: null };
  try {
    const parsed = JSON.parse(readFileSync(OUT, 'utf8'));
    return {
      items: Array.isArray(parsed.items) ? parsed.items : [],
      skipped: Array.isArray(parsed.skipped) ? parsed.skipped : [],
      indexedThrough: typeof parsed.indexedThrough === 'string' ? parsed.indexedThrough : null,
    };
  } catch {
    console.warn('Existing index could not be read; rebuilding from scratch.');
    return { items: [], skipped: [], indexedThrough: null };
  }
}

/** "2026Q3" for a quarter pair, so the high-water mark sorts as a string. */
const quarterKey = ([y, q]) => `${y}Q${q}`;

async function main() {
  const existing = readExisting();
  const known = new Set(existing.items.map((r) => r.accession));
  const skipped = new Map(existing.skipped.map((s) => [s.accession, s]));
  console.log(
    `${existing.items.length} transactions already on file, ` +
    `${skipped.size} filings previously found unusable.`,
  );

  // Everything from SINCE_YEAR, then trimmed to what has not been settled.
  // The recorded quarter is re-read because it was very likely still open when
  // it was written, so it can still gain filings.
  const all = quartersFrom(SINCE_YEAR);
  const from = existing.indexedThrough;
  const quarters = from ? all.filter((q) => quarterKey(q) >= from) : all;
  const skippedQuarters = all.length - quarters.length;

  const lists = [];
  for (const [y, q] of quarters) {
    lists.push(...(await filingsIn(y, q)));
  }
  console.log(
    `${lists.length} Schedule 13E-3 filings across ${quarters.length} quarters` +
    `${skippedQuarters > 0 ? `, ${skippedQuarters} earlier quarters already settled` : ''}.`,
  );

  // A target amends its Schedule 13E-3 several times; the earliest filing is
  // the one that dates the transaction, so later ones are dropped.
  const firstByCik = new Map();
  for (const f of lists.sort((a, b) => (a.filed < b.filed ? -1 : 1))) {
    if (!firstByCik.has(f.cik)) firstByCik.set(f.cik, f);
  }

  const fresh = [...firstByCik.values()].filter(
    (f) => !known.has(f.accession) && !skipped.has(f.accession),
  );
  console.log(`${fresh.length} to resolve.`);

  let done = 0;
  const outcomes = (await pool(fresh, CONCURRENCY, async (f) => {
    let row = null;
    try {
      row = await resolve(f);
    } catch (err) {
      // Left out of both lists, so it is tried again next time. A failure
      // here is the network, not the filing.
      console.warn(`  ${f.cik}: ${err.message}`);
    }
    done += 1;
    if (done % 25 === 0) console.log(`  ${done}/${fresh.length}`);
    return row;
  })).filter(Boolean);

  const resolved = outcomes.filter((r) => !r.skip);
  for (const r of outcomes.filter((r) => r.skip)) {
    skipped.set(r.accession, { accession: r.accession, cik: r.cik, reason: r.reason });
  }

  // Keep every row that still has an industry code, newest transaction first.
  const byAccession = new Map();
  for (const row of [...existing.items, ...resolved]) {
    if (!row?.accession || !row.sic) continue;
    const { skip, ...clean } = row;
    void skip;
    byAccession.set(row.accession, clean);
  }
  const items = [...byAccession.values()].sort((a, b) => (a.announced < b.announced ? 1 : -1));

  const withRevenue = items.filter((r) => r.revenue !== null).length;
  const withEbitda = items.filter((r) => r.ebitda !== null).length;

  // The skip list is sorted so a rerun that changes nothing produces no diff.
  const skipList = [...skipped.values()].sort((a, b) => (a.accession < b.accession ? -1 : 1));

  // The newest quarter looked at becomes the high-water mark. On a run that
  // read nothing new, the existing mark stands.
  const indexedThrough = quarters.length > 0
    ? quarterKey(quarters[quarters.length - 1])
    : existing.indexedThrough;

  writeFileSync(
    OUT,
    `${JSON.stringify(
      { generatedAt: new Date().toISOString(), indexedThrough, items, skipped: skipList },
      null,
      0,
    )}\n`,
  );
  console.log(
    `Wrote ${items.length} transactions (${resolved.length} new), ` +
    `${withRevenue} with revenue, ${withEbitda} with EBITDA, ` +
    `${skipList.length} filings on the skip list, in ${requests} requests.`,
  );

  if (items.length < existing.items.length) {
    console.error('The index shrank, which should not happen on an incremental run.');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
