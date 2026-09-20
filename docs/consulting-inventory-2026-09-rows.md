# Consulting inventory: the rows behind the counts

_19 September 2026. The reviewable artefact for `docs/consulting-inventory-2026-09.md`._

Every consulting-relevant row from the step 3 collection, so the counts can be
checked rather than taken on trust. Reproduce with the method in the report.

## Accepted: the 47 qualified rows

| # | Firm | Country | Title | Closing date |
|---|---|---|---|---|
| 1 | Huron Consulting Group | US | Consulting Intern - Summer 2027, Chicago (Spring 2028 Graduates) | 2026-09-25 |
| 2 | Huron Consulting Group | CA | Digital Consulting Intern Summer 2027, Montreal (Spring 2028 Graduates) | — |
| 3 | Huron Consulting Group | CA | Digital Consulting Intern Summer 2027, Toronto (Spring 2028 Graduates) | — |
| 4 | Huron Consulting Group | US | Consulting Analyst - Q3/Q4 2027 Start Dates (Spring 2027 Graduates) | 2026-09-25 |
| 5 | Huron Consulting Group | CA | Consulting Analyst, Digital (Toronto) Start Dates Q3/Q4 2027 (Spring 2027 Graduates) | — |
| 6 | Huron Consulting Group | CA | Consulting Analyst, Digital (Montreal Bilingual French and English) - Start Dates Q3/Q4 2027 (Spring 2027 Graduates) | — |
| 7 | Huron Consulting Group | US | Turnaround and Restructuring Analyst 2027 Graduates (Q3/Q4 2027 Start Dates; Chicago or NY) | — |
| 8 | Accenture | IT | Digital transformation intern | — |
| 9 | Accenture | IT | Business Analyst - Intern | — |
| 10 | Accenture | IT | Talent Transformation Analyst - Intern | — |
| 11 | Accenture | IT | Finance Transformation Analyst - Intern | — |
| 12 | Accenture | BE | Internship - Management Consulting Intern -Song Services - As of February 2027 | — |
| 13 | Accenture | CZ | Technology Consulting Internship | — |
| 14 | Accenture | IT | Cloud Transformation Internship | — |
| 15 | Accenture | NL | Internship – Products Strategy & Consulting | — |
| 16 | Accenture | NL | Finance Transformation - Working Internship | — |
| 17 | Accenture | IT | Maritime Business Analyst Internship | — |
| 18 | Accenture | IT | Technology Strategy & Advisory - Internship | — |
| 19 | Accenture | IT | Intellera Public Service Local - Digital Transformation Intern | — |
| 20 | Accenture | NL | Thesis Internship Management Consulting - Song | — |
| 21 | Accenture | CZ | Consulting Internship (Prague, Czech Republic) | — |
| 22 | Accenture | NL | Strategy & Consulting - Talent & Organization Thesis Internship | — |
| 23 | Accenture | ID | Accenture Indonesia Internship Program – Technology & Consulting | 2027-08-31 |
| 24 | Accenture | NL | Technology Strategy and Transformation (TS&T) Thesis Internship | — |
| 25 | Accenture | PL | Growth Strategy Internship Program (She/He/They) | — |
| 26 | Accenture | NL | Portfolio Management Working Internship — Technology, Strategy and Transformation | — |
| 27 | Accenture | LU | Internship – Technology Strategy & Transformation Luxembourg – as of February 2027 | — |
| 28 | Accenture | NL | Thesis Internship Utilities - Strategy & Consulting - Marktgebaseerde vs. gereguleerde ontsluiting van flexibiliteit in het elektriciteitsnet | — |
| 29 | Accenture | NL | Thesis Internship Utilities - Strategy & Consulting – Balanceren van warmte en elektriciteit: de rol van hybride warmtesystemen bij het verminderen van netcongestie | — |
| 30 | Accenture | MY | Strategy & Consulting - Fresh Graduates | — |
| 31 | Accenture | PH | Management Consulting (Master's Graduate Consulting Program) | 2027-08-31 |
| 32 | Accenture | US | Entry Level Advisory Summer Analyst - Various Locations - NAELFY27 | 2026-10-16 |
| 33 | Guidehouse | US | Consultant - Health and Human Services, Federal Health Advisory - Campus 2027 | — |
| 34 | Guidehouse | US | Consultant – State and Local Government  - Campus 2027 | 2026-10-16 |
| 35 | Guidehouse | US | Consultant - Energy Providers - Campus 2027 | 2026-10-15 |
| 36 | Guidehouse | US | Consultant - Life Sciences Advisory, Health Segment - Campus 2027 | — |
| 37 | Guidehouse | US | Consultant – State and Local Government Columbia, SC market – Campus 2026 | — |
| 38 | Guidehouse | US | Consulting Analyst - State & Local Government - Campus 2027 | 2026-10-16 |
| 39 | Guidehouse | US | Consulting Analyst - Energy Providers - Campus 2027 | 2026-10-15 |
| 40 | Trinity Life Sciences | US | Commercial Strategy Summer Associate (SF) | — |
| 41 | Trinity Life Sciences | US | VAP Summer Associate (NY) | — |
| 42 | Trinity Life Sciences | US | Insights Summer Associate (New York, NY) | — |
| 43 | Trinity Life Sciences | US | Insights Summer Associate (Waltham, MA) | — |
| 44 | Trinity Life Sciences | US | Commercial Strategy Summer Associate (NY) | — |
| 45 | Trinity Life Sciences | US | Commercial Strategy Summer Associate (Waltham) | — |
| 46 | Trinity Life Sciences | US | VAP Summer Associate (Waltham) | — |
| 47 | Trinity Life Sciences | US | VAP Summer Associate (SF) | — |

## Rejected on hand review: 4 rows

| Firm | Country | Title | Rejected because |
|---|---|---|---|
| Huron Consulting Group | US | Workday Student Financials - Consulting Manager | Experienced hire. Seniority leak: `manager` is absent from the SENIOR guard, and `Student` matched from the product name *Workday Student Financials* |
| Accenture | SG | Accenture Summer Internship Program - Consulting (Aug to Dec2024) | Stale: advertises an Aug–Dec 2024 window and is still live, on a reposted requisition |
| Accenture | SK | Junior Business Analyst (part-time for students) | Bratislava shared-services centre. Not client-facing consulting |
| Accenture | DK | Join Halfspace’s Strategy & Execution Team: Associate Engagement Manager (Part-Time, Student Position) | Experienced hire. Same missing `manager` guard |
