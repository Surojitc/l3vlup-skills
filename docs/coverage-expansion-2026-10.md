# Coverage expansion: wealth, private credit, pensions, insurers, consultants (October 2026)

_30 October 2026. Batch 3 added 45 employers to `lib/sources/ats-registry.json`
(182 to 227 rows, 171 to 216 polled, 11 parked). Every number below is a
verification read on 30 October through the collector's own `toOpportunity`,
`toExperiencedOpportunity`, `capExperienced`, `paginateWorkday` and
`paginateOracle`; nothing has been through a publishing run, so the effect on
`data/opportunities.auto.json` is a projection until the next daily run._

## 1. The gap, by segment, before

The registry had 182 rows. By the brief's segments:

| Segment | Rows before | Which |
|---|---|---|
| Asset managers (traditional and alternative) | 10 | Vanguard, Northwestern Mutual, BlackRock (tal.net), T. Rowe Price, Wellington, Capital Group, Schroders, StepStone, and the two pensions below that sit in the same tier |
| Pensions and sovereign funds | 2 | OMERS, PSP Investments (both tier Asset Manager) |
| Wealth management | 0 | none (Northwestern Mutual and Northern Trust are the nearest, and are not wealth rows) |
| Private credit | 0 | none as such; Apollo (Megafund, Workday) covers some of it |
| Insurers and reinsurers | 4 | AIG, Chubb, Travelers, Prudential Financial (all tier Other); no reinsurer, no UK or European insurer |
| Investment consultants | 0 | none |
| Family and multi-family offices | 0 | none |

Tiers before: Fintech 30, Enterprise Tech 25, Middle Market 24, Trading Tech 17,
Systematic 12, Big Tech 10, Elite Boutique 10, Asset Manager 10, Bulge Bracket 9,
Consulting 9, Other 7, Multi-Manager 6, AI Lab 5, Independent Advisory 4,
Megafund 3, Prop Trading 1.

Tiers after: Fintech 30, Other 29, Asset Manager 28, Middle Market 25, Enterprise
Tech 25, Trading Tech 17, Systematic 12, Elite Boutique 11, Big Tech 10,
Consulting 10, Bulge Bracket 9, Multi-Manager 6, AI Lab 5, Megafund 5,
Independent Advisory 4, Prop Trading 1.

No new tier was created. `Consulting` is not in the site's `TIER_ORDER`
(`app/tracker/TrackerClient.tsx`) but already has nine rows and sorts after the
known tiers; `lib/opportunities.ts` types `tier` as an optional string and
nothing in it enumerates tiers, so the site tolerates an unknown value. The
tier that fits was chosen from the ones in use:

- `Asset Manager` for traditional and alternative managers, private banks, wealth
  firms and the Canadian pension. It is also the tier that makes
  `firmTypeForTier` return `finance`, so a Greenhouse, Ashby or Lever board in it
  would yield experienced rows (none of the 45 is on those families), and it sits
  in the Hiring Pulse's buy-side group.
- `Megafund` for Carlyle and Bain Capital (Blackstone, Apollo and TPG are there).
- `Middle Market` for Baird, as for Raymond James and William Blair.
- `Elite Boutique` for Lazard, matching its parked tal.net row.
- `Consulting` for Cambridge Associates (an investment consultant).
- `Other` for insurers and brokers, as AIG, Chubb, Travelers and Prudential
  Financial already are. The site has no insurance tier, so a registry batch
  cannot give them one (see `docs/tracker-expansion-2026-10.md`, batch 1).

## 2. What was added

The admission rule is the one in `docs/tracker-expansion-2026-10.md`: a live
board on the employer's own ATS, the right employer, a family `sync-ats.mjs`
reads, no duplicate by firm, token, tenant or host, and at least one role today
that the collector's own rules accept. All 45 pass it. Families: 44 Workday, 1
Oracle Recruiting Cloud. No Greenhouse, Ashby or Lever board qualified (see
section 3), so none of the 45 yields experienced rows: Workday and Oracle
boards are searched for early-career terms only, by design.

