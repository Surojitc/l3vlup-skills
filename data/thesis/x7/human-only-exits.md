# Human-only: four stated sales from the cross-manager pass

**Decided (Suro, 2026-10-10): none of the four is published as a manager-level
exit.** Fund-level sale statements are not promoted to manager-level thesis
exits where the manager's firm-wide 13F continues to report the security. The
reviewed thesis feed and the 13F comparison are both keyed at manager (firm)
level, so turning "Sequoia Fund exited" into "Ruane exited" would be false, and
the firm's own filings show it. Each stays here as a source-grounded fund-level
action; no fund-level claim architecture is built for them in this release.

| # | Decision |
|---|---|
| 1 | Ruane / Netflix: a Sequoia Fund action. Not a Ruane exit: the firm-wide 13F still listed 855 shares at Q2 2023. |
| 2 | Harris / Netflix: an Oakmark Select (and Oakmark Global Select) sale. Not a Harris Associates exit: the firm-wide 13F still held Netflix. |
| 3 | Harris / Meta: an Oakmark Fund sale. Not a Harris Associates exit: the firm-wide 13F still listed shares. |
| 4 | Harris / Liberty Broadband: an Oakmark Select tax sale. Not a Harris Associates exit, all the more because the firm later reported more LBRDK. |

The runner does not let a session or a model declare an exit (`stance: exited`
needs an `exitBasis` only a person sets), so these four were dropped from the
pass and are listed here for a person to decide. Nothing here is in the review
queue or the published feed.

Each passage is the filing's own words, as extracted. Each sale is stated for
**one fund**, while a 13F covers the whole firm: the "13F context" line says
what the firm's filings then showed (shares, from `data/funds/by-ticker`). A
sale by one fund with shares still listed by the firm is not a firm-wide exit,
and the suggested wording says so.

| # | Manager | Document | Fund | Company | Exact passage | 13F context (firm-wide) | Suggestion before the decision |
|---|---|---|---|---|---|---|---|
| 1 | Ruane, Cunniff & Goldfarb | N-CSRS, period 2023-06-30, filed 2023-08-30 ([filing](https://www.sec.gov/Archives/edgar/data/89043/000119312523224787/d539474dncsrs.htm)) | Sequoia Fund | Netflix (NFLX) | "exited our investment in Netflix, responding in each case to strong rebounds in stock prices" | 212,986 shares at Q1 2023, 855 at Q2 2023, 456 at Q3 2023 | Exited, `exitBasis: manager_statement`, worded "Sequoia exited Netflix in Q2 2023 after its rebound"; the firm still listed a residual 855 shares |
| 2 | Harris Associates | N-CSRS, period 2023-03-31, filed 2023-05-25 ([filing](https://www.sec.gov/Archives/edgar/data/872323/000110465923064651/tm2312388d1_ncsrs.htm)) | Oakmark Select Fund (Oakmark Global Select also sold it) | Netflix (NFLX) | "We sold our holdings in Allison Transmission, Citigroup and Netflix." | 734,048 shares at Q4 2022, 469,079 at Q1 2023, 116,366 at Q2, 35,402 at Q3 2023 | Exited for the named funds only; worded "Oakmark Select sold Netflix"; the firm's other accounts kept a falling position |
| 3 | Harris Associates | N-CSRS, period 2024-03-31, filed 2024-05-28 ([filing](https://www.sec.gov/Archives/edgar/data/872323/000110465924065556/tm246073d1_ncsrs.htm)) | Oakmark Fund | Meta Platforms (META) | "We sold our positions in Amazon, HCA Healthcare, Hilton Worldwide, Meta Platforms and PHINIA during the period." | 311,718 shares at Q4 2023, 35,821 at Q1 2024, 16,095 at Q2 2024 | Exited for Oakmark Fund, as it approached Harris's estimate of intrinsic value; firm residual remains |
| 4 | Harris Associates | N-CSRS, period 2024-03-31, filed 2024-05-28 (same filing) | Oakmark Select Fund | Liberty Broadband (LBRDK) | "We sold our shares in Liberty Broadband to realize losses for taxable investors" | LBRDK 496,666 shares at Q4 2023, 280,513 at Q1 2024, 367,518 at Q2 2024 | Exited for Oakmark Select (tax sale, swapped into Charter); the firm still listed and later added LBRDK, so never a firm-wide exit |

The 13F figures are quarter-end holdings across every account Harris or Ruane
manages, filed up to 45 days later; they say nothing about when in a quarter a
sale happened.
