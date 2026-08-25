# Company Profile evolution ledger

Policy: [../../docs/skill-evolution.md](../../docs/skill-evolution.md)

- Current version: `company-profile-v0.3.0`
- Status: `working`
- Next: quarterly columns alongside the annual axis, and a segment breakout where
  the filer tags one.

## History

| Version | Date | Evidence | Change |
| --- | --- | --- | --- |
| `v0.1.0` | 2026-08-24 | — | Five fiscal years of income statement, balance sheet and cash flow from SEC XBRL company facts, with growth and margins as live formulas and a Sources tab resolving every figure to a tag, period, form and accession. Price is deliberately absent: it is not filing data, and a workbook that guessed one and printed a multiple off it would look finished while being unsourced. |
| `v0.2.0` | 2026-08-24 | first live run vs AAPL | The axis was keyed on the XBRL `fy` field, which describes the FILING's fiscal year rather than the period's, so a FY2025 10-K tagged its FY2023 and FY2024 comparatives as fy=2025 and Apple's FY2021 column showed FY2019 numbers. Now keyed on period end date, which is a fact, with the label resolved from a filing made within 150 days of that end — the original annual report rather than a later comparative. Keying on the label and hoping comparatives sorted themselves out was the alternative, and it is what produced the bug. |
| `v0.3.0` | 2026-08-24 | live run vs NVDA | Tag choice is by coverage rather than by preference order. NVIDIA abandoned one revenue concept for another, and first-match-wins kept returning the dead tag with its stale history, freezing the company at FY2022 with everything below revenue blank. Every tag in the list is now evaluated and the one reaching the most recent period wins, with period count and then list order as tie-breaks. Simply reordering the list per filer was rejected: it would need maintaining for every company that ever switches, and coverage is observable from the data. |
