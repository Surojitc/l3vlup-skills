# The quarter of the board that lands in Other

**21 September 2026.** An evaluation, not a change to the collector.

## What this is about

`inferVertical` places roles by an ordered cascade of regular expressions over
the job title. For the titles a bank publishes it is right, it is free, and a
person can read it and say why it decided what it decided. That is worth more
than it looks, and nothing here proposes replacing it.

It also returns `Other` for **363 of the 1,386 rows** in the September feed. A
quarter of the tracker arrives with no vertical, which means the filters that
are the point of the tracker cannot see any of it.

Some of that is correct. "Employee and Workplace Experience Intern" belongs in
no finance or technology vertical and should stay exactly where it is. Some of
it is the gap the classifier names itself, at `scripts/sync-ats.mjs:317`:

> a bare "Investment Analyst" still lands in Other, which is a real remaining
> gap and deliberately left alone here — the title is genuinely ambiguous across
> funds, corporates and asset managers, and guessing it into one of them would
> be worse than leaving it visible in the Other report.

That sentence is right, and it is also the specification for anything that tries
to close the gap. A wrong vertical is worse than `Other`, because `Other` is
visible and countable and obviously incomplete, and a confident wrong label
looks exactly like a right one.

## Why this is worth evaluating now

Placing a role in one of 22 named areas is a closed-set judgement over a short
piece of text. It is not something a regular expression over a title can settle,
and until recently the only alternative was a reasoning model, at a price that
made 363 rows a day an unserious proposal.

TypeSafe's Jev charges $0.042 per million input tokens and nothing for output.
Measured from the real serialised request, one row costs **1,124 input tokens**,
dominated by the 22 option descriptions:

| Scope | Per day | Per month |
|---|---|---|
| The 363 rows in `Other` | $0.0171 | **$0.51** |
| Every row on the board | $0.065 | **$1.96** |

Batching rows into one request would repeat the option descriptions per question
and save nothing, so one row per request is the right shape.

## What was built

Three files, none of which any workflow calls.

- `lib/vertical-judge.mjs` — the options, their descriptions, the two questions,
  the cutoff and the decision. Calls nothing.
- `lib/typesafe.mjs` — the only file that holds a client, with the ledger and
  the ceilings, in the same shape `lib/thesis-cost.mjs` uses and for the reason
  stated there: a ceiling enforced after the spend is not a ceiling.
- `scripts/vertical-eval.mjs` — the evaluation. Offline and deterministic by
  default; `--live` needs a key and says so.

`sync-ats.mjs` is untouched and the suite asserts it. `collect.yml` is untouched
and the suite asserts that too.

## The safety property

The judge can move a row **out of** `Other` and it can do nothing else.

- It only ever looks at rows already classified `Other`.
- It never overrides a rule that fired.
- It cannot move a row between two verticals.
- It cannot name a vertical `data/taxonomy.json` does not declare, and the suite
  checks the two files against each other in both directions.
- A row it declines is byte for byte the row that exists today.

`scripts/__tests__/vertical-judge.test.mjs` asserts each of these. Four
deliberate regressions were introduced against them during development, and all
four were caught: the judge overwriting rows the rules placed, the cutoff
dropped so it guesses, a declined row written as the choice anyway, and a
vertical silently dropped from the option list.

## Why two questions and not one

A Choice always picks something. Handed 22 verticals and a facilities role it
returns the least bad of 22 wrong answers, and the distribution may even be
concentrated, because one of them really is closest.

So the Choice settles *which* vertical, and a separate yes/no settles *whether*
the role belongs to any of them. Both go in the same request over the same
state, and the code reads them together. Neither can answer the other's
question. This is the shape TypeSafe's own skill-suggestion cookbook uses, for
the same reason.

The state is four fields: title, firm, what kind of firm, location. Not the
posting body, which is mostly benefits and boilerplate. TypeSafe's published
notes say accuracy falls as the state fills with material the question does not
need, and those four fields are what a person reads to answer this anyway.

## How to read the evaluation

```
node scripts/vertical-eval.mjs                        # offline, free, proves the plumbing
TYPESAFE_API_KEY=… node scripts/vertical-eval.mjs --live --limit 80
```

Two passes, and they only mean anything together.

**Control.** The 1,023 rows the rules did place, judged blind. The rules are the
label. Disagreement here is the error rate on roles whose vertical is not in
doubt. A judge that cannot pass this has no business being trusted on the
ambiguous ones.

**Recovery.** The 363 `Other` rows, where there is no label. Coverage only, plus
where they landed, for a person to read. **Coverage is not accuracy.** A judge
that confidently placed every row would score 100% coverage and could still be
wrong about all of them.

Both sweep the cutoff at 0.70, 0.80, 0.85, 0.90 and 0.95. The 0.90 shipped here
comes from TypeSafe's worked example on SEC filings, on their data, not ours. It
is a reason to start high and measure, not a result.

The offline mode answers from a deterministic word-overlap stub. It exercises
the adapter, the budget, the cutoffs and the arithmetic, and its token counts are
real measurements of request size. It measures nothing about Jev, and it prints
that in its own output.

## The ruling this is for

Adopt the judge only if the control pass agrees on at least **90%** of what it
decides, at a cutoff whose recovery coverage is above **40%**.

Below either, the answer is that `Other` stays. That is not a failure: it is the
classifier's author being right, with a number attached.

If it clears both, the change that follows is a separate one, and it is small:
a post-pass over `Other` rows, off by default, writing the vertical and the
confidence onto the row so the tracker can show how it was placed. That change
would touch the collector and the publication contract, and it should be
proposed on its own evidence rather than bundled here.

## What was deliberately not built

**Stage B of the thesis pipeline.** `lib/thesis-anthropic.mjs:340` asks a model
to pick at most six candidates and return only `{candidateId, rank}`; the tool
schema has no field that could carry prose. That is reranking with the
generation already designed out of it, and it is the cleanest fit for a typed
judgement anywhere in this repository. Jev would return a calibrated score per
candidate, which is strictly more than the current call returns, and the runner
could then apply its own materiality threshold in code.

It was left alone for three reasons. The pipeline has run five times in its life
and spent almost nothing, so there is no saving. PR #55 is actively rewriting
its bounds, and two people editing the same ceilings is how a $15 hard stop
becomes a $150 one. And a third model in `MODEL_ALLOWLIST` touches the constants
`thesis-pilot.yml` re-asserts before every run, which is not a thing to do in
passing.

Worth doing. Not worth doing today.

**Anything else.** Deadline extraction reads dates, which Jev reads as text
rather than as ordered quantities. The letters PDF classifier reads page
geometry from raw bytes. The deck cover-title reconstruction reads OCR soup.
None of those is a language judgement, and the existing heuristics are better
suited to all three.
