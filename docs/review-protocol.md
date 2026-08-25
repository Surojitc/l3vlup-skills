# Review protocol

How a skill's output gets checked before it ships. Adapted from the audit protocol
in [wildcat-finance/skills](https://github.com/wildcat-finance/skills/tree/main/plugins/hexaemeron),
which solves the same problem in smart-contract auditing: how do you stop a
competent-looking reviewer from doing surface-level work?

Their answer is that the reasoning has to leave a trace. If the thinking is
invisible, "I checked it" and "it looked fine" are indistinguishable. What follows
is that idea moved from Solidity to financial analysis.

## The three tools

Not steps to work through in order. Each has a **trigger**, and when the trigger
fires the marker is required before you continue. Extra markers are always fine.
Skipping one after its trigger fired is not.

| Trigger | Marker | What goes in it |
|---|---|---|
| You open a line item, a segment or a business you have not explained yet | `[Feynman: <item>]` | What it is, in plain English, with no finance vocabulary. Not "revenue grew 14%" but "they sold more of the thing, and each one cost a bit more than last year." Where your plain-English version goes fuzzy, or you reach for a term like *normalised* or *adjusted* to keep it accurate, that is where the assumption is hiding. Mark the spot. |
| You stop on a figure whose size, direction or absence is not immediately obvious | `[Socratic: <item> — why?]` | One question that drills past the restatement. If your first answer repeats the number back, ask again. Stop when you reach the belief the figure rests on. |
| A number looks clean, a margin looks stable, a thesis looks obviously right | `[Inversion: <claim>]` | Three concrete ways it could be wrong. Specific mechanisms with figures, not "execution risk". A clean-looking line is the one nobody checks. |

The Feynman test is first and it is the load-bearing one. A segment you have not
explained in plain words is a segment you have not understood, however confidently
you can quote its growth rate.

### Worked example

Reading a filer whose gross margin improved 240bp:

- `[Feynman: gross margin]` — "For every pound of stuff they sold, a bit more of it
  stayed with them instead of going to whoever made it."
- `[Socratic: gross margin — why?]` — Why did more stay with them? → Input costs
  fell. Why did input costs fall? → *The explanation stops here in the MD&A.* Was it
  price, mix, volume leverage, or a one-off? Three of those repeat and one does not.
- `[Inversion: margin expansion is structural]` — It could be a supplier credit that
  does not repeat; it could be mix, with a low-margin line shrinking rather than a
  high-margin line growing; it could be capitalised cost moving off the line.

That is three markers and about ninety seconds, and it turns "margins improved" into
a question worth asking management.

## FINDING versus LEAD

Two output classes, and the distinction is the whole discipline.

- **FINDING** — a claim with a `proof:` field carrying a concrete figure and its
  source. A period, a filing, an accession number.
- **LEAD** — a real observation with a partial path. Something looks off but the
  figure to prove it is not in hand.

**No proof, no FINDING. Ever.** A claim without a sourced figure is a LEAD, and
saying so is not a weaker answer — it is an accurate one. Default to LEAD rather
than dropping something; an unproven observation someone can chase beats silence.

This is the same rule as the [source policy](output-standard.md#source-policy--historic-financials-come-from-filings),
stated for prose instead of spreadsheets.

```
FINDING | company: TICKER | area: segment-margin | group_key: TICKER | segment-margin
claim: one sentence
proof: 240bp gross margin expansion FY2024→FY2025, FY2025 10-K, accn 0000000-25-000001
so_what: what changes about the decision
```

`group_key` exists so that parallel reviewers looking at the same thing produce one
item rather than three.

## Weaponise every pattern

When you find an aggressive choice at one company, **check every comparable for the
same thing.** A filer capitalising costs its peers expense is a finding about one
company; discovering three of the five do it is a finding about the comp set, and it
changes the multiple you would apply. Missing the repeat instance is the failure.

Then escalate: take each finding to its worst version. A presentational quirk may be
hiding a real one.

## Do not report

Naming the noise matters as much as naming the signal. None of the following is a
finding on its own:

- Risk factors lifted from the 10-K. Every filer discloses competition and key-person
  risk. Disclosure is not analysis.
- "The multiple is above the peer median." That is an observation. The finding is
  *why*, and whether the reason is durable.
- "The stock is cheap" with no catalyst and no mechanism.
- A consensus view restated confidently. If the Street already holds it, it is priced.
- Round-number targets with no working shown.
- Model output quoted to two decimal places, which claims precision the inputs cannot
  support.

## What we took and what we left

Worth being explicit, because copying a system wholesale is its own failure mode.

**Taken:** the trigger-and-marker protocol; FINDING versus LEAD with mandatory proof;
the group key; weaponising a pattern across the set; the explicit do-not-report list;
a per-skill evolution ledger.

**Left:** the SHA-256 frontier hashes, the scoreboard ledger and the parked-job lane.
Those solve coordination across many autonomous agents running unattended. This is a
small library with a human in the loop, and machinery that is not load-bearing is
just something else to keep correct.
