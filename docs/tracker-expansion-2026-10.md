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

## Batch 2 (24 October 2026)

_30 employers admitted to `lib/sources/ats-registry.json`, 10 of them from the
owner's named list of 31. Every number below is a verification read on 24
October through the collector's own `toOpportunity`, `toExperiencedOpportunity`,
`capExperienced` and `screenRoles`; nothing here has been through a publishing
run, so the "after" column is a projection until the next daily run._

| Count | Before (board check, 24 Oct) | After (projection) |
|---|---|---|
| Configured | 152 (141 polled, 11 parked) | 182 (171 polled, 11 parked) |
| Healthy | 139 of 141 (136 ok, 3 partial, 2 failed) | 169 of 171 (all 30 new boards answered) |
| Employers with roles | 116 (114 with early-career roles) | 146 (144) |
| Roles | 2,233 early career, 812 experienced | +160 early career, +65 experienced |

The two failed boards on 24 October were Marqeta (Greenhouse 404) and
Guggenheim Securities (every Workday request failed); the three partial ones
are batch 1's Oracle boards, BDO USA, BNY and Chubb, stopped by the per-board
request budget, so their counts are floors. Raising `ORACLE_MAX_PAGES_PER_QUERY`
or `ORACLE_MAX_POSTINGS_PER_FIRM` is a change to `scripts/sync-ats.mjs` and is
not in this batch.

**Run-time cost.** Greenhouse, Ashby and Lever: 26 boards, 6.7 s read one after
another, one request each. Workday: 4 boards, 20.3 s (RBC 9.3 s for a 20-posting
board, the other three 3.4 to 3.9 s), five keyword queries each. In the pool of
eight the Greenhouse-family boards hide behind slower ones; the worst case is
each Workday board landing in its own batch, about +20 s. Enrichment adds about
38 Workday detail requests and about 120 posting-page requests on the first run
at a pool of 12, roughly +10 to +15 s, falling once the deadline ledger knows
them. Estimate: +25 to +40 s on the first run, well inside the +90 s allowance.
Each Workday board was taken for a reason: G-Research and RBC were named gaps
with nothing on a cheaper ATS, Alantra is a named European mid-market adviser,
and Capital Group is a large asset manager whose campus seats (CAP Summer
Associate, SLATE) appear on no other board.

### Employers added

| Employer | Sector | Region of today's roles | ATS | Early / experienced |
|---|---|---|---|---|
| Alan | Insurance technology | Europe | Ashby | 7 / 0 |
| Alantra | Investment banking (mid-market) | Europe | Workday | 9 / 0 |
| AlixPartners | Restructuring advisory | US, Europe, Asia | Greenhouse | 7 / 0 |
| Ardea Partners | Investment banking boutique | US | Ashby | 1 / 0 |
| Belvedere Trading | Trading | US | Lever | 6 / 7 |
| Bitpanda | Fintech (digital assets) | Europe | Greenhouse | 5 / 0 |
| Block | Fintech | US | Greenhouse | 2 / 0 |
| Capco | Consulting (financial services) | Asia | Greenhouse | 1 / 0 |
| Capital Group | Asset management | US, UK, Asia | Workday | 8 / 0 |
| Charles River Associates | Economic consulting | US, UK, Europe | Greenhouse | 18 / 0 |
| Duolingo | Technology | US | Greenhouse | 5 / 0 |
| DV Trading | Trading | US, UK, Asia | Greenhouse | 30 / 28 |
| Elixirr | Consulting | UK | Greenhouse | 1 / 0 |
| Engineers Gate | Systematic fund | Asia | Greenhouse | 2 / 5 |
| Flowdesk | Trading (digital assets) | Europe | Greenhouse | 1 / 5 |
| G-Research | Quantitative research | UK | Workday | 9 / 0 |
| Geneva Trading | Trading | US, Europe | Greenhouse | 6 / 4 |
| GSA Capital | Systematic fund | UK | Greenhouse | 2 / 4 |
| Keystone | Economic and strategy consulting | US, UK | Greenhouse | 5 / 0 |
| Lendable | Fintech (lending) | UK | Ashby | 4 / 0 |
| Mako | Trading | UK | Greenhouse | 1 / 1 |
| Marshall Wace | Hedge fund | US | Greenhouse | 1 / 0 |
| Qonto | Fintech | Europe | Ashby | 3 / 0 |
| Quadrature Capital | Systematic fund | UK | Greenhouse | 1 / 1 |
| Raine | Merchant bank (advisory) | US, Asia | Lever | 2 / 0 |
| RBC | Bank (capital markets) | US | Workday | 12 / 0 |
| Redgate | Technology (software) | UK | Ashby | 1 / 0 |
| Teneo | Advisory | US | Greenhouse | 1 / 0 |
| Verition Fund Management | Multi-strategy fund | US, UK, Asia | Greenhouse | 7 / 0 |
| Wincent | Trading (digital assets) | Europe | Ashby | 2 / 10 |

