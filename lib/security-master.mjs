// The bridge between a company a manager writes about and a line in a 13F.
//
// There is no direct join. A 13F reports a CUSIP and an issuer name as the
// filer typed them; it does not report the issuer's SEC CIK, and the name is
// whatever the filing agent put in the field. A letter, meanwhile, names a
// company in prose. Joining those on name would be wrong often enough to
// poison everything downstream, and wrong in the direction that looks right:
// "Alphabet" and "Alphabet Inc. Class C" are not the same security, and
// neither is "First Republic" in 2021 and "First Republic" in 2024.
//
// So the relationship is explicit, and every hop can fail without inventing
// anything:
//
//   a company mentioned in a document
//     -> a reviewed canonical issuer        (a person confirmed it)
//     -> the security master                (CUSIP, class, dates)
//     -> a specific CUSIP and share class
//     -> that manager's 13F position
//
// Two rules that are never relaxed. Never join on issuer name alone. Never
// map one share class to another: Class A and Class C are different
// securities with different prices and different votes, and a manager who
// holds one does not hold the other.
//
// And the position, once found, is context. It corroborates a thesis; it
// never proves one, and its absence proves nothing at all.

export const SECURITY_MASTER_VERSION = 1;

/** Every column a security-master row carries. */
export const SECURITY_FIELDS = Object.freeze([
  'securityId',
  'cusipFiled',        // exactly as the 13F reported it, never cleaned in place
  'cusipNormalised',   // upper case, padded, check digit validated
  'issuerNameFiled',   // as the filer typed it
  'canonicalIssuerName',
  'ticker',
  'exchange',
  'issuerCik',         // where resolved; null is a legitimate answer
  'shareClass',
  'effectiveFrom',
  'effectiveTo',       // null means current
  'mappingSource',
  'mappingConfidence',
  'reviewState',
]);

export const MAPPING_SOURCES = Object.freeze(['sec_company_tickers', 'manual_review', 'filing_cover_page', 'unresolved']);
export const MAPPING_CONFIDENCE = Object.freeze(['exact', 'high', 'medium', 'low', 'none']);
export const SECURITY_REVIEW_STATES = Object.freeze(['confirmed', 'proposed', 'needs_review', 'unresolved']);

/** Confidence levels that may be used without a person having confirmed them. */
const AUTOMATIC_OK = Object.freeze(['exact']);

/** CUSIP check digit, so a typo in a filing is caught rather than mapped. */
export function cusipCheckDigit(first8) {
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ*@#';
  let sum = 0;
  for (let i = 0; i < 8; i += 1) {
    let v = chars.indexOf(first8[i]);
    if (v < 0) return null;
    if (i % 2 === 1) v *= 2;
    sum += Math.floor(v / 10) + (v % 10);
  }
  return String((10 - (sum % 10)) % 10);
}

