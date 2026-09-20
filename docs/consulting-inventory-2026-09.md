# Consulting launch inventory, counted

_19 September 2026. Step 3 of the consulting plan. Analysis only: no classifier,
no taxonomy, no user-facing change._

Detailed records were pulled from the five boards proved in step 2, through the
Workday detail endpoint so that geography comes from the structured location
rather than from `locationsText`. The production `isEarlyCareer` filter was used
unchanged.

## Headline

| | |
|---|---|
| **Raw records collected** | **128** |
| Consulting-relevant | 51 |
| After de-duplication | 51 (0 exact duplicates) |
| **Qualified after hand review** | **47** |
| Precision on review | **92%** |
| **Launch gates passed** | **5 of 8** |

The gate that fails on evidence is geography. **There are zero UK rows.**

## The definition used

Stated rather than inferred, and applied to every row.

**Qualifies:** a client-facing advisory, strategy or consulting-practice role at
a consulting firm, including technology consulting where consulting is the
recruiting pathway.

**Does not qualify:** build-and-run engineering, internal corporate functions,
service-delivery and BPO operations, design and marketing, and generic
programmes naming no practice.

## The seven cuts

### By employer

| Employer | Raw | Qualified |
|---|---|---|
| Accenture | 103 | 25 |
| Guidehouse | 9 | 7 |
| Huron Consulting Group | 8 | 7 |
| Trinity Life Sciences | 8 | 8 |
| Cornerstone Research | 0 | 0 |

**Accenture loses 76% of its rows to the quality filter.** Its board is a global
delivery organisation, not a consulting practice, and the raw 96 from step 2 was
exactly the overstatement this step existed to catch.

### By country and region

| Region | Qualified |
|---|---|
| Europe | 21 |
| **US** | **19** |
| Canada | 4 |
| Asia | 3 |
| **UK** | **0** |

Raw and qualified by country, every country that appeared:

| Country | Raw | Qualified | Country | Raw | Qualified |
|---|---|---|---|---|---|
| US | 24 | **19** | Singapore | 9 | 0 |
| Italy | 15 | **8** | Portugal | 7 | 0 |
| Netherlands | 12 | **8** | Norway | 5 | 0 |
| Canada | 4 | **4** | Slovakia | 4 | 0 |
| Czechia | 2 | **2** | Thailand | 3 | 0 |
| Poland | 21 | **1** | Mauritius | 2 | 0 |
| Malaysia | 6 | **1** | Greece | 1 | 0 |
| Belgium | 4 | **1** | Switzerland | 1 | 0 |
| Indonesia | 2 | **1** | India | 1 | 0 |
| Luxembourg | 1 | **1** | Hungary | 1 | 0 |
| Philippines | 1 | **1** | Australia | 1 | 0 |
| | | | Denmark | 1 | 0 |

Poland is the clearest illustration of the gap between raw and qualified: **21
raw rows, 1 qualified.** Accenture's Warsaw, Łódź and Katowice postings are a
technology delivery centre, not a consulting practice.

### By programme and role type

| Type | Qualified |
|---|---|
| Internship | 20 |
| Graduate / campus | 13 |
| Other | 9 |
| **Thesis placement** | **5** |

The five thesis placements are Dutch master's-thesis internships. They are real
early-career opportunities and they are not what a candidate browsing an
internship board expects, so they want their own programme type rather than
being filed as internships.

### Consulting relevance, and what was excluded

Of the 128 raw rows, 41 were excluded on relevance and 36 were ambiguous.

The complete taxonomy, with every reason a row can leave the qualified set:

