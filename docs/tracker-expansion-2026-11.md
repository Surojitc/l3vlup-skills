# Opportunity Tracker: November 2026 cycle (batch 3)

_17 November 2026. Follows the method in `docs/tracker-expansion-2026-10.md`:
three counts, reported apart, and nothing admitted that was not read live._

## What this batch could and could not do

The session that wrote it had no outbound network: every ATS API, EDGAR and
the site itself answered with a refused tunnel. So this batch **admits no
employer**. The method's step 3 ("prove it": fetch the board, run every
posting through `toOpportunity`) cannot be done without a read, and a row
admitted on an October note or a guessed token is exactly what the method
exists to prevent. What it does instead is the work that needs no live read
to be safe, each piece pinned by fixtures, and a verification plan that runs
on the existing GitHub Actions runners.

## 1. Baseline, measured (feed of 16 November 2026, 16:19 UTC)

**Configured** (`lib/sources/ats-registry.json`): 227 rows, 216 polled and 11
parked. By family: Workday 97, Greenhouse 83, Ashby 22, tal.net 8, Oracle 7,
Lever 4, Taleo 2, Eightfold 1, Jane Street 1, custom 1, Avature 1.

**Healthy** (`data/board-checks/2026-11-16.json`): 210 ok, 4 partial, 2 failed.

**Verified opportunities** (`data/opportunities.auto.json`): 3,429 roles at
184 employers.

| Cut | Count |
|---|---|
| Early career (Internship 1,885, Graduate 693) | 2,578 roles, 182 employers |
| Experienced | 851 roles, 39 employers |
| Polled employers with no role today | 32 (Anthropic, OpenAI, PJT Partners, Guggenheim Securities, Marshall Wace, Monzo, OMERS, Aviva, AIG and others; recorded, re-read daily, not removed) |
| UK | 442 (Internship 165, Graduate 122, Experienced 155) |
| US / Asia / Europe / Middle East / Remote | 1,790 / 633 / 499 / 37 / 28 |
| By family (rows) | Workday 1,369, Greenhouse 1,248, Oracle 443, Lever 99, Ashby 89, tal.net 83, Jane Street 67, Eightfold 31 |
| Programme type | Summer Internship 1,883, Lateral 849, Graduate Programme 694, **Spring Week 2**, MBA Hire 1, **Insight Program 0** |
| Vertical `Other` | 759 (22%) |
| Same firm, title and location, distinct requisitions | 50 groups, 72 extra rows (e.g. Samsara posts one SDR internship three times per city). Distinct application links; not merged |
| Duplicate application links | 0 |
| Rows not confirmed by today's read | 0 (every row's `lastConfirmedAt` is the run's own date: nothing stale lingers) |

Experienced rows are concentrated by design: the 60-row cap per firm (150 for
bulge brackets) binds at JPMorgan (150) and at IMC, Point72, QRT and DRW (60
each).

**Run cost.** The ATS sync step took 6 min 10 s on 15 November; the whole
tracker job about 8 minutes, on four jobs. This repository is public, so
GitHub-hosted minutes are not billed; the cost that matters is wall time on a
daily schedule and politeness to the boards.

## 2. The finding: the season is missing

Mid-November is the height of the spring-week and insight season, and the feed
held 2 Spring Week rows and no Insight Program row at all. Two causes, both in
what is asked, not in what is judged:

1. **The search terms.** Workday and Oracle boards are searched, not read
   whole, with `intern, graduate, new grad, summer analyst, apprentice`
   (Oracle: `student` for `new grad`). "2027 Spring Insight Programme",
   "Markets Off-Cycle Analyst" and "Industrial Placement Programme" contain
   none of them, so the 102 polled Workday and Oracle employers, most of the banks,
   never returned those postings to be judged.
2. **The gate.** `isEarlyCareer` admitted "spring insight" but no insight
   programme without "spring" (proposal 1 of the October note), so GSA
   Capital's "General Trading & Technology Insight Programme - 2027" was
   refused on Greenhouse, which is read whole.

## 3. Changes in this batch

| Change | Where | Evidence it is safe |
|---|---|---|
| Four seasonal terms (`spring`, `insight`, `placement`, `off cycle`) searched first on every Workday and Oracle board | `SEASONAL_QUERIES` in `scripts/sync-ats.mjs` | Everything they return still passes `isEarlyCareer` and the vertical rules. They run first so the shared 600-posting budget cannot crowd them out |
| Insight programmes admitted when the word is followed, within three words, by day, week, series or programme; taster day or week | `INSIGHT_PROGRAMME` in `scripts/sync-ats.mjs` | 13 new fixtures in `early-career-recovery.test.mjs`, including "Customer Insights Analyst", "Insights Program Manager" and "Market Insights Events Coordinator" refused. Run over every one of the 5,431 distinct titles in the feed and the archive, it changes the reading of **none**: no row that is published today moves |
| A SmartRecruiters reader, with no registry row | `lib/smartrecruiters.mjs`, fetcher in `scripts/sync-ats.mjs`, `scripts/__tests__/smartrecruiters.test.mjs` (19 cases) | The public, documented Posting API; one request per hundred postings, no detail pages, no trust in `experienceLevel`, a posting under another company identifier refused. Fixtures follow the documented schema and are labelled as such |
| Discovery recognises and validates SmartRecruiters boards | `lib/ats-discover.mjs`, `scripts/discover-ats.mjs` | A 200 with `totalFound: 0` (what an unknown company returns) is not counted as a board |

## 4. Additional opportunities: not yet counted, by rule

The gain from section 3 cannot be counted without a read, and this note does
not estimate it as a number. The first tracker run after merge is the
measurement: compare its Spring Week and Insight Program counts, and its UK
early-career count, with the table above. The run's board checks name every
role id by vertical, so the new rows are attributable to the change.

## 5. Verification plan (existing infrastructure, no new schedule)

1. **After merge, the next daily tracker run** reads the seasonal terms on
   every Workday and Oracle board. Expected marginal time: four extra queries
   on 102 boards, most answering in one page, about 410 requests; at the pace
   of today's step that is in the order of one to three minutes. The step's
   new 30-minute limit is far above it. Record the actual step time.
2. **SmartRecruiters candidates**, through `Discover ATS boards`
   (`discover-ats.yml`, manual only, `write: false`): PA Consulting,
   Evelyn Partners, WTW, Stifel, Tikehau Capital. Admit a row only where the
   board names the employer, a posting passes `toOpportunity` or
   `toExperiencedOpportunity`, and the application link is on
   `jobs.smartrecruiters.com/<company>`. A healthy, empty board goes in the
   batch report for a recheck in season, not in the registry.
3. **Then the sector gap list** from the cycle brief, UK first, through the
   same discovery run: independent advisers, private credit, hedge funds and
   market makers, asset managers and pensions, wealth and investment
   consulting, AI infrastructure and enterprise software, fintech, healthcare
   technology.

## 6. Families not built, and why

| Family | Decision |
|---|---|
| Workable (Interpath, Fasanara, Hayfin) | Not built. Workable's documented API needs the employer's token; the open widget endpoint is undocumented. Whether reading it is permitted is a decision for the owner, not an adapter |
| tal.net tile layout (L.E.K.) | Not built: the October note asks for a saved L.E.K. fixture first, and none could be fetched in this session |
| iCIMS, SuccessFactors, Phenom, Avature | Not built. No public JSON API; each is an HTML reader per front end, and iCIMS was measured on 31 August at one early-career role across three boards. Revisit only with a measured list of employers that would be gained |

## 7. Not changed

No registry row was added, parked or removed. No cap, ceiling or region rule
moved. No paid service is used.