Counts, 30 October 2026: **45 boards, all answered, no request failed, no walk
was cut short by the page or posting budget. 492 early-career roles, 0
experienced.**

| Firm | Segment | Tier | ATS | Tenant / site | Board postings | Early-career roles | Experienced roles |
|---|---|---|---|---|---|---|---|
| Invesco | Asset management | Asset Manager | workday | `invesco.wd1 / IVZ` | 213 | 5 | 0 |
| PIMCO | Asset management | Asset Manager | workday | `pimco.wd1 / pimco-careers` | 180 | 44 | 0 |
| Neuberger Berman | Asset management (alternatives) | Asset Manager | workday | `nb.wd1 / NBCareers` | 92 | 3 | 0 |
| AllianceBernstein | Asset management | Asset Manager | workday | `abglobal.wd1 / abcampuscareers` | 25 | 20 | 0 |
| Barings | Private credit / asset management | Asset Manager | workday | `barings.wd1 / Barings` | 39 | 3 | 0 |
| Ardian | Private markets | Asset Manager | workday | `ardian.wd103 / ArdianCareers` | 65 | 35 | 0 |
| Dimensional | Asset management | Asset Manager | workday | `dimensional.wd5 / DFA_Careers` | 74 | 10 | 0 |
| TIAA | Asset management (Nuveen) / retirement | Asset Manager | workday | `tiaa.wd1 / Search` | 166 | 3 | 0 |
| 3i | Private equity | Asset Manager | workday | `3i.wd103 / Intern_Career` | 5 | 5 | 0 |
| SEI | Asset management services | Asset Manager | workday | `seic.wd1 / SEI_Global_Services` | 121 | 2 | 0 |
| Robeco | Asset management | Asset Manager | workday | `robeco.wd3 / robecoexternalcareers` | 11 | 2 | 0 |
| Fidelity Investments | Asset management / brokerage | Asset Manager | workday | `fmr.wd1 / FidelityCareers` | 805 | 4 | 0 |
| Ameriprise Financial | Wealth management | Asset Manager | workday | `ameriprise.wd5 / Ameriprise` | 219 | 2 | 0 |
| Lombard Odier | Wealth management (private bank) | Asset Manager | workday | `lombardodier.wd3 / Lombard_Odier_Careers` | 63 | 29 | 0 |
| Julius Baer | Wealth management (private bank) | Asset Manager | workday | `juliusbaer.wd3 / External` | 192 | 6 | 0 |
| LGT | Wealth management (private bank) | Asset Manager | workday | `lgt.wd3 / lgtcurrentvacancies` | 56 | 2 | 0 |
| Brookfield | Alternatives / private credit | Asset Manager | workday | `brookfield.wd5 / brookfield` | 141 | 3 | 0 |
| AIMCo | Pension / sovereign-style investor | Asset Manager | workday | `aimco.wd10 / AIMCoCareers` | 6 | 3 | 0 |
| Carlyle | Private equity and credit | Megafund | workday | `carlyle.wd1 / Carlyle` | 71 | 3 | 0 |
| Bain Capital | Private equity and credit | Megafund | workday | `baincapital.wd1 / External_Private` | 42 | 9 | 0 |
| Baird | Wealth management and banking | Middle Market | workday | `baird.wd1 / Careers` | 144 | 49 | 0 |
| Cambridge Associates | Investment consulting | Consulting | workday | `cambridgeassociates.wd5 / Cambridge_Associates` | 46 | 8 | 0 |
| Lazard | Advisory and asset management (route for the parked tal.net row) | Elite Boutique | oracle | `icbpjb.fa.ocs.oraclecloud.com / LazardProfessionalCareers` | 131 | 43 | 0 |
| Prudential plc | Insurer | Other | workday | `prudential.wd3 / prudential` | 454 | 36 | 0 |
| Aviva | Insurer | Other | workday | `aviva.wd1 / External` | 135 | 1 | 0 |
| The Hartford | Insurer | Other | workday | `thehartford.wd5 / Careers_External` | 248 | 20 | 0 |
| Manulife | Insurer | Other | workday | `manulife.wd3 / MFCJH_Jobs` | 608 | 28 | 0 |
| Guardian Life | Insurer | Other | workday | `guardianlife.wd5 / Guardian-Life-Careers` | 104 | 22 | 0 |
| Pacific Life | Insurer | Other | workday | `pacificlife.wd1 / PacificLifeCareers` | 124 | 10 | 0 |
| Everest | Reinsurer | Other | workday | `everestre.wd5 / careers` | 56 | 6 | 0 |
| Sun Life | Insurer | Other | workday | `sunlife.wd3 / Campus` | 13 | 13 | 0 |
| Unum | Insurer | Other | workday | `unum.wd1 / External` | 82 | 12 | 0 |
| Nationwide | Insurer | Other | workday | `nationwide.wd1 / Nationwide_Career` | 155 | 9 | 0 |
| Jackson Financial | Insurer | Other | workday | `jackson.wd1 / Jackson_Careers` | 34 | 2 | 0 |
| Corebridge Financial | Insurer | Other | workday | `corebridgefinancial.wd1 / CorebridgeFinancial` | 151 | 2 | 0 |
| Allstate | Insurer | Other | workday | `allstate.wd5 / allstate_careers` | 435 | 3 | 0 |
| Transamerica | Insurer | Other | workday | `transamerica.wd5 / US` | 149 | 1 | 0 |
| NN Group | Insurer | Other | workday | `nngroup.wd3 / WDExternal` | 170 | 2 | 0 |
| HUB International | Insurance broker | Other | workday | `hubinternational.wd1 / HUBInternational` | 583 | 7 | 0 |
| Baldwin Group | Insurance broker | Other | workday | `baldwin.wd1 / Baldwin` | 114 | 4 | 0 |
| Acrisure | Insurance broker | Other | workday | `acrisure.wd1 / Acrisure` | 223 | 1 | 0 |
| CNA Financial | Insurer | Other | workday | `cna.wd1 / CNA_Careers` | 109 | 6 | 0 |
| Assurant | Insurer | Other | workday | `assurant.wd1 / Assurant_Careers` | 123 | 10 | 0 |
| Globe Life | Insurer | Other | workday | `globelife.wd5 / Globe-Life-Careers` | 22 | 1 | 0 |
| USAA | Insurer and bank | Other | workday | `usaa.wd1 / USAAJOBSWD` | 232 | 3 | 0 |

