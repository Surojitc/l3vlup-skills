# The thesis data contract

Written before anything is generated against it. Nothing in this milestone
calls a model, holds a key, fetches a document or publishes a claim. It
defines the shapes a model's output will have to fit and the deterministic
checks it will have to pass, so the rules are a precondition rather than a
reaction to whatever the first run happens to produce.

## Why the 13F join is a bridge and not a join

An earlier note said a thesis links to a manager's 13F positions "through
CIK". That was wrong, and the error mattered enough to correct in code.

Form 13F reports a **CUSIP and an issuer name as the filer typed them**. It
does not report the issuer's SEC CIK. A letter, meanwhile, names a company in
prose. Joining those on name would be wrong often, and wrong in the direction
that looks right: "Alphabet" and "Alphabet Inc. Class C" are not the same
security, and "First Republic" in 2021 and "First Republic" in 2024 are not
the same company.

So the relationship is explicit and every hop may fail:

```
a company mentioned in a document
  → a reviewed canonical issuer      (a person confirmed the alias)
  → the security master              (CUSIP, share class, effective dates)
  → a specific CUSIP and share class
  → that manager's 13F position
```

`lib/security-master.mjs` holds the bridge. Each row carries the filed CUSIP,
the normalised CUSIP, the filed issuer name, the canonical name, ticker,
exchange, the issuer CIK **where resolved**, share class, effective dates,
mapping source, mapping confidence and review state.

Two rules are never relaxed:

- **Never join on issuer name alone.** A name reaches an issuer only through
  an alias somebody confirmed. An unconfirmed alias is a proposal.
- **Never map one share class to another.** One CUSIP matching two classes
  returns `ambiguous` and no security. Class A and Class C have different
  prices and different votes; a manager who holds one does not hold the other.

An unresolved security stays unresolved. `resolveSecurity` returns `null`
with a reason, never a best guess.

### A position is context

A 13F position corroborates a thesis. It never proves one, and **its absence
proves nothing at all**: the holding may be below the reporting threshold,
under confidential treatment, held through a non-13F instrument, or simply
not yet filed. Every position carries that sentence, and `positionDelta`
returns `impliesConviction: false` and `impliesExit: false` as fields rather
than as documentation.

## The five claim kinds

| Kind | Meaning | May be quoted |
|---|---|---|
| `statement` | explicitly stated by the manager | yes, verified |
| `paraphrase` | a faithful compression of stated material | yes, verified |
| `classification` | application of the closed taxonomy | yes, verified |
| `inference` | an analytical conclusion not directly stated | **never** |
| `filing` | a deterministic fact from a 13F, 13D/G or filing metadata | **never** |

The first three cannot enter review until their evidence verifies. The last
two may never be rendered as a quotation or attributed to the manager, in the
public view or on a review card — the card labels them **OUR INFERENCE** and
**FILING FACT** in capitals, because the distinction dies at the point of
review if it dies anywhere.

## Evidence

Exact-match verification against the transient extracted text, inside the
run, never against a stored copy. The excerpt must appear byte for byte **at
the stated offsets**: a span that occurs elsewhere in the document is still a
failure, because an offset that does not point where it claims cannot locate
anything later.

A failed span is **dropped, not repaired**. A second model asked to fix a
quotation produces a better-looking quotation, not a true one.

### Public excerpt limits

Both caps apply and the lower bites: **25 words and 200 characters**. Naming
one would let the other through — a list of tickers reaches 25 words in far
fewer than 200 characters, and a long compound reaches 200 characters in far
fewer than 25 words.

Because many short excerpts reassemble into a long one, `reassemblyProblems`
applies a **cumulative cap per source document: 50 words and 400 characters**,
across every published claim from that document, whichever bites first. Spans
that touch or overlap are measured merged, so two excerpts either side of a
comma cannot be stitched into one long one.

