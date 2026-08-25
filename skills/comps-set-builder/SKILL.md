---
name: comps-set-builder
tier: free
description: >
  Build a defensible trading-comparables sheet from SEC filings, with live multiple
  formulas, median and mean statistics, and a prompted inclusion-and-rejection
  rationale. Use when someone says "build comps", "comparable companies", "where does
  [ticker] trade versus peers", or is preparing for a modelling test where they will be
  asked to justify every name in the set.
output: XLSX — Comps, Inclusion, Sources
argument-hint: "[ticker] --peers TICK,TICK,TICK"
---

# Comps Set Builder

## What it produces

    python3 skills/comps-set-builder/build.py NVDA --peers AMD,AVGO,MRVL --out out/

| Tab | What it holds |
|---|---|
| **Comps** | Market, capital structure, operating metrics, trailing multiples, forward multiples, set statistics |
| **Inclusion** | Why each name is in, which names were rejected and why, and every adjustment made |
| **Sources** | Every filing-derived figure resolved to tag, period, form and accession |

## The job to be done

Choose a comparable-companies universe you can defend line by line, and show where the
target trades against it. The output is not the multiple. The output is the argument
for the multiple.

## Why it is built this way

**Fundamentals from filings, price from you.** Revenue, EBITDA, debt, cash and share
count come from each filer's XBRL tags. Share price and forward consensus do not exist
in filings, so they appear as shaded blue input cells. The workbook will not guess a
price and then print a multiple off it — an unsourced multiple is worse than an empty
cell, because it looks finished.

**Multiples are formulas, always.** Change a price and every multiple, median and mean
moves. A comps sheet whose multiples are pasted values cannot survive the first
question anyone asks it.

**Trailing and forward, both.** A valuation output that shows only one is incomplete.
The forward block is separately shaded and separately labelled so nobody mistakes a
consensus number for a filed one.

**EBITDA is built, not pulled.** Operating income plus D&A, computed in the sheet from
two sourced lines, because `EBITDA` is not a GAAP tag and any figure claiming to be one
is somebody's adjustment. If you want a different definition, you can see exactly where
to change it.

## The Inclusion tab is the actual skill

Anyone can pull five tickers. The tab ships three prompted blocks, empty:

- **Why each name is in** — business model, size band, growth band, margin structure,
  end-market exposure. Those five tests are what survive scrutiny.
- **Names considered and rejected** — an empty rejection list is flagged in the sheet
  as a red flag, because taking a sector list and calling it a comp set is the most
  common failure in a first-round modelling test.
- **Adjustments made** — stock-based compensation treatment, operating leases,
  non-recurring items, fiscal-year calendarisation. An unstated adjustment is the
  fastest way to lose the room.

Fill all three before showing the sheet to anyone.

## Quality checks

- [ ] Every included name has a written rationale
- [ ] At least two names were considered and rejected, with reasons
- [ ] Calendarisation stated where fiscal year-ends differ
- [ ] Trailing and forward multiples both present
- [ ] Median sits alongside mean, and outliers are visible rather than quietly dropped
- [ ] No hard-coded multiples anywhere

## Next skill

`stock-pitch-builder` — turn the relative-value read into a variant perception rather
than an observation.

## Before you send it to anyone

Run the [review protocol](../../docs/review-protocol.md) over the output. Three
markers, and they are cheap:

- `[Feynman: <line>]` — explain the biggest line in plain English, no finance
  vocabulary. Where the explanation goes fuzzy is where the assumption is hiding.
- `[Socratic: <line> — why?]` — for any figure whose size or direction is not
  obvious, one question that drills past restating the number.
- `[Inversion: <claim>]` — for anything that looks clean, three concrete ways it
  could be wrong.

Anything you conclude is a **FINDING** only if it carries a figure and the filing
it came from. Without that it is a **LEAD** — which is a fine thing to hand over,
and an honest one.

Change history for this skill: [EVOLUTION.md](EVOLUTION.md).
