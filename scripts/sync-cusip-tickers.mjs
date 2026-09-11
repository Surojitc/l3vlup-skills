#!/usr/bin/env node
// CUSIP to ticker, from the SEC's own files.
//
// A 13F information table names a security by CUSIP and by whatever the filer
// typed in the issuer column. It never carries a ticker, and the SEC publishes
// no free CUSIP-to-ticker map, so /intel/funds had a ticker on barely half its
// rows: everything with two share classes (Alphabet, Berkshire) and every ETF
// filed under its trust name (Select Sector SPDR TR, iShares TR) resolved to
// nothing, and a page of ten "Select Sector SPDR TR" lines told a reader
// nothing about what the manager actually bought.
//
// The fails-to-deliver files are the map. The SEC publishes them twice a month
// under FOIA, and each row is settlement date, CUSIP, symbol, quantity,
// description and price for a security that failed to settle at NSCC. The fails
// themselves are irrelevant here; the CUSIP-symbol pair beside them is the
// authoritative link, published by the regulator, free, and covering every
// US-listed name that traded enough to fail once in six months.
//
// Runs in GitHub Actions; /intel/funds renders from the committed JSON. The
// mapping only moves when a ticker changes, so a monthly refresh is ample and a
// stale file is still a correct file.

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const UA = { 'User-Agent': 'L3VLUP-cusip/1.0 (educational; contact: suro@l3vlup.com)' };
const INDEX = 'https://www.sec.gov/data/foiadocsfailsdatahtm';

// Half-monthly files, so twelve is six months. Enough that a name has to have
// gone quiet for half a year to fall out, and small enough to fetch politely.
const FILES = 12;

/**
 * The zip files hold one text member. Node ships an inflater but no zip reader,
 * so this walks the central directory rather than adding a dependency for one
 * archive shape: find the end-of-central-directory record, take the first
 * entry, and inflate it where it sits.
 */
function unzipFirst(buf) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error('not a zip');
  const cd = buf.readUInt32LE(eocd + 16);
  if (buf.readUInt32LE(cd) !== 0x02014b50) throw new Error('no central directory');
  const method = buf.readUInt16LE(cd + 10);
  const compressed = buf.readUInt32LE(cd + 20);
  const local = buf.readUInt32LE(cd + 42);
  if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error('no local header');
  const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
  const body = buf.subarray(start, start + compressed);
  if (method === 0) return body.toString('latin1');
  if (method === 8) return inflateRawSync(body).toString('latin1');
  throw new Error(`compression method ${method}`);
}

/**
 * The punctuated spelling of a symbol, where the SEC publishes one.
 *
 * The fails files strip punctuation: Berkshire's B shares are BRKB there and
 * BRK-B everywhere a person would type them, so the link off a holdings page
 * led nowhere. company_tickers.json is the SEC's own registrant list and does
 * carry the punctuation, so a symbol that matches one of its symbols once the
 * dots and dashes are removed is replaced by that spelling.
 *
 * Matching on the stripped form is what makes this safe rather than a guess.
 * CMCSA, NWSA, FOXA and ZBRA all end in their share-class letter and are all
 * correct as they stand; none of them collides with a punctuated symbol, so
 * none of them is touched. Only a symbol that is demonstrably the same string
 * as a punctuated one changes.
 */
async function punctuation() {
  try {
    const res = await fetch('https://www.sec.gov/files/company_tickers.json', { headers: UA });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const rows = await res.json();
    const plain = new Set();
    const map = new Map();
    for (const r of Object.values(rows)) {
      const t = String(r?.ticker ?? '').toUpperCase().trim();
      if (!t) continue;
      if (/[.\-]/.test(t)) map.set(t.replace(/[.\-]/g, ''), t);
      else plain.add(t);
    }
    // A stripped form can collide with a symbol somebody else already trades
    // under: AT&T's preferred series C is T-PC, which strips to TPC, and TPC is
    // Tutor Perini. Where the stripped form is itself a live symbol the fails
    // file is believed and nothing is rewritten.
    for (const stripped of map.keys()) if (plain.has(stripped)) map.delete(stripped);
    console.log(`punctuated symbols from company_tickers.json: ${map.size}\n`);
    return map;
  } catch (e) {
    console.log(`  company_tickers.json unavailable (${e.message}); symbols stay as the fails files spell them\n`);
    return new Map();
  }
}

