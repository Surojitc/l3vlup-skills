/**
 * Vertical classification, and the guarantee that classifying badly never
 * loses a role.
 *
 * WHY THIS EXISTS
 * inferVertical used to return null for anything outside a short list, and
 * toOpportunity dropped the role when it did. So every Markets, Sales & Trading,
 * Wealth Management, Asset Management, Risk, Compliance and Operations scheme a
 * bank publishes was discarded in silence — which is most of a bank's graduate
 * intake, and the reason a finance careers tracker showed 60 software
 * engineering roles against 10 in investment banking.
 *
 * The fallback is the load-bearing part. A missing rule should cost accuracy,
 * never inventory.
 */
import { inferVertical, toOpportunity } from '../sync-ats.mjs';

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`
  );
  ok ? pass++ : fail++;
};
const vert = (title, want) => eq(`${title.slice(0, 52).padEnd(54)} → ${want}`, inferVertical(title), want);

// --- the bank divisions that were being discarded entirely ----------------
vert('Markets Graduate Programme 2027', 'Sales & Trading');
vert('Sales and Trading Summer Analyst', 'Sales & Trading');
vert('Global Markets Analyst', 'Sales & Trading');
vert('Wealth Management Internship', 'Wealth Management');
vert('Asset Management Graduate Programme', 'Asset Management');
vert('Private Banking Analyst', 'Wealth Management');
vert('Credit Risk Analyst', 'Risk');
vert('Operations Summer Analyst', 'Operations');
vert('Compliance Graduate Programme', 'Compliance & Legal');
vert('Finance Analyst', 'Finance & Accounting');
vert('Technology Analyst', 'Software Engineering');

// --- the fallback ---------------------------------------------------------
vert('Summer Analyst Programme 2027', 'Other');
vert('Early Careers Opportunity', 'Other');

// --- buy-side ------------------------------------------------------------
vert('Private Credit Analyst', 'Private Credit');
vert('Venture Capital Summer Analyst', 'Venture Capital');
vert('Private Equity Summer Associate', 'Private Equity');

// --- must not regress: real titles from a live run -----------------------
vert('Banking - Investment Banking, Summer Analyst, Hong Kong', 'Investment Banking');
vert('Markets - Quantitative Analysis, Summer Analyst - New York', 'Quant');
vert('Functions - Quantitative Risk Management, Summer Analyst', 'Quant');
vert('Research Analyst Summer Internship Programme 2027', 'Equity Research');
vert('Intern - M&A/Financial Restructuring - Sao Paulo', 'Investment Banking');
vert('2027 Technology Developer Summer Internship Programme', 'Software Engineering');
vert('Machine Learning Engineer Intern', 'Data & ML');

// --- overloaded words resolve to the specific reading --------------------
// Each of these is only correct because of rule ORDER. They are the cases that
// break first if the branches in inferVertical are ever reshuffled.
vert('Technology Investment Banking Summer Analyst', 'Investment Banking');
vert('Quantitative Risk Graduate Programme', 'Quant');
vert('Markets Operations Summer Analyst', 'Sales & Trading');

// --- the regression that matters: no role is ever dropped ----------------
const firm = { ats: 'workday', tenant: 'firm', tier: 'Tracked', firm: 'Test Bank' };
const unclassifiable = toOpportunity(
  { id: '1', title: 'Summer Analyst Programme 2027', location: 'London', url: 'https://x/1' },
  firm
);
eq('an unrecognised vertical does not return null', unclassifiable !== null, true);
eq('...and is labelled Other', unclassifiable?.vertical, 'Other');
eq('...keeping the title for reclassification', unclassifiable?.role, 'Summer Analyst Programme 2027');
eq('...and the application URL', unclassifiable?.applicationUrl, 'https://x/1');

// The early-career filter is the only thing that may still reject a role, and
// it must keep doing so — the fallback is for unknown FIELDS, not for seniority.
eq(
  'a senior role is still rejected',
  toOpportunity({ id: '2', title: 'Senior Trading Analyst', location: 'NY', url: 'u' }, firm),
  null
);
eq(
  'a non-early-career role is still rejected',
  toOpportunity({ id: '3', title: 'Managing Director, Markets', location: 'NY', url: 'u' }, firm),
  null
);

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
