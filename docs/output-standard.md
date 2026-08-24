# L3VLUP output standard

Every skill in this repo produces a file someone senior will open. This document is
the contract that file has to meet. It is deliberately specific, because "make it
look professional" is not a spec and cannot be checked.

## The bar we are building to

Two products define the standard for AI-produced finance work, and they define it in
different directions:

**[Rogo](https://rogo.com/rogo-home)** is the format bar. It sits inside the bank's
own workflow and returns Excel models, PowerPoint pages and Word memos already in the
firm's template, with source footnotes, because a deliverable that needs reformatting
before it can be shown has not saved anybody any time. Its own framing is that every
output has to meet the auditability and citation standards institutional clients
demand.

**[Hudson Labs](https://www.hudson-labs.com/)** is the sourcing bar. It works off SEC
filings and nothing else, cites the filing behind every claim, and scores forensic
risk against ten years of enforcement actions. Analysts trust it because the output is
citeable, not because it sounds confident.

L3VLUP is a teaching product rather than a terminal, so we take the format discipline
from the first and the sourcing discipline from the second, and we add the thing
neither has to do: **the output has to teach the person holding it why it is built
this way.** A student who receives a comps sheet should finish the day able to build
one without us.

That gives three tests every output must pass.

| Test | Question | Fails when |
|---|---|---|
| **Format** | Could this go into a deck without reformatting? | Colours drift, gridlines on, numbers unformatted, no print setup |
| **Provenance** | Can every historic number be traced to a filing? | A figure with no tag, period and accession behind it |
| **Teaching** | Does the reader learn the convention from the file? | Notes absent, structure unexplained, blanks indistinguishable from zeros |

## Source policy — historic financials come from filings

This is the rule that everything else hangs off, and it has no exceptions.

**Every historic financial figure comes from a filing.** Not an aggregator, not a
screener, not a model's recollection of a number. In practice that means SEC EDGAR
XBRL company facts, which are the filer's own tagged numbers as submitted, carrying
the tag, the period, the form, the filing date and the accession number.

The consequences are worth stating plainly, because they are what makes the rule real:

- **A missing line stays missing.** If the filer did not tag it, the workbook prints an
  em dash, not a zero and not an estimate. Blank means "not tagged", and the file says
  so on its face.
- **Original filings beat restated comparatives.** Where FY2023 revenue appears both in
  the FY2023 10-K and as a comparative in the FY2025 10-K, we take the FY2023 filing.
  A restatement is visible because the Sources tab names the accession.
- **We never sum across two tags for the same line.** A filer who reports both
  `Revenues` and `RevenueFromContractWithCustomerExcludingAssessedTax` would be
  double-counted. Tag lists are ordered preferences, first match wins.
- **Price is not filing data.** Share price, market data and forward consensus do not
  come from filings, so they are never auto-filled. They appear as shaded blue input
  cells for you to populate from your own licensed feed. A workbook that guessed a
  price and then printed a multiple off it would be worse than one that left the cell
  empty.
- **Forward numbers never mix with actuals.** Estimates live in their own block,
  shaded, labelled `E`, and sourced separately. The period row carries `2025A` and
  `2026E` number formats so the distinction survives being screenshotted.

Non-US filers on 20-F and 40-F are covered by the same path. Companies not in the SEC
ticker file are reported as unresolved, by name, on the face of the output.

## Excel house style

Ported from the TWC model exporter, which is in turn the convention every bulge
bracket training programme teaches. The point of a convention is that a reader who has
never seen your file knows what they are looking at in two seconds.

### Colour is meaning, not decoration

| Colour | Hex | Means |
|---|---|---|
| **Blue** | `FF0000FF` | Hard input, or a value pulled from a filing. Something a human can change. |
| **Black** | default | Formula computed inside this workbook. Do not overtype it. |
| **Green** | `FF008000` | Link to another sheet in the same workbook. |
| **Navy** | `FF264D82` | Headers, section labels, the period row. |
| **Grey** | `FF808080` | Notes, units, indented sub-rows. |
| **Red fill** | `FFC00000` | A tie-out that failed. Conditional, never applied by hand. |

The rule behind the rule: **if a reader cannot tell an assumption from a calculation at
a glance, they have to audit the whole file before they can trust any of it.**

### Number formats

| Marker | Format | Used for |
|---|---|---|
| `D` | `"$"#,##0,,_);("$"#,##0,,)` | Currency in millions. Raw values are kept, so formulas stay exact and only the display scales. |
| `P` | `0.0%_);(0.0%)` | Margins, growth |
| `X` | `0.0"x"` | Multiples |
| `S` | `0.00_);(0.00)` | Per share |
| `SH` | `#,##0,,_);(#,##0,,)` | Share counts in millions |
| `BP` | `#,##0" bp"` | Spreads |

Negatives sit in parentheses everywhere. Not a minus sign, not red text.

### Layout

- Column **A** is a 3-wide gutter. Nothing is written in it. The grid should never
  touch the edge of the page.
- Column **B** holds labels, 38 wide.
- Column **C** is a 1.7-wide spacer.
- Data starts at **D**, 13 wide per period.
- Rows 2–5 are the header block: entity, sheet title, source line, units line.
- Row 6 is the period row, right-aligned, navy, `yyyy"A"` or `yyyy"E"`.
- Body starts at row 7. **Freeze panes at D7.**
- Gridlines off. Landscape. Fit to one page wide. Print area set.
- Section headers carry a thin navy bottom border. Subtotals are bold.
- `% margin` and `% growth` are grey italic indented sub-rows, and they are **always
  formulas** — a hard-coded margin is a bug.

### Tie-outs

Any statement that can be checked, is. The balance sheet carries an
assets-less-liabilities-and-equity row with conditional red formatting on non-zero.
A workbook that does not tie should announce that itself rather than wait to be caught.

## The Sources tab

Every workbook ends with one, and it is the tab that separates output you can defend
from output you cannot.

Each figure pulled from a filing registers its origin. The writer numbers the distinct
sources, prints a `[n]` marker in a narrow column to the right of each row, and emits
a Sources sheet resolving each marker to:

| # | Source | Detail | Accession | Link |
|---|---|---|---|---|
| 1 | AAPL FY2025 10-K | `us-gaap:Revenues` · period ending 2025-09-27 · USD · filed 2025-10-31 | 0000320193-25-000073 | link to the filing index on EDGAR |

A number with no provenance record is an unsourced number. Where a workbook contains
any by design — price, consensus — the Sources tab says so in red at the top rather
than leaving the reader to notice.

## Teaching layer

The thing Rogo and Hudson Labs do not need to do, and we do.

- **Notes on the face of the sheet.** Grey, 8pt, under the block they explain. What
  blue means. What an em dash means. What a red balance check means.
- **Rationale is a field, not an afterthought.** The comps workbook ships an Inclusion
  tab with a row per included name, a rejected-names block, and an adjustments block —
  prompted, empty, waiting to be filled. An empty rejection list is called out as a red
  flag in the sheet itself, because taking a sector list and calling it a comp set is
  the single most common failure in a first-round modelling test.
- **The workbook is the lesson.** Formulas are left live and traceable rather than
  pasted as values, so the reader can click a multiple and see what it is made of.

## Checklist before an output ships

- [ ] Every historic figure traces to a filing on the Sources tab
- [ ] Blue is only ever an input or a pulled value; no blue formulas
- [ ] No hard-coded margins, growth rates or multiples
- [ ] Missing data shows an em dash, never a zero
- [ ] Actuals and estimates are visually separated and separately labelled
- [ ] Trailing **and** forward multiples present in any valuation output
- [ ] Tie-out rows present and passing
- [ ] Gridlines off, freeze panes set, print area set, landscape fit-to-width
- [ ] Notes explain the conventions to a reader who has never seen the file
- [ ] Rationale fields present wherever judgement was exercised

## Calibrating against real examples

See [`../calibration/README.md`](../calibration/README.md). Drop real bank, fund or
PE outputs into that folder and this standard gets amended to match what they
actually do, rather than what we think they do.
