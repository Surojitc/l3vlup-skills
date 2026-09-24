# Role lifecycle telemetry: how old the undated roles are

_23 September 2026. Measured against the feed of 2026-09-20 (1,386 rows), the
32 snapshots in `data/tracker-history.json` and the 1,720 entries in
`data/tracker-archive.json`. Analysis only: no closure or expiry rule is
implemented, and none is recommended yet. Reproduce every table with
`npm run report:lifecycle`._

## Why this exists

An SEO audit found a role still published in September 2026 as
`citi-2025-markets-internship-colombia`, status Listed, no deadline. The
tempting fix is an expiry rule. Before writing one, this measures what every
candidate rule would actually remove.

The fact that shapes everything below: **the collector already drops any role
that is absent from its firm's board on a run.** `lib/role-retention.mjs`
carries a role forward only when the board request itself failed, for at most
seven days, and tags it `Unconfirmed`. So a "stale" row in the feed is one the
employer's own ATS is still listing today. The Citi row above is not a
collector bug. Workday's detail endpoint, asked on 2026-09-23, still returns
it with `canApply: true` and a `startDate` of 2025-03-10.

## The population

1,025 of the 1,386 live rows (74%) carry no closing date.

| source | live rows | undated | undated share |
|---|---|---|---|
| workday | 670 | 427 | 64% |
| greenhouse | 308 | 306 | 99% |
| talnet | 95 | 35 | 37% |
| oracle | 86 | 86 | 100% |
| lever | 74 | 74 | 100% |
| janestreet | 69 | 69 | 100% |
| eightfold | 56 | 0 | 0% |
| ashby | 28 | 28 | 100% |

## (a) How long we have seen them

From the board history, which begins on 2026-08-18. This is a floor: a role
first seen on the first snapshot may be much older.

| days since first seen (history) | rows | share |
|---|---|---|
| 0-6 | 189 | 18.4% |
| 7-13 | 141 | 13.8% |
| 14-29 | 594 | 58.0% |
| 30-59 | 101 | 9.9% |
| 60+ | 0 | 0% |

The archive's `firstSeen` is **not** a usable lifetime measure. 624 live rows
carry 2026-09-01 (the archive backfill) and 561 carry 2026-09-18 (the day the
collector took ownership of slugs and began writing the archive itself); 908
live rows have an archive `firstSeen` later than their first appearance in the
history. The history is the better floor until a first-seen date is recorded
per id from day one (see the recommendations).

## (b) How old the ATS says they are

`openingDate` is the posted date from the ATS.

| posted age (days) | rows | share |
|---|---|---|
| 0-6 | 138 | 13.5% |
| 7-13 | 132 | 12.9% |
| 14-29 | 241 | 23.5% |
| 30-59 | 61 | 6.0% |
| 60-89 | 79 | 7.7% |
| 90-179 | 41 | 4.0% |
| 180-364 | 19 | 1.9% |
| 365+ | 75 | 7.3% |
| no posted date | 239 | 23.3% |

By source:

| source | undated | 0-29 | 30-89 | 90-179 | 180-364 | 365+ | no date |
|---|---|---|---|---|---|---|---|
| ashby | 28 | 6 | 16 | 5 | 1 | 0 | 0 |
| greenhouse | 306 | 156 | 96 | 23 | 8 | 23 | 0 |
| janestreet | 69 | 0 | 0 | 0 | 0 | 0 | 69 |
| lever | 74 | 2 | 9 | 6 | 9 | 48 | 0 |
| oracle | 86 | 86 | 0 | 0 | 0 | 0 | 0 |
| talnet | 35 | 0 | 0 | 0 | 0 | 0 | 35 |
| workday | 427 | 261 | 19 | 7 | 1 | 4 | 135 |

Three things make posted age a poor closure signal on its own:

1. **It is missing exactly where age matters.** Workday's list endpoint says
   "Posted 30+ Days Ago" for anything older than a month, and the collector
   rightly refuses to turn a floor into a date. The exact date comes from the
   detail endpoint, which is only asked for rows still hunting a deadline, so
   135 of the oldest Workday rows (including both Citi 2025 rows) have no
   posted date at all. Jane Street and tal.net publish none.
2. **Evergreen postings are old and open.** 48 of Lever's 74 rows are over a
   year old, all of them Palantir; one Palantir internship posting was created
   in February 2016 and is live today. Databricks' "Associate Product Manager, New Grad (2027
   Start)" was first published on Greenhouse in August 2024 and was updated on
   2026-09-23. A 365-day rule would remove both.
3. **Oracle rows are always young** because JPMorgan reposts; age there says
   nothing either way.

## (c) A past recruiting year in the title

Cycles are read as their later year (`2025-2026` and `2025/26` are 2026,
`2026/27` is 2027), a year run into a word counts (`Dec2024`), and a number
running into other digits does not (the requisition `25843173` is not 2584).
See `inferCohortYear` in `lib/role-telemetry.mjs`.

