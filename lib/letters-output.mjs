// What a parsing run is allowed to publish.
//
// The risk this module exists for is drift: a field added for a good local
// reason, carried into the committed file a release later, and a sentence of
// somebody's letter is suddenly public. So the public record is an allowlist
// rather than a convention. Anything not named here is dropped before the
// file is written, and a value long enough to be prose is refused outright
// even if its field is allowed.
//
// The permitted fields are provenance and measurement: who wrote it, where
// it is on sec.gov, how big it was, what hashed to what, which parser read
// it and how well. Nothing about what it says.

export const SCHEMA_VERSION = 1;

/**
 * The parsing behaviour, versioned by hand.
 *
 * Bump this whenever what the parsers produce changes: a new hardening flag
 * on the PDF worker, a different rule about which elements survive the HTML
 * walk, a change to how units are counted. It is not the library version,
 * which moves for reasons of its own; it is our configuration of them, and
 * it exists so a record can say whether it was produced the same way as the
 * one before it.
 */
export const EXTRACTION_CONFIG_VERSION = 1;

/** Every field a public record may carry, and what it is. */
export const PUBLIC_FIELDS = {
  schemaVersion: 'the shape of this record',
  manager: 'the fund slug',
  documentId: 'the sha256 of the source bytes; the record is keyed by content',
  subjectOrPeriod: 'the subject company for a solicitation, the reporting period for a shareholder report',
  filingDate: 'the date of the filing',
  form: 'the SEC form type',
  accession: 'the accession number',
  filingIndexUrl: 'the authoritative filing index page on sec.gov',
  documentUrl: 'the document URL as that index printed it',
  sourceBytes: 'the size of what was fetched',
  sha256: 'the hash of what was fetched, computed while streaming',
  mimeType: 'what the server said it sent',
  parser: 'which parser read it',
  parserVersion: 'the exact version, so a re-parse can be compared',
  extractionConfigVersion: 'our configuration of the parsers, bumped when what they produce changes',
  extractionStatus: 'ok, no_text_layer or failed',
  units: 'pages for a PDF, sections for HTML',
  unitCount: 'how many',
  characterCount: 'characters of normalised text, counted and discarded',
  quality: 'the deterministic measures: empty-unit ratio, repeated-edge ratio, replacement rate, table rows, whether manager discussion is present',
  warnings: 'anything a person should look at',
  processedAt: 'when this record was first produced, and preserved while nothing about it changes',
};

/** Fields that would leak the document itself, refused by name as well as by absence. */
const FORBIDDEN = ['text', 'pageText', 'body', 'html', 'excerpt', 'quote', 'content', 'summary', 'claims', 'tags', 'themes', 'items', 'pages', 'sections', 'originalPath', 'textPath'];

const MAX_STRING = 400;
const MAX_WARNING = 500;

/** Only the allowed fields, in a fixed order, with nothing else carried along. */
export function toPublicRecord(row) {
  const out = {};
  for (const key of Object.keys(PUBLIC_FIELDS)) if (row[key] !== undefined) out[key] = row[key];
  return out;
}

/**
 * Everything wrong with a record, as a list. Empty means publishable.
 *
 * Checked rather than trusted, because `toPublicRecord` and this function
 * are written on different days by different hands and only one of them has
 * to be wrong for a letter to escape.
 */
export function validatePublicRecord(record) {
  const problems = [];
  for (const key of Object.keys(record)) {
    if (!(key in PUBLIC_FIELDS)) problems.push(`${key} is not a public field`);
    if (FORBIDDEN.includes(key)) problems.push(`${key} would carry document content`);
  }
  for (const key of ['manager', 'documentId', 'accession', 'documentUrl', 'sha256', 'extractionStatus', 'processedAt']) {
    if (!record[key]) problems.push(`${key} is required`);
  }
  if (record.sha256 && !/^[0-9a-f]{64}$/.test(record.sha256)) problems.push('sha256 is not a 64-character hex digest');
  if (record.documentId && record.sha256 && record.documentId !== record.sha256) problems.push('documentId must be the sha256 of the source bytes');
  if (record.documentUrl && !/^https:\/\/www\.sec\.gov\/Archives\//.test(record.documentUrl)) problems.push('documentUrl must be an authoritative sec.gov archive URL');
  if (record.sourceBytes != null && record.sourceBytes > 15 * 1024 * 1024) problems.push('sourceBytes is over the 15 MiB cap');

  const walk = (value, path) => {
    if (typeof value === 'string') {
      const limit = path.startsWith('warnings') ? MAX_WARNING : MAX_STRING;
      if (value.length > limit) problems.push(`${path} is ${value.length} characters: the public record holds measurements, not text`);
    } else if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) walk(v, `${path}${path ? '.' : ''}${k}`);
    }
  };
  walk(record, '');
  return problems;
}

