# Data-rights register

Last reviewed 19 October 2026. The register is `lib/rights-register.json`; the test that keeps it honest is `scripts/__tests__/rights-register.test.mjs`.

It answers one question for every outside source the collectors read: what do the source's own terms let L3VLUP do with it? It records what the terms say. It does not clear a source: that is a human decision, and every `unverified` below is a question for a person, not an answer.

## The fields

| Field | Meaning |
|---|---|
| `id`, `owner`, `source` | The source, the organisation behind it and what is fetched (host, path, feed). |
| `collectors`, `outputs` | The scripts that fetch it and the `data/` paths written from it. |
| `termsUrl` | The governing terms or licence page. `unverified: ...` where none could be found. |
| `termsReadUrls` | The pages actually read in this review. A source with none was not read at source. |
| `businessUse` | `permitted`, `restricted` or `unverified`, with the basis in `businessUseBasis`. |
| `displayRights` | May L3VLUP show the data (or a figure from it) to site visitors. |
| `derivedUseRights` | May it compute new figures from it and show those. |
| `storageRights` | May it keep a copy (the committed JSON, or a working history). |
| | Each of the three is `yes`, `no`, `conditional` or `unverified`, with the basis beside it and a quotation where the terms give one. `conditional` means a stated condition applies (attribution, labelling a change, excerpt only) or the terms are silent and the permission rests on the absence of a restriction. |
| `redistribution` | Restrictions on passing the data on. |
| `attribution` | The exact wording required, or `none stated`. "Requested" is distinguished from "required" in the text. |
| `lastReviewed` | ISO date. |
| `notes` | What a reviewer must know. |

`prohibitedSources` lists what must never be used (Yahoo Finance, Google Finance, MarketWatch, Investing.com and TradingView scraping, and undocumented private APIs), each "not to be used (L3VLUP policy, 19 Oct 2026)".

US federal works (SEC, Treasury, BLS, BEA) are treated as public domain under 17 U.S.C. 105, as supplied to this review. Where a page also says so itself, that is quoted. FRED is not used by any collector in this repository.

## The register

