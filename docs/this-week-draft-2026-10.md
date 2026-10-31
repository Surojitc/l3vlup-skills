# The Thursday draft of This Week (October 2026)

`.github/workflows/this-week-draft.yml`, `scripts/this-week-draft.mjs`,
`lib/this-week-draft.mjs`, `scripts/__tests__/this-week-draft.test.mjs`.

The site's editorial page (`/this-week` on l3vlup.com) publishes one edition a
week, written and approved by a person. This repository now prepares the
draft that person starts from, every Thursday at 06:30 UTC, and publishes it
as one data file, `data/this-week.draft.json`, which the site shows to an
operator at `/this-week/draft`. Nothing else changes: the record of editions
stays in the site's `data/this-week.manual.json`, and an edition reaches
readers only when a person has read every figure at its source and changed
its status to approved.

## What a run does

| Stage | Job | Power | What it does |
|---|---|---|---|
| shortlist | prepare | none | Reads the committed `newsflow.auto.json` and `deals.auto.json` (fresh from the morning's collection), removes duplicates (same link, same normalised title, or the same story in other words within two days: most title words shared, or two shared company names and some words), and picks three headline candidates, three deal candidates and up to eight market moves by the site's own rule: most recent, largest disclosed value, most recent from another area, then one per area |
| fetch | prepare | none | Reads each candidate page once, one request a second, 15 s timeout, keeping the title, description and the first 3,200 characters of text; reads the site's sitemap for the pages an edition may link (guides, models, careers, comparisons, intel hubs, labs; never a tracker role) |
| draft | draft | `id-token: write`, no `contents` | One model call. The model receives the shortlist, the source texts by index and the allowed paths by index, and answers through one strict tool whose every URL field is an index into those lists, so it cannot cite a page it was not given. Budget stated by the caller (0.25, 0.50 or 1 dollar; the hard stop is 1), estimated before the call and refused if over; the actual spend recorded from the response's usage. A refusal, a truncation, two tool calls or an authentication failure is recorded by name |
| render | draft | none | Resolves the answer into the site's edition shape, applies the site's validation rules (two to three summary sentences, no forecast verbs in fact lines, at most five moves, two to five distinct options, the prediction resolving after the week, https sources), lists every problem for the editor, and writes the file and a Markdown report (also the job summary) |
| publish | publish | `contents: write`, `pull-requests: write` | `publish-data.yml`, producer `this-week-draft`: a data pull request on `automation/this-week-draft`, merged |

A failed model stage still publishes: the file carries the shortlist, the
stage marked `failed` with its reason, no edition and no brief. The site shows
exactly that. An empty week is never silent.

## What it never does

Send a newsletter, post to a channel, change the site's record, approve
anything, or spend without a budget. The credential is a federated identity
token, never a stored key (`docs/thesis-oidc-federation.md`, "A second rule for
the weekly draft"); the draft job can write nothing and the publish job holds
no token for Anthropic.

## The cartoon brief

The model also briefs the week's Lev cartoon: a scene, a one-sentence deadpan
caption, and the verified fact of the headline the joke rests on. The brief
is for an illustrator or for Lev's drawing pipeline; it is not a picture. The
house style the brief must respect is the site's editorial illustration
language (white paper, black ink with a hand-drawn wobble, red and orange at
most once each, generous empty space, one idea played straight, no words
inside the picture, fair to everyone in the story), and the page labels the
cartoon as satire wherever it appears beside reported facts.

## Running it by hand

```bash
node scripts/this-week-draft.mjs shortlist --out /tmp/tw
node scripts/this-week-draft.mjs fetch --out /tmp/tw
node scripts/this-week-draft.mjs draft --out /tmp/tw --budget 0.50 --dry-run   # no model, no spend
node scripts/this-week-draft.mjs render --out /tmp/tw                           # data/this-week.draft.json and /tmp/tw/this-week-draft.md
```

Without `--dry-run` the draft stage needs a credential the SDK can resolve
(locally, `ANTHROPIC_API_KEY` in the shell; in Actions, federation). From the
Actions tab, **This Week draft → Run workflow** with `dry_run` on exercises
every stage but the model.

## Owner steps before the first real run

1. In the Claude Console, a second federation rule beside the thesis pilot's,
   named `l3vlup-skills-this-week-draft`, same issuer, target and workspace,
   with `workflow_ref` `Surojitc/l3vlup-skills/.github/workflows/this-week-draft.yml@refs/heads/main`
   and `event_name` `schedule`; and a third identical but for `event_name`
   `workflow_dispatch`, so a dry run by hand can also be a real run when
   asked. Record each `fdrl_…` id.
2. Repository variable `ANTHROPIC_FEDERATION_RULE_ID_THIS_WEEK` set to the
   schedule rule's id (the dispatch rule shares the same id if the Console
   allows two event names on one rule; otherwise set it to the schedule rule
   and accept that dispatched real runs are refused). `ANTHROPIC_ORGANIZATION_ID`
   and `ANTHROPIC_SERVICE_ACCOUNT_ID` already exist.
3. Run the workflow by hand with `dry_run` on. The data pull request carries a
   draft marked `skipped`; the site's `/this-week/draft` shows it.
4. Wait for the Thursday run, or dispatch with `dry_run` off and the budget
   at 0.50. Read the report in the job summary and the page.

## Cost

One call a week at a stated ceiling, normally about 20,000 input tokens and
up to 6,000 output tokens: about 7 cents on Sonnet 5, 3 cents on Haiku 4.5.
The hard stop in code is one dollar a run.