`Board postings` is the total the board reported for an empty search (or, where
the family reports none, the number of requisitions read); `Early-career roles`
is what the five keyword queries of `paginateWorkday` (or `paginateOracle`)
returned after `toOpportunity`. Both are on the same day as the registry
`postingsAtDiscovery`.

Points to know before the next daily run:

- **Insurers and brokers read as `Other`.** Of the 492, 199 are insurance
  and broker rows (actuarial, claims, underwriting, IT) and most classify as
  `Other` or `Software Engineering`. This is the same effect batch 1 recorded; the
  vertical rules in `sync-ats.mjs` have no insurance reading.
- **False positives that pass the early-career test.** Ameriprise's "Recruiter,
  Early Careers" and Neuberger Berman's "Student General Interest Form" are not
  seats; HUB International's seven rows are one programme repeated by city
  (`collapseRepeats` is only applied to experienced rows). The Ontario Teachers
  board was not added because its only match is a campus-recruiter vacancy.
- **Region defaults.** Calgary (AIMCo), Montreal (Manulife) and other Canadian
  cities, Guernsey (Julius Baer) and Liechtenstein (LGT) fall to the US default
  in `inferRegion`. They are still the right employer's real roles.
- **Lazard is a second route, not a second firm.** The parked `Lazard` row is the
  gated tal.net tenant. The new row reads Lazard's professional Oracle site
  (`LazardProfessionalCareers`, linked from lazard.com/careers), which carries 43
  early-career roles today (2028 summer analyst seats and M&A internships). It
  shares a name with the parked row; if that is not wanted, delete the one row,
  nothing else depends on it.