| Source | Owner | Business use | Display | Derived | Storage | Attribution |
|---|---|---|---|---|---|---|
| `sec-edgar-structured` | U.S. Securities and Exchange Commission | permitted | yes | yes | yes | Requested, not required: "Please consider appropriate citation to the SEC as the source." |
| `sec-edgar-filing-documents` | Individual EDGAR filers | permitted | conditional | conditional | conditional | Credit the filer and link the filing on sec.gov (L3VLUP rule); the SEC asks for citatio... |
| `us-treasury-rates` | U.S. Department of the Treasury | permitted | yes | yes | yes | none stated (L3VLUP shows sourceName "U.S. Department of the Treasury" and the source U... |
| `us-bls` | U.S. Bureau of Labor Statistics | permitted | yes | conditional | yes | Requested: "we do ask that you cite the Bureau of Labor Statistics as the source." Requ... |
| `us-bea-schedule` | U.S. Bureau of Economic Analysis | permitted | yes | yes | yes | Requested: "Citations are appreciated and appropriate." |
| `fed-fomc-calendar` | Board of Governors of the Federal Reserve System | permitted | yes | yes | yes | Requested: "Please cite to the Board as the source of the information." |
| `ecb` | European Central Bank | permitted | yes | conditional | unverified | "the ECB must be cited as the source." |
| `ons` | Office for National Statistics | permitted | yes | yes | yes | Required by OGL: "Contains public sector information licensed under the Open Government... |
| `boe` | Bank of England | permitted | yes | yes | yes | Specified for SONIA only ("licensed under the Open Government Licence v3.0"). For other... |
| `nyfed-sofr` | Federal Reserve Bank of New York | permitted | yes | conditional | yes | Include copyright notices and source identifiers. Default: "Content from the New York F... |
| `imf-datamapper` | International Monetary Fund | unverified | conditional | conditional | unverified | "Source: International Monetary Fund, Database Name, <<link to the dataset>>." |
| `damodaran-nyu` | Aswath Damodaran, NYU Stern School of Business | unverified | conditional | conditional | unverified | Acknowledgement requested, not required. KPMG credit required for the tax-rate file: "P... |
| `govuk-corporation-tax` | HM Revenue and Customs | permitted | yes | yes | yes | "Contains public sector information licensed under the Open Government Licence v3.0." |
| `iex-historical-data` | Investors Exchange LLC | permitted | yes | conditional | conditional | Data provided for free by IEX. By accessing or using IEX Historical Data, you agree to... |
| `prnewswire-rss` | PR Newswire Association LLC | unverified | unverified | unverified | unverified | none stated (the site shows the publisher name and links the item) |
| `globenewswire-rss` | GlobeNewswire | unverified | unverified | unverified | unverified | none stated (the site shows the publisher name and links the item) |
| `ft-rss` | The Financial Times Ltd | unverified | unverified | unverified | unverified | none stated (the site shows the publisher name and links the item) |
| `wsj-dowjones-rss` | Dow Jones & Company, Inc. | unverified | unverified | unverified | unverified | none stated (the site shows the publisher name and links the item) |
| `bloomberg-rss` | Bloomberg L.P. | restricted | no | unverified | no | none stated (the site shows the publisher name and links the item) |
| `techcrunch-rss` | TechCrunch | unverified | unverified | unverified | unverified | none stated (the site shows the publisher name and links the item) |
| `pehub-rss` | PE Hub | unverified | unverified | unverified | unverified | none stated (the site shows the publisher name and links the item) |
| `privateequitywire-rss` | Private Equity Wire | unverified | unverified | unverified | unverified | none stated (the site shows the publisher name and links the item) |
| `hedgeweek-rss` | Hedgeweek | unverified | unverified | unverified | unverified | none stated (the site shows the publisher name and links the item) |
| `ats-greenhouse` | Greenhouse Software, Inc. | unverified | conditional | conditional | unverified | none stated |
| `ats-ashby` | Ashby Inc. | unverified | conditional | conditional | unverified | none stated |
| `ats-lever` | Lever | unverified | conditional | conditional | unverified | none stated |
| `ats-workday-cxs` | Workday, Inc. | unverified | unverified | unverified | unverified | none stated |
| `ats-oracle-recruiting-cloud` | Oracle Corporation | unverified | unverified | unverified | unverified | none stated |
| `ats-talnet` | Eploy / tal.net | unverified | unverified | unverified | unverified | none stated |
| `ats-eightfold` | Eightfold AI | unverified | unverified | unverified | unverified | none stated |
| `janestreet-jobs-feed` | Jane Street Group, LLC | unverified | unverified | unverified | unverified | none stated |
| `employer-careers-pages` | Individual employers | unverified | conditional | yes | unverified | none stated |

Full bases, quotations, redistribution terms and notes are in the JSON.

## Findings

### Prohibited-source search

Searched `scripts/`, `lib/` and `skills/` (and then the whole repository) for `yahoo`, `query1.finance`, `query2.finance`, `google.com/finance`, `marketwatch`, `investing.com` and `tradingview`, case-insensitively.

- **Hits in `scripts/`, `lib/`, `skills/`, `tests/`, `.github/` and `docs/`: none.** No collector reads a prohibited source and no code was changed.
- Hits elsewhere in the repository are data, not use of the source, and nothing here contacts Yahoo:
  - `data/funds/history/**` (227 files): the issuer name "Yahoo Inc" (and variants "Yahoo! Inc") in 13F holdings, for example `data/funds/history/invesco/index.json:1`.
  - `data/merger-index.auto.json`: `"name": "YAHOO INC"`, an EDGAR filer name.
  - `data/precedent-transactions.auto.json`: "shares of Yahoo common stock were outstanding", text from a filing.
- The test fails if a prohibited host appears in any register entry or in collector code, so this stays true.

### Sources of concern

1. **Bloomberg RSS (`bloomberg-rss`) is `restricted`.** The terms read (`bloomberg.com/notices/tos/`) limit use to "your own noncommercial use", bar scrapers and bots without written consent, bar recirculation and publication, and say the information "may not be used to construct a database of any kind." `scripts/sync-newsflow.mjs` stores Bloomberg headlines and links in `data/newsflow.auto.json` for eight days. The terms do not mention RSS, so whether they bind the public feed is unclear. Treat as blocked until cleared.
2. **The FT and Dow Jones (WSJ) feeds are unverified, and likely restricted.** Their terms could not be fetched. Secondary sources suggest commercial use of RSS content needs a licence. Review these next, with Bloomberg.
3. **Undocumented endpoints behind public careers sites.** `ats-workday-cxs` (Workday `/wday/cxs/...`, about 34 registry firms plus discovered tenants), `ats-oracle-recruiting-cloud`, `ats-eightfold` and `janestreet-jobs-feed` are the JSON backends of employer careers sites, not published licensed APIs. They may fall inside the prohibited class "undocumented private APIs". The policy needs a human decision on whether they do. Greenhouse, Ashby and Lever are documented public APIs.
4. **Parked tal.net tenants.** Five employers (Evercore, Jefferies, Lazard, Rothschild & Co, Perella Weinberg) serve a bot-check page; the collector stops at the gate and does not work around it. Worth keeping that way.
5. **IMF DataMapper.** The Data licence permits download and derivative works, but the same page says commercial reuse needs a request to copyright@imf.org and bans bulk automated download without permission.
6. **IEX.** Display is allowed with the clause 01 attribution. Storage and derived use are not addressed by the Terms of Use: recorded as `conditional` ("permitted by absence of restriction"), and written confirmation from IEX is requested. Three further points:
   - The `s.15` sentence of the IEX Market Data Policies rests on the quotation supplied to this review; I could not find it by search.
   - `IEX_TERMS_URL` in `lib/iex-tops.mjs` is `https://iextrading.com/iex-historical-data-terms/`, which answers a 301 to `exchange.iex.io`; the governing page named in the register is `https://www.iex.io/legal/hist-data-terms`.
   - The collector now publishes a reference price and a weekly history, so prices (not only categories) are shown. Clause 01 attribution and the clause 08/10 "reference point only" wording apply wherever they appear. The collector files were renamed from `market-context` to `market-reference` on this branch; the register uses the new names.
7. **Attribution duties to check in the site repository:** BLS (retrieval date, and the statement that "BLS.gov cannot vouch for the data or analyses derived from these data"), New York Fed (the SOFR Terms-of-Use notice), ECB (calculated growth rates must be flagged), OGL sources (ONS, Bank of England, GOV.UK), IEX (clause 01 text).
8. **Letters and board books.** The SEC permits copying of what is on sec.gov, but the authors of letters and adviser decks keep their copyright. The pipeline already limits display to excerpts and previews with a link; a person should confirm the page previews sit inside that allowance.

## Sources needing a human rights review

Every entry below has at least one field `unverified`, a terms page that could not be found or read, or a `restricted` classification.

- `us-treasury-rates` (terms not located; unverified: terms page).
- `ecb` (partly unverified; unverified: storageRights).
- `imf-datamapper` (partly unverified; unverified: businessUse, storageRights).
- `damodaran-nyu` (partly unverified; unverified: businessUse, storageRights).
- `prnewswire-rss` (terms not located; unverified: businessUse, displayRights, derivedUseRights, storageRights).
- `globenewswire-rss` (terms not located; unverified: businessUse, displayRights, derivedUseRights, storageRights).
- `ft-rss` (terms not located; unverified: businessUse, displayRights, derivedUseRights, storageRights).
- `wsj-dowjones-rss` (terms not located; unverified: businessUse, displayRights, derivedUseRights, storageRights).
- `bloomberg-rss` (RESTRICTED; unverified: derivedUseRights).
- `techcrunch-rss` (terms not located; unverified: businessUse, displayRights, derivedUseRights, storageRights).
- `pehub-rss` (terms not located; unverified: businessUse, displayRights, derivedUseRights, storageRights).
- `privateequitywire-rss` (terms not located; unverified: businessUse, displayRights, derivedUseRights, storageRights).
- `hedgeweek-rss` (terms not located; unverified: businessUse, displayRights, derivedUseRights, storageRights).
- `ats-greenhouse` (partly unverified; unverified: businessUse, storageRights).
- `ats-ashby` (partly unverified; unverified: businessUse, storageRights).
- `ats-lever` (partly unverified; unverified: businessUse, storageRights).
- `ats-workday-cxs` (terms not located; unverified: businessUse, displayRights, derivedUseRights, storageRights).
- `ats-oracle-recruiting-cloud` (terms not located; unverified: businessUse, displayRights, derivedUseRights, storageRights).
- `ats-talnet` (terms not located; unverified: businessUse, displayRights, derivedUseRights, storageRights).
- `ats-eightfold` (terms not located; unverified: businessUse, displayRights, derivedUseRights, storageRights).
- `janestreet-jobs-feed` (terms not located; unverified: businessUse, displayRights, derivedUseRights, storageRights).
- `employer-careers-pages` (terms not located; unverified: businessUse, storageRights).

Other things a reviewer should know: the Anthropic API (`scripts/thesis-pilot.mjs`, `scripts/thesis-auth-check.mjs`) and Firecrawl (`scripts/detect-career-changes.mjs`) are processors, not data sources, and are outside this register. `scripts/daily-post.mjs` only posts out.

## Keeping it current

The test reads `.github/workflows/*.yml` for every `node scripts/*.mjs`, `python3 scripts/*.py` and `python3 skills/*/*.py` line. Each must appear in some entry's `collectors`, or be named, with a reason, in the test's `FETCHES_NOTHING_EXTERNAL` list (which is checked: those scripts may contain no network call) or `OUTBOUND_OR_PROCESSOR_ONLY`. A new collector without a register entry fails the test. Add the entry, read the terms, and set `lastReviewed`.

The test is not yet in the list in `scripts/run-collector-tests.mjs`, which was left untouched; add `rights-register` there to run it before data is published.