/** Upper case, trimmed, and only if it is actually a CUSIP. */
export function normaliseCusip(filed) {
  const raw = String(filed ?? '').trim().toUpperCase().replace(/\s+/g, '');
  if (!/^[0-9A-Z*@#]{8,9}$/.test(raw)) return { cusip: null, problem: `${filed} is not a CUSIP` };
  const body = raw.slice(0, 8);
  const expected = cusipCheckDigit(body);
  if (expected === null) return { cusip: null, problem: `${filed} contains a character no CUSIP may hold` };
  if (raw.length === 9 && raw[8] !== expected) {
    return { cusip: null, problem: `${raw} fails its check digit: expected ${expected}` };
  }
  return { cusip: body + expected, problem: null };
}

export function validateSecurityRow(row) {
  const problems = [];
  for (const f of ['securityId', 'cusipFiled', 'issuerNameFiled', 'mappingSource', 'mappingConfidence', 'reviewState']) {
    if (!row[f]) problems.push(`${f} is required`);
  }
  if (row.mappingSource && !MAPPING_SOURCES.includes(row.mappingSource)) problems.push(`${row.mappingSource} is not a mapping source`);
  if (row.mappingConfidence && !MAPPING_CONFIDENCE.includes(row.mappingConfidence)) problems.push(`${row.mappingConfidence} is not a confidence`);
  if (row.reviewState && !SECURITY_REVIEW_STATES.includes(row.reviewState)) problems.push(`${row.reviewState} is not a review state`);
  if (row.cusipNormalised) {
    const { cusip, problem } = normaliseCusip(row.cusipFiled);
    if (problem) problems.push(problem);
    else if (cusip !== row.cusipNormalised) problems.push(`cusipNormalised ${row.cusipNormalised} does not follow from cusipFiled ${row.cusipFiled}`);
  }
  if (row.reviewState === 'confirmed' && !AUTOMATIC_OK.includes(row.mappingConfidence) && row.mappingSource !== 'manual_review') {
    problems.push('a confirmed row below exact confidence must name manual_review as its source');
  }
  if (row.effectiveTo && row.effectiveFrom && row.effectiveTo < row.effectiveFrom) problems.push('effectiveTo precedes effectiveFrom');
  return problems;
}

/**
 * Find the security a 13F line refers to. Unresolved stays unresolved.
 *
 * Matching is on the normalised CUSIP and the date, and on nothing else. A
 * name is carried for a person to read; it is never used to decide.
 */
export function resolveSecurity(line, master, { asOf = null } = {}) {
  const { cusip, problem } = normaliseCusip(line.cusip);
  if (problem) return { security: null, reason: problem, state: 'unresolved' };
  const candidates = master.filter((row) => row.cusipNormalised === cusip
    && (!asOf || ((!row.effectiveFrom || row.effectiveFrom <= asOf) && (!row.effectiveTo || row.effectiveTo >= asOf))));
  if (!candidates.length) return { security: null, reason: `no security-master row for ${cusip}`, state: 'unresolved' };
  if (candidates.length > 1) {
    return { security: null, reason: `${cusip} matches ${candidates.length} rows: ${candidates.map((c) => c.shareClass).join(', ')}`, state: 'ambiguous' };
  }
  const row = candidates[0];
  if (row.reviewState === 'unresolved' || row.reviewState === 'needs_review') {
    return { security: null, reason: `${cusip} is mapped but ${row.reviewState}`, state: row.reviewState };
  }
  return { security: row, reason: null, state: 'resolved' };
}

/**
 * Resolve a company named in a document. Never on name alone.
 *
 * A name reaches an issuer only through a reviewed alias somebody confirmed.
 * An unreviewed alias is a proposal, and a proposal is not a resolution.
 */
export function resolveIssuerMention(mention, aliases) {
  const key = String(mention ?? '').trim().toLowerCase();
  const hits = aliases.filter((a) => a.alias.toLowerCase() === key);
  if (!hits.length) return { issuerId: null, state: 'unresolved', reason: `no reviewed alias for "${mention}"` };
  const confirmed = hits.filter((a) => a.reviewState === 'confirmed');
  if (!confirmed.length) return { issuerId: null, state: 'needs_review', reason: `"${mention}" has only unconfirmed aliases` };
  if (new Set(confirmed.map((a) => a.issuerId)).size > 1) {
    return { issuerId: null, state: 'ambiguous', reason: `"${mention}" is a confirmed alias of more than one issuer` };
  }
  return { issuerId: confirmed[0].issuerId, state: 'resolved', reason: null };
}

/** The lag between a 13F period end and the world seeing it: up to 45 days. */
export const THIRTEEN_F_LAG_DAYS = 45;

/**
 * Position context, with the qualification that makes it honest.
 *
 * Every reason a security can be missing from a 13F while still being held:
 * it is below the reporting threshold, the manager has confidential
 * treatment, it is not a 13F security at all, or the next filing has not
 * landed. A reader shown a position without this is being invited to a
 * conclusion the data does not support.
 */
export function positionContext(position, { asOf }) {
  const warnings = [
    `13F positions are reported up to ${THIRTEEN_F_LAG_DAYS} days after the period end; this is the position on ${position.periodEnd}, not today`,
  ];
  if (!position.shares) {
    warnings.push('absence from a 13F is not an exit: the holding may be below the reporting threshold, under confidential treatment, held through a non-13F instrument, or simply not yet filed');
  }
  return {
    ...position,
    asOf,
    lagWarning: warnings.join('. '),
    corroborationOnly: true,
    provesThesis: false,
  };
}

/**
 * How a position changed, described and not interpreted.
 *
 * A bigger position is a bigger position. It is not more conviction, and a
 * smaller one is not less: a manager trims on risk limits, on redemptions,
 * on a price move. Conviction is recorded only where it was expressed.
 */
export function positionDelta(previous, current) {
  if (!previous || !current) return { direction: 'unknown', impliesConviction: false, impliesExit: false };
  const before = previous.shares ?? 0;
  const after = current.shares ?? 0;
  let direction = 'unchanged';
  if (after > before) direction = 'increased';
  else if (after < before && after > 0) direction = 'decreased';
  else if (after === 0 && before > 0) direction = 'absent_from_filing';
  return {
    direction,
    before,
    after,
    impliesConviction: false,
    impliesExit: false,
    note: direction === 'absent_from_filing'
      ? 'absent from this filing; this is not an exit without a manager statement or a qualified deterministic basis'
      : 'a size change is a size change; it carries no conviction reading on its own',
  };
}
