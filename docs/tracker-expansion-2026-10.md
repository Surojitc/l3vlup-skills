# Opportunity Tracker expansion (October 2026)

_22 October 2026. Batch 1 added 46 employers to `lib/sources/ats-registry.json`.
This note is the method every later batch follows._

## Targets

| Phase | Configured employers | What it takes |
|---|---|---|
| Today, before batch 1 | 106 (95 polled, 11 parked) | |
| Phase 1 | 150 to 200 | Boards our adapters already read: Greenhouse, Ashby, Lever, Workday CXS, Oracle Recruiting Cloud |
| Phase 2 | 300+ | The same, plus the families recorded as unsupported (phenom, iCIMS, SuccessFactors, Avature), each an adapter of its own, measured before it is written |

## Three counts, always reported separately

A registry row is not a source of roles, and a board that answers is not a
board with anything on it. Every batch reports, before and after:

1. **Configured**: rows in the registry, polled and parked.
2. **Healthy**: boards that answered when read, from the board-check file
   (`data/board-checks/`) or, for new rows, from the verification fetches.
3. **Verified opportunities**: employers with at least one role the
   collector's own rules accept, and the number of those roles, early career
   and experienced counted apart.

Adding the first count without the other two is how a tracker comes to list
firms that show nothing.

## Method

1. **Gap list.** Start from the priority sectors (banks and advisers, asset
   managers and funds, private markets and credit, trading, insurance,
   accounting and consulting, corporate finance seats, technology and
   fintech), UK first, then US and Europe. A public competitor listing may
   be read for employer names as a checklist only; nothing else is copied.
2. **Find the board on the employer's own site.** Fetch the careers page and
   take the board it links to (`lib/ats-discover.mjs`). Where the page is
   rendered in the browser, a token may be tried against the ATS API, and is
   then accepted only if the board's name and its postings name the employer
   (and preferably link back to the employer's own domain). Never guess a
   Workday tenant or an Oracle site.
3. **Prove it.** Fetch the board the way `scripts/sync-ats.mjs` does and run
   every posting through `toOpportunity` and `toExperiencedOpportunity`.
   Record the board total, the eligible roles, their regions, verticals and
   programme types, and how long the read took.
4. **Admit only what passes**: a live board, the right employer (not a
   subsidiary's board under the parent's name, not a recruiter), at least one
   eligible role today, application links on the employer's ATS, no duplicate
   by firm, token, tenant or host. A healthy board with nothing eligible is
   recorded in the batch report, not the registry, and re-probed in season.
5. **Keep the conventions.** Rows found from a careers page carry
   `discoveredVia`, `discoveredAt` and `postingsAtDiscovery`; `tier` is a
   value the site's `TIER_ORDER` knows. An unsupported ATS is named with its
   family in the report; no adapter is written inside a registry batch.
6. **Run the suites** (`node scripts/run-collector-tests.mjs`), and never a
   publishing run of the collector from a branch.

## What batch 1 found

- 46 employers admitted, every one with a role today: 625 early-career and
  245 experienced roles on the verification read.
- About 40% of the new early-career rows classify as `Other`, mostly
  insurance (underwriting, claims), audit and assurance, and custody banks'
  programmes. The vertical rules in `scripts/sync-ats.mjs` have no insurance
  or assurance reading; that is a separate change on a danger surface.
- A few rows fall to the region default (Málaga, Bogotá, Penang, Costa Rica,
  Turkey read as US). Two employers whose only current role did so were held
  back.
- Insurers and corporates sit in tier `Other` because the site has no
  insurance or corporate tier. Adding one is a site change first.
- Oracle Recruiting Cloud resolved five employers the earlier sweeps had
  recorded as unsupported; it is supported here, and is the cheapest next
  source of banks and accounting firms.
