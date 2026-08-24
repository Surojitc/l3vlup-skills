---
name: company-profile
tier: free
description: >
  Build a banker-grade company one-pager from SEC filings alone — five years of income
  statement, balance sheet and cash flow, with margins and growth as live formulas and
  every figure traceable to a tag, a period and an accession number. Use when someone
  says "company profile", "one-pager", "get me up to speed on [ticker]", or needs a
  clean financial summary before a meeting, an interview or a first screen.
output: XLSX — Profile, Income Statement, Balance Sheet, Cash Flow, Filings, Sources
argument-hint: "[ticker] [--years 5]"
---

# Company Profile

## What it produces

    python3 skills/company-profile/build.py AAPL --years 5 --out out/

A workbook in the [L3VLUP output standard](../../docs/output-standard.md):

| Tab | What it holds |
|---|---|
| **Profile** | Scale, per share, cash generation, balance sheet — the page you actually read |
| **Income Statement** | Five years as filed, with growth and margin formula sub-rows |
| **Balance Sheet** | Five years as filed, with a conditional-red balance check |
| **Cash Flow** | Five years as filed, with free cash flow computed in the workbook |
| **Filings** | The 10-Ks and 10-Qs the numbers came out of |
| **Sources** | Every `[n]` marker resolved to tag, period, form, accession and an EDGAR link |

## The job to be done

Walk into a meeting knowing the company's shape: how big, how fast, how profitable,
how levered, and how much cash it actually throws off. Not a thesis — the base layer a
thesis gets built on.

## Why it is built this way

**Filings only.** Historic financials come from the filer's own XBRL tags, never from a
screener. If the filer did not tag a line, the workbook prints an em dash and lists the
gap on the face of the sheet. Blank means "not tagged", never zero. See the
[source policy](../../docs/output-standard.md#source-policy--historic-financials-come-from-filings).

**Original filings beat restatements.** FY2023 revenue comes from the FY2023 10-K, not
from the comparative column of the FY2025 10-K. The accession number on the Sources tab
tells you which filing you are looking at, so a restatement is visible rather than
silent.

**Margins are formulas.** Every `% margin` and `% growth` row is computed inside the
workbook off the rows above it. Click one and you can see what it is made of. A
hard-coded margin is a bug, not a shortcut.

## How to use the output

1. Read the Profile tab first. Five lines tell you the story: revenue growth, gross
   margin trend, operating margin trend, free cash flow conversion, net debt.
2. Check the balance check on the Balance Sheet tab is not red.
3. Where a line is an em dash, open the filing from the Filings tab and find out
   whether the filer reports it under a name we do not yet map, or genuinely does not
   report it. Both are findings.
4. Add your own price and share count if you want multiples — this workbook
   deliberately does not, because price is not filing data.

## Quality checks

- [ ] Sources tab has an entry for every `[n]` marker used
- [ ] Balance check is zero across all years
- [ ] No blue formulas and no black hard-codes
- [ ] Missing lines are em dashes, and the gap list on the Profile tab names them
- [ ] Free cash flow reconciles to CFO less capex by inspection

## Next skill

[`comps-set-builder`](../comps-set-builder/) — once you know the company's shape, find
out what the market is paying for it relative to peers.