- **Run time.** Forty-five more boards at 6 to 16 seconds each, in the pool of
  eight, is about one extra minute on the collection. The Workday detail pass is
  capped at 800 requests a run; up to 492 new roles without a ledger entry could take most of
  one first-run cap, so deadlines on the new rows may arrive over two runs.
- **Hiring Pulse.** The new boards have no history, so they are not compared
  until they have two comparable days; the registry grew 25 per cent, inside the
  1.5 ratio `publication-contracts.mjs` allows.

### How the boards were found

Three routes, all on public endpoints, none of them a login or a bot gate:

1. **The employer's own careers page** (`lib/ats-discover.mjs` on the page's
   links): Invesco, TIAA (via the Nuveen page), PIMCO, Prudential plc and Lazard.
   These rows carry the careers page in `discoveredVia`.
2. **The Workday tenant's `robots.txt`.** A Workday tenant host publishes its
   site names in its own `robots.txt` (`Sitemap: .../<site>/siteMap.xml`), so a
   brand-derived tenant on `wd1`, `wd3`, `wd5`, `wd10` or `wd103` needs one request
   to learn whether it exists and what its sites are called. Careers pages that are
   client-rendered (most asset managers, insurers and pensions) expose no link, so
   this found the other 40 Workday boards. It is a guess at the tenant name and
   it can be wrong: it returned `hamilton` (Hamilton Company, a Swiss medical
   device maker, not Hamilton Lane), `park` (Park University) and `brown` (Brown
   University, not Brown & Brown), all rejected. A board is therefore admitted
   only after the identity is confirmed from the postings: for 40 of the 44
   Workday boards the detail record names the hiring entity (for example "Pacific Investment
   Mgt Co. LLC", "Alberta Investment Management Corporation", "The Guardian Life
   Insurance Company of America"); for Barings, Dimensional, 3i and Transamerica
   the tenant publishes no hiring organisation and the titles and locations were
   read instead. Those four are the least well evidenced. Lazard's Oracle site
   was linked from the employer's own page.
3. **Token tries** on the Greenhouse, Ashby, Lever and SmartRecruiters APIs from
   the firm name, accepted only if the board's name or postings name the
   employer. Thirteen answered under another organisation's name (rejected, in 3e).

Each added row's board URL, family, check date, how it was found, the employer
named by the board and the counts are in `data/registry-provenance.json`,
keyed by firm. The registry rows carry `discoveredVia`, `discoveredAt` and
`postingsAtDiscovery` as batches 1 and 2 do; the registry shape has no field for
the rest, and any field added to a row changes its board-config hash
(`boardConfigHash`), so the sidecar is where the extra evidence lives. Nothing
reads the sidecar at runtime.

## 3. Deferred, and why

### 3a. A family the collector reads, healthy, nothing it accepts today

These were read the same way as the 45 and returned no early-career or
experienced row, so the admission rule keeps them out of the registry
(`docs/tracker-expansion-2026-10.md`, step 4). Most should be re-probed when
their campus cycle opens (UK and European asset managers and insurers mostly
open applications between November and January). The "Employer link" column
says whether the board was linked from the employer's own careers page.

| Firm | Family | Board | Postings | Collector yield today | Employer link | Note |
|---|---|---|---|---|---|---|
| Fidelity International | workday | https://fil.wd3.myworkdayjobs.com/001 | 86 | 0 early, 0 experienced | linked from its careers page | Workday board; its campus programmes are on tal.net, see the next table |
| M&G | workday | https://mgpru.wd3.myworkdayjobs.com/mandgprudential | 112 | 0 early, 0 experienced | linked from its careers page |  |
| abrdn | workday | https://abrdn.wd3.myworkdayjobs.com/abrdn | 19 | 0 early, 0 experienced | linked from its careers page |  |
| Railpen | workday | https://railpen.wd3.myworkdayjobs.com/Railpen | 2 | 0 early, 0 experienced | linked from its careers page |  |
| Ontario Teachers | workday | https://otppb.wd3.myworkdayjobs.com/OntarioTeachers_Careers | 35 | 1 early, 0 experienced | linked from its careers page | Its one match is a campus recruiter vacancy, a false positive, so not added |
| Intermediate Capital Group | workday | https://icg.wd3.myworkdayjobs.com/external_careers | 18 | 0 early, 0 experienced | linked from its careers page |  |
| Oaktree | workday | https://oaktree.wd1.myworkdayjobs.com/Oaktree | 47 | 0 early, 0 experienced | linked from its careers page |  |
| Baillie Gifford | workday | https://bailliegifford.wd3.myworkdayjobs.com/BaillieGiffordCareers | 7 | 0 early, 0 experienced | linked from its careers page |  |
| Hiscox | workday | https://hiscox.wd3.myworkdayjobs.com/Hiscox_External_Site | 87 | 0 early, 0 experienced | tenant or token probe, employer not separately confirmed |  |
| Blue Owl | workday | https://blueowl.wd1.myworkdayjobs.com/blueowl | 43 | 0 early, 0 experienced | tenant or token probe, employer not separately confirmed |  |
| Franklin Templeton | workday | https://franklintempleton.wd5.myworkdayjobs.com/Jobs-Clarion | 14 | 0 early, 0 experienced | tenant or token probe, employer not separately confirmed | Only the Clarion real-estate site was readable; the group board (Phenom front end) was not found |
| LPL Financial | workday | https://lplfinancial.wd1.myworkdayjobs.com/External | 298 | 0 early, 0 experienced | tenant or token probe, employer not separately confirmed |  |
| Lloyd's | workday | https://lloyds.wd3.myworkdayjobs.com/Lloyds-of-London | 14 | 0 early, 0 experienced | tenant or token probe, employer not separately confirmed |  |
| Cerberus | workday | https://cerberus.wd1.myworkdayjobs.com/CerberusCareers | 4 | 0 early, 0 experienced | tenant or token probe, employer not separately confirmed |  |
| Antares Capital | workday | https://antares.wd5.myworkdayjobs.com/antares | 17 | 0 early, 0 experienced | tenant or token probe, employer not separately confirmed |  |
| Muzinich | workday | https://muzinich.wd5.myworkdayjobs.com/muzinichcareers | 1 | 0 early, 0 experienced | tenant or token probe, employer not separately confirmed |  |
| Sixth Street | workday | https://sixthstreet.wd1.myworkdayjobs.com/sixthstreetcareers | 17 | 0 early, 0 experienced | tenant or token probe, employer not separately confirmed |  |
| Hargreaves Lansdown | workday | https://hargreaveslansdown.wd3.myworkdayjobs.com/HargreavesLansdown | 12 | 0 early, 0 experienced | tenant or token probe, employer not separately confirmed |  |
| HPS Investment Partners | greenhouse | https://boards.greenhouse.io/hpsinvestmentpartners | 1 | 0 early, 0 experienced | tenant or token probe, employer not separately confirmed |  |
| Permira | greenhouse | https://boards.greenhouse.io/permira | 0 | 0 early, 0 experienced | tenant or token probe, employer not separately confirmed |  |
| Pemberton | ashby | https://jobs.ashbyhq.com/pemberton | 3 | 0 early, 0 experienced | linked from its careers page |  |
| Phoenix Group | oracle | https://fa-enor-saasfaprod1.fa.ocs.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX | 39 | 0 early, 0 experienced | linked from its careers page | Oracle site CX linked from thephoenixgroup.com/careers |
| Ares Management | workday | https://aresmgmt.wd1.myworkdayjobs.com/External | 238 | 0 early, 0 experienced | tenant or token probe, employer not separately confirmed |  |
| Golub Capital | workday | https://golubcapital.wd501.myworkdayjobs.com/Golub_Capital_Careers | 29 | 0 early, 0 experienced | tenant or token probe, employer not separately confirmed |  |
| Quilter | workday | https://quilter.wd3.myworkdayjobs.com/External-Career-Site | 30 | 0 early, 0 experienced | tenant or token probe, employer not separately confirmed |  |
| Vontobel | workday | https://vontobel.wd3.myworkdayjobs.com/Vontobel_External_Career | 41 | 0 early, 0 experienced | tenant or token probe, employer not separately confirmed |  |
| AXIS Capital | workday | https://axiscapital.wd1.myworkdayjobs.com/axiscareers | 68 | 0 early, 0 experienced | tenant or token probe, employer not separately confirmed |  |
| MFS | workday | https://mfs.wd1.myworkdayjobs.com/MFS-Careers | 30 | 0 early, 0 experienced | tenant or token probe, employer not separately confirmed |  |
| Brown Advisory | workday | https://brownadvisory.wd1.myworkdayjobs.com/Brown | 22 | 0 early, 0 experienced | tenant or token probe, employer not separately confirmed |  |
| Russell Investments | workday | https://russell.wd5.myworkdayjobs.com/russellinvestments | 39 | 0 early, 0 experienced | tenant or token probe, employer not separately confirmed |  |
| Angelo Gordon | workday | https://angelogordon.wd1.myworkdayjobs.com/angelogordoncareers | 1 | 0 early, 0 experienced | tenant or token probe, employer not separately confirmed |  |
| CI Financial | workday | https://ci.wd3.myworkdayjobs.com/CI_FINANCIAL_EXTERNAL_CAREER-SITE | 80 | 0 early, 0 experienced | tenant or token probe, employer not separately confirmed |  |
| General Atlantic | greenhouse | https://boards.greenhouse.io/generalatlantic | 14 | 0 early, 1 experienced | tenant or token probe, employer not separately confirmed | The one experienced match is an "Analyst, Portfolio Management" typed Hedge Fund; the other analyst seats are not typed. Held back |
| ICONIQ | greenhouse | https://boards.greenhouse.io/iconiq | 15 | 0 early, 0 experienced | tenant or token probe, employer not separately confirmed | Family-office advisory analysts are on this board; not typed by the experienced classifier |
| Glenmede | lever | https://jobs.lever.co/glenmede | 13 | 0 early, 0 experienced | tenant or token probe, employer not separately confirmed | Private bank and trust; no early-career title today |
| Callan | lever | https://jobs.lever.co/callan | 4 | 0 early, 0 experienced | tenant or token probe, employer not separately confirmed | Investment consultant; Consulting tier has no experienced reading |
| CDPQ | workday | https://cdpq.wd10.myworkdayjobs.com/CDPQ-recrutement-universitaire | 4 | 0 early, 0 experienced | tenant or token probe, employer not separately confirmed | University site; 4 "Stagiaire" internships that the early-career rule does not read (French) |
| CDPQ (main site) | workday | https://cdpq.wd10.myworkdayjobs.com/CDPQ | 37 | 0 early, 0 experienced | tenant or token probe, employer not separately confirmed | Main site |
| HOOPP | workday | https://hoopp.wd10.myworkdayjobs.com/HOOPP | 37 | 0 early, 0 experienced | tenant or token probe, employer not separately confirmed |  |
| BCI | workday | https://bci.wd10.myworkdayjobs.com/BCI_Careers | 11 | 0 early, 0 experienced | tenant or token probe, employer not separately confirmed |  |
| Virtus | workday | https://virtus.wd5.myworkdayjobs.com/VirtusCareers | 11 | 0 early, 0 experienced | tenant or token probe, employer not separately confirmed |  |
| Wealth Enhancement Group | workday | https://wealthenhancement.wd1.myworkdayjobs.com/WEG_Careers | 58 | 0 early, 0 experienced | tenant or token probe, employer not separately confirmed |  |
| Just Group | workday | https://just.wd3.myworkdayjobs.com/JUST_External | 9 | 0 early, 0 experienced | tenant or token probe, employer not separately confirmed |  |
| Hastings | workday | https://hastingsdirect.wd3.myworkdayjobs.com/external_careers | 62 | 0 early, 0 experienced | tenant or token probe, employer not separately confirmed |  |
| Principal Financial Group | workday | https://pfg.wd3.myworkdayjobs.com/PFGCareers | 17 | 0 early, 0 experienced | tenant or token probe, employer not separately confirmed |  |
| Primerica | workday | https://primerica.wd1.myworkdayjobs.com/PRI | 41 | 0 early, 0 experienced | tenant or token probe, employer not separately confirmed |  |
| Penn Mutual | workday | https://pennmutual.wd1.myworkdayjobs.com/_penn-careers | 12 | 0 early, 0 experienced | tenant or token probe, employer not separately confirmed |  |
| Liberty Mutual | workday | https://lmg.wd3.myworkdayjobs.com/LMG | 15 | 0 early, 0 experienced | tenant or token probe, employer not separately confirmed |  |

### 3b. A family the collector does not read, or reads but cannot place

Listed with the board and the family; none is in the registry. SmartRecruiters
URLs are the standard form for the company id the API answered to, not fetched
as pages.

| Firm | Family | Board | Why it waits |
|---|---|---|---|
| Fidelity International | tal.net (a family the collector reads) | https://fidelityinternational.tal.net/vx/lang-en-GB/mobile-0/appcentre-ext/brand-4/candidate/jobboard/vacancy/1/adv/ | 33 campus rows parse, but the board has no location cell, so all 33 would carry region `US` (Dubai, Milan, Kronberg, Dalian). Needs the city read from the title ("... - Milan"), a change to `scripts/sync-ats.mjs`. The best single deferred board in the batch |
| Evelyn Partners | SmartRecruiters (company `EvelynPartners`, 20 postings) | https://careers.smartrecruiters.com/EvelynPartners | No SmartRecruiters adapter (already noted in the batch 2 doc as the cheap next adapter) |
| WTW | SmartRecruiters (`wtw`, 1 posting); the main site careers.wtwco.com showed no board | https://careers.smartrecruiters.com/WTW | As above; the SmartRecruiters company looks like a small slice of the group |
| Stifel, Tikehau Capital | SmartRecruiters (1 posting each) | https://careers.smartrecruiters.com/Stifel, https://careers.smartrecruiters.com/TikehauCapital | As above, and not worth an adapter on their own |
| Hayfin | Workable | https://hayfin-capital-management.workable.com/ | No Workable adapter |
| Franklin Templeton | Phenom front end (Workday behind it; only the Clarion real-estate site was readable) | https://careers.franklintempleton.com/ | The group board's Workday site was not found; Phenom is not read |
| Brevan Howard | Phenom | https://careers.brevanhoward.com/ | No Phenom adapter |
| Allianz | Phenom | https://careers.allianz.com/ | As above |
| Janus Henderson | SuccessFactors | https://jobs.janushenderson.com/ | No SuccessFactors adapter |
| Pictet | SuccessFactors | https://career012.successfactors.eu/ (linked from group.pictet/careers) | As above |
| GIC | SuccessFactors | https://careers.gic.com.sg/ | As above |
| Swiss Re | SuccessFactors | https://careers.swissre.com/ | As above |
| Charles Schwab | iCIMS | https://www.schwabjobs.com/ (career-schwab.icims.com) | No iCIMS adapter; no JSON API |
| Beazley | iCIMS | https://careers.beazley.com/ | As above |
| AXA | iCIMS | https://careers.axa.com/ | As above |
| Isio | Teamtailor | https://careers.isio.com/ | No Teamtailor adapter |

### 3c. No public board found, or a page the collector must not read

Not in the registry and not guessed.

- **Careers page returns 403 or 429 to a plain GET** (not worked around): Coutts,
  Temasek, AustralianSuper, Julius Baer's group site (its Workday board is a
  separate public host and is in the registry), Aviva's group site (same), the
  www host of Allianz (careers.allianz.com answers), WTW on one host.
