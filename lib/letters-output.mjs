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
  extractionStatus: 'ok, no_text_layer or failed',
  units: 'pages for a PDF, sections for HTML',
  unitCount: 'how many',
  characterCount: 'characters of normalised text, counted and discarded',
  quality: 'the deterministic measures: empty-unit ratio, repeated-edge ratio, replacement rate, table rows, whether manager discussion is present',
  warnings: 'anything a person should look at',
  processedAt: 'when this record was produced',
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
  return {
    schemaVersion: SCHEMA_VERSION,
    note: 'Deterministic parsing results for the approved Phase 0 documents. Metadata and measurements only: no original bytes, no extracted text, no excerpt, and no generated analysis. The documents themselves stay on sec.gov.',
    generatedAt: null,
    counts: {},
    documents: [],
  };
}

/** A record is unchanged when the filing, the bytes and the parser are all the same. */
export function identityKey(record) {
  return `${record.accession}:${record.sha256}:${record.parser}@${record.parserVersion}`;
}

export function unchanged(previous, record) {
  const before = (previous?.documents || []).find((d) => d.documentUrl === record.documentUrl);
  return Boolean(before && identityKey(before) === identityKey(record) && before.extractionStatus === record.extractionStatus);
}