async function fetchBuffer(url) {
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * The SEC has moved these files between two directories over the years and the
 * index page is the only place that says which one a given month lives in, so
 * the hrefs are read rather than guessed.
 */
async function fileUrls() {
  const res = await fetch(INDEX, { headers: UA });
  if (!res.ok) throw new Error(`index HTTP ${res.status}`);
  const html = await res.text();
  const urls = [];
  const seen = new Set();
  for (const m of html.matchAll(/href="([^"]*cnsfails(\d{6}[ab])\.zip)"/gi)) {
    if (seen.has(m[2])) continue;
    seen.add(m[2]);
    urls.push({ period: m[2], url: new URL(m[1], 'https://www.sec.gov').href });
  }
  // Newest first on the page already, but the order is what decides which
  // symbol wins for a CUSIP that changed ticker, so it is made explicit.
  urls.sort((a, b) => b.period.localeCompare(a.period));
  return urls.slice(0, FILES);
}

// A fund is linked to a fund reference and a company to a company one, so the
// test has to be a signal that is actually about the vehicle rather than a word
// that happens to appear in a name. These are issuers and product suffixes that
// only ever front pooled vehicles; anything they miss stays an ordinary
// security, which costs a reader a better link rather than sending them to a
// page that does not exist.
const FUND_SIGNAL =
  /\b(ETF|ETN|ETP|SPDR|ISHARES|PROSHARES|DIREXION|WISDOMTREE|VANECK|ROUNDHILL|GLOBAL X|GLOBALX|POWERSHARES|GRANITESHARES|SIMPLIFY|TIDAL|AMPLIFY|DEFIANCE|YIELDMAX|INVESCO (QQQ|EXCHANGE)|SELECT SECTOR|INDEX F(D|UND)|MUTUAL F(D|UND)|CLOSED END|TRUST F(D|UND))\b/;

const isFund = (description) => FUND_SIGNAL.test(description.toUpperCase());

async function main() {
  const files = await fileUrls();
  if (!files.length) throw new Error('no fails-to-deliver files listed');
  const punctuated = await punctuation();
  console.log(`SEC fails-to-deliver: ${files.length} files, ${files[files.length - 1].period} to ${files[0].period}\n`);

  // Oldest first so the newest file writes last and a renamed ticker ends on
  // the name it trades under now.
  const tickers = {};
  const funds = new Set();
  const periods = [];
  for (const { period, url } of [...files].reverse()) {
    let text;
    try {
      text = unzipFirst(await fetchBuffer(url));
    } catch (e) {
      console.log(`  ${period}: skipped (${e.message})`);
      continue;
    }
    let rows = 0;
    for (const line of text.split(/\r?\n/).slice(1)) {
      const f = line.split('|');
      if (f.length < 5) continue;
      const cusip = f[1].trim().toUpperCase();
      const symbol = f[2].trim().toUpperCase();
      // NSCC pads the symbol column when a CUSIP is standing in for something
      // temporary: a when-issued line, a post-split class, a security it has no
      // symbol for at all. Honeywell's ordinary CUSIP arrives as HONZZZZ in one
      // file out of twelve and as HON in the rest, and a page that prints
      // HONZZZZ beside Honeywell has told the reader something false. These
      // rows are dropped rather than trimmed back to a guess: the CUSIP almost
      // always appears again spelled properly, and where it does not, no ticker
      // is the honest answer.
      if (!/^[0-9A-Z]{9}$/.test(cusip)) continue;
      if (!/^[A-Z][A-Z0-9.\-]{0,9}$/.test(symbol) || /Z{2,}$/.test(symbol) || /X{3,}/.test(symbol)) continue;
      tickers[cusip] = punctuated.get(symbol) ?? symbol;
      // Sticky: the description is truncated at thirty characters, so a fund
      // whose name runs long can lose its signal in one file and keep it in the
      // next. Once a symbol has shown itself to be a fund it stays one.
      if (isFund(f[4] || '')) funds.add(tickers[cusip]);
      rows += 1;
    }
    periods.push(period);
    console.log(`  ${period}: ${rows.toLocaleString()} rows`);
  }

  const out = {
    generatedAt: new Date().toISOString(),
    source: 'SEC fails-to-deliver data (FOIA), https://www.sec.gov/data/foiadocsfailsdatahtm',
    periods: periods.reverse(),
    count: Object.keys(tickers).length,
    // Sorted so a refresh that changes nothing produces no diff.
    tickers: Object.fromEntries(Object.entries(tickers).sort(([a], [b]) => a.localeCompare(b))),
    funds: [...funds].sort(),
  };

  mkdirSync(join(ROOT, 'data'), { recursive: true });
  writeFileSync(join(ROOT, 'data', 'cusip-tickers.auto.json'), JSON.stringify(out));
  console.log(`\nWrote ${out.count.toLocaleString()} CUSIPs (${out.funds.length.toLocaleString()} fund tickers) → data/cusip-tickers.auto.json`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
