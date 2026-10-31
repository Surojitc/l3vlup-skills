/**
 * The euro reference rates the site converts reference figures with, read
 * from the European Central Bank and checked before anything is written.
 *
 * WHAT THIS IS FOR
 * ----------------
 * l3vlup.com shows pay bands and career comparisons in the visitor's
 * currency (dollars, pounds or euros). Those are reference figures, rounded
 * to the nearest five thousand, and they need a rate that is recent and
 * correct, not live. The site's own table used to be refreshed by hand; this
 * is the small scheduled replacement. It is never used for a charge: product
 * prices stay in the currency they are billed in, and company models keep the
 * currency they report in. See docs/currency-display-2026-10.md on the site.
 *
 * THE SOURCE
 * ----------
 * https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml: the ECB's
 * euro foreign exchange reference rates, published on TARGET working days
 * around 16:00 CET, public, no key. The file holds one dated block of
 * "units of currency per 1 euro". The site wants "per 1 US dollar", so the
 * dollar is the pivot: EUR = 1 / USD and GBP = GBP / USD, each rounded to six
 * decimals. The rates are cross rates through the euro, so a pound-to-dollar
 * figure is the ECB's own GBP and USD quotes divided, nothing more.
 *
 * WHAT MAKES A FILE FIT TO WRITE
 * ------------------------------
 *   1. both currencies the site converts with (USD and GBP) are present;
 *   2. every rate is a finite number greater than zero;
 *   3. the date is a real calendar date, no later than today and no more
 *      than 10 days old (a weekend, a holiday and a missed run fit inside it;
 *      a feed stuck for a fortnight does not);
 *   4. the date is not older than the date already published (a late
 *      response from a cache must not roll the table back);
 *   5. each derived rate is within 20% of the previous file's rate when there
 *      is one (the dollar and the pound do not move a fifth in a week; a
 *      mis-parsed or inverted rate does, and it must not reach a reader).
 * Any failure writes nothing. The caller exits non-zero with the reasons, the
 * workflow goes red, and the last valid file stays where it is. The site
 * keeps its own check of the same shape, and its own 60-day rule on top.
 *
 * Pure functions only; the network and the file live in scripts/fx-rates.mjs.
 */

export const ECB_URL = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml';
export const FX_SOURCE = 'European Central Bank euro reference rates';

/** Currencies the file carries per dollar; the site's `Currency` type. */
export const FX_CURRENCIES = ['USD', 'EUR', 'GBP'];

/** The oldest a rate date may be at fetch time. */
export const MAX_AGE_DAYS = 10;
/** How far a derived rate may move from the previous file's, as a fraction. */
export const MAX_MOVE = 0.2;

const DAY_MS = 86_400_000;

/** `2026-10-30` and nothing else, and a day that exists (not 2026-02-30). */
export function isCalendarDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s;
}

/** Six decimals, the precision the file promises. */
export const round6 = (x) => Math.round(x * 1e6) / 1e6;

/**
 * The date and the USD and GBP rates out of the ECB's XML.
 *
 * The file is small and regular, so this reads it with patterns instead of an
 * XML library, and is strict about what it accepts: exactly one dated block,
 * and a rate must be a plain decimal ("1.1172"), not "1e3", "NaN" or "-1".
 * Returns { asOf, eurPer } where `eurPer` holds the raw units per euro the
 * file gave (a currency it lacks is simply absent), or { problems }.
 */
