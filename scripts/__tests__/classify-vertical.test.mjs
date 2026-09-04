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

// --- AI, split out of the single 'Data & ML' bucket -----------------------
// Three careers were sharing one vertical. These fix the boundary between them,
// and the finance cases below fix the boundary that the research rule could
// most easily have broken.
vert('Research Engineer Intern (Fall 2026)', 'AI Research');
vert('PhD GenAI Research Scientist Intern', 'AI Research');
vert('Applied Scientist Intern', 'AI Research');
vert('ML Research Intern', 'AI Research');
vert('Graduate Machine Learning Researcher - London', 'AI Research');
vert('AI Residency Program', 'AI Engineering');

vert('Machine Learning Engineer, New Grad', 'AI Engineering');
vert('Software Engineer, Early Career (AI)', 'AI Engineering');
vert('NVIDIA 2027 Internships: Deep Learning', 'AI Engineering');
vert('LLM Infrastructure Intern', 'AI Engineering');
vert('Computer Vision Intern 2027', 'AI Engineering');

// A title that calls itself data work stays data work, even with an AI token
// in it. The alternative empties the data vertical for no gain.
vert('Data Science Intern (Winter 2027)', 'Data & ML');
vert('Campus Data Engineer (Intern)', 'Data & ML');
vert('Data Analytics Intern, Winter 2027', 'Data & ML');
vert('Data Scientist, Machine Learning (New Grad)', 'Data & ML');

// The regressions the research rule could most easily cause. "Research" means
// something entirely different in finance, and a wider rule would have moved
// every equity research and hedge fund role into AI overnight.
vert('Equity Research Summer Analyst', 'Equity Research');
vert('Research Analyst, Healthcare', 'Equity Research');
vert('Quantitative Research Analyst', 'Quant');
// Sell-side equity research, not a hedge fund seat. Goldman's equity research
// division is called Global Investment Research and asset managers use the name
// for the same function, so the title belongs here rather than in Other, where
// it used to land.
vert('Investment Research Intern', 'Equity Research');
vert('Global Investment Research Summer Analyst', 'Equity Research');
// Buy-side research keeps its own homes, so widening the rule has not swallowed
// the funds.
vert('Hedge Fund Investment Analyst', 'Hedge Fund');
// The remaining gap, asserted so it stays visible: a bare "Investment Analyst"
// is genuinely ambiguous across funds, corporates and asset managers, so it is
// left in Other rather than guessed into one of them.
vert('Investment Analyst Intern', 'Other');
vert('Quantitative Research Analyst', 'Quant');

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
// Moved from 'Data & ML' when AI was split out: this is an engineer, not a
// data role, and it now routes to the AI engineering preparation.
vert('Machine Learning Engineer Intern', 'AI Engineering');

// --- overloaded words resolve to the specific reading --------------------
// Each of these is only correct because of rule ORDER. They are the cases that
// break first if the branches in inferVertical are ever reshuffled.
vert('Technology Investment Banking Summer Analyst', 'Investment Banking');
vert('Quantitative Risk Graduate Programme', 'Quant');
vert('Markets Operations Summer Analyst', 'Sales & Trading');

// --- rules added after reading the first live 'Other' bucket -------------
// 31% of roles fell back on the first run. These are the titles that caused it,
// taken verbatim from that report — the fallback count exists to produce
// exactly this list.
vert('Banking Summer Internship Programme 2027 London', 'Investment Banking');
vert('Banking Analyst Graduate Program 2027 San Francisco', 'Investment Banking');
vert('Off-Cycle Intern - Capital Solutions, Debt Advisory', 'Investment Banking');
vert('Off-Cycle Intern, Financial and Valuation Advisory', 'Investment Banking');
vert('Banking - Corporate Banking, Summer Analyst, Singapore', 'Corporate Banking');
vert('Banking - Commercial Banking - Natural Resources, Summer Analyst', 'Corporate Banking');
vert('ASIC Physical Design Intern - 2027', 'Software Engineering');
vert('NVIDIA 2027 Internships: Hardware Verification', 'Software Engineering');
vert('System Design Validation Intern - 2027', 'Software Engineering');
vert('Account Development Representative Intern - Atlanta', 'FinTech Sales');
// Also moved: applied research on NLP is research, and reading it as a data
// role was the conflation this split exists to end.
vert('Applied Research Intern, NLP - Fall 2026', 'AI Research');
// Still correctly Other: no function is named at all.
vert('Internship, Kuala Lumpur, Malaysia - APAC, 2026', 'Other');
vert('Internship Program, Americas, 2027 - Mexico City', 'Other');

// 'Private Banking' is wealth management, not a deal team. This broke the
// moment the generic 'banking' rule landed, which is the whole argument for
// pinning order with tests.
vert('Private Banking Summer Analyst', 'Wealth Management');
vert('Corporate Banking Graduate Programme', 'Corporate Banking');

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

// 'Summer Associate' is the standard title for MBA-level banking and private
// equity internships. EARLY_CAREER knew 'summer analyst' and not this, so those
// roles were rejected before classification ever saw them — found by the prep
// wiring test below returning undefined for a role that should have matched.
eq(
  'a Summer Associate role is early-career',
  toOpportunity({ id: 'sa', title: 'Private Equity Summer Associate', location: 'NY', url: 'u' }, firm)?.vertical,
  'Private Equity'
);

// --- every collected role should reach a prep page where one exists --------
// prepSlugFor was three tech branches, so 24 investment banking rows and 12
// sales & trading rows pointed nowhere while their prep pages sat written and
// unlinked. These assert the wiring, not the pages.
const prep = (title, want) => {
  const o = toOpportunity({ id: 'p', title, location: 'London', url: 'u' }, firm);
  eq(`prep: ${title.slice(0, 44).padEnd(46)} → ${want ?? 'none'}`, o?.recommendedPrepSlug, want);
};
prep('Investment Banking Summer Analyst', 'investment-banking-interview-prep');
prep('Sales and Trading Summer Analyst', 'sales-and-trading-interview-prep');
prep('Equity Research Summer Analyst', 'equity-research-interview-prep');
prep('Venture Capital Summer Analyst', 'venture-capital-interview-prep');
prep('Private Equity Summer Associate', 'private-equity-interview-prep');
prep('Software Engineer Intern', 'software-engineering-interview-prep');
// No track written yet: undefined is correct, and is what docs/content-gaps.md
// tracks. It must stay undefined rather than silently borrow an unrelated page.
prep('Quantitative Researcher Intern', undefined);
prep('Wealth Management Internship', undefined);
prep('Summer Analyst Programme 2027', undefined);

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
