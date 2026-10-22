/**
 * SEC filing evidence for one corporate-action candidate: the filings the
 * company made near the date, their text, and the share counts on their
 * covers. lib/corporate-actions.mjs decides what the evidence means.
 *
 * Every URL built here is on sec.gov: EDGAR's submissions and company-concept
 * APIs on data.sec.gov, and the filing archive on www.sec.gov. Nothing else is
 * fetched, and nothing a filing links to is followed. The fetcher is injected,
 * so the collector supplies a polite one (a declared User-Agent, a pause
 * between requests, retries) and the tests supply fixtures.
 *
 * Network failure is not evidence: it returns { checked: false } and the
 * candidate stays as it was, to be tried on a later run. An error carrying
 * `stop` (the collector's 403/429) is never swallowed.
 */

import { CURRENT_FORMS, EVIDENCE_DAYS_AFTER, EVIDENCE_DAYS_BEFORE, EVIDENCE_FORMS } from './corporate-actions.mjs';

export const SEC_HOSTS = /^https:\/\/(www|data)\.sec\.gov\//;
const DAY = 86_400_000;
/**
 * At most this many filings are read per candidate, nearest the date first,
 * and this many exhibits each. A move shaped like a split reads every evidence
 * form, since its announcement can sit in a proxy months before; any other
 * move reads current reports only, which is where a spin-off, a distribution
 * or a split announced alongside a large day's move is stated.
 */
export const MAX_FILINGS = 12;
export const MAX_FILINGS_UNSHAPED = 6;
const MAX_EXHIBITS = 2;
/** A document is read to this many characters: a split ratio or a spin-off is stated early. */
const MAX_TEXT = 400_000;

/** IEX writes a class with a dot (BRK.B); SEC's ticker file with a dash (BRK-B). */
export const secTicker = (symbol) => symbol.replace(/\./g, '-').toUpperCase();

/** { TICKER: cik } from SEC's company_tickers_exchange.json ({ fields, data }). */
export function tickerIndex(json) {
  const out = {};
  const f = json?.fields ?? [];
  const iCik = f.indexOf('cik');
  const iTicker = f.indexOf('ticker');
  if (iCik < 0 || iTicker < 0) return out;
  for (const row of json.data ?? []) {
    const t = typeof row[iTicker] === 'string' ? row[iTicker].toUpperCase() : null;
    if (t && Number.isInteger(row[iCik]) && !(t in out)) out[t] = row[iCik];
  }
  return out;
}

const pad = (cik) => String(cik).padStart(10, '0');
const shift = (iso, days) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);

/**
 * The evidence for `symbol`'s move on `date`.
 *   get(url, 'json' | 'text') -> parsed JSON or text; throws on failure.
 *   splitShaped: whether the move is shaped like a split (which forms are read).
 *   cache: an object kept for the run, so a company's submissions and share counts are fetched once.
 * Returns { checked: true, date, cik, filings, shares } or { checked: false, error }.
 */
export async function gatherEvidence({ symbol, date, tickers, get, splitShaped = true, maxFilings = splitShaped ? MAX_FILINGS : MAX_FILINGS_UNSHAPED, cache = null }) {
  const cik = tickers[secTicker(symbol)] ?? null;
  if (!cik) return { checked: true, date, cik: null, filings: [], shares: [] };
  const fetchSec = (url, kind) => {
    if (!SEC_HOSTS.test(url)) throw new Error(`refusing a non-SEC URL: ${url}`);
    return get(url, kind);
  };
  try {
    // A run's cache: one company's submissions and share counts serve every candidate of its symbol.
    const once = (url, kind) => (cache ? (cache[url] ??= fetchSec(url, kind)) : fetchSec(url, kind));
    const sub = await once(`https://data.sec.gov/submissions/CIK${pad(cik)}.json`, 'json');
    const r = sub?.filings?.recent ?? {};
    const from = shift(date, -EVIDENCE_DAYS_BEFORE);
    const to = shift(date, EVIDENCE_DAYS_AFTER);
    const listed = (r.form ?? [])
      .map((form, i) => ({ form, filed: r.filingDate?.[i], accession: r.accessionNumber?.[i], doc: r.primaryDocument?.[i] }))
      .filter((x) => (splitShaped ? EVIDENCE_FORMS : CURRENT_FORMS).has(x.form) && typeof x.filed === 'string' && x.filed >= from && x.filed <= to && /^\d{10}-\d{2}-\d{6}$/.test(x.accession ?? '') && /^[\w.-]+$/.test(x.doc ?? ''))
      .sort((a, b) => Math.abs(Date.parse(a.filed) - Date.parse(date)) - Math.abs(Date.parse(b.filed) - Date.parse(date)))
      .slice(0, maxFilings);

    const filings = [];
    let missing = 0;
    for (const x of listed) {
      const folder = `https://www.sec.gov/Archives/edgar/data/${cik}/${x.accession.replace(/-/g, '')}`;
      const url = `${folder}/${x.doc}`;
      try {
        let text = String(await fetchSec(url, 'text')).slice(0, MAX_TEXT);
        // An 8-K or 6-K often states the terms only in its press release.
        if (/^(8-K|6-K)/.test(x.form)) {
          const index = await fetchSec(`${folder}/index.json`, 'json').catch((e) => { if (e?.stop) throw e; return null; });
          const exhibits = (index?.directory?.item ?? []).map((i) => i?.name).filter((n) => typeof n === 'string' && /ex-?99/i.test(n) && /\.(htm|html|txt)$/i.test(n) && /^[\w.-]+$/.test(n)).slice(0, MAX_EXHIBITS);
          for (const n of exhibits) text += ` ${String(await fetchSec(`${folder}/${n}`, 'text')).slice(0, MAX_TEXT)}`;
        }
        filings.push({ form: x.form, filed: x.filed, accession: x.accession, url, text });
      } catch (e) {
        // A rate limit ends the read; one document that will not load is left out and counted.
        if (e?.stop) throw e;
        missing += 1;
      }
    }
    // Evidence with most of its documents missing is not evidence: try again on a later run.
    if (listed.length && missing * 2 > listed.length) return { checked: false, error: `${missing} of ${listed.length} filings could not be read` };

    const concept = await Promise.resolve(once(`https://data.sec.gov/api/xbrl/companyconcept/CIK${pad(cik)}/dei/EntityCommonStockSharesOutstanding.json`, 'json')).catch((e) => { if (e?.stop) throw e; return null; });
    const shares = (concept?.units?.shares ?? [])
      .filter((s) => typeof s?.val === 'number' && typeof s?.end === 'string')
      .map((s) => ({ end: s.end, val: s.val, form: s.form ?? null, accession: s.accn ?? null }));
    return { checked: true, date, cik, filings, shares };
  } catch (e) {
    return { checked: false, stop: Boolean(e?.stop), error: String(e?.message ?? e).slice(0, 200) };
  }
}
