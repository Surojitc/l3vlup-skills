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

## 1. The manual workflow, for the next pull request

Not added here. What it should say when it is:

| Setting | Value | Why |
|---|---|---|
| Trigger | `workflow_dispatch` only, at first | A first run someone watches, before a schedule exists |
| Schedule | added only after a manual run is reviewed, monthly | The documents move quarterly; monthly is already generous |
| Concurrency | `group: letters-parse`, `cancel-in-progress: false` | Two runs fetching the same documents is impolite to the SEC and races on the output |
| Timeout | `timeout-minutes: 15` | The nine documents parse in under a minute; anything near this is wrong |
| Permissions | `contents: read` for the parsing job | The job that touches documents holds no write token |
| Output | a pull request from a separate job, never a push to `main` | Generated change is reviewed, not asserted |
| Ceilings | nine documents, nine requests, 15 MiB each, enforced in the script | The workflow cannot raise them by editing a `with:` value |
| AI | none. No `ANTHROPIC_API_KEY`, no model step | This stage is deterministic; extraction is a later approval |
| Artifacts | none for source documents or extracted text | An artifact outlives the runner and is downloadable |
| Logs | metadata only: sizes, counts, hashes, statuses | A log is public and permanent |
| Cleanup | a final step with `if: always()` removing the workspace | Belt to the runner's braces |

The sequence: checkout, `npm ci`, run in `ephemeral-sec`, assert the
workspace is gone, then a second job opens the pull request with the two
generated files. Only the second job needs write access, and it never sees a
document.

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
