# Running the thesis pilot without an API key

The thesis pilot spends money, and until now it needed an `ANTHROPIC_API_KEY`
stored in this repository. This describes the replacement: the workflow proves
who it is to Anthropic using GitHub's OIDC identity token, and Anthropic hands
back an access token that lives thirty minutes and can do nothing but call
Claude in one workspace.

Nothing long-lived is stored here. There is no secret to leak, rotate, or
revoke, and a leaked credential is worth half an hour of inference rather than
unlimited spend until somebody notices.

## What has to be true before it works

Four things, in this order. The first three are entered in the Claude Console
by an organization owner or admin; the fourth is three repository variables.

You will need your Anthropic **organization ID**, which is in the Console under
**Settings → Organization**, and the **workspace** you want the spend billed to.

### 1. Service account

**Settings → Service accounts → Create service account**

| Field | Value |
|---|---|
| Name | `l3vlup-thesis-pilot` |
| Organization role | **Developer** |

Add it to the workspace whose billing and rate limits should apply. Note the
`svac_…` id.

Developer, not admin. The scope in step 3 already caps what a token can do, but
the effective permission is the intersection of the two, so a developer account
cannot be widened later by editing only the rule.

### 2. Federation issuer

**Settings → Workload identity → Connect workload → GitHub Actions**

| Field | Value |
|---|---|
| Name | `github-actions` |
| Issuer URL | `https://token.actions.githubusercontent.com` |
| JWKS | **Discovery** |

GitHub publishes its OIDC discovery document publicly, so Anthropic follows key
rotations on its own. Note the `fdis_…` id.

### 3. Federation rule

This is the whole security boundary. Everything it matches can spend money as
us, so it names one repository, one branch, one workflow file and one trigger.

| Field | Value |
|---|---|
| Name | `l3vlup-skills-thesis-pilot` |
| Issuer | the `fdis_…` from step 2 |
| Subject | `repo:Surojitc@68951812/l3vlup-skills@1344803946:ref:refs/heads/main` |
| Audience | `https://api.anthropic.com` |
| Target | the `svac_…` from step 1 |
| Workspace | the workspace from step 1 |
| OAuth scope | `workspace:inference` |
| Token lifetime | `1800` seconds |

And seven claim conditions:

| Claim | Required value |
|---|---|
| `repository` | `Surojitc/l3vlup-skills` |
| `repository_owner` | `Surojitc` |
| `repository_id` | `1344803946` |
| `repository_owner_id` | `68951812` |
| `ref` | `refs/heads/main` |
| `event_name` | `workflow_dispatch` |
| `workflow_ref` | `Surojitc/l3vlup-skills/.github/workflows/thesis-pilot.yml@refs/heads/main` |

The same rule through the Admin API:

```json
{
  "name": "l3vlup-skills-thesis-pilot",
  "issuer_id": "fdis_…",
  "match": {
    "subject_prefix": "repo:Surojitc@68951812/l3vlup-skills@1344803946:ref:refs/heads/main",
    "audience": "https://api.anthropic.com",
    "claims": {
      "repository": "Surojitc/l3vlup-skills",
      "repository_owner": "Surojitc",
      "repository_id": "1344803946",
      "repository_owner_id": "68951812",
      "ref": "refs/heads/main",
      "event_name": "workflow_dispatch",
      "workflow_ref": "Surojitc/l3vlup-skills/.github/workflows/thesis-pilot.yml@refs/heads/main"
    }
  },
  "target": { "type": "service_account", "service_account_id": "svac_…" },
  "workspace_id": "wrkspc_…",
  "oauth_scope": "workspace:inference",
  "token_lifetime_seconds": 1800
}
```

Note the `svac_…`, `fdrl_…` and `wrkspc_…` ids.

#### Why each line is there

**Read the subject off a real token, not off the documentation.** GitHub
publishes the default `sub` as `repo:<owner>/<repo>:ref:<ref>`. This issuer
does not produce that: it decorates both names with their numeric ids, and the
value above is what Anthropic recorded verbatim for run 35448297026. The rule
was first written from the published default and the exchange was refused with
`match_subject_prefix`. A `sub` is whatever the issuer puts in it; the
authentication history shows the decoded token, so check there rather than
assuming.

**The subject carries no trailing `*`.** Anthropic treats `subject_prefix` as an
exact match unless it ends in one. A wildcard such as
`repo:Surojitc@68951812/l3vlup-skills@1344803946:*` would also match
`repo:…:pull_request`, and a pull-request run's token is issued to whoever
opened the pull request, including from a fork. Anyone who could open a pull
request could then spend our inference budget. The exact form matches only a
run against `main`.

**The two numeric ids survive a rename.** `repository` and `repository_owner`
are names, and a name can be given up and taken by somebody else. The ids
cannot. Pinning both means a renamed-and-squatted `Surojitc/l3vlup-skills`
fails even though every name matches. They are also what the subject is built
from, so the two halves of the rule cannot drift apart.

**`workflow_ref` is the one restriction the subject cannot express.** The `sub`
claim names the repository and the ref, never the workflow file. Without this
condition, any workflow anywhere in this repository, on `main`, could mint a
token. Pinning it means a new workflow file cannot borrow this identity, and a
change to `thesis-pilot.yml` is the ordinary reviewed path onto `main`.

**`event_name` pins it to a manual dispatch.** A `push` to `main`, a schedule
added later, a `repository_dispatch` from outside: all carry a different
`event_name` and none of them match.

