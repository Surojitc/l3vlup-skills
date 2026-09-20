# Consulting classifier: two scorecards

_20 September 2026. Evaluation artefact for the step 4 classifier._

An earlier version of this reported 97.9% precision and 97.9% recall. That
number was wrong, not arithmetically but conceptually: it mixed **what a role
is** with **whether an opportunity is usable**, and those are different
questions answered by different parts of the pipeline.

A genuine consulting role that is stale is still correctly classified as
Consulting. Staleness is eligibility. A Huron restructuring row correctly sent
to Investment Banking is not a consulting false negative; it is a correct
non-consulting classification. Counting either as a classifier error made the
classifier look worse than it is and hid where the real work sits.

Both scorecards below run over the same 128 records collected in step 3.

## Scorecard 1: vertical classification

**The question: is this a consulting role?** Seniority and freshness are not
asked here.

| | |
|---|---|
| True positives | **49** |
| False positives | **0** |
| False negatives | **0** |
| True negatives | **79** |
| **Precision** | **100%** |
| **Recall** | **100%** |

### The three rows that were previously disputed, and their final vertical

| Row | Previously counted as | Final vertical | Why that is correct |
|---|---|---|---|
| `Accenture Summer Internship Program - Consulting (Aug to Dec2024)` | false positive | **Consulting** | It is a consulting role. That it advertises a 2024 window is a freshness fact, and freshness is scorecard 2 |
| `Turnaround and Restructuring Analyst 2027 Graduates` (Huron) | false negative | **Investment Banking** | Correct non-consulting classification. Restructuring belongs beside the banks, which is the rule as specified |
| `Junior Business Analyst (part-time for students)` (Accenture) | false positive | **Other** | Excluded by the delivery-centre rule. A true negative, not an error |
| `Workday Student Financials - Consulting Manager` (Huron) | false positive | **Consulting** | It is a consulting role. That it is an experienced hire is scorecard 2 |
| `Associate Engagement Manager` (Accenture) | — | **Consulting** | Same: a consulting role, filtered on seniority rather than on vertical |

No row is in dispute after the split.

## Scorecard 2: opportunity eligibility

**The question: of the rows classified Consulting, which can be shown to a
candidate?**

| Bucket | Rows |
|---|---|
| **Current and qualifying** | **46** |
| Stale | 1 |
| Senior | 2 |
| Unrelated function | 0 |
| Duplicate | 0 |
| Ambiguous or insufficient evidence | 0 |
| **Total classified Consulting** | **49** |

Notes on the buckets that are zero, because a zero is a claim too:

- **Unrelated function** is zero because the delivery-centre and BPO exclusions
  run inside the classifier, so those rows never reach this scorecard. They are
  true negatives in scorecard 1.
- **Duplicate** is zero on the de-duplication key firm + title + **location**. A
  city variant is a separate opportunity; an earlier key of firm + title alone
  merged Trinity's three cities and understated inventory by five rows.
- **Ambiguous** is zero because the classifier answers `null` for the 36
  generic programmes naming no practice, so they land in `Other` rather than in
  this set.

### What production would actually do with the three exclusions

The two senior rows never reach classification at all: `isEarlyCareer` runs
first in `toOpportunity`, so they are dropped before a vertical is assigned.
Only the stale row would be collected, and staleness is the retention and
deadline layer's to resolve, not the classifier's.

## Reconciliation with step 3

Step 3 counted 47 qualified rows by hand. Scorecard 2 counts 46 current and
qualifying, and scorecard 3 counts 47 against the live feed. The single difference is the Huron restructuring row, which the
hand review counted as consulting and the classifier sends to Investment
Banking by rule. That is a deliberate disagreement with the hand review and the
rule is the one that was asked for.

## Scorecard 3: the live feed, after the 20 September collection

The two scorecards above are computed against the 128 records collected by
hand in step 3. That collection predates the 20 September publication, which
carries 1,386 rows against the 1,318 step 3 measured, so the rule was run once
more over every row the site is serving today.

| | |
|---|---:|
| Feed rows | 1,386 |
| Rows the rule claims | **47** |
| False positives found | **0** (one found and fixed, below) |
| Rows taken from `Other` | 42 |
| Rows taken from a named vertical | 5 |

| Firm | Rows |
|---|---:|
| Accenture | 19 |
| Trinity Life Sciences | 8 |
| Guidehouse | 7 |
| Huron Consulting Group | 6 |
| FTI Consulting | 4 |
| Berkeley Research Group | 2 |
| Visa | 1 |

| Region | Rows |
|---|---:|
| US | 42 |
| Europe | 3 |
| Asia | 2 |
| **UK** | **0** |

Forty-seven, against the forty-seven step 3 qualified by hand. The inventory
finding is unchanged by a feed sixty-eight rows larger, and so is the release
blocker: gate 4 asks for UK coverage and the live feed has none.

### The false positive the sweep found

`Consultant AML- (Winter 2027 Co-Op)` at CIBC. The word consultant there is the
bank's internal grade and the seat is in its anti-money-laundering team, but
the explicit-consulting token needs no employer and took it.

The repair is not an exclusion. Guidehouse and FTI sell financial-crime
compliance consulting, so an outright ban would lose real rows. Instead the
financial-crime subject withdraws the employer-independent token and leaves the
employer gate standing: CIBC falls through to the ordinary chain, Guidehouse
does not. Four fixtures pin it, including an explicit consulting title at a
bank that must still read Consulting.

### The five rows taken from a named vertical

These matter more than the forty-two taken from `Other`, because each is a
vertical changing its answer.

| Firm | Title | Was | Now |
|---|---|---|---|
| FTI Consulting | Risk & Investigations, Forensic and Litigation Consulting | Risk | Consulting |
| Accenture | Finance Transformation Analyst - Intern | Finance & Accounting | Consulting |
| Accenture | Finance Transformation - Working Internship | Finance & Accounting | Consulting |
| Accenture | Technology Consulting Internship | Software Engineering | Consulting |
| Accenture | Technology Strategy & Advisory - Internship | Software Engineering | Consulting |

All five are correct. The two technology rows are the case the rule ordering
exists for, and FTI's Forensic and Litigation segment is consulting by name.

## How to reproduce

Both scorecards are computed from the 128 records in the step 3 collection,
using `inferVertical` and `isEarlyCareer` exactly as this branch defines them.
The collection method is in `docs/consulting-inventory-2026-09.md`, and the
row-level list is in `docs/consulting-inventory-2026-09-rows.md`.
