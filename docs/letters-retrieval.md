# Retrieving and parsing the nine approved letters

What this does, and what it refuses to do. The command fetches the nine
documents Suro approved in the Phase 0 pilot, once each, and turns each into
page-aware or section-aware text. It runs no model, no optical character
recognition and no network request beyond those nine. Everything it produces
is a mechanical transformation of bytes the SEC published, and none of those
bytes may reach git.

## Before anything runs

The archive is a precondition, not a setting. `LETTERS_ARCHIVE_ROOT` must
name a directory that exists, sits outside this repository, is not on
scratch space, and lives on a volume the tool can confirm is encrypted. Six
checks run in that order and the command prints which one failed:

| Check | Refuses when |
|---|---|
| archive root set | `LETTERS_ARCHIVE_ROOT` is unset or blank |
| archive root absolute | the path is relative |
| archive root exists | the directory is absent, or is a file; mount the volume first |
| archive outside the repository | the path is inside this checkout, where a document could be staged |
| archive is not scratch space | the path is under a temporary directory, which a container erases |
| archive volume is encrypted | the probe says no, or cannot tell |

The encryption probe asks the operating system. On macOS it reads
`diskutil info -plist` for the volume holding the path and looks for
`Encrypted`. On Linux it finds the mount's backing device and asks whether
it is a dm-crypt mapping. A probe that cannot answer is a refusal: an
unproven volume is treated as an unencrypted one.

```bash
export LETTERS_ARCHIVE_ROOT=/Volumes/L3VLUP-Letters
export SEC_USER_AGENT='L3VLUP Research (contact: suro@l3vlup.com)'
node scripts/retrieve-letters.mjs --dry-run
```

`--dry-run` prints the precondition results and the nine planned documents
and fetches nothing. It is also what runs when the archive is missing: the
command prints the plan, says which check failed, and exits 3 without a
request.

## The run

```bash
node scripts/retrieve-letters.mjs                     # retrieve, parse, write the archive
node scripts/retrieve-letters.mjs --forget-originals  # keep the text and the hashes, drop the originals
```

Each document, in turn, with a pause between: fetch once, hash while
streaming, write the original under its hash, parse, write the text and the
structured units, update the manifest atomically. A document already in the
manifest with a verified hash and a good extraction is skipped without a
request, so a second run costs nothing.

Retrieval rules the fetcher enforces rather than assumes:

- only the exact approved URL, only `https`, only a `sec.gov` host
- redirects followed only within `sec.gov`, at most three
- a body abandoned mid-stream the moment it passes 15 MiB (15,728,640 bytes)
- a declared `Content-Length` over the cap refused before the body starts
- the content type checked against what the selection expects
- a 403 or a 429 stops the whole run, with no retry
- SHA-256 computed while streaming, so nothing is read twice

## What lands on the archive

```
$LETTERS_ARCHIVE_ROOT/
  originals/<sha256>        the bytes as fetched, or absent after --forget-originals
  text/<sha256>.txt         one normalised UTF-8 file
  structured/<sha256>.json  units in order, each with its own hash
  manifest.json             one metadata row per document
  review/report.md          short samples, for Suro's eyes, never committed
```

Nothing generated lives here: no summary, no claim, no tag, no inference.
Those belong to a later milestone that has not been approved.

## Parsing

**PDF.** `pdfjs-dist`, pinned to 6.3.289, in a child process with a
two-minute wall clock and a 1 GB heap, killed if it passes either. Script
execution, `eval`, XFA forms, system fonts, image decoding and every
external fetch are off, so the file is data. Page numbers are preserved. A
document with no text layer fails closed and is recorded as
`no_text_layer`: there is no optical character recognition here, and an
image-only document is not guessed at.

**SEC HTML and inline XBRL.** `parse5`, the WHATWG parser, walking a real
tree rather than matching patterns. Script, style and page furniture are
dropped with their contents; the inline-XBRL metadata containers
(`ix:header`, `ix:hidden`, `ix:references`, `ix:resources`) are dropped
because they hold tagging rather than prose, while every other `ix:` element
is unwrapped because the visible sentence sits inside one. Headings,
paragraphs, list items and table rows are kept in document order, a table
row holding its cell boundaries. Links are text: nothing is followed,
nothing external is loaded.

## Quality, reported per document

Extraction status, units and how many, raw and normalised character counts,
the share of empty units, the share of units opening or closing with the
same line (a running header counted as content), the replacement-character
rate, how many table rows, and whether the vocabulary of a manager
discussing a holding is present at all. Each threshold crossed becomes a
warning naming what to look at. A warning is for a person, not a gate.

## Dependencies

| Package | Version | Licence | Runtime dependencies | Unpacked | Why |
|---|---|---|---|---|---|
| `pdfjs-dist` | 6.3.289 (exact) | Apache-2.0 | none (`@napi-rs/canvas` optional, not installed) | 34.8 MB | The only maintained, permissively licensed PDF engine that runs in Node without native compilation. Patched against CVE-2024-4367 and CVE-2026-16633 |
| `parse5` | 8.0.1 (exact) | MIT | `entities` | 337 KB | A correct HTML parser for 16 MB inline-XBRL reports, where patterns are neither safe nor accurate |

Both are pinned exactly and locked. Neither is imported by any collector
that runs in GitHub Actions, so the scheduled jobs still need no install.
