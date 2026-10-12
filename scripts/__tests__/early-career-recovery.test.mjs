/**
 * Early-career titles the collector used to refuse (A0), and the titles that
 * must stay refused while they are recovered.
 *
 *   node scripts/__tests__/early-career-recovery.test.mjs
 *
 * Every title here is real: read from the boards the collector reads, on 12
 * October 2026. The negatives matter as much as the positives. Each recovery
 * rule needs two signals (a level word and a seat, or a class year and a
 * campus word), and each negative below is a title that carries one of the
 * two and must not be promoted on it.
 */
import { isEarlyCareer, toExperiencedOpportunity } from '../sync-ats.mjs';

let pass = 0;
let fail = 0;
const check = (title, want, why) => {
  const got = isEarlyCareer(title);
  const ok = got === want;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${want ? 'early ' : 'refuse'}  ${title}${why ? `  (${why})` : ''}${ok ? '' : `\n        got ${got}`}`);
  ok ? pass++ : fail++;
};

// ── Spelling: US "Program", plural "Insights" and "Careers" ───────────────────
check('2027 Commercial Real Estate Full-Time Analyst Program', true, 'US spelling');
check('2027 Commercial & Investment Bank Global Payments Full Time Analyst Program', true);
check('2027 Spring Insights: Analyse & Trade at JPMorganChase – London', true, 'plural');
check('2027 Spring Insights: Engineer & Innovate at JPMorganChase – Glasgow', true);
check('C++ Software Engineer, Early Careers', true, 'plural');
check('Graduate Program - Markets', true, 'US spelling, strong token');
// The UK spellings keep working.
check('Graduate Analyst Programme', true);
check('Spring Week - Investment Banking', true);

// ── Stated level ──────────────────────────────────────────────────────────────
check('Software Engineer (Entry-Level) - C++', true);
check('Software Engineer (Entry-Level) - Python', true);
check('Investment Accounting Associate (Entry-Level)', true);

// ── Junior, in front of a quant or trading seat ───────────────────────────────
check('Junior Quant Researcher', true);
check('Junior Quantitative Researcher - Deep Learning (Time Series)', true);
check('Junior Quant Developer', true);
check('Junior Quantitative Developer & Strategist', true);
check('Junior Quantitative Trader - APAC Delta One', true);
check('Junior Discretionary Trader', true);
check('Junior Execution Trader - Equity', true);
check('Junior Quant - MBS', true);
// Junior on its own is not a seat.
check('Junior Executive Assistant', false, 'junior, not a desk seat');
check('Junior Desktop Support Analyst', false, 'junior IT support');
check('Junior Platform Specialist', false);
check('CPS Learning Admin Junior Specialist', false);
check('(Junior) Financial Expert voor de regio Leuven', false);
check('Junior Project Manager / Business Analyst', false, 'manager, no strong token');
check('AI Engineer (Junior/Senior)', false, 'senior wins');
check('Investment Banking - TMT Equity Capital Markets - Senior Vice President/Junior Executive Director', false);
check('Junior Risk Manager', false, 'a manager; left for a decision, not promoted here');

// ── A class year beside a campus word ─────────────────────────────────────────
check('Quantitative Portfolio Analyst – 2026 Grad', true);
check('2027 Trading Analyst', true);
check('2027 Business Development Analyst - US Wealth', true);
check('2027 Full-Time Analyst, Valuations & Opinions Group', true);
check('2027 Data & AI - Full Time Analyst - London, Glasgow', true);
check('Working in Technology (WiT) Software Engineering - Summer 2027', true);
check('Working in Technology (WiT) Data Science - Summer 2027', true);
check('2027 Software Engineer Program - Full-time - Dublin', true);
check('2027 Sydney Traineeship Program', true);
check('2027 Chase Digital Development Programme – Full-time Analyst (London)', true);
// A year alone is not a campus seat.
check('Connect with us at ICLR 2026!', false, 'event, year only');
check('ISCA 2026', false);
check('LON - 2026 - Office Assistant', false);
check('Fast Track to Investment Banking - Fall 2026 Event', false);
check('Prosperity 2026 - Role Interest Form', false);
check('2026 Women in Finance Workshop', false);
check('NEW26RL - Account Specialist I - December 11, 2026', false);
check('Private Client Banker - Knightsville - Summerville, SC', false, 'Summerville is not summer');
check('Senior Home Lending Advisor, Summerville, SC', false);
// A year and a campus word, for experienced people.
check('2027 Full-Time Associate (FDD/TAS Experience Required)', false, 'experience required');
check('Point72 Academy 2026 Investment Analyst Program for Experienced Professionals – Hong Kong', false, 'for experienced professionals');
check('Point72 Academy 2026-2027 Investment Analyst Program for Experienced Professionals - US', false);
check('Senior Analyst - 2026 Budget Cycle', false, 'senior wins');

// ── MBA: the summer associate is early career; the full-time hire is not ──────
check('2027 Asset & Wealth Management U.S. Private Bank MBA Summer Associate Program', true);
check('MBA, Investment Banking Summer Associate - Summer 2027', true);
check('2027 Investment Banking Full-Time MBA Associate', false, 'post-MBA hire stays experienced');
check('Private Equity Senior Associate (Post-MBA)', false);

// ── Unchanged: titles that were already early career stay so ──────────────────
for (const t of ['Investment Banking Summer Analyst Intern 2027', 'Software Engineer, New Grad', 'Associate Product Manager - New Grad', 'Quantitative Research Intern', 'Industrial Placement - Technology']) {
  check(t, true, 'unchanged');
}
// …and experienced titles stay refused.
for (const t of ['Software Engineer - Risk Technology', 'Quantitative Researcher - Systematic Credit', 'Investment Banking Associate - Technology', 'Cubist Portfolio Manager']) {
  check(t, false, 'experienced, unchanged');
}

// ── The two paths stay disjoint ───────────────────────────────────────────────
// A recovered title is never also an experienced row: the experienced path
// reads only what the early-career path refused.
{
  const firm = { firm: 'Squarepoint Capital', ats: 'greenhouse', token: 'squarepointcapital', tier: 'Multi-Manager' };
  const job = { id: '1', title: 'Junior Quant Researcher', location: 'London', url: 'https://example.invalid/1' };
  const ok = toExperiencedOpportunity(job, firm) === null;
  console.log(`${ok ? 'PASS' : 'FAIL'}  a recovered title is not also an experienced row`);
  ok ? pass++ : fail++;
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
