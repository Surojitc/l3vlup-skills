# Skill evolution ledgers

Every skill carries an `EVOLUTION.md` beside its `SKILL.md`. It records what the
skill did, what changed, and why — as prose, not as a bullet fragment.

The convention is borrowed from
[wildcat-finance/skills](https://github.com/wildcat-finance/skills/tree/main/plugins/hexaemeron),
minus the cryptographic machinery. Their ledgers are worth reading for one habit in
particular: the change column explains the *reasoning*, including what was considered
and rejected. A line saying "added a country picker" is worth almost nothing six
months later. A line saying "added a country picker, taking the mature-market base
plus the country piece rather than the published total, because the total already
includes the country premium and setting both would double-count it" is worth a great
deal, because it stops the next person undoing it.

## Format

```markdown
# <Skill> evolution ledger

- Current version: `<skill>-v0.2.0`
- Status: `draft` | `working` | `mature`
- Next: what the skill still cannot do

## History

| Version | Date | Evidence | Change |
| --- | --- | --- | --- |
| `v0.1.0` | 2026-08-24 | — | What it started as, and what it deliberately does not do. |
| `v0.2.0` | 2026-08-25 | live run vs AAPL | Prose. What changed, what it fixes, what was rejected and why. |
```

## Rules

- **Evidence, not assertion.** Link the run, the issue or the artefact that showed
  the change was needed. "Seemed better" is not evidence.
- **Write the rejected option down.** The alternative you did not take is the part
  nobody can reconstruct later.
- **One row per shipped change.** Not per commit.
- **Never rewrite history.** A wrong row gets a later row correcting it, so the
  mistake and its fix both stay visible.