- **Corporate site's `robots.txt` disallows the careers path** for a generic agent, so
  the page was not read: Amundi, DWS, St. James's Place, Rathbones, Hiscox's site,
  Ares's site, Blue Owl's site, MetLife, Aon, Mercer, Liontrust, Cambridge
  Associates' site. Where a Workday board exists it was found through the
  tenant instead (Hiscox, Ares, Blue Owl and Cambridge Associates above).
- **Careers page read, client-rendered, no ATS link and no token answered under
  the firm's name:** Legal & General, Munich Re, Zurich, NEST, Border to
  Coast, Redington, LCP, Hymans Robertson, XPS, Artemis (the
  fund manager).
- **Careers URL not located** (the addresses tried returned 404, or 202 with no
  content for CPP Investments): LGIM, USS, NBIM, CPP Investments, Lindsell Train,
  Ruffer, Polar Capital, Arcmont, Brewin Dolphin. Brewin
  Dolphin is RBC Brewin, and `RBC` is already a row (the early-talent Workday
  site); the others need a person to find the page.
- **Family offices.** ICONIQ (Greenhouse, 15 postings, "Analyst, Family Office
  Advisory" among them) is the only public board found, and the collector
  accepts nothing on it today. No multi-family office answered. The segment
  stays empty.
- **Investment consultants.** Cambridge Associates is the only one admitted.
  Callan (Lever, 4 postings, "Investment Consultant" seats) is healthy but the
  `Consulting` tier has no experienced reading, and the other named firms
  (Mercer, Aon, WTW, Redington, LCP, Hymans Robertson, XPS, Isio) are in the lists above.

### 3d. Already covered under another name

Lazard Asset Management is Lazard (the group's professional Oracle site is the
new row). Nuveen is TIAA (added). Columbia Threadneedle is Ameriprise (added).
Northern Trust Asset Management is Northern Trust, T. Rowe Price, Wellington,
Capital Group, Schroders, Man Group, Marshall Wace, Apollo, PSP and OMERS were
rows before this batch. Brewin Dolphin is RBC Brewin, see above.

### 3e. Boards that answered under another organisation's name (rejected)

Greenhouse `charles` (not Schwab), `lincoln` (a property company, not Lincoln
Financial), `insight`, `crescent` (a manufacturer, not Crescent Capital), `ii`
(Inside Ideas, not interactive investor), `public`; Ashby `antares` (a nuclear
start-up, not Antares Capital), `julius` (an AI-finance start-up, not Julius
Baer), `polar` (payments), `artemis` (security research), `phoenix` (not
Phoenix Group); Lever `blue` (not Blue Owl), `metlife` (Colombian agent
recruiting under MetLife's name, left unverified and out). Workday `hamilton`,
`park`, `brown` as above. A token that merely answers is not a board for the
firm.

## 4. How the work was done, and limits

- Network etiquette: every host was asked for at most one request a second,
  `robots.txt` was read before any corporate page, no login, interstitial or
  bot check was passed, and no request used a browser identity. One early
  version of my pacing helper let up to six workers hit the same host at once;
  it was found and fixed before the bulk runs, and affected only the first
  token-guess run (stopped after a few minutes) and the first two careers-page
  scans, which mostly hit different hosts.
- Tests: `node scripts/run-collector-tests.mjs` passes, 30 of 30 suites, and so
  does `npm test` (the offline skill checks). No suite names the registry rows,
  so none needed a fixture.
- What the verification read does not exercise: `main()` of `sync-ats.mjs` (no
  publishing run was made from a branch), slug issue, the Workday detail and
  JobPosting deadline passes, retention and the board-check files. It uses the
  same fetch shapes, paginators and classifiers, with the production keyword
  queries, so the counts are what the collector will see on an ordinary day, but
  boards move daily.
- The tal.net probe used the honest collector user agent. Production
  `fetchTalnet` uses a browser user agent for that family by design; I did not.
- The experienced path was not exercised by any added row. It is why the
  Greenhouse, Ashby and Lever candidates (General Atlantic, ICONIQ, Callan,
  Glenmede, HPS) matter: if a later batch wants experienced coverage of private
  markets, those families are where it comes from.
