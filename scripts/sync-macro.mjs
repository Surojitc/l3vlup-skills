#!/usr/bin/env node
// Macro chartbook sync — official primary sources, organized by country.
// No scraping of aggregator sites: US Treasury, BLS, ECB Data Portal, ONS and
// the Bank of England publish these series keylessly. Runs in GitHub Actions
// (open internet); the /macro page renders from the committed JSON with
// per-series source attribution.

import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const UA = { 'User-Agent': 'L3VLUP-macro-chartbook/2.0 (educational; contact: suro@l3vlup.com)' };

const monthKey = (d) => d.slice(0, 7); // YYYY-MM

async function fetchText(url) {
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/** Keep one point per month (last observation), oldest-first, capped. */
function monthly(points, cap = 720) {
  const byMonth = new Map();
  for (const p of points.sort((a, b) => (a.d < b.d ? -1 : 1))) byMonth.set(monthKey(p.d), p);
  return Array.from(byMonth.values()).slice(-cap);
}

// --- US ---------------------------------------------------------------------

// The Treasury yield-curve CSVs are one request per year and carry every
// tenor, so fetch once and serve 10Y, 2Y and the 2s10s spread from one pass.
let treasuryCache = null;

// Years of Treasury CSV to pull per run. Past years are already committed and
// never change, so a weekly refresh only needs the current one (plus last year,
// for the first days of January). FULL_HISTORY=1 backfills all 26 years.
const TREASURY_YEARS = process.env.FULL_HISTORY === '1' ? 26 : 2;

async function treasuryCurve() {
  if (treasuryCache) return treasuryCache;
  const rowsByDate = new Map(); // date → { '10 Yr': n, '2 Yr': n }
  const thisYear = new Date().getUTCFullYear();
  for (let year = thisYear - (TREASURY_YEARS - 1); year <= thisYear; year++) {
    const url = `https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/${year}/all?type=daily_treasury_yield_curve&field_tdr_date_value=${year}&page&_format=csv`;
    try {
      const csv = await fetchText(url);
      const [header, ...rows] = csv.trim().split('\n');
      const cols = header.split(',').map((c) => c.replace(/"/g, '').trim());
      const dateIdx = cols.findIndex((c) => /^date$/i.test(c));
      const tenIdx = cols.findIndex((c) => /^10 ?yr$/i.test(c));
      const twoIdx = cols.findIndex((c) => /^2 ?yr$/i.test(c));
      if (dateIdx < 0 || tenIdx < 0) throw new Error(`columns not found: ${header.slice(0, 120)}`);
      for (const row of rows) {
        const cells = row.split(',');
        const [m, d, y] = (cells[dateIdx] || '').replace(/"/g, '').split('/');
        if (!m || !d || !y) continue;
        const date = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
        const ten = parseFloat(cells[tenIdx]);
        const two = twoIdx >= 0 ? parseFloat(cells[twoIdx]) : NaN;
        rowsByDate.set(date, {
          ten: Number.isFinite(ten) ? ten : null,
          two: Number.isFinite(two) ? two : null,
        });
      }
    } catch (err) {
      console.log(`    treasury ${year}: ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  treasuryCache = rowsByDate;
  return rowsByDate;
}

async function usTenor(which) {
  const rows = await treasuryCurve();
  const points = [];
  for (const [d, r] of rows) if (r[which] !== null) points.push({ d, v: r[which] });
  return monthly(points);
}

async function usCurveSpread() {
  // 10s minus 2s, in basis points. Negative = inverted = the recession klaxon.
  const rows = await treasuryCurve();
  const points = [];
  for (const [d, r] of rows) {
    if (r.ten !== null && r.two !== null) points.push({ d, v: Math.round((r.ten - r.two) * 100) });
  }
  return monthly(points);
}

async function blsSeries(seriesId) {
  // BLS v1 (keyless) caps at 10 years per request and a modest daily quota —
  // two requests cover 20 years of monthly observations.
  const thisYear = new Date().getUTCFullYear();
  const points = [];
  const windows =
    process.env.FULL_HISTORY === '1'
      ? [[thisYear - 19, thisYear - 10], [thisYear - 9, thisYear]]
      : [[thisYear - 1, thisYear]];
  for (const [start, end] of windows) {
    const res = await fetch('https://api.bls.gov/publicAPI/v1/timeseries/data/', {
      method: 'POST',
      headers: { ...UA, 'Content-Type': 'application/json' },
      body: JSON.stringify({ seriesid: [seriesId], startyear: String(start), endyear: String(end) }),
    });
    if (!res.ok) throw new Error(`BLS HTTP ${res.status}`);
    const data = await res.json();
    if (data.status !== 'REQUEST_SUCCEEDED') throw new Error(`BLS: ${data.message?.join('; ')}`);
    for (const item of data.Results.series[0].data) {
      if (!/^M\d\d$/.test(item.period) || item.period === 'M13') continue;
      // BLS publishes gaps (October 2025, for one) as a non-numeric value.
      // A NaN here serialises to null and crashes anything calling toFixed.
      const v = parseFloat(item.value);
      if (!Number.isFinite(v)) continue;
      points.push({ d: `${item.year}-${item.period.slice(1)}-01`, v });
    }
    await new Promise((r) => setTimeout(r, 800));
  }
  return points.sort((a, b) => (a.d < b.d ? -1 : 1));
}

async function usCpiYoY() {
  const index = await blsSeries('CUUR0000SA0'); // CPI-U, all items, NSA index
  const byMonth = new Map(index.map((p) => [monthKey(p.d), p.v]));
  const points = [];
  for (const p of index) {
    const [y, m] = p.d.split('-');
    const prev = byMonth.get(`${Number(y) - 1}-${m}`);
    if (prev) points.push({ d: p.d, v: Number((((p.v - prev) / prev) * 100).toFixed(2)) });
  }
  return points;
}

// --- Eurozone (ECB Data Portal, keyless csvdata) ----------------------------

function parseEcbCsv(csv) {
  // csvdata: header row includes TIME_PERIOD and OBS_VALUE columns.
  const [header, ...rows] = csv.trim().split('\n');
  const cols = header.split(',');
  const tIdx = cols.indexOf('TIME_PERIOD');
  const vIdx = cols.indexOf('OBS_VALUE');
  if (tIdx < 0 || vIdx < 0) throw new Error(`ECB columns not found: ${header.slice(0, 120)}`);
  const points = [];
  for (const row of rows) {
    const cells = row.split(',');
    const t = cells[tIdx];
    const v = parseFloat(cells[vIdx]);
    if (!t || !Number.isFinite(v)) continue;
    const d = t.length === 7 ? `${t}-01` : t; // YYYY-MM → YYYY-MM-01
    if (/^\d{4}-\d{2}-\d{2}$/.test(d)) points.push({ d, v });
  }
  return points;
}

const ecbSeries = (key) =>
  fetchText(`https://data-api.ecb.europa.eu/service/data/${key}?format=csvdata&startPeriod=2000-01`).then(parseEcbCsv);

// --- UK ---------------------------------------------------------------------

async function onsCpiYoY() {
  // ONS CSV generator (keyless): d7g7 = CPI all items, annual rate. Rows are
  // yearly, quarterly then monthly ("2024 JAN",1.2) — keep the monthly ones.
  const csv = await fetchText(
    'https://www.ons.gov.uk/generator?format=csv&uri=/economy/inflationandpriceindices/timeseries/d7g7/mm23'
  );
  const MONTHS = { JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06', JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12' };
  const points = [];
  for (const row of csv.split('\n')) {
    const m = /^"?(\d{4}) ([A-Z]{3})"?,"?(-?[0-9.]+)"?/.exec(row.trim());
    if (m && MONTHS[m[2]]) {
      points.push({ d: `${m[1]}-${MONTHS[m[2]]}-01`, v: parseFloat(m[3]) });
    }
  }
  return points.sort((a, b) => (a.d < b.d ? -1 : 1));
}

async function boeSeries(code) {
  // Bank of England database CSV export, keyless. Rows: "DD Mon YYYY,value"
  const url = `https://www.bankofengland.co.uk/boeapps/iadb/fromshowcolumns.asp?csv.x=yes&Datefrom=01/Jan/2000&Dateto=now&SeriesCodes=${code}&CSVF=TN&UsingCodes=Y&VPD=Y&VFD=N`;
  const csv = await fetchText(url);
  const MONTHS = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
  const points = [];
  for (const row of csv.trim().split('\n').slice(1)) {
    const [dateStr, valStr] = row.split(',');
    const m = /^(\d{1,2}) (\w{3}) (\d{4})$/.exec((dateStr || '').trim());
    const v = parseFloat(valStr);
    if (m && MONTHS[m[2]] && Number.isFinite(v)) {
      points.push({ d: `${m[3]}-${MONTHS[m[2]]}-${m[1].padStart(2, '0')}`, v });
    }
  }
  return monthly(points);
}

// --- Series registry --------------------------------------------------------

const SERIES = [
  // US
  {
    id: 'us-treasury-10y', country: 'US', name: '10-Year Treasury Yield', unit: '%',
    sourceName: 'U.S. Department of the Treasury', url: 'https://home.treasury.gov/resource-center/data-chart-center/interest-rates',
    blurb: 'The risk-free rate every DCF on earth is quietly built on.',
    fetch: () => usTenor('ten'),
  },
  {
    id: 'us-treasury-2y', country: 'US', name: '2-Year Treasury Yield', unit: '%',
    sourceName: 'U.S. Department of the Treasury', url: 'https://home.treasury.gov/resource-center/data-chart-center/interest-rates',
    blurb: 'The market’s bet on where the Fed goes next. Front-end, so it moves first.',
    fetch: () => usTenor('two'),
  },
  {
    id: 'us-curve-2s10s', country: 'US', name: 'Yield Curve (10Y minus 2Y)', unit: 'bp',
    sourceName: 'U.S. Department of the Treasury', url: 'https://home.treasury.gov/resource-center/data-chart-center/interest-rates',
    blurb: 'Below zero means the bond market thinks the Fed has gone too far. It has an unnerving track record.',
    fetch: usCurveSpread,
  },
  {
    id: 'us-cpi-yoy', country: 'US', name: 'US Inflation (CPI, YoY)', unit: '%',
    sourceName: 'U.S. Bureau of Labor Statistics', url: 'https://www.bls.gov/cpi/',
    blurb: 'The print that decides whether the Fed cuts, holds, or ruins your quarter.',
    fetch: usCpiYoY,
  },
  {
    id: 'us-unemployment', country: 'US', name: 'US Unemployment Rate', unit: '%',
    sourceName: 'U.S. Bureau of Labor Statistics', url: 'https://www.bls.gov/cps/',
    blurb: 'The other half of the Fed’s mandate, and the half that ends hiking cycles.',
    fetch: () => blsSeries('LNS14000000'),
  },
  // Eurozone
  {
    id: 'ez-hicp-yoy', country: 'Eurozone', name: 'Euro Area Inflation (HICP, YoY)', unit: '%',
    sourceName: 'European Central Bank', url: 'https://data.ecb.europa.eu/',
    blurb: 'Twenty economies, one index, one 2% target nobody hits on purpose.',
    fetch: () => ecbSeries('ICP/M.U2.N.000000.4.ANR').then((p) => monthly(p)),
  },
  {
    id: 'ez-depo-rate', country: 'Eurozone', name: 'ECB Deposit Facility Rate', unit: '%',
    sourceName: 'European Central Bank', url: 'https://data.ecb.europa.eu/',
    blurb: 'Once negative, which is a sentence that should still bother you.',
    fetch: () => ecbSeries('FM/B.U2.EUR.4F.KR.DFR.LEV').then((p) => monthly(p)),
  },
  {
    id: 'ez-10y-aaa', country: 'Eurozone', name: 'Euro Area 10Y AAA Government Yield', unit: '%',
    sourceName: 'European Central Bank', url: 'https://data.ecb.europa.eu/',
    blurb: 'Europe’s risk-free benchmark. Spreads to Italy are where the drama lives.',
    fetch: () => ecbSeries('YC/B.U2.EUR.4F.G_N_A.SV_C_YM.SR_10Y').then((p) => monthly(p)),
  },
  // UK
  {
    id: 'uk-cpi-yoy', country: 'UK', name: 'UK Inflation (CPI, YoY)', unit: '%',
    sourceName: 'Office for National Statistics', url: 'https://www.ons.gov.uk/economy/inflationandpriceindices',
    blurb: 'Above 3% and the Governor has to write the Chancellor a letter. It has been a busy few years.',
    fetch: onsCpiYoY,
  },
  {
    id: 'uk-bank-rate', country: 'UK', name: 'Bank of England Bank Rate', unit: '%',
    sourceName: 'Bank of England', url: 'https://www.bankofengland.co.uk/boeapps/database/',
    blurb: 'The base every UK mortgage, loan and leveraged deal prices off.',
    fetch: () => boeSeries('IUDBEDR'),
  },
  {
    id: 'uk-gilt-10y', country: 'UK', name: 'UK 10-Year Gilt Yield', unit: '%',
    sourceName: 'Bank of England', url: 'https://www.bankofengland.co.uk/boeapps/database/',
    blurb: 'The line that ended a premiership in 2022. Fiscal credibility, priced daily.',
    fetch: () => boeSeries('IUDMNPY'),
  },
];

// --- Run --------------------------------------------------------------------

const out = { generatedAt: new Date().toISOString(), series: [] };

for (const s of SERIES) {
  process.stdout.write(`Fetching ${s.name} (${s.country})… `);
  try {
    const points = await s.fetch();
    // An incremental run legitimately returns only the recent window (~20
    // monthly points), which the merge below extends onto the committed
    // history. Only a genuinely empty fetch is a failure; the length floor
    // belongs after the merge, not here.
    if (points.length === 0) throw new Error('no points returned');
    const { fetch: _f, ...meta } = s;
    out.series.push({ ...meta, points });
    console.log(`${points.length} pts (${points[0].d} → ${points[points.length - 1].d}, latest ${points[points.length - 1].v})`);
  } catch (err) {
    console.log(`FAILED: ${err.message}`);
  }
}

if (out.series.length === 0) {
  console.error('No series fetched — leaving existing data untouched.');
  process.exit(1);
}

// Merge with what is already committed. Two levels matter:
//   - series level: a source that failed this run keeps its existing chart
//   - point level: a short fetch window extends the history rather than
//     replacing it, which is what makes the cheap weekly run possible
try {
  const prev = JSON.parse(readFileSync(join(ROOT, 'data', 'macro.auto.json'), 'utf8'));
  for (const old of prev.series ?? []) {
    const fresh = out.series.find((s) => s.id === old.id);
    if (!fresh) {
      out.series.push(old);
      continue;
    }
    const byDate = new Map((old.points ?? []).map((p) => [p.d, p]));
    for (const p of fresh.points) byDate.set(p.d, p); // fresh wins on revisions
    fresh.points = Array.from(byDate.values()).sort((a, b) => (a.d < b.d ? -1 : 1));
  }
} catch { /* first run */ }

// No series leaves here carrying a non-finite value, whatever the source did.
for (const s of out.series) {
  const before = s.points.length;
  s.points = s.points.filter((p) => Number.isFinite(p.v));
  if (s.points.length !== before) {
    console.log(`  ${s.id}: dropped ${before - s.points.length} non-numeric point(s)`);
  }
}

// Now that history is merged in, drop anything too thin to chart honestly.
const MIN_POINTS = 12;
const thin = out.series.filter((s) => s.points.length < MIN_POINTS);
for (const s of thin) console.log(`  ${s.id}: only ${s.points.length} points after merge, dropped`);
out.series = out.series.filter((s) => s.points.length >= MIN_POINTS);

for (const s of out.series) {
  console.log(`  ${s.id}: ${s.points.length} points after merge (through ${s.points[s.points.length - 1]?.d})`);
}

mkdirSync(join(ROOT, 'data'), { recursive: true });
writeFileSync(join(ROOT, 'data', 'macro.auto.json'), JSON.stringify(out));
console.log(`\nWrote ${out.series.length} series → data/macro.auto.json`);
