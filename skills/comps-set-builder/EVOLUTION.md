# Comps Set Builder evolution ledger

Policy: [../../docs/skill-evolution.md](../../docs/skill-evolution.md)

- Current version: `comps-set-builder-v0.2.0`
- Status: `working`
- Next: automatic calendarisation of off-cycle filers to a common year end. The
  sheet currently detects the problem and refuses to be quiet about it, but the
  stub adjustment is still manual.

## History

| Version | Date | Evidence | Change |
| --- | --- | --- | --- |
| `v0.1.0` | 2026-08-24 | — | Trading comparables with fundamentals from each filer's XBRL tags, every multiple a live formula, median and mean over the set, and an Inclusion tab prompting for rationale, rejected names and adjustments. Share price and forward consensus are shaded input cells rather than fetched, because neither is filing data; an unsourced multiple is worse than an empty cell because it looks finished. EBITDA is built in the sheet from operating income plus D&A rather than pulled, since EBITDA is not a GAAP tag and anything claiming to be one is somebody's adjustment. |
| `v0.2.0` | 2026-08-24 | live run vs NVDA, AMD, AVGO, MRVL, INTC | The set spanned January, November and December year ends and the sheet said nothing about it, so the multiples silently compared different twelve-month windows. Fiscal year end and period covered are now rows on the face of the sheet, a calendarisation warning fires when the set spans more than one year end, and the Inclusion tab carries a prompted block for it. Auto-stubbing to a common year end was considered and deferred: it needs quarterly data the collector does not yet pull, and a silent adjustment would be worse than a visible warning. |
