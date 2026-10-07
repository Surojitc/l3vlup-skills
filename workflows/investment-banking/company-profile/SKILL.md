---
name: company-profile
description: Build a banker-grade one-pager on any company, fast. Use for IB/PE work when the task is company profile; output is company one-pager (profile page inputs).
license: CC-BY-4.0
metadata:
  author: L3VLUP (l3vlup.com)
  version: "1.0"
  last_reviewed: "2026-08-18"
  career_path: investment-banking
  roles: [IB, PE]
  source: https://www.l3vlup.com/skills/company-profile
  workflow: workflow.json
  generated_from: L3vlup lib/skills-library.ts (regenerate there; do not edit here)
---

# Company Profile

> Build a banker-grade one-pager on any company, fast.

The standard first deliverable in IB and PE: business description, segments, financial snapshot, ownership, management, recent news and valuation context — structured the way a deal team expects it, with every figure sourced.

| | |
|---|---|
| **Output** | Company one-pager (profile page inputs) |
| **Level** | Analyst · Core |
| **Time** | ~25 min |
| **Context** | Interviews & on the job |

## The operating split

```mermaid
flowchart LR
    A[🤖 DELEGATE<br/>agent does the grunt work] --> B[🛡️ VERIFY<br/>professional checks it]
    B --> C[🎯 DECIDE<br/>human owns the judgment]
```

### Delegate — what the agent should do

- Gathering filings, investor decks and recent news into a source pack
- Extracting segment splits and 3-year financials into a table
- Drafting the business description from the 10-K
- Compiling the management and shareholder lists

### Verify — agent output a professional must check

- Financials tie to the filing (right period, right currency, right units)
- Segment definitions match the company’s own reporting, not a generic split
- Ownership data is current — stale shareholder lists are a classic error
- News items are real and dated; no hallucinated events

### Decide — judgment the human owns (never the agent)

The agent must NOT make these calls; surface evidence and frame them as open questions:

- What the "so what" of this company is for your specific purpose
- Which 3-4 facts lead the page and which go to footnotes
- How to characterise the company’s competitive position honestly

## Inputs

- Company name or ticker
- Purpose: pitch, buyer profile, target profile or interview prep
- Latest annual report / 10-K if available

## Workflow

1. **Scope the ask** — A profile for a sell-side pitch, a buyer list and an interview answer emphasise different things. Fix the purpose first.
2. **Describe the business** — What the company sells, to whom, how it makes money, segment split with revenue/EBITDA by segment.
3. **Build the financial snapshot** — 3-year revenue, EBITDA, margins, leverage, FCF — with period labels and the source filing for each.
4. **Map ownership and management** — Top shareholders, free float, CEO/CFO tenure, any activist or PE presence.
5. **Add market context** — Trading multiples vs peers, 52-week range, recent news and broker sentiment where public.
6. **Pressure-test the page** — Would an MD scan this in 60 seconds and find nothing to red-pen? Check formatting, footing and sources.

## Example output

> **Illustrative output** — fictional company, illustrative numbers.

**MERIDIAN INDUSTRIALS PLC — ONE-PAGER INPUTS** *(Investment Banking lens)*

**Business:** UK-listed industrial components group; 3 segments — Flow Control (48% of revenue), Thermal Systems (33%), Aftermarket Services (19%). Revenue model ~60% OEM contracts / 40% recurring aftermarket. *(FY25 annual report, segment note)*

**Financial snapshot (FY23–FY25):** Revenue £1,38bn → £1,47bn → £1,52bn; EBITDA margin 16.8% → 17.4% → 17.9%; net debt/EBITDA 1.6x; FCF conversion ~85%. *(FY25 annual report, pp. 12, 44)*

**Ownership:** Free float 92%; top holders two index funds (~13% combined) and one active manager (6.2%, added in FY25). CEO 6 years in seat; CFO appointed FY24. *(latest RNS holdings, annual report governance section)*

**Flags for the deck:** aftermarket mix shift is the margin story; Thermal Systems exposed to one auto-OEM at ~11% of group revenue; no disclosed M&A since FY22 — balance sheet capacity ~£400m at 2.5x leverage.

## Quality checklist (apply before returning output)

- Every figure has period + source
- Segment revenue sums to total revenue
- The page reads top-down: most important facts first
- No unexplained jargon a first-year wouldn’t know

## Grounding rules

- Use only source material provided by the user or fetched from pages you cite.
- Every factual claim carries a source reference; numbers carry their period (Q/FY).
- Never invent figures, filings, dates or events; say "not provided" instead.

---

**Run this workflow interactively** — with source auto-fetch and practice drills — at
[l3vlup.com/skills/company-profile](https://www.l3vlup.com/skills/company-profile). Next in the chain: **Comps Set Builder**.

The machine-readable form of this workflow, in the Finance OS contract, is
[`workflow.json`](./workflow.json); the contract is described in
[docs/finance-skill-spec.md](../../../docs/finance-skill-spec.md).
