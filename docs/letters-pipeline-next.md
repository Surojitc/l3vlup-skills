# Next: the public workflow, and the optional Mac ingest

Two designs, neither built. The first is the next pull request; the second
is an interface specification for a consumer that may never be commissioned.
Both exist so the shape is agreed before code is written.

## The architecture this assumes

```
SEC filings
  → public l3vlup-skills collector
  → temporary GitHub Actions workspace
  → deterministic parsing
  → structured thesis and theme extraction   (a later, separately approved stage)
  → compact public JSON
  → L3VLUP site
```

The Mac mini is downstream and optional. Everything above works with it
permanently offline, which is why the default mode retains nothing and needs
no archive.

## 1. The manual workflow

Built: `.github/workflows/letters-parse.yml`. What it says, and why:

| Setting | Value | Why |
|---|---|---|
| Trigger | `workflow_dispatch` only | A first run someone watches, before a schedule exists |
| Schedule | added only after a manual run is reviewed, monthly | The documents move quarterly; monthly is already generous |
| Concurrency | `group: letters-parse`, `cancel-in-progress: false` | Two runs fetching the same documents is impolite to the SEC and races on the output |
| Timeout | `timeout-minutes: 15` | The nine documents parse in under a minute; anything near this is wrong |
| Defaults | `dry_run: true`, `open_pull_request: false` | Running it unchanged plans the work, fetches nothing and opens nothing |
| Contradictions | `dry_run` and `open_pull_request` both true fails on the first step | A dry run produces nothing to open; running half of what was asked and skipping the rest silently is not an answer |
| User agent | `vars.SEC_USER_AGENT` with an identified fallback, never a secret | The SEC asks an automated reader to name itself; there is nothing private in a contact address |
| Branch names | `letters/parsed-<date>-<run id>-<attempt>`, refused if it already exists | A same-second timestamp can collide; a run id cannot |
| Permissions | `contents: read` at the top and on the parsing job; `contents: write` and `pull-requests: write` on the second, and nothing else | The job that touches documents holds no write token, and the one that can write never addresses sec.gov |
| Actions | pinned to full commit SHAs, each with the tag it came from in a comment | A tag can be moved; a commit cannot |
| Output | a pull request from a separate job, never a push to `main` | Generated change is reviewed, not asserted |
| Ceilings | nine documents, nine requests, 15 MiB each, enforced in the script | The workflow cannot raise them by editing a `with:` value |
| AI | none. No `ANTHROPIC_API_KEY`, no model step | This stage is deterministic; extraction is a later approval |
| Artifacts | the three metadata files, named one by one, never a directory or a wildcard | An artifact outlives the runner and is downloadable, so a glob is how a document escapes |
| No-change | the write job starts only when `data/letters.parsed.json` or `data/letters.parsed.md` moved | An unchanged rerun rewrites the same bytes, so an empty diff is the normal result |
| Request logging | routine attempts go to a run log, the job summary and the one-day artifact; the tracked ledger takes only `new_document`, `source_change`, `error` or `milestone_verification` | Nine identical 200s on every run tell nobody anything and make every run look like a change. A durable write always coincides with a publication change, so the ledger never opens a pull request on its own |
| Logs | metadata only: sizes, counts, hashes, statuses | A log is public and permanent |
| Cleanup | the script's own `finally` and signal handlers, then an `if: always()` step that looks for a surviving `letters-run-*` workspace and for any document or text file git did not expect | A shell step cannot clean up a `mkdtemp` directory it was never told about, but it can check the two places a leftover could be and fail the run if it finds one. It asks git rather than mtimes, so there is no race against the checkout's own timestamps |

The sequence: checkout with `persist-credentials: false`, `npm ci
--omit=optional`, the three letters suites, a check that the nine-document
and nine-request ceilings are still in the script, then either a dry run or
a real one in `ephemeral-sec`, the allowlist validator, and a check that the
run left nothing in `data/` but the three metadata files. If they changed,
they are uploaded, named one by one.

The second job downloads them and validates them again, knowing nothing
about how they were made: every record inside the allowlist, every document
one the approved selection names, no more than nine, no run data, and the
two files agreeing with each other. `scripts/letters-validate-output.mjs` is
that gate, and nothing is committed until it passes. Only this job holds a
write token, and it never addresses sec.gov.

`scripts/__tests__/letters-workflow.test.mjs` holds each of these as a test,
so the limits the workflow was agreed under do not depend on anyone
remembering them.

**Runtime and growth, measured.** The nine documents fetched and parsed in
17.8 seconds on an ordinary connection; add `npm ci` for two packages and a
checkout, and a run should be a minute or two. The committed output is
about 12 KB of JSON and 2 KB of Markdown, rewritten in place each run, so
the repository grows by roughly the size of a diff per run, not per
document. Nothing about the documents is stored.

## 2. The Mac ingest, if it is ever commissioned

An interface, not an implementation. The public pipeline must not know
whether this exists.

**What it consumes.** The committed `data/letters.parsed.json`: one record
per document with the accession, the source URL, the SHA-256 of the bytes,
the parser and version, and the quality measures. That file is the contract.

**What it does.**

1. Pull the committed JSON and find records whose accession and source hash
   it has not seen. The pair is the identity: a re-parse with a new parser
   version is a new record for the same bytes, and the ingest can tell.
2. Fetch the original **from sec.gov**, not from GitHub. The public
   repository holds no document bytes and never will, so the ingest goes to
   the source, under the same limits.
3. Verify the SHA-256 against the committed record. A mismatch means the
   filing changed and is a finding, not a retry.
4. Retain the original and any extracted text only on a verified encrypted
   volume, through the `local-private` gate that already exists.
5. Do what the public pipeline will not: optical character recognition on
   image-only exhibits, documents above the 15 MiB cap, manager websites
   whose terms allow a person but not a crawler, and any private research on
   top.
6. Never write private text, extracted prose or a document back into the
   public repository. The flow is one way.

**What it must not become.** A dependency. If the Mac mini is off for a
year, the public pipeline keeps producing the same records and the site
keeps rendering them; the only thing missing is the deeper private work,
which is exactly the sort of thing that should be allowed to wait.