160 early-career rows: 38 UK, 73 US, 33 Europe, 15 Asia, 1 remote; 122 filed as
Summer Internship and 38 as Graduate Programme. Seven boards were found from a
link on the employer's own careers page and carry `discoveredVia`; the rest
were token tries accepted because the board's name and its postings name the
employer (Ashby and Lever expose no board name, so the postings were read).
Points to know:

- RBC's early-talent board was found through the Workday apply links on
  jobs.rbc.com, which is a Phenom front end. Two of its 12 rows are in
  Putrajaya, Malaysia and fall to the US region default.
- Belvedere's "Early Career Talent Partner" postings (two) are recruiter jobs
  that pass on the words "early career": a classifier false positive.
- Verition runs two Greenhouse boards. Only the internships board
  (`veritiongroupllcinternships`) was added, to keep one row per firm; the main
  board (`veritiongroupllc`, 15 postings) yielded 6 experienced rows and no
  early-career one.
- Capco's board holds 726 postings and one early-career role today (an HR
  intern in Bengaluru); it is admitted on the rule and is worth re-reading in
  season for the UK Associate Training Programme.
- `Consulting` is not in the site's `TIER_ORDER` but is the tier the Hiring
  Pulse reads for consulting, so the four consultancies follow the existing
  consulting rows; AlixPartners and Teneo follow FTI as Independent Advisory.

### Named gaps that were not added

None of the 31 named employers appears in `data/opportunities.auto.json` or
`data/tracker-archive.json` under any name. Citadel, Microsoft and Amazon appear
only as hand-kept rows in the site's `data/opportunities.curated.json`, which
the collector neither reads nor refreshes.

| Reason | Employers |
|---|---|
| Already covered | None by the collector (see the curated rows above) |
| Unsupported ATS or no ATS | D. E. Shaw (own application site, apply.deshaw.com); Balyasny (own site on Salesforce Experience Cloud); Fasanara (Workable); Centerview (application form posting to its own site); Qatalyst (applications by email); Campbell Lutyens (graduate page with no ATS link); Panmure Liberum (BambooHR); Eurazeo (JobTeaser); Microsoft (Eightfold, but its PCSX tenant refuses the public `apply/v2` API our adapter calls: "Not authorized for PCSX"); Amazon (amazon.jobs, own search); TikTok (lifeattiktok.com, own API); Tesco (Avature); Roland Berger (own job search on rolandberger.com); PA Consulting (SmartRecruiters: 197 postings, 32 early career by our rules, the most valuable miss of the batch); Interpath (Workable; the Greenhouse token `interpath` is Interpath Laboratory, a different firm); L.E.K. (tal.net, reachable, but its board renders tiles, `<li class="opp-container">`, which `parseTalnetBoard` does not read; 23 vacancies on the Europe board including "London Office - Associate (entry level) - Generalist 2027") |
| No eligible role today | None of the named; Verition's main board, as above |
| Board unreachable | Citadel Securities (403 on every careers URL); NatWest Markets (Cloudflare challenge on jobs.natwestgroup.com); BNP Paribas (403 on the group careers site); MathWorks (403) |
| Identity not confirmed | CapVest (careers page 404 and no careers link on its site, so no board to confirm) |

Two of these are cheap next steps on normal surfaces, each its own pull
request: a SmartRecruiters adapter (public JSON, PA Consulting today and Evelyn
Partners, which links to SmartRecruiters but has no early-career role now), and
a tile-layout branch in `lib/talnet.mjs` with a saved L.E.K. fixture.

