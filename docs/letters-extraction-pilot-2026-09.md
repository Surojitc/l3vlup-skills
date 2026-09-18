# The extraction harness, and the pilot it is built for

The harness is complete and has never called a model. It takes a `Model` —
an object with one async `propose` method — and every test drives it with a
deterministic fake that answers from a fixture map. No module in this
milestone imports a provider SDK, reads an environment variable, or opens a
socket; a test asserts that, file by file.

```
npm run extract:thesis     # the whole pipeline against fixtures and the fake
npm run test:extraction    # 21 tests
```

## The order of operations is the safety argument

```
transient parsed text
  → deterministic chunking, each chunk carrying its offset in the document
  → ask the model about one chunk, within budget
  → strip anything it said that it is not allowed to say
  → translate its offsets into the whole document
  → verify the span byte for byte against the transient text
  → enforce the closed taxonomy
  → resolve the issuer deterministically, or leave it unresolved
  → truncate the public excerpt and meter it against the document's budget
  → fingerprint, collapse duplicates, drop anything already rejected
  → hand a person a review card
```

One-way. A claim that fails a step is dropped at that step and **never sent
back to a model to be fixed** — the runner calls `propose` exactly once per
chunk, and a test counts the call sites.

## What the model may say, and what it may not

| May propose | May not determine |
|---|---|
| issuer mention (as the letter names it) | canonical issuer identity |
| claim paraphrase | ticker, CUSIP, normalised CUSIP, share class |
| claim kind | SEC issuer CIK |
| stance | 13F position, shares, position change |
| taxonomy tags | filing date, accession, form, document URL, hash |
| catalyst, risk, horizon | whether the evidence actually matches |
| evidence span and offsets | whether a claim is published |

The right-hand column is not a list of fields we prefer to compute. It is the
list where **a plausible wrong answer is worse than no answer**, because
nothing downstream would catch it: a wrong ticker resolves, a wrong CUSIP
matches a real security, a hallucinated position reads exactly like a real
one.

`stripToProposable` enforces it. A model that returns a ticker is not an
error to abort on — it is a normal thing for a model to do — so the field is
dropped and **reported**, because silently dropping would hide a prompt that
is inviting the wrong answer. The fixture run strips six such fields.

## Publication states

```
proposed → evidence_verified → issuer_unresolved → needs_review
                                       ↘             ↓
                                        needs_review → accepted / edited → published
```

`accepted`, `edited`, `rejected` and `published` are **human-only**: the
runner is refused if it tries. And there is no edge from `proposed`,
`evidence_verified` or `needs_review` to `published` at all, so the absence
is structural. `reachableWithoutHuman('proposed')` returns four states and
`published` is not among them — asserted, not argued.

## Quotation

Per excerpt: 25 words and 200 characters, whichever bites first, and a long
span is **truncated rather than refused** — the claim keeps its paraphrase.

Per document, cumulatively across every published claim: **50 words and 400
characters**. Once spent, further claims keep their paraphrase and their
excerpt is withheld with a reason. They are not dropped: a claim is worth
reviewing whether or not there is quotation budget left to evidence it
publicly.

## Cost

| | |
|---|---|
| Allowlist | `claude-haiku-4-5-20251001` (extraction), `claude-sonnet-5` (escalation) |
| Max documents | 9 |
| Max chunks per document | 12 |
| Max input / output tokens per call | 40,000 / 4,000 |
| Max input / output tokens per document | 120,000 / 8,000 |
| Max calls | 18 |
| **Pilot budget** | **$3.00** |
| **Milestone ceiling** | **$15.00** |

Checked **before** each call from the estimate. A run's own budget can never
be raised above the milestone ceiling: `emptyCostLedger({ budgetUsd: 500 })`
comes back at 15.

**An unpriced model refuses to run.** If a model is configured but carries no
price, `estimateUsd` returns `null` and the run stops rather than treating
the call as free. A cost that cannot be computed cannot be kept under a
ceiling, and a budget that cannot be enforced is not a budget.

**The stop is a stop.** No fallback to a cheaper model, no shortened input,
no skipped verification. Once stopped, every later call is refused too.

**A run is resumable.** State is a value. A run interrupted mid-document
resumes from the calls already in its ledger: chunks already charged for are
skipped and the budget carries forward rather than resetting.

## The first live pilot — designed, not executed

Two contrasting documents, chosen because they fail differently. An activist
exhibit is short, argumentative and full of dated catalysts. A registered
fund's shareholder report is long, table-dense, and buries the manager
discussion inside financial statements — which is exactly where extraction is
most likely to quote a table and call it a thesis.

| | Document | Form | Filed | Source bytes | Extracted characters |
|---|---|---|---|---|---|
| 1 | Starboard Value / CarMax exhibit | DFAN14A | 2026-03-11 | 145,421 | 16,006 |
| 2 | Longleaf Partners semi-annual report | N-CSRS | 2026-09-04 | 1,403,127 | 65,697 |

The second Longleaf report is the better test of manager discussion than
either Oakmark report, which are ten times the size and would spend most of
the chunk ceiling on financial statements.

**Model:** `claude-haiku-4-5-20251001`, one pass, **no automatic fallback**.
Any `claude-sonnet-5` adjudication of a failed verification is a separate
decision requiring separate approval; the allowlist contains it, and nothing
reaches for it.

**Estimated cost**, at 8,000-character chunks with roughly 900 tokens of
instruction overhead per call and 1,200 output tokens per chunk:

| Document | Chunks | Input tokens | Output tokens | Estimated |
|---|---|---|---|---|
| Starboard / CarMax | 3 | 7,503 | 3,600 | $0.0255 |
| Longleaf N-CSRS | 9 | 27,788 | 10,800 | $0.0818 |
| **Total** | **12 calls** | | | **≈ $0.11** |

About **28× headroom** under the $3 pilot budget. The gap is deliberate: the
budget is there to stop a runaway, not to be a forecast, and a first run
whose cost estimate is wrong by an order of magnitude should still stop long
before it matters.

**Output:** a draft review artefact only. Nothing is published, nothing
reaches the site, and every claim lands in `needs_review` or
`issuer_unresolved` for a person to decide.

## What the pilot still needs

An `ANTHROPIC_API_KEY`, which nobody has granted and which this repository
must never hold — the collector is public. The realistic shape is a local run
on a machine holding the key, or a separate manually-dispatched workflow job
carrying it as a secret. Either is its own approval.