export function emptyOutput() {
  return buildOutput([]);
}

/**
 * What makes a record the same record: the filing, the exact bytes, the
 * parser and version that read them, the shape we publish and the way we
 * configured the parsing. Any of those moving is a genuine change and earns
 * a new timestamp; none of them moving means a rerun must produce the file
 * it produced last time, byte for byte.
 */
export function identityKey(record) {
  return [
    record.accession,
    record.sha256,
    `${record.parser}@${record.parserVersion}`,
    `schema${record.schemaVersion}`,
    `config${record.extractionConfigVersion}`,
    record.extractionStatus,
  ].join(':');
}

export function unchanged(previous, record) {
  const before = findPrevious(previous, record);
  return Boolean(before && identityKey(before) === identityKey(record));
}

export function findPrevious(previous, record) {
  return (previous?.documents || []).find((d) => d.documentUrl === record.documentUrl) || null;
}

/**
 * The timestamp a record should carry: the one it already had, unless
 * something about it genuinely changed.
 */
export function preserveProcessedAt(previous, record) {
  const before = findPrevious(previous, record);
  if (before && identityKey(before) === identityKey(record) && before.processedAt) {
    return { ...record, processedAt: before.processedAt };
  }
  return record;
}

/** Manager, then filing date, then accession: an order that does not depend on how the run went. */
export function sortRecords(records) {
  return [...records].sort(
    (a, b) =>
      String(a.manager).localeCompare(String(b.manager)) ||
      String(a.filingDate).localeCompare(String(b.filingDate)) ||
      String(a.accession).localeCompare(String(b.accession)) ||
      String(a.documentUrl).localeCompare(String(b.documentUrl))
  );
}

/**
 * The committed file.
 *
 * No generation stamp, no request count, no timing, no tally of what was
 * skipped: those describe the run, not the documents, and a file that
 * changes because a run happened cannot be diffed for what matters. They go
 * to the console and, later, to the job summary.
 */
export function buildOutput(records) {
  return {
    schemaVersion: SCHEMA_VERSION,
    extractionConfigVersion: EXTRACTION_CONFIG_VERSION,
    note: 'Deterministic parsing results for the approved Phase 0 documents. Metadata and measurements only: no original bytes, no extracted text, no excerpt, and no generated analysis. Regenerating without a change produces this file byte for byte.',
    documents: sortRecords(records),
  };
}

export function serialiseOutput(output) {
  return `${JSON.stringify(output, null, 2)}\n`;
}

/** The same content as a table, and just as stable. */
export function renderMarkdown(output) {
  const l = [
    '# Letters: deterministic parsing results',
    '',
    `Schema version ${output.schemaVersion}, extraction configuration ${output.extractionConfigVersion}.`,
    '',
    'Measurements only. No original bytes, no extracted text, no excerpt and no generated analysis: the documents stay on sec.gov, and this file records what was read and how well. It carries nothing about when a run happened, so an unchanged rerun rewrites it identically.',
    '',
    '| Manager | Subject or period | Filed | Form | Bytes | Parser | Status | Units | Characters | Empty | Repeated edge | Discussion | Warnings |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const d of output.documents) {
    const q = d.quality || {};
    l.push(`| ${d.manager} | ${d.subjectOrPeriod} | ${d.filingDate} | ${d.form} | ${d.sourceBytes} | ${d.parser} ${d.parserVersion} | ${d.extractionStatus} | ${d.unitCount} ${d.units} | ${d.characterCount} | ${q.emptyUnitRatio ?? ''} | ${q.repeatedEdgeRatio ?? ''} | ${q.managerDiscussionPresent ? 'yes' : 'no'} | ${(d.warnings || []).length} |`);
  }
  l.push('', '## Warnings', '');
  const withWarnings = output.documents.filter((d) => (d.warnings || []).length);
  for (const d of withWarnings) for (const w of d.warnings) l.push(`- ${d.manager} ${d.filingDate}: ${w}`);
  if (!withWarnings.length) l.push('- none');
  return `${l.join('\n')}\n`;
}