Beyond the named list, these answered and were held back: no eligible role
today at Baringa (111 postings), Faculty, Quantexa, Fireblocks, Form3, Funding
Circle, Marshmallow, N26, Paddle, Pennylane, Tractable, TrueLayer, Zilch, Cleo,
Freetrade, Moneybox, Clearwater, Sequoia, B2C2, Keyrock and Oliver Wyman's
two-posting Lever board; Mollie, Solaris, SumUp and Wealthsimple, whose only
eligible roles are working-student or office seats outside the priority
sectors; and two identity failures, Primer (the Ashby board's roles are US
campus coordinators, not the London payments firm) and Wise (the Greenhouse
token belongs to "Wise Worksite Field Sales").

### Programme types: how the collector reads them

`inferProgrammeAndLevel` in `scripts/sync-ats.mjs` knows four early-career
types: Insight Program, Spring Week, Summer Internship and Graduate Programme
(the default). Examples are from the feed, the archive and the raw titles of
every Greenhouse, Ashby and Lever board on 24 October.

| Type | Treatment | Three real examples |
|---|---|---|
| Spring week, insight programme | Recognised, but split two ways: a title with "insight ... programme" is Insight Program, one with "spring insight" and no programme word is Spring Week | Point72 "2027 Point72 Academy Spring Insight Programme – UK" (Insight Program); Morgan Stanley "2027 ISG & MSIM Spring Insight Programme (Frankfurt)" (Insight Program); BlackRock "Spring Insight Event" (Spring Week) |
| Insight programme without "spring" | Dropped before typing: `isEarlyCareer` has no insight token | GSA Capital "General Trading & Technology Insight Programme - 2027"; GSA Capital "Women in Trading & Technology Insight Programme - 2027"; AQR "AQR MBA Discovery - Early Engagement Program" |
| Off-cycle internship | Admitted, folded into Summer Internship when the title says intern, into Graduate Programme when it does not | JPMorgan "2027 Commercial & Investment Banking - Global Markets - Off-cycle Internship - London" (Summer Internship); Raine "2027 Off-Cycle Analyst (Singapore)" (Graduate Programme); Mizuho "Greenhill Off-Cycle Analyst (January - June 2026) - Madrid" (Graduate Programme) |
| Industrial placement, year in industry | Admitted, folded: Graduate Programme unless the title also says internship or student | Barclays "2027 Human Resources Industrial Placement Programme London" (Graduate Programme); PA Consulting "2027 Industrial Placement - Consulting (Agile) - London" (Graduate Programme, on a board we do not read); Morgan Stanley "2027 ISG Central Risk Industrial Placement Internship (London)" (Summer Internship) |
| Apprenticeship | Admitted, folded into Graduate Programme, all 60 seen | Barclays "2027 Technology Developer Degree Apprenticeship Programme Knutsford"; Citi "Citi India Apprenticeship Program - SS Ops"; Qonto "Growth Operations Apprentice" |
| Specialist graduate scheme | Recognised as Graduate Programme (the default) | Citi "Mehnaty Graduate Program (UAE Nationals Only)"; Mastercard "Associate Product Specialist, Launch Graduate Program 2027 – Lisbon, Portugal"; Flexport "Commercial Graduate Trainee" |
| Working student | Admitted, folded into Summer Internship; the German "Werkstudent" is refused | IMC "Working Student - Tech" (Summer Internship); JPMorgan "2027 – Firmwide – Germany Working Student (April – March) – Frankfurt" (Summer Internship); AlixPartners "Werkstudent:in Marketing & Communcations ..." (refused) |
| Recruiting event | Dropped by `lib/role-screen.mjs` only when it names attendance (coffee chat, networking event, information session); other events pass as Graduate Programme | Dropped: Point72 "Point72 Academy Coffee Chats — Class of 2029 (US)", IMC "Aarhus Networking event", S&P Global "Exclusive Networking Event – Client Forward: Early Careers in Commercial Functions". Kept: ING "ING's Early Career Event", S&P Global "Ratings Forward: S&P Global Early Careers Virtual Event - EMEA" |

Proposed rule change (for `scripts/sync-ats.mjs`, a danger surface, so a
separate pull request with these titles as fixtures):

1. Add `insight`, `discovery (day|week|programme|program)` and `taster` to
   `EARLY_CAREER`, so insight programmes without "spring" are admitted, and
   type every spring week or spring insight as Spring Week whatever follows it.
2. Add three types, checked before the intern match: Off-cycle Internship
   (`off[\s-]?cycle`), Industrial Placement (`industrial placement`,
   `placement year`, `year in industry`, `12-month placement`) and
   Apprenticeship (`apprentice`, `apprenticeship`, `aprendiz`). The site's
   programme-type list needs the three values first.
