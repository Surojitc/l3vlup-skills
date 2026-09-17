# Retrieving and parsing the nine approved letters

What this does, and what it refuses to do. The command fetches the nine
documents Suro approved in the Phase 0 pilot, once each, and turns each into
page-aware or section-aware text. It runs no model, no optical character
recognition and no network request beyond those nine. Everything it produces
is a mechanical transformation of bytes the SEC published, and none of those
bytes may reach git.

## Two modes

| | `ephemeral-sec` (default) | `local-private` |
|---|---|---|
| Purpose | the first-cut production path, and what runs in the public collector | optional deeper private work, not part of Phase 0 |
| Where it works | a directory made fresh for the run and deleted at the end | a verified encrypted archive volume |
| What survives | nothing but the public measurements | originals, normalised text and per-unit hashes |
| Needs `LETTERS_ARCHIVE_ROOT` | no | yes, and it must pass every check below |
| Documents it may touch | only URLs on `https://www.sec.gov/` that the approved selection already names | the same |
| Where it can run | a laptop, a GitHub runner, anywhere | the machine holding the archive |

The default needs no archive at all. That is deliberate: the public pipeline
has to keep working with the private machine permanently offline.

```bash
node scripts/retrieve-letters.mjs --dry-run        # plan and checks, fetches nothing
node scripts/retrieve-letters.mjs                  # ephemeral-sec, the default
node scripts/retrieve-letters.mjs --render-only     # rebuild the two files, no network
node scripts/retrieve-letters.mjs --mode local-private
```

## What the approved-document guard does

Two conditions, both required, checked before a request is made: the URL
must be an `https://www.sec.gov/Archives/edgar/data/...` filing document,
and it must appear in `data/letters.selection.json`. Editing a URL does not
reach a document nobody approved.

## The archive gate, for `local-private` only

That mode keeps bytes, so it keeps the gate. Six checks, in order, each with
its own refusal:

| Check | Refuses when |
|---|---|
| archive root set | `LETTERS_ARCHIVE_ROOT` is unset or blank |
| archive root absolute | the path is relative |
| archive root exists | the directory is absent, or is a file |
| archive outside the repository | the path is inside this checkout, where a document could be staged |
| archive is not scratch space | the path is under a temporary directory |
| archive volume is encrypted | the probe says no, or cannot tell |

On Linux the probe asks whether the mount's backing device is a dm-crypt
mapping. **On macOS it is not written yet**, and says so, so `local-private`
refuses there: the private archive has not been commissioned, and an
untested probe returning true would be worse than no probe. It will be
built when the downstream ingest is.

## Temporary data, and what happens to it

Every run gets its own directory from `mkdtemp`, so two runs never share a
path. It is removed by a `finally` block that covers a clean return, a fetch
refusal, a parser that threw, a parser killed on timeout and an interrupted
write; by handlers for `SIGINT`, `SIGTERM` and `SIGHUP`, which is what a
cancelled job sends; and the run then surveys the directory and reports a
failure to delete rather than assuming success. Cleanup is idempotent, so a
signal handler and the `finally` block can both run it.

**What this does not cover**: a machine destroyed mid-run. No code runs
then. On a hosted runner the protection is that the runner itself is
discarded with its disk; that is the isolation, and it is not the same thing
as a guarantee.

## The run

Each document in turn, with a pause between: fetch once, hash while
streaming, write it to the run's own directory, parse it there, measure the
result, then delete the file. Rules the fetcher enforces rather than assumes:

- only the exact approved URL, only `https`, only a `sec.gov` host
- redirects followed only within `sec.gov`, at most three
- the body abandoned the moment it passes **15 MiB (15,728,640 bytes)**, and a
  declared `Content-Length` over the cap refused before the body starts
- the content type checked against what the selection expects
- SHA-256 computed while streaming, so nothing is read twice
- a 403 or a 429 stops the run, with no retry
- at most nine documents and nine requests

A document whose accession, source hash and parser version all match the
previous run is not parsed again; its record is carried forward. The hash is
only knowable after fetching, so idempotency saves the parse, not the
request.

Note on sizes: the SEC serves these compressed, so `Content-Length` reports
the bytes on the wire while the decoded document is larger. The comparison
that matters is against the size the selection recorded, and that is the one
that warns.

## What the run publishes

Two files, both metadata:

- `data/letters.parsed.json` — one record per document: manager, document id,
  subject or period, filing date, form, accession, the authoritative index
  and document URLs, source bytes, SHA-256, MIME type, parser and exact
  version, extraction status, unit counts, character count, the quality
  measures, warnings, and when it was processed.
- `data/letters.parsed.md` — the same, as a table a person reads.

The permitted fields are an allowlist in `lib/letters-output.mjs`. Anything
not on it is dropped before the file is written, a field named after
document content is refused by name, and a string long enough to be prose is
refused even in an allowed field. No original bytes, no extracted text, no
excerpt, no summary, no thesis and no theme tag: those belong to a later
stage that has not been approved.

In `local-private` mode the originals, the normalised text and the per-unit
hashes are also written to the archive. They are never committed.

### An unchanged rerun writes the same bytes

Both files are a function of the documents and nothing else, so a diff on
either means a document moved. Two things make that true.

The committed file carries no run data. No generation stamp, no request
count, no runtime, no tally of what was carried forward: those describe the
run, and a file that changes every time a run happens cannot be read for
what changed. They are printed instead, and later go to the job summary.

A record keeps its `processedAt` until something about it genuinely moves.
The identity of a record is its accession, the SHA-256 of the exact bytes,
the parser and its version, the schema version and the extraction
configuration version. While all six match, the stored record is carried
forward untouched, timestamp and all. When any one of them moves the record
is rebuilt and dated, because that is news.

`extractionConfigVersion` is our configuration of the parsers, versioned by
hand in `lib/letters-output.mjs`. Bump it whenever what the parsers produce
changes: a new hardening flag on the PDF worker, a different rule about
which elements survive the HTML walk, a change to how units are counted. It
is not the library version, which moves for its own reasons.

Records are written in a fixed order — manager, then filing date, then
accession, then document URL — so the file does not depend on the order a
run happened to read them in, or on which ones were carried forward.

```bash
node scripts/retrieve-letters.mjs --render-only
```

rebuilds both files from the records already on disk and makes no network
request at all. Run it twice and `git diff` is empty. It is also how a
change to the Markdown table is applied without asking the SEC for the same
nine documents again.

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