| Reason | Rows | Definition | Example |
|---|---|---|---|
| **Engineering** | 25 | Build-and-run software, infrastructure or platform work | `Java Developer Internship Program`, `Linux Administrator Internship`, `AI/MLOps Internship` |
| **Internal corporate** | 7 | A function serving the firm itself rather than a client | `Student Receptionist`, `Workplace Support Intern`, `Human Resources Talent Accelerator` |
| **Design and marketing** | 5 | Creative and demand-generation work | `Industrial Design Internship`, `Digital Marketing (SEO / Web Analytics)` |
| **Operations and BPO** | 4 | Service delivery and transaction processing | `Customer Service - Korean speaking`, `Trust & Safety New Associate`, `Insurance Operations Associate` |
| **Ambiguous: no practice named** | 36 | A real programme that does not say what the work is | `Accenture Internship Program - May to Aug 2027`, `Postgraduate Internship Program` |
| **Seniority** | 2 | Cleared `isEarlyCareer` but is an experienced hire | `Consulting Manager`, `Associate Engagement Manager` |
| **Not client-facing** | 1 | Consulting-sounding title inside a delivery centre | `Junior Business Analyst (part-time for students)` |
| **Stale** | 1 | Advertises a window that has passed | `Summer Internship Program - Consulting (Aug to Dec2024)` |

The first five are applied before the hand review and account for the 128 → 51
reduction. The last three were found **by** the hand review and account for
51 → 47.

The 36 ambiguous rows are held out rather than guessed into the qualified
count. Several are probably consulting; none says so.

### Seniority

Two rows cleared `isEarlyCareer` and should not have:

- `Workday Student Financials - Consulting Manager` (Huron)
- `Join Halfspace's Strategy & Execution Team: Associate Engagement Manager` (Accenture)

**Root cause, and it is general rather than consulting-specific.** The `SENIOR`
guard is `senior|staff|principal|director|distinguished|vp|head of|lead`. It does
not contain **manager**. The Huron row compounds it: "Student" appears in the
product name *Workday Student Financials*, which is what matched the
early-career pattern in the first place.

Adding `manager` naively would break genuine graduate titles, "Associate Product
Manager" among them, so this is a step 4 fixture problem rather than a one-word
edit.

### Duplicates

**0%.** De-duplication is on firm plus title plus location, because a city
variant is a separate opportunity. An earlier pass that collapsed on title alone
merged Trinity's three cities into one and understated the inventory by five
rows; that was wrong and is not how the figure above is computed.

### Dates

| | |
|---|---|
| Qualified rows with an opening date | 47 of 47 |
| Qualified rows with a closing date | **9 of 47 (19%)** |
| Rows opened before March 2026 | 0 |

The missing closing dates are normal rather than a consulting problem: the ATS
feeds publish almost none, which is why `deriveStatus` treats `Listed` as
applyable. One stale row was caught by title instead: an Accenture posting
reading "Aug to Dec2024", still live, with a recent opening date because the
requisition was reposted.

### Concentration

**Accenture is 25 of 47 qualified rows, or 53%.** Under the 60% ceiling, and
still more than the other three combined.

## Hand review

All 51 consulting-relevant rows were read individually, which is more than the
30 required, and covers all four contributing employers with positive, negative
and ambiguous examples. Four were rejected:

**Every accepted and rejected row is listed in
`docs/consulting-inventory-2026-09-rows.md`**, so the counts above can be
checked rather than taken on trust.

The four rejections:

| Row | Why |
|---|---|
| Huron, `Workday Student Financials - Consulting Manager` | Experienced hire; seniority leak |
| Accenture, `Associate Engagement Manager (Copenhagen)` | Experienced hire; seniority leak |
| Accenture, `Junior Business Analyst (part-time for students)` | Bratislava shared-services centre, not client-facing |
| Accenture, `Summer Internship Program - Consulting (Aug to Dec2024)` | Stale: advertises a 2024 window |

**Precision: 47 of 51, or 92%.**

**This is precision on the 51-row consulting-relevant set, not on the 128 raw
records.** It answers "of the rows we would put in front of a candidate as
consulting, how many genuinely are" — which is the number that matters for gate
5. It is not a measure of how well anything separates consulting from the other
77 raw rows; that is the classifier's job and is measured in step 4.