3. Read "Werkstudent" as a working student, and file recruiting events that
   are not dropped ("Early Career Event", "Virtual Event") as an Event type
   rather than as a Graduate Programme, so they are labelled as what they are.
4. Refuse "talent partner" and "recruiter" titles even when they say "early
   career" (Belvedere above).

### Fields shown elsewhere that the tracker does not carry

| Field | Authoritative source | Exposed by our adapters today | What it would be |
|---|---|---|---|
| Historical opening dates | The ATS posting date, for this cycle only: Greenhouse `first_published`, Ashby `publishedAt`, Lever `createdAt`, Oracle `PostedDate`, Workday `startDate` (detail pass), Eightfold `t_create`. Nothing authoritative records earlier cycles | All, as `openingDate` (none for tal.net or Jane Street) | This cycle: a verified fact. Earlier cycles: a historical estimate from our own observations |
| Assessment stages | The employer's programme page, sometimes the posting body | None as a field; the body text is fetched for Greenhouse, Ashby, Lever, Oracle and tal.net | A verified fact only where the employer states it, per programme and in prose; otherwise a community report |
| Visa sponsorship | The posting body, when the employer states it | None as a field; same bodies as above | A verified fact where stated; silence is not a "no" |
| Application materials | Greenhouse's job endpoint with `questions=true` names each required item (GSA Capital: CV required, cover letter optional); the employer's page elsewhere | None (we call the board endpoint, not the per-job one; Ashby, Lever, Workday, Oracle and tal.net expose no form) | A verified fact on Greenhouse, at one request per role |
| Rolling recruitment | The posting body ("reviewed on a rolling basis") | Yes: `extractDeadline` tags a row `Rolling`, 70 of 3,045 rows on 24 October (27 Greenhouse, 41 tal.net, 2 Jane Street); none on Workday, whose list endpoint carries no body | A verified fact as stated by the employer |

What `data/tracker-history.json` gives without new collection: 61 daily
snapshots of every published id since 18 August 2026, and the archive's
`firstSeen` and `lastSeen` for 4,366 URLs. For each record that is the first and
last day the tracker saw it on the employer's board, a floor on when it opened
and a bound on when it closed. It is not the employer's opening date: across
2,464 rows carrying both, our first sighting trails the ATS posting date by a
median of 24 days, because most boards joined the registry after their roles
were posted. It becomes a historical opening estimate ("opened around 2
September last year") only after a second cycle, and only by matching a
programme across years on firm and normalised title, since the ATS issues a new
id each year.

### Manual verified listings (proposal, not built)

For an employer on an ATS we do not read, or an opportunity the employer has
authorised us to list:

- **File**: `data/opportunities.manual.json` in this repo, hand-kept, reviewed
  in a pull request like the registry. It replaces the site's
  `data/opportunities.curated.json`, whose rows carry no source or check date.
- **Shape**: `id` (`manual-<firm>-<n>`, its own namespace, so its slug never
  collides with a collected row), `firm`, `role`, `programmeType`, `location`,
  `region`, `applicationUrl` (on the employer's own domain or ATS),
  `sourceUrl` (the employer page that states the opportunity), `basis`
  (`employer-page` or `employer-authorised`, the latter with the contact's role
  and the date of the authorisation), `verifiedAt`, `verifiedBy`, optional
  `openingDate` and `closingDate`, and `expiresAt`.
- **Expiry**: `expiresAt` is at most 14 days after `verifiedAt`, or the
  closing date if sooner. Past it the row is hidden from the feed, kept in the
  file, and listed in the run log as awaiting re-verification. A row is never
  carried forward by the retention rule.
- **Who re-verifies**: an editor, weekly, from a list the run prints of rows
  expiring in the next three days: open the source URL, confirm the role and
  dates, move `verifiedAt` and `expiresAt`. An authorised row is re-confirmed
  with the employer on the same clock.
- **Merge**: after the collected rows are screened, before slugs are assigned.
  A manual row is dropped if a collected row has the same firm and application
  URL (collected wins). It carries `source: "manual"` and its `verifiedAt` in
  place of `lastConfirmedAt`, and is left out of the board checks, the Hiring
  Pulse, the collapse guard and every "employers with roles" count.
- **On the site**: the programme page says "Listed from <employer>'s own page,
  checked <date>" (or "Listed with <employer>'s agreement, checked <date>")
  instead of the line a collected role carries, and the status is derived from
  its dates as for any other row.