| latest year named | undated rows |
|---|---|
| none | 483 |
| past (< 2026) | 3 |
| 2026 | 41 |
| 2027 or later | 498 |

The three past-year rows:

| slug | title | source | posted | first in history |
|---|---|---|---|---|
| `accenture-accenture-summer-internship-program-consulting-aug-to-dec2024` | Accenture Summer Internship Program - Consulting (Aug to Dec2024) | workday | 2024-04-25 | 2026-09-20 |
| `citi-2025-markets-internship-colombia` | 2025 Markets Internship Colombia | workday | none (detail says 2025-03-10) | 2026-08-28 |
| `citi-2025-wealth-management-summer-internship-dubai-uae-uae-nationals-preferred` | 2025 Wealth Management Summer Internship, Dubai, UAE (UAE Nationals preferred) | workday | none | 2026-08-28 |

Five more name 2026 as their latest year and say "summer": all Mizuho Workday
rows (`mizuho-2026-commercial-lending-technology-summer-internship`,
`mizuho-2026-corporate-communications-and-marketing-summer-internship`,
`mizuho-compliance-internship-summer-2026`, `mizuho-2026-summer-associate-houston`,
`mizuho-2026-manda-summer-associate-chicago`), none with a posted date. A
summer 2026 internship in late September is very likely filled, but "2026"
alone is not a past year: 36 other rows naming 2026 are graduate intakes and
off-cycle seats that can still be recruiting.

## (d) Candidate rules, and what each would touch

Undated live rows each rule would remove at each threshold:

| rule | ≥7d | ≥14d | ≥30d | ≥60d | ≥90d | ≥180d | ≥365d |
|---|---|---|---|---|---|---|---|
| absent from the feed (carried from a failed board) | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| in the feed for N days (history) | 836 | 695 | 101 | 0 | 0 | 0 | 0 |
| posted N days ago | 648 | 516 | 275 | 214 | 135 | 94 | 75 |

- **Absent from the feed.** Already enforced by the collector: an absent role
  is dropped the same day. The only rows to which an absence rule could apply
  are those carried from a failed board, and there are none in this feed
  (retention stops at seven days anyway). There is nothing to add here.
- **In the feed for N days.** Pure age in our own history cannot separate a
  rolling graduate scheme from a forgotten posting, and at 30 days it already
  touches 101 rows most of which are 2027 programmes. Not a rule.
- **Posted N days ago.** At 365 days it removes 75 rows: 48 Palantir
  evergreen postings on Lever that are genuinely open, 23 Greenhouse rows
  (Point72 9, Squarepoint 5, Databricks 3, IMC 3, others 3; the Databricks row
  sampled is a 2027 programme updated this week) and 4 Workday rows. Not a rule on
  its own.
- **A past year in the title.** 3 rows, all three correct on inspection. The
  most precise signal in the data, and the only one that would have caught the
  audited Citi row. Combined with a posted age of 180+ days it catches 1 (the
  Accenture 2024 row), because the Citi rows have no posted date.

### Absence is noisy, which is why the collector does not close on it

Across the 32 snapshots, 1,994 ids have appeared. 220 absences ended with the
role coming back, 21 of them after seven or more missing snapshots:

| snapshots missing before the role returned | returns |
|---|---|
| 1 | 113 |
| 2 | 62 |
| 3 | 5 |
| 4 | 5 |
| 5 | 8 |
| 6 | 6 |
| 7+ | 21 |

Some of this is pagination and query changes in late August rather than
boards blinking, but it is why a missing row renders from the archive rather
than disappearing.

## Can the application URL be validated?

**It can be reached, and it says nothing new.** A sample of 28 sequential
requests, 1.5 s apart, on 2026-09-23, across every family:

| family | sampled | result |
|---|---|---|
| Workday public page | 5 (incl. both Citi 2025 rows, Accenture 2024) | 200, no "closed" text |
| Workday detail API | 2 (Citi 2025 Colombia, Accenture 2024) | 200, `canApply: true` |
| Greenhouse (Databricks via its own site, Flexport) | 4 | 200; Databricks redirects to its careers page |
| Greenhouse board API (Databricks 2024 posting) | 1 | 200, `updated_at` 2026-09-23 |
| Lever public page and API (Palantir, one created 2016) | 5 | 200 |
| tal.net (Morgan Stanley) | 3 | 200 with the real page from here; blocked from CI datacentre ranges per `lib/role-retention.mjs` |
| Jane Street, Ashby, Oracle, Eightfold | 8 | 200 |

Every stale-looking row answered 200 and its ATS still offers the apply
button. That is the same answer the board listing gave that morning, because
the source of both is the employer's ATS. A liveness check adds information
only in two places:

1. **Rows carried from a failed board**, where we have not heard from the ATS
   today. A direct check of the posting through the
   board's own API (Greenhouse `/v1/boards/{token}/jobs/{id}`, Lever
   `/v0/postings/{site}/{id}`, the Workday cxs detail path the collector
   already builds) would confirm or drop them before retention's seven days
   are up. Zero such rows today; up to ~100 on a bad tal.net day.
