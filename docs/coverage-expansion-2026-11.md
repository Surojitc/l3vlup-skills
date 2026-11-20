# Coverage expansion: rendered careers pages, Recruitee and Pinpoint (November 2026)

_20 November 2026. Batch 4 added 17 employers to `lib/sources/ats-registry.json`
(227 to 244 rows, 216 to 233 polled, 11 parked), two readers
(`lib/recruitee.mjs`, `lib/pinpoint.mjs`) and a fix to the Workday complete
read. Every number below is a verification read on 20 November through the
collector's own fetchers (`FETCHERS`), `toOpportunity`,
`toExperiencedOpportunity` and `capExperienced`; nothing has been through a
publishing run, so the effect on `data/opportunities.auto.json` is a projection
until the next daily run. The method is the one in
`docs/tracker-expansion-2026-10.md`._

## 1. What was different about this sweep

The brief was the roles a candidate does not find on the large job boards:
private credit and buyout firms, European sponsors, systematic funds and the
fintechs that hire analysts without a campus programme. Two methods ran:

1. **Token guessing** (`candidateTokens`, as in batches 1 to 3) for 321 firms
   not in the registry, across Greenhouse, Ashby, Lever, SmartRecruiters,
   Recruitee, Personio, Teamtailor and Pinpoint. 117 answered; most were the
   wrong company (section 4).
2. **Rendering the careers page in Chromium.** The 110 seed firms
   (`lib/sources/careers-seed.json`) that earlier sweeps left at "no board
   found" were loaded in a browser, every request and link recorded, and run
   through `detectBoard`. Earlier sweeps used a plain fetch, which sees nothing
   on a page built in the browser. This found the boards behind Ares, Oaktree,
   Blue Owl, Sixth Street, Antares, General Atlantic, HPS, Onex, PAI Partners,
   Cinven, Checkout.com and Roland Berger, none of which a plain fetch reveals.

The rendering script was scaffolding and is not committed; a careers page that
moves is re-rendered by hand, and the registry row records `discoveredVia`.

## 2. Added (17)

| Firm | Tier | Board | Postings | Early career | Experienced | Where |
|---|---|---|---|---|---|---|
| Ares Management | Megafund | Workday `aresmgmt` / `External`, complete | 230 | 0 | 12 | US, Europe: PE, direct lending and secondaries associates |
| Oaktree Capital | Asset Manager | Workday `oaktree` / `Oaktree`, complete | 57 | 2 | 3 | US, India |
| General Atlantic | Megafund | Greenhouse `generalatlantic` | 12 | 0 | 1 | US |
| PAI Partners | Megafund | Recruitee `paipartnerssas` | 8 | 6 | 0 | Luxembourg, Paris, London |
| Cinven | Megafund | Pinpoint `cinven` | 1 | 1 | 0 | Frankfurt |
| Legal & General | Asset Manager | SmartRecruiters `LegalAndGeneral` | 40 | 3 | 0 | UK graduate schemes |
| WorldQuant | Systematic | Greenhouse `worldquant` | 80 | 4 | 53 | Asia, US, Europe, UK |
| ION Group | Trading Tech | Lever `ion` | 99 | 16 | 15 | US, Asia, Italy |
| Kpler | Trading Tech | Lever `kpler` | 111 | 2 | 24 | Europe, UK, Singapore |
| Roland Berger | Consulting | SmartRecruiters `RolandBerger` | 206 | 30 | 0 | Europe, Asia, Middle East |
| xAI | AI Lab | Greenhouse `xai` | 299 | 4 | 0 | US |
| Upvest | Fintech | Ashby `upvest` | 29 | 6 | 0 | Berlin, London |
| Moss | Fintech | Ashby `moss` | 31 | 3 | 0 | Berlin |
| Column | Fintech | Ashby `column` | 24 | 1 | 0 | San Francisco |
| Ledger | Fintech | Ashby `ledger` | 17 | 2 | 0 | Paris |
| Airwallex | Fintech | Ashby `airwallex` | 492 | 2 | 0 | Singapore |
| Raisin | Fintech | Greenhouse `raisin` | 29 | 2 | 0 | Berlin |

**Projected: about 84 early-career and 108 experienced roles** from 17 new
employers, every application link on the employer's own system. Fintech rows
carry no experienced roles, as before: `firmTypeForTier('Fintech')` is null.

Ares and Oaktree are `collect: "complete"`: their keyword searches return
nothing early career today, and the experienced roles (private credit and
private equity associates, which do not reach the large boards in any
volume) need the whole board read. Both proved complete under the fix in
section 3.

## 3. The Workday complete read stopped at 40

`walkCompleteBoard` ends a pass when the offset reaches the board's stated
total. Barclays, ING and Capital One, the three complete Workday rows before
this batch, state the total on every page. Ares, Blue Owl and Oaktree state
it on the first page only and answer `total: 0` on every later page while
still returning postings, so the walk read 0 as the total, stopped at offset
40 and called the read complete: Ares read as 40 postings of 230, Blue Owl
as 40 of 51.

