# UK consulting coverage: how to get it

_20 September 2026. A read-only plan. Nothing here is implemented, and none of
it belongs in the step 4 classifier pull request._

Step 3 found **zero UK consulting rows**, which is the one launch gate the data
refuses and the reason the tracker filter is not being exposed. This is the plan
for fixing that, and the evidence behind it.

## What was probed

Twenty-one UK routes for the named firms, using the repository's own
`lib/ats-discover.mjs`, without a Firecrawl key. Read-only.

| Outcome | Count | Firms |
|---|---|---|
| **Board found and proven** | **1** | Compass Lexecon |
| No board in the HTML, JS-rendered | 9 | Bain, EY-Parthenon, KPMG, L.E.K., Arthur D. Little, Newton Europe, PA Consulting, Oxera, NERA |
| Blocked | 4 | McKinsey 503, Strategy& 403, Kearney 403, Oliver Wyman connection failure |
| Unsupported ATS family | 1 | BCG (phenom) |
| URL wrong or moved | 6 | Deloitte, Roland Berger, Simon-Kucher, OC&C, Capgemini Invent, Frontier Economics |

### The one that resolved

**Compass Lexecon** sits on FTI's existing Workday tenant under a different
site, which is the kind of thing only discovery finds:

```
workday · tenant fticonsulting · shard wd108 · site CompassLexeconCareers
31 postings, 9 of the first 20 early-career
```

Its early-career rows are European competition-economics seats in Brussels,
Berlin and Düsseldorf, with London expected in season. It is the cheapest
addition available: the tenant is already polled daily for FTI itself.

### The population that matters

**Nine firms are JS-rendered**, and that is the single largest group. They are
not unreachable; they are unreachable *by a plain fetch*. This is the
population the rendered-discovery fallback exists for, and it is the difference
between a UK launch that is months away and one that is a discovery run away.

## Three routes, in cost order

### 1. Direct ATS collection, where the board is reachable

Compass Lexecon today. Anything the rendered fallback resolves tomorrow. No
recurring cost beyond the daily poll, and every row arrives with real ids,
locations and, where the board publishes them, dates.

### 2. One-off rendered discovery

For the nine JS-rendered firms. Render once, detect, validate, promote, then
collect directly forever after. Designed below.

### 3. Curated primary-source rows

For McKinsey, BCG, Bain, Strategy& and anything that stays blocked. **Not
before the curated remediation and validator are complete**, per the decision
already taken: the existing 55 rows have 29 that can never age out and none
with a source, and adding UK consulting rows to a file in that state spreads
the problem.

## The rendered-discovery fallback, designed

### Proposed file changes

| File | Change |
|---|---|
| `scripts/discover-ats.mjs` | In `resolveFirm`, when a plain fetch yields no board and no unsupported family, retry **once** through Firecrawl and re-run the identical `firstBoard` → `countPostings` path |
| `lib/firecrawl.mjs` | **New.** The render call lifted out of `detect-career-changes.mjs` so both callers share one implementation rather than forking a second |
| `scripts/detect-career-changes.mjs` | Import the shared helper instead of its private copy. No behaviour change |
| `lib/sources/ats-registry.json` | Rows gain `discoveredBy: "rendered"` where the fallback found them |
| `scripts/__tests__/ats-discover.test.mjs` | Fallback fires only after a plain miss; never on a validated board; never on an unsupported family; a render failure degrades rather than throws |
| `scripts/__tests__/registry-schema.test.mjs` | **New.** See below |

`scripts/` is a danger surface, so this is its own pull request and is not
self-merged.

### Failure handling

The existing integration is optional by design and that property is preserved
exactly.

| Condition | Behaviour |
|---|---|
| No `FIRECRAWL_API_KEY` | Fallback never runs. Discovery behaves as it does today |
| Firecrawl returns non-200 | Recorded as `status: 'render-failed'` with the code. **Not** `no-board-found`, because a failed render is not evidence a firm has no board |
| Firecrawl returns 200 with `success: false` | Same, carrying the reported error |
| Rendered HTML contains no board | `no-board-found`, with `renderAttempted: true` so a re-run is not spent on it blindly |
| Board found but returns no postings | `detected-not-validated`, exactly as today. **Nothing unproven enters the registry** |
| Timeout | 30 seconds, matching the existing call. One attempt, no retry, no backoff |

One render per firm per run, hard. No retry loop, because the failure modes
above are nearly all permanent within a run and a retry would double the spend
to change almost nothing.

### Schema validation

There is **no registry validation today**, which the step 2 review recorded
rather than claimed. `registry-schema.test.mjs` would assert, against the
committed file so it runs in CI without network:

- every row has `firm` and `ats`, and `ats` is one of the eleven adapters
- a `workday` row has `host`, or `tenant` **and** `shard`, and a `site`
- a `greenhouse`, `ashby` or `lever` row has a `token`
- `tier` is a value `TIER_ORDER` knows, so a new firm cannot silently render an
  unordered section heading on the board
- no duplicate firm, case-insensitively
- where `discoveredAt` is present, it parses as a date and `discoveredVia` is an
  absolute URL
- `parked: true` rows carry a `parkedReason`

That last set is why the evidence fields are worth having: today they are inert
and unchecked, and a test makes them a contract.

### Expected one-off usage

| | Renders |
|---|---|
| Baseline today, unchanged | ~3/day, forever, from `career-pages.json` |
| The nine JS-rendered UK firms | **9, once** |
| The seventeen JS-rendered firms from step 2 | **17, once** |
| Steady state after promotion | **0** — a proven board is polled directly and never rendered again |

Fewer than 30 one-off renders against a standing 3/day. The fallback pays for
itself in under two weeks even if it resolves nothing, because it is the
mechanism that lets a rendered discovery become a direct collection instead of
a page rendered daily in perpetuity.

## Per-firm routing

| Firm | Route | Note |
|---|---|---|
| Compass Lexecon | **Direct, now** | Proven. Add to the registry |
| Bain, EY-Parthenon, KPMG, L.E.K. | Rendered discovery | JS-rendered, no block observed |
| Arthur D. Little, Newton Europe, PA Consulting | Rendered discovery | Same |
| Oxera, NERA | Rendered discovery | UK economic consulting, both run graduate schemes |
| Deloitte, Roland Berger, Simon-Kucher, OC&C, Capgemini Invent, Frontier Economics | Re-seed, then rendered discovery | The probed URL 404'd; the seed needs a current careers URL before anything else is concluded |
| McKinsey, Strategy&, Kearney, Oliver Wyman | **Curated** | Blocked at the edge. Rendering does not defeat a 403 |
| BCG | Curated, or a phenom adapter | phenom also blocks Oliver Wyman, so an adapter has a second customer |
| Accenture Strategy | Already collected | Accenture's board is polled; the practice split is a `division` question for step 6 |

## What would actually clear the gate

Gate 4 needs **10 UK rows**. On the evidence:

- Compass Lexecon contributes European economics rows now, London in season.
- The nine rendered-discovery firms include Bain, KPMG, PA Consulting and
  Newton, all of which run UK graduate schemes of real size. If even three
  resolve, ten UK rows is a low bar.
- Curated MBB adds the firms candidates search for most, and is bounded by the
  remediation work rather than by collection.

**The honest order:** re-seed the six wrong URLs, ship the rendered fallback,
run discovery once, count. Only then decide whether curation is filling a gap
or doing the whole job.

## Not proposed

Scraping a firm that blocks scrapers. A phenom or icims adapter as part of this
work. Curated rows before the validator exists. Any change to the region
taxonomy, which still has no Canada and is step 6's to resolve.