Two of the four failures are seniority rather than relevance. On relevance
alone, precision is 96%.

Judgement calls worth recording, all resolved as qualifying: Accenture's
"Business Analyst" is its consulting entry title; "Talent Transformation" and
"Finance Transformation" are named consulting practices; Intellera is
Accenture's Italian public-sector consulting arm; Trinity's "VAP" is Value,
Access and Pricing.

## The eight gates

| # | Gate | Result | |
|---|---|---|---|
| 1 | ≥40 qualified rows | 47 | **PASS** |
| 2 | ≥4 contributing employers | 4 | **PASS** |
| 3 | No employer above 60% | Accenture 53% | **PASS** |
| 4 | ≥10 UK **and** ≥10 US | UK 0, US 19 | **FAIL** |
| 5 | ≥90% precision on review | 92% | **PASS** |
| 6 | ≤5% duplicates | 0% | **PASS** |
| 7 | Curated rows pass validation | step 6 not started | pending |
| 8 | Classifier fixtures green | step 4 not written | pending |

Gates 7 and 8 are sequencing, not evidence: neither step has run. Gate 4 is the
only one the data refuses.

## Recommendation, and the decision taken

> **Decision, 20 September 2026: the US-scoped launch and the 15-row threshold
> were both declined.** The eight gates stand unchanged, the 15-row figure is
> recorded as an observation rather than an approved criterion, and the
> Consulting filter is not exposed publicly until UK coverage improves. The 47
> qualified rows and the 19-row US subset are preserved as the initial
> validated inventory, and the content and preparation pathway continue
> independently of the tracker.
>
> The reasoning, which is a standing rule and not a one-off call: revising a
> threshold from 40 to 15 after seeing a result that failed it makes the gate
> fit the data. L3VLUP has a meaningful UK audience, and a Consulting vertical
> opening with zero UK opportunities is a poor first impression that costs more
> than the delay.
>
> The recommendation below is left as written, because a decision record is
> more useful with the argument it declined still in it.

**Recommendation as submitted: launch the Consulting filter scoped to the United
States, and do not launch a global or UK filter yet.**

Criterion 4 was written to permit exactly this. The US slice is not merely
adequate, it is **better balanced than the global set**:

| US-scoped inventory | Rows |
|---|---|
| Trinity Life Sciences | 8 |
| Guidehouse | 7 |
| Huron Consulting Group | 3 |
| Accenture | 1 |
| **Total** | **19 rows, 4 employers, top employer 42%** |

Nineteen rows is below the forty in criterion 1, so **this is a proposed
revision to criterion 1 for a region-scoped launch**, made on documented
evidence as section 3 of the plan allows: a regional threshold of **15 qualified
rows from at least 3 employers with no employer above 60%** reads as a real
board rather than a thin one, and the US slice clears it.

The alternative is to hold the filter until the UK exists. On the evidence that
means waiting for firms the collector cannot currently reach: every UK-strong
consultancy in the seed either blocks scrapers or runs an unsupported ATS.

**What should not happen:** launching globally to reach 47. Twenty-one European
rows spread across ten countries, including five Dutch thesis placements, is not
a browsing experience, and it would put Accenture's delivery-centre postings in
front of candidates looking for strategy work.

## What this changes for later steps

- **Step 4.** `SENIOR` needs `manager` handled without breaking graduate titles.
  The four rejected rows become negative fixtures; the three Intellera, VAP and
  Talent Transformation calls become positive ones; the 36 generic programmes
  become the ambiguous set that must resolve to `Other`.
- **Step 6.** Canada has 4 qualified rows and no home in the `Region` union.
  Hold them as Canada or unclassified; do not fold them into US or Europe.
- **Step 7.** A thesis placement is its own programme type.
- **Cornerstone Research** contributes nothing and its board holds six postings
  in total. Worth `parked: true` rather than polling daily.