export function parseEcbXml(xml) {
  if (typeof xml !== 'string' || !xml.trim()) return { problems: ['the ECB response was empty'] };
  const times = [...xml.matchAll(/<Cube\s+time=(['"])([^'"]*)\1\s*>/g)].map((m) => m[2]);
  if (times.length === 0) return { problems: ['the ECB response has no dated rates block'] };
  if (times.length > 1) return { problems: [`the ECB response has ${times.length} dated blocks, expected one`] };
  const asOf = times[0];
  const block = xml.slice(xml.search(/<Cube\s+time=/));
  const eurPer = {};
  const problems = [];
  for (const m of block.matchAll(/<Cube\s+currency=(['"])([A-Z]{3})\1\s+rate=(['"])([^'"]*)\3\s*\/>/g)) {
    const [, , code, , raw] = m;
    if (code in eurPer) {
      problems.push(`${code} appears twice in the ECB response`);
      continue;
    }
    eurPer[code] = /^\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw;
  }
  return problems.length ? { problems } : { asOf, eurPer };
}

/**
 * The file's body from a parsed response: the dollar as the pivot.
 * Does not judge it; `validateFx` does, so the two stay separately testable.
 */
export function buildFx({ asOf, eurPer }, now) {
  const usd = eurPer.USD;
  const gbp = eurPer.GBP;
  return {
    asOf,
    source: FX_SOURCE,
    fetchedAt: new Date(now).toISOString(),
    perUsd: {
      USD: 1,
      EUR: round6(1 / usd),
      GBP: round6(gbp / usd),
    },
  };
}

/**
 * Rules 1 and 2 on the raw response: both currencies present, each a finite
 * number above zero. Run before any division, so a missing or zero dollar
 * rate is reported by name instead of becoming NaN or Infinity in the file.
 */
export function responseProblems(eurPer) {
  const problems = [];
  for (const code of ['USD', 'GBP']) {
    const v = eurPer?.[code];
    if (v === undefined) problems.push(`${code} is missing from the ECB response`);
    else if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) problems.push(`${code} is not a positive number (${JSON.stringify(v)})`);
  }
  return problems;
}

/**
 * Every reason the built file is not fit to write. An empty list means it is.
 * `fx` is the built file, `prev` the file already published (a usable one) or
 * null. Rule 1 and 2 are checked again on the derived rates, because a rate
 * that is positive per euro can still round to zero or overflow per dollar.
 */
export function validateFx({ fx, prev }, now) {
  const problems = [];
  for (const code of FX_CURRENCIES) {
    const v = fx?.perUsd?.[code];
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) problems.push(`the ${code} rate per dollar is not a positive number (${JSON.stringify(v)})`);
  }

  // 3: a real date, not in the future, not stale.
  const asOf = fx?.asOf;
  if (!isCalendarDate(asOf)) {
    problems.push(`the rate date ${JSON.stringify(asOf)} is not a calendar date`);
  } else {
    const today = new Date(now).toISOString().slice(0, 10);
    if (asOf > today) problems.push(`the rate date ${asOf} is in the future (today is ${today})`);
    const age = Math.floor((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${asOf}T00:00:00Z`)) / DAY_MS);
    if (age > MAX_AGE_DAYS) problems.push(`the rate date ${asOf} is ${age} days old, past the ${MAX_AGE_DAYS}-day limit`);
  }

  // 4 and 5: against the file already published, when there is a usable one.
  if (prev && isCalendarDate(asOf) && isCalendarDate(prev.asOf) && asOf < prev.asOf) {
    problems.push(`the rate date ${asOf} is older than the published ${prev.asOf}`);
  }
  if (prev) {
    for (const code of ['EUR', 'GBP']) {
      const was = prev.perUsd?.[code];
      const next = fx?.perUsd?.[code];
      if (typeof was !== 'number' || !(was > 0) || typeof next !== 'number' || !Number.isFinite(next) || next <= 0) continue;
      const move = Math.abs(next / was - 1);
      // Inclusive: exactly 20% passes. The epsilon is for floating point (0.96 / 0.8 is 1.2000000000000002).
      if (move > MAX_MOVE + 1e-9) {
        problems.push(`${code} moved ${(move * 100).toFixed(1)}% from the published ${was} to ${next}, past the ${MAX_MOVE * 100}% limit`);
      }
    }
  }
  return problems;
}

/**
 * Whether a previously published file can be used as a baseline: the shape the
 * site reads, with positive rates. A file that is not one is ignored as a
 * baseline (and said so) rather than blocking the table from ever recovering.
 */
export function usablePrevious(prev) {
  if (!prev || typeof prev !== 'object') return null;
  if (!isCalendarDate(prev.asOf)) return null;
  const p = prev.perUsd;
  if (!p || typeof p !== 'object') return null;
  for (const code of FX_CURRENCIES) {
    if (typeof p[code] !== 'number' || !Number.isFinite(p[code]) || p[code] <= 0) return null;
  }
  return prev;
}

/**
 * The whole decision, pure: from the response text, the clock and the
 * published file to either the file to write or the reasons not to.
 * `unchanged` is true when the response is the day already published, so the
 * caller leaves the file alone (a new `fetchedAt` alone is not a change).
 */
export function refresh({ xml, now, prev }) {
  const parsed = parseEcbXml(xml);
  if (parsed.problems) return { ok: false, problems: parsed.problems };
  const bad = responseProblems(parsed.eurPer);
  if (bad.length) return { ok: false, problems: bad };
  const baseline = usablePrevious(prev);
  const fx = buildFx(parsed, now);
  const problems = validateFx({ fx, prev: baseline }, now);
  if (problems.length) return { ok: false, problems };
  const unchanged = Boolean(
    baseline && baseline.asOf === fx.asOf && FX_CURRENCIES.every((c) => baseline.perUsd[c] === fx.perUsd[c]),
  );
  const warnings = prev && !baseline ? ['the published file is not a usable baseline and was ignored'] : [];
  return { ok: true, fx, unchanged, warnings };
}
