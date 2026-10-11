# Experienced and lateral roles: why the feed has none, and the plan (October 2026)

The feed carries about 1,300 roles, almost all internships and graduate
programmes. The L3VLUP Weekly now has an "Experienced and lateral" stage
(L3vlup #591), and the site already maps `programmeType: 'Lateral /
Experienced'` and `'MBA Hire'` to it. The collector produces neither. Read
on 11 October 2026; every endpoint below was probed live, once.

## Where experienced roles are lost

- `scripts/sync-ats.mjs:622` drops every title that is not early career:
  `if (!job.earlyCareerConfirmed && !isEarlyCareer(job.title)) return null;`.
  `isEarlyCareer` rejects `SENIOR` (senior, staff, principal, director, vp,
  head of, lead) and requires an `EARLY_CAREER` word (`:93-95`). Associate,
  VP, portfolio manager and trader titles cannot pass on any board.
- `inferProgrammeAndLevel` (`:434-448`) never emits `'Lateral / Experienced'`.
- Workday and Oracle boards are searched only for early-career terms
  (`WORKDAY_QUERIES`, `:729`; `ORACLE_QUERIES`, `:882`).
- Experienced sites are parked in `lib/sources/ats-registry.json` as "zero
  early-career" (Bank of America `lateral-us`, Moelis `Experienced-Hires`).
- Greenhouse, Ashby and Lever boards are already read in full every day and
  about 750 non-early postings on ten finance boards are discarded: Point72
  208, IMC 138, Squarepoint 83, Jump 64, Schonfeld 53, Man 50, William Blair
  47, AQR 42, Lincoln 33, Akuna 33 (Stripe 703 and Ramp 160 besides).

## Sources that answered (11 October)

| Firm | Board | Experienced finance roles, roughly |
|---|---|---|
| Moelis (parked) | Workday `moelis.wd1` / `Experienced-Hires` | 32, banking analyst to VP |
| Perella Weinberg | Workday `pwp.wd1` / `PWP_Experienced_Opportunities` | 6 |
| PJT Partners | Workday `pjtpartners.wd1` / `Careers` | about 31 associate |
| Mizuho | Workday `mizuho.wd1` / `mizuhoamericas` | about 47 associate |
| Raymond James | Workday `raymondjames.wd1` / `RaymondJamesCareers` | 79 banking |
| Lazard | Oracle `icbpjb.fa.ocs.oraclecloud.com`, `LazardProfessionalCareers` | 124, mixed |
| Blackstone | Workday `blackstone.wd1` / `Blackstone_Careers` | about 70 associate |
| Carlyle | Workday `carlyle.wd1` / `Carlyle` | 73 |
| Apollo | Workday `athene.wd5` / `Apollo_Careers` (in registry) | about 32 associate |
| BlackRock | Workday `blackrock.wd1` / `BlackRock_Professional` | 136 associate, 98 portfolio manager |
| TPG | Greenhouse `tpgcareers` | 17 |
| General Atlantic | Greenhouse `generalatlantic` | 12 |
| Bridgewater | Greenhouse `bridgewater89` | 16 |
| Millennium | Eightfold `mlp.eightfold.ai` | 214 |
| Hudson River Trading | Greenhouse `wehrtyou` | 78 |
| Optiver | Greenhouse `optiverus` | 129 |
| Plaid | Ashby `plaid` | 121 |
| Citi, Wells Fargo, Bank of America | Workday | hundreds each: only after a strong screen |

Not resolved: Evercore and KKR (Workday tenants exist, site ids unknown),
Houlihan Lokey (campus site only), Jefferies (bot check), Centerview,
Warburg Pincus, Balyasny, EQT, CVC (no ATS found), Morgan Stanley (Eightfold
refuses). Left alone on terms or robots: Citadel, D.E. Shaw, Two Sigma.

## Plan

1. **No new fetches first.** Classify the roles already read in full on the
   ten finance boards above, behind a seniority classifier.
2. **A seniority classifier** (`lib/seniority.mjs`, tested like
   `isEarlyCareer`): experienced analyst, associate, AVP/VP, director/MD,
   portfolio manager, trader, researcher; requires a finance or quant-tech
   vertical; excludes retail, branch, "Associate Banker", administration,
   HR and recruiting.
3. **Registry `population`:** `campus | experienced | mixed`, with two
   entries per firm allowed. Experienced Workday and Oracle sites under 500
   postings are read whole; larger ones use `EXPERIENCED_QUERIES`.
4. **`toOpportunity`:** on experienced or mixed boards, rows that fail
   `isEarlyCareer` go through the classifier and emit `programmeType:
   'Lateral / Experienced'` (or `'MBA Hire'`) and `level: 'Experienced'`.
5. **Separate limits and reporting:** an experienced ceiling per firm (about
   150), kept out of the early-career counts the collapse guard and the
   empty-firm report use.
6. **Then the new boards**, in the order of the table, and the large banks
   last.

Risks: volume (a weak screen swamps the tracker, the slug registry and the
archive), duplicates across locations (extend `lib/role-duplicates.mjs`),
long-lived postings ("new this week" must key on first seen), and
"Associate" as a graduate rank (decide on board population plus the
classifier, never the title alone). The programme pages are written for
early careers and will want a lateral variant on the site. Steps 1 to 6
change `scripts/` and the registry: each is a pull request for Suro to merge.
