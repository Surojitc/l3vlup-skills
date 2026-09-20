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

Step 3 counted 47 qualified rows by hand. This counts 46 current and
qualifying. The single difference is the Huron restructuring row, which the
hand review counted as consulting and the classifier sends to Investment
Banking by rule. That is a deliberate disagreement with the hand review and the
rule is the one that was asked for.

## How to reproduce

Both scorecards are computed from the 128 records in the step 3 collection,
using `inferVertical` and `isEarlyCareer` exactly as this branch defines them.
The collection method is in `docs/consulting-inventory-2026-09.md`, and the
row-level list is in `docs/consulting-inventory-2026-09-rows.md`.