**`workspace:inference` is the smallest scope that works.** It covers the
Messages API and the Models API, which is everything the pipeline calls.
`workspace:developer` would additionally grant Files and Skills, which it never
touches.

**1800 seconds is deliberate, and longer than the doc's example.** The
extraction job has a twenty-minute timeout. If the access token expired inside
that window the SDK would refresh it by re-reading the identity token file and
exchanging it again, and GitHub's tokens carry a `jti`, which Anthropic accepts
exactly once. The second exchange is rejected as a replay. One exchange per
run is the only shape that works, so the token has to outlive the job.

### 4. Repository variables

**Settings → Secrets and variables → Actions → Variables → New repository variable**

| Name | Value |
|---|---|
| `ANTHROPIC_FEDERATION_RULE_ID` | the `fdrl_…` from step 3 |
| `ANTHROPIC_ORGANIZATION_ID` | your organization UUID |
| `ANTHROPIC_SERVICE_ACCOUNT_ID` | the `svac_…` from step 1 |

Variables, not secrets, and deliberately. These are resource identifiers, not
credentials: holding all three proves nothing, because a token is only minted
for a run whose claims satisfy the rule. Anthropic's own documentation calls
the file that holds them non-secret and safe to commit. Keeping them readable
means the trust boundary can be reviewed in a pull request.

Do not add `ANTHROPIC_WORKSPACE_ID` unless the rule is enabled for more than
one workspace. With a single-workspace rule, Anthropic selects it.

Do not set `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_PROFILE`
anywhere in this repository. Each of them outranks federation in the SDK's
credential order, and an empty string still wins its place, so the run would
authenticate as something other than this workflow. The workflow refuses to
start if it finds any of the three.

## Prove it works before spending anything

Once the four steps above are done, dispatch the workflow with
**`auth_check_only = true`** and `dry_run = false`. That runs one thing: the
identity token is fetched, exchanged, and used to read the pilot model from the
Models API, which is not an inference endpoint and is not billed.

It cannot do more. `scripts/thesis-auth-check.mjs` imports no fetcher and never
calls `messages.create`, and a test asserts both by reading the file. In the
workflow the mode is exclusive with extraction: no document is fetched, no
artefact is produced, and no pull request is opened.

A pass looks like this:

```
PASSED
  the identity token was exchanged and the token was accepted
  claude-haiku-4-5-20251001 (Claude Haiku 4.5), context 200000 tokens
```

`auth_check_only`, `dry_run` and `open_pull_request` are mutually exclusive;
setting two of them fails the run in its first step.

## What happens at run time

1. You dispatch the workflow by hand from `main`.
2. The extraction job, the only one holding `id-token: write`, asks GitHub for
   an identity token for the audience `https://api.anthropic.com` and writes it
   to the runner's private temp directory under `umask 077`.
3. The SDK reads the three variables and the token file, posts to
   `POST /v1/oauth/token`, and gets back an `sk-ant-oat01-…` access token that
   it holds in memory. It is never written down.
4. Extraction runs. Every existing ceiling applies unchanged: nine documents,
   twelve chunks each, eighteen calls, no retries, $3 budget, $15 hard stop.
5. The cleanup step deletes the identity token along with the documents and
   extracted text, on success, failure, timeout and cancellation alike.
6. The pull-request job runs with `contents: write` and no `id-token`. GitHub
   does not expose the token request endpoint to a job without that permission,
   so it cannot obtain an Anthropic credential. It never could read the old
   secret either; the difference is that now it is a capability it lacks rather
   than a rule it is trusted to follow. It downloads one artefact carrying one
   file, the feed it is about to commit. The review notes and the cost ledger
   go out as a separate artefact it has no path to.

## When the exchange is refused

A denied exchange returns an opaque `401` with the message `Authentication
failed`, whichever check failed, so that nobody can probe the rule. The reason
is recorded in the Console under **Settings → Workload identity → History**,
one row per attempt, naming the matcher that refused (`match_subject_prefix`,
`match_claims.workflow_ref`, `jti_reused`, and so on).

Start there. The workflow prints the run's `repository`, `ref`, `event_name`
and `workflow_ref` before the exchange, so the history row can be read straight
against the rule without decoding anything.

The likeliest first-run causes, in order: a `workflow_ref` typo, the rule
enabled for more than one workspace so the exchange needs an explicit
workspace, and a `@anthropic-ai/sdk` older than 0.93.0, which does not know how
to federate at all and fails without mentioning federation. The workflow checks
the last of these itself before fetching anything.

## What this does not protect against

Federation removes the stored key. It does not make the pipeline safe on its
own, and the trust chain is only as strong as the weakest link above it.

Anyone who can push to `main` can change `thesis-pilot.yml`, and a change to
that file on `main` is trusted by the rule. Branch protection on `main` is
therefore part of this boundary, not separate from it. Anyone with admin rights
on the repository can change the variables to point at a different rule, or add
an `ANTHROPIC_API_KEY` variable, though the workflow refuses to run when it
finds one.

And the rule lives in the Console, where it cannot be code-reviewed.
`lib/thesis-federation.mjs` writes it down as data and
`scripts/__tests__/thesis-federation.test.mjs` runs hostile claim sets against
it, which proves the policy we wrote down is tight. It cannot prove the Console
holds that policy. Check that once, by hand, against the history page after the
first dispatch.