2. **Soft-404 pages** on company-hosted career sites (Databricks, Stripe),
   where a closed job redirects to a generic page with a 200. Detecting these
   needs per-site rules and is not worth it while the board API is the source.

Cost if it were done for every undated row: ~1,025 extra GETs a day (the
JSON-LD pass already spends up to 1,200). Greenhouse, Lever and Ashby publish
no documented rate limit for their public board APIs; Workday cxs is
per-tenant and already takes up to 75 list calls a firm (five queries, fifteen
pages each). How a closed posting answers on each API was not observed,
because no sampled row was closed; that needs confirming on a known-closed id
before any check is trusted to drop a row. tal.net would fail from CI
regardless. Not recommended as a blanket pass; recommended only for
retained rows.

## Recommendations

### Telemetry the collector should emit per row

| field | how | why |
|---|---|---|
| `firstSeen` | earliest date the id was collated, persisted per id | the archive's value was reset twice (2026-09-01, 2026-09-18); the history holds only 120 days |
| `postedAgeDays` | `today - openingDate` | saves every consumer the arithmetic, and states "unknown" honestly |
| `postedDateSource` | `ats-list`, `ats-detail`, `none` | makes the 135 Workday "30+" rows visible as unknown rather than young |
| `inferredCohortYear` | `inferCohortYear(role).cohortYear` | the most precise staleness signal in the data |
| `daysAbsentFromFeed` | `unconfirmedDays`, already emitted for retained rows | exists; keep |
| `source` | id prefix | exists implicitly; explicit is cheaper for the site |
| `urlCheck` | `{ status, checkedAt }` for retained rows only | the only place a check adds information |

A cheaper and more useful fix sits underneath `postedDateSource`: persist the
Workday detail `startDate` in the deadline ledger when it is first read, so a
row keeps its real posted date after the list endpoint starts saying "30+".
That alone would have dated both Citi 2025 rows.

### Why the derived fields are not emitted yet

They are additive and would not change a slug or which rows are published,
and the feed contract (`scripts/publication-contracts.mjs`) does not reject
extra fields. But the site casts the feed rather than picking from it, and
several server pages spread whole rows (`{ ...o, status }`) before handing them
on. `lib/tracker-wire.ts` on the site records that fields riding along this way
were costing ISR read units on `/tracker`. Three fields across ~1,400 rows is
roughly 70 KB before compression, on pages billed in 8 KB units. That is a
site-side decision, so it is left as a recommendation: add them to the
`Opportunity` type and the wire format deliberately, or emit them to a
separate file the site does not load.

### Three dates, kept apart

Future lifecycle work treats these as separate fields and never lets one
stand in for another:

| concept | what it answers | where it comes from today |
|---|---|---|
| **Posting date** | when the firm published the requisition | `openingDate` for a live row: the ATS list date, or the Workday detail `startDate`, which despite its name is when the posting went live |
| **Application deadline** | when applications close | `closingDate`: the Workday detail `endDate` (shown to candidates as "time left to apply"), the ledger, or a date parsed from the posting text |
| **Programme start / cohort year** | when the job itself starts, the intake it belongs to | not collected as a field; only `inferCohortYear(role)` from the title |

Mixing them is how both earlier mistakes happen. An age threshold on the
posting date would close Palantir postings that are years old and still
hiring, and a deadline check says nothing about an intake that has already
started. The Citi 2025 rows are stale in the third sense: the application
is still open on Workday, but the intake it belongs to was 2025. The honest
treatment is a label ("2025 intake"; "an earlier cohort, still accepting
applications"), not deletion.

The most promising signal is the third field, not an age threshold or a
URL-liveness check. Two concrete steps toward it: persist the Workday detail
`startDate` as the posting date, so it survives the list endpoint's "30+"
(see above); and add an explicit cohort or programme-start field, filled
from the title today and from structured sources where an ATS exposes one.

### If a closure rule is wanted later

The evidence supports, at most: **a past recruiting year in the title and no
later year** (3 rows today, all correct), possibly widened to **"summer" with
the current year once the summer is over** (5 Mizuho rows). Both should mark a
row rather than drop it, so the page can say the listing looks out of date
while the employer still shows it; the site's `Listed` contract is unchanged.
Posted-age and time-in-feed rules would remove real open seats and should not
be used on their own.

## Also landed alongside this report

- `lib/role-screen.mjs`: information sessions, webinars, open days,
  networking events and requisition-only placeholders are screened out of the
  feed, and a requisition label is cleaned off an otherwise real title. On the
  2026-09-20 feed it drops 2 rows and cleans 1. Their archive entries are
  removed so the site answers 404 for a record that was never a role, instead
  of an indexable "archived role"; their slugs stay reserved in the registry.
- `lib/role-duplicates.mjs`: apparent duplicates are classified and reported,
  never collapsed. On the 2026-09-20 feed: 0 postings collected twice, 31
  same-title-same-city groups (64 rows) of distinct requisitions, and 133
  programmes posted in several cities (385 rows).
