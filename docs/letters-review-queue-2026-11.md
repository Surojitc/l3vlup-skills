# Letters review queue (November 2026)

Discovery (`scripts/discover-letters.mjs`) lists filings from the approved
sources. The review queue turns that list into something a person can work
through: each filing classified, checked against the site's catalogue, and
drafted as far as facts allow. It publishes nothing.

## What runs

| Step | Script | Reads | Writes |
|---|---|---|---|
| Discover | `scripts/discover-letters.mjs` | one submissions index per source on data.sec.gov | `data/letters.discovery.{json,md}`, `.cache/letters/` |
| Keys | `scripts/letters-catalogue-keys.mjs --site ../L3vlup` | the site's `data/letters.{catalogue,held,excluded}.json` | `data/letters.catalogue-keys.json` (ids, statuses, accessions, URLs only) |
| Queue | `scripts/letters-queue.mjs` | the cached submissions, the keys, `data/letters.exhibits.json`, the last queue, and at most `--max-indexes` (default 20) filing index pages, one a second | `data/letters.review-queue.{json,md}` |

The weekly workflow (`.github/workflows/letters-discover.yml`) runs discovery
and then the queue, with `contents: read` only, and uploads both as a one-week
artifact. A reviewer commits the queue from the artifact once read, as with
the discovery report. `scripts/__tests__/letters-queue.test.mjs` runs on every
pushed branch through `scripts/run-collector-tests.mjs`; it fails if the
committed queue holds a filing the committed keys already cover, so after
refreshing the keys, run the queue again.

## The classes

Decided from metadata alone, never from a document's text
(`lib/letters-queue.mjs`):

- **investor-letter**: a shareholder report whose registrant was checked to
  carry the manager's letter (`reportCarriesLetter: true` in the registry), or
  an exhibit labelled as a letter (high). An unlabelled PDF under 2 MB is a
  letter at low confidence.
- **presentation**: an exhibit labelled as a deck or slides (high), or an
  unlabelled PDF of 2 MB or more (low). The catalogue has no presentation
  type; one belongs only if it reads as a letter.
- **proxy-material**: a proxy statement, or a solicitation with nothing
  identified in it.
- **other**: ownership amendments, press releases, report amendments, and
  tailored shareholder reports (an open-end fund's report since 2024 carries
  figures, not a letter: a `fund-report` at most).

A label naming an instrument ("registration rights letter agreement", "EX 1:
Amendment No. 1 to the Schedule 13D") is never a letter. A letter filed twice
(a DFAN14A exhibit and the same PDF behind a 13D/A, same subject, label and
size) is marked `repeatOf`.

## Duplicates

A filing is in the catalogue if its accession, or any URL it carries, matches
a published, held or excluded record. Accessions are read off the
`/Archives/edgar/data/<cik>/<18 digits>/` path where a record lacks the field
(42 of the 69 SEC-hosted records did on 7 November 2026). One filing listed by
two approved filers is one entry, with `alsoFiledBy`.

## Why nothing is published automatically

The site publishes a record only when `recordProblems` passes, and that
requires a `why` sentence; a page needs grounded notes and a 100 to 200 word
introduction (`hasDetailPage`). `docs/letters-launch-2026-10.md` in the site
repo says it outright: "A new filing never becomes a new page on its own." So
every skeleton has `why: null`, empty notes, `grounded: false` and
`publishable: false`, and quotes nothing from the filing (an exhibit's label
stays in the entry's reasons, out of the record).

## Sources added on 7 November 2026

Ten, each CIK and entity name read from data.sec.gov that day: Trian
(0001345471), Carl C. Icahn (0000921669), JANA Partners Management
(0001998597), Sachem Head (0001582090), Engaged Capital (0001559771), Third
Point (0001040273), Pershing Square Capital Management (0001336528), and
three closed-end funds whose reports carry the manager's letter: Pershing
Square USA, Ltd. (0002002660), The Gabelli Equity Trust (0000794685) and
Source Capital (0000091847). Every activist source now also lists `SCHEDULE
13D` and `SCHEDULE 13D/A`, the form types EDGAR has used since December 2024.
