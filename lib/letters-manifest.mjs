// The manifest: one row per retrieved document, and the only record of the
// archive that a person reads.
//
// It is written atomically, because a manifest half-written during a crash
// would describe an archive that does not exist: the new copy is written
// beside the old one and renamed over it, which is atomic on every file
// system we run on. Nothing here holds document text; the fields are the
// provenance a later phase needs to prove where a claim came from.

import { renameSync, writeFileSync } from 'node:fs';

export const MANIFEST_VERSION = 1;

/** Every field a row must carry, and what it means. */
export const MANIFEST_FIELDS = {
  manager: 'the fund slug, as in funds.universe.json',
  documentId: 'the sha256 of the bytes: the archive is keyed by content, not by filename',
  subjectOrPeriod: 'the subject company for a solicitation, the reporting period for a shareholder report',
  filingDate: 'the date the filing was made',
  form: 'the SEC form type',
  accession: 'the accession number',
  filingIndexUrl: "the filing index page, the authoritative one EDGAR's own links use",
  documentUrl: 'the document URL as the index page printed it',
  retrievedAt: 'when the bytes were fetched',
  httpStatus: 'the status the fetch ended on',
  contentType: 'what the server said it was sending',
  expectedBytes: 'the size the selection recorded from the index',
  actualBytes: 'the size that arrived',
  sha256: 'the hash of the bytes, computed while streaming',
  parser: 'which parser read it',
  parserVersion: 'the exact version, so a re-parse can be compared',
  extractionStatus: 'ok, no_text_layer, failed or skipped',
  units: 'pages for a PDF, sections for HTML',
  unitCount: 'how many of them',
  characterCount: 'characters of normalised text',
  warnings: 'anything a person should look at',
  originalRetained: 'whether the bytes are still on disk or have been forgotten',
  rightsJudgement: 'why we may hold it',
  sourceClassification: 'the source type from the registry',
};

const REQUIRED = Object.keys(MANIFEST_FIELDS);

export function validateRow(row) {
  const missing = REQUIRED.filter((k) => !(k in row));
  const problems = missing.map((k) => `missing ${k}`);
  if (row.sha256 && !/^[0-9a-f]{64}$/.test(row.sha256)) problems.push('sha256 is not a 64-character hex digest');
  if (row.documentId && row.sha256 && row.documentId !== row.sha256) problems.push('documentId must be the sha256');
  if (row.actualBytes != null && row.actualBytes > 15 * 1024 * 1024) problems.push('actualBytes is over the 15 MiB cap');
  for (const [k, v] of Object.entries(row)) {
    if (typeof v === 'string' && v.length > 500 && k !== 'warnings') problems.push(`${k} is ${v.length} characters: the manifest holds metadata, not text`);
  }
  return problems;
}

export function emptyManifest() {
  return { version: MANIFEST_VERSION, note: 'Metadata only. Originals and extracted text live beside this file on the encrypted archive and are never committed.', updatedAt: null, documents: {} };
}

/** Write the manifest so a crash leaves either the old file or the new one, never half of either. */
export function writeManifestAtomic(path, manifest, { write = writeFileSync, rename = renameSync } = {}) {
  const body = `${JSON.stringify({ ...manifest, updatedAt: new Date().toISOString() }, null, 2)}\n`;
  const tmp = `${path}.tmp-${process.pid}`;
  write(tmp, body);
  rename(tmp, path);
  return tmp;
}

/** A document already in the manifest with the same hash needs no second fetch. */
export function alreadyRetrieved(manifest, sha256) {
  return Boolean(sha256 && manifest.documents?.[sha256] && manifest.documents[sha256].extractionStatus === 'ok');
}