The cumulative cap is absolute rather than proportional, and that is the
point. A share-of-document rule is wrong at both ends: two per cent of a
short note forbids quoting it at all, while two per cent of a 15 MB
shareholder report is 300,000 characters, which is not a limit. The reason to
cap is the manager's copyright in their own words, and that does not scale
with page count. Fifty words is two permitted excerpts; a document needing
more than two short quotations is being reproduced rather than cited, and the
paraphrase is doing no work.

Public output is the paraphrase, the sec.gov link, the page or section
locator, and a short attributed excerpt only where one is needed.

## Stance, conviction and silence

- **Silence is `no_new_evidence`**, not a stance change. A document that says
  nothing does not become the new baseline; the last thing the manager
  actually said stays the thing they said.
- **`exited` needs a basis**: an explicit manager statement, or deterministic
  position evidence that carries its filing-lag qualification. The validator
  refuses `exited` without one.
- **A larger 13F position is not more conviction**, and a smaller one is not
  less. Managers trim on risk limits, redemptions and price moves.
- **There is no composite conviction score.** `convictionScore` and
  `compositeScore` are on the forbidden-field list. Conviction is recorded
  only where it was expressed, or as a clearly labelled classification a
  person reviewed.
- **A risk does not reduce stance.** Mixed or uncertain stays `unclear`.

## The taxonomy

52 tags across ten axes — investment case, business quality, valuation,
operating driver, catalyst, risk, capital allocation, ownership and
governance, horizon, and sector context. Each carries a stable code, label,
definition, aliases, a positive **and a negative** example, mutually
exclusive and compatible tags, the version it was introduced in, and a
deprecation replacement where applicable.

The negative example is the part that matters: a taxonomy rots by a tag
quietly widening until it means nothing.

**Sector is a deterministic issuer attribute**, not a model-selected tag. The
`sector_context` axis holds forces a manager argues about, which is a
different thing from what industry the company is in.

The model may select from the list and may not extend it. An unmatched claim
is recorded as unclassified, never as a new tag.

## Thesis history

Keyed by manager, canonical issuer and thesis identity — **not by a tag**. A
manager can hold two theses on one company at once, and a tag is a label on a
thesis rather than the thesis itself.

Transitions: `initiated`, `reiterated`, `strengthened`, `weakened`,
`revised`, `catalyst_update`, `risk_update`, `closed_explicitly`,
`no_new_evidence`. Every one needs two dated observations.

## Review

`scripts/thesis-review.mjs` renders local cards from fixtures: the
paraphrase, the excerpt where allowed, the locator and sec.gov link, manager
and issuer, proposed tags, stance, catalysts, risks, and the 13F context with
its lag warning. An unresolved company offers only `unresolved_company` or
`reject` — it cannot be accepted.

Decisions are keyed by a **fingerprint** of the claim rather than its id, so
a rejected claim re-proposed unchanged is filtered out before review, while a
genuinely changed one earns a fresh look.

## Cost

Defined, not executed. No key, no client, no dependency.

| | |
|---|---|
| Maximum documents | 9 |
| Maximum input tokens per document | 120,000 |
| Maximum output tokens per document | 8,000 |
| Maximum model calls | 18 |
| Model allowlist | `claude-haiku-4-5-20251001` (extraction), `claude-sonnet-5` (escalation on a failed verification) |
| Prompt version | `thesis-extract-v1` |
| Hard stop | **$15.00 cumulative** |

The budget is checked **before** a call, from the estimate: a ceiling
enforced after the spend is not a ceiling. And when it is reached the run
**stops** — it does not switch to a cheaper model, shorten the input or skip
verification. A budget that silently changes behaviour has not saved money,
it has changed the product without telling anybody.

## What is not here

No model call, no API key, no model dependency, no SEC fetch, no scheduling,
no site change, no published thesis data, and no Mac ingest. `npm test`,
`test:thesis`, `validate:thesis` and `review:thesis` all run offline against
synthetic fixtures written for the purpose — no manager's words appear
anywhere in this repository.