`workdayPageTotal` in `scripts/sync-ats.mjs` reads a later page that returns
postings under a total of 0 as restating the first page's total; an empty page
and a total that really moved are still taken as given. Tested in
`scripts/__tests__/complete-board.test.mjs`. Recorded as the same collection
method (`lib/collection-method.json`): the three boards that used the complete
read before state their totals on every page, so none of them yields a
different set, and the Hiring Pulse keeps its comparisons.

## 4. Two new readers, and the trap in one of them

**Recruitee** (`lib/recruitee.mjs`): one unauthenticated request for the
whole board. A renamed company answers with a redirect
(`paipartners` → `paipartnerssas`), so the registry stores the name the
redirect lands on. PAI leaves notices published ("CLOSED: Munich Investment
Group Internship … applications open December 15") to announce the next
window; the reader drops a title marked closed rather than list it as open
four weeks early.

**Pinpoint** (`lib/pinpoint.mjs`): one request for the whole board. A
subdomain nobody claimed answers 404, but an account opened and never used
answers 200 with Pinpoint's sample board: three or four postings ("Head of
DEI - UK", "Marketing Executive", sometimes with the firm's name spliced in) in
London, Paris and New York on requisitions 0001 to 0003. Token guessing made
Atomico, Maven Securities, Graham Capital, Teza, Kraken, AJ Bell and Baillie
Gifford all look like Pinpoint employers with live roles. None is. So a
Pinpoint row is admitted only from a link on the employer's own careers page,
and the reader throws on the sample board, so an unused account reads as a
failed board and never as invented roles.

Both readers are read in full, so both are in `FULL_READ_ATS` and yield
experienced rows at finance tiers. Both are recognised by `detectBoard` from
an employer's link. Tests: `scripts/__tests__/recruitee-pinpoint.test.mjs`,
fixtures cut from the real boards.

## 5. Measured and not admitted

**Healthy boards with nothing eligible today**, re-probe in season:

| Firm | Board | Postings | Note |
|---|---|---|---|
| Blue Owl Capital | Workday `blueowl` / `blueowl` | 51 | complete read, no eligible role |
| Sixth Street | Workday `sixthstreet` / `sixthstreetcareers` | 16 | |
| Antares Capital | Workday `antares` (wd5) / `antares` | 17 | |
| Frontier Economics | Workday `frontiereconomics` (wd3) / `Frontier_Economics_Careers` | 6 | |
| HPS Investment Partners | Greenhouse `hpsinvestmentpartners` | 1 | |
| Onex | Greenhouse `onexgeneral` | 2 | |
| Evelyn Partners | SmartRecruiters `EvelynPartners` | 19 | |
| Tikehau Capital | SmartRecruiters `TikehauCapital` | 1 | |
| Checkout.com | Ashby `checkout.com` | 165 | |

**Eligible by the rules, outside the seats this tracker covers**, left out
by judgement: bunq (Recruitee: copywriting and website interns), Mollie
(regional marketing intern), SumUp (payroll working student), Payoneer
(sales and marketing interns in China). Re-read if their boards start
posting finance, data or engineering roles.

**The wrong company under the guessed token**: Summit Partners (`summit` on
Recruitee is Summit Media), Hudson Bay (`hudson` on Teamtailor is Hudson
Nordic), Two Sigma (`two` is Two Inc), Five Rings (`five` is an Italian
agency), Radix (`radix` is Superlinear), Tiger Global and Eagle Seven (`tiger`
and `eagle` on Ashby are start-ups), Primer (`primer` is a school group),
General Catalyst (`general` is a general-interest board), Wise (`wise` is a
sales agency), Clearwater Analytics (`clearwater` on Greenhouse is a
cybersecurity firm), and the Pinpoint sample accounts in section 4. Vista,
Battery and Insight link their portfolio companies' boards from their careers
pages; none was taken.

**Families still without a reader:**

- **Workable**: Capula (`capula-investment-management-ltd`) and Hayfin link
  Workable boards. Both are firms this tracker wants. Workable answered every
  request from the verification container with Cloudflare's 1015 (rate
  limited), so no board was read and no reader was written against an unread
  shape. Next step: one read from the collection runner (a
  `workflow_dispatch` probe), then a reader if the boards hold eligible roles.
- **Phenom**: Brevan Howard. **iCIMS**: Atlassian, Analysis Group, ZS,
  Exponent (and the August measurement of Stifel). **SuccessFactors**: EY.
  **Taleo**: Bridgespan. Unchanged from October: each is an HTML adapter of
  its own, to be measured before it is written.
- **Personio and Teamtailor** answered for Vivid, Chip, CoinShares, Sumsub and
  Lightyear, with nothing eligible. No reader until a firm needs one.

## 6. Three counts

| | Before | After |
|---|---|---|
| Configured (rows) | 227 | 244 |
| Polled | 216 | 233 |
| Verified opportunities from the new rows | | 17 employers, about 84 early career and 108 experienced |
