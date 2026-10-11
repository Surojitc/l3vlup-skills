# The Finance Skill specification, v0.1

The open contract for finance workflows: what a workflow is, what data it
needs, what evidence its output carries, and who owns what. Contract
version `1`. The machine-readable form is in
[`schemas/finance-os/`](../schemas/finance-os/); this page explains it.

A finance workflow is a recipe, not an agent. It is an ordered set of
calls to a small set of primitives, with the sources it may use, the data it
needs, the figures it calculates, the checks that must pass, the judgments
it leaves to a person, and the files it hands over. The same contract
describes a skill you run locally from this repository and the same skill run
by a hosted service.

## 1. The primitives

`retrieve`, `extract`, `structure`, `calculate`, `compare`, `screen`, `rank`,
`search`, `reason`, `draft`, `render`, `verify`, `monitor`, `notify`,
`orchestrate`. Named workflows (trading comps, an earnings review, a buyer
screen) are compositions of these. Only `reason` and `draft` need a model.

## 2. The workflow (`workflow.schema.json`)

| Field | What it holds |
|---|---|
| `id`, `name`, `version`, `contractVersion` | A slug, a name, a semantic version, and `"1"` |
| `vertical`, `roles`, `difficulty` | `banking`, `markets` or `shared`; IB, PE, ER/HF, General; Core to Advanced |
| `inputs` | What the person supplies: a ticker, a company, peers, a document, text |
| `sources` | The evidence policy: which kinds of document may count as a source (`required`, `optional`, `prohibited`) |
| `data` | What the workflow needs to be fed, as capabilities (§3) |
| `steps` | Title, primitive and detail, in order |
| `outputs` | The files it hands over: format, filename, sections, and where the numbers come from |
| `calculations` | Named figures, their formulas, and the figures they read |
| `verification` | Checks: `deterministic` (code) or `human` (what a professional confirms) |
| `humanCheckpoints` | The judgments the workflow deliberately leaves to a person |
| `dependencies` | Workflows this one chains from |
| `runtime` | Primitives used, whether a model is needed, tools |
| `ownership` | §5 |
| `tests`, `evals` | Fixture and eval ids |

## 3. Data requirements (`data-requirement.schema.json`)

A workflow says what it needs, never who supplies it. A requirement names a
capability (`company.identity`, `financials.standardized`,
`financials.as-reported`, `filings.index`, `filings.text`, `prices.eod`,
`prices.intraday`, `segments`, `kpis`, `guidance`, `transcripts`, `news`,
`ownership.institutional`, `ownership.insider`, `estimates.consensus`,
`transactions.precedent`, `macro.series`, `user.document`), whether it is
required, how much history it needs, the weakest evidence it will accept
(`filing-linked`, `source-named`, `any`), and what the output does with it
(`display`, `calculate`, `export`).

So the same workflow can run on public filings alone, on a workbook the
person uploads, or on a data licence they already hold.

A provider describes itself in the same vocabulary: what it covers, its
licence class, its credential model, and its rights to display, export,
publish derived figures and store. **A provider whose rights have not been
reviewed and approved is never used automatically, and any right recorded as
`unknown` counts as `no`.** Being publicly reachable is not a right.

## 4. Evidence: three layers (`provenance.schema.json`)

Citation alone is not an audit. An output carries three layers.

1. **Source lineage.** Every material figure has a value, a unit, a period
   (duration or instant, ending on a date, actual or estimate) and a source:
   the kind of document, its title, form and accession where there is one,
   the page, table or tag, a short excerpt of the printed value, when it was
   read, and the provider that supplied it.
2. **Calculation lineage.** A derived figure records its formula and the
   figures it was computed from, each independently sourced. It is verified
   only when every input is.
3. **Decision lineage.** Why a figure or an entity was selected, adjusted,
   excluded, included, classified, normalised or overridden. Each decision
   records whether a rule, a model or a person made it, what it rests on,
   and what it changed downstream. A model's decision starts as needs-review.
   A person is recorded by role, never by identity.

Four rules hold everywhere:

- **Missing is `null`, marked `missing`, and never zero.** A genuine zero
  from a filing is a verified zero, which is a different thing.
- **A figure with no source is never verified.**
- **A period is mandatory.**
- **Original filings beat restated comparatives;** the accession says which
  one was used.

[`fixtures/finance-os/precedent-ev.evidence.json`](../fixtures/finance-os/precedent-ev.evidence.json)
shows all three layers on one invented precedent transaction. It builds the
enterprise value from the share count, offer price, net debt and a pension
adjustment. The negative LTM EBITDA leaves the multiple `null`, and a rule
then keeps the deal out of the quartiles.

## 5. Ownership

| Field | Meaning |
|---|---|
| `specOwner` | Who owns the method: `open` (this repository), `commercial` (a hosted product) or `twc` (a private research operation) |
| `runtimeOwner` | Who owns the machine that runs it for a person |
| `publicationRing` | The most public place anything about it is published |
| `upstreamSource` | Where the specification is maintained |
| `referenceImplementation` | An executable reference build in this repository, when one exists |
| `privateExtensionsAllowed` | Whether others may extend it privately; always true for open workflows |
| `promotionReviewRequired` | Whether the method originated privately and needs review before publication |
| `licence` | Recorded per workflow; `undecided` until the licence matrix is settled |
| `repoPath` | Its home here |

**A private variant of a workflow is a separate workflow with its own id,
never a new version of an open one.** Nothing whose method, runtime or
publication is private is ever published here.
`scripts/__tests__/public-boundary.test.mjs` checks for that, among other
things. It is a guardrail, not a proof; promotions into this repository are
reviewed by a person.

## 6. Checking your output

```bash
npm run test:finance-os       # schemas, fixtures and every published workflow
npm run test:boundary         # the public-boundary guard
```

`lib/finance-os-schema.mjs` is a dependency-free validator for exactly the
JSON Schema subset these files use, plus the lineage rules a schema cannot
express. Any standard JSON Schema 2020-12 validator can check against the
schemas too.
