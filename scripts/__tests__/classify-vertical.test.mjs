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
import { readFileSync } from 'node:fs';
import { inferVertical, isEarlyCareer, toOpportunity, isNotAPosting, namesOnlyPastCycle } from '../sync-ats.mjs';

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

// --- Hedge Fund is a fund seat, not a service provider's ------------------
// Live finding (career radar, 1 November 2026): a bank's fund-services back
// office, a risk seat whose clients are funds, a technology governance role
// and a lender's credit book were all typed Hedge Fund on the words alone.
const vertAt = (title, firm, want) =>
  eq(`${title.slice(0, 44).padEnd(46)} @ ${firm.slice(0, 16).padEnd(16)} → ${want}`, inferVertical(title, { firm }), want);
vertAt('Hedge Fund Services - Financial Reporting - Associate', 'JPMorgan Chase', 'Operations');
vertAt('Risk Management - Commercial & Investment Bank Credit Risk Hedge Funds Associate', 'JPMorgan Chase', 'Risk');
vertAt('Executive Director-Portfolio Management & Governance, Corporate Technology', 'JPMorgan Chase', 'Software Engineering');
vertAt('Portfolio Management', 'Capital One', 'Other');
vertAt('Analyst, Specialty Underwriting and Portfolio Management - FIG', 'Capital One', 'Other');
// The same bare words at a fund, and the explicit tokens anywhere, stay Hedge Fund.
vertAt('Portfolio Management Analyst', 'Man Group', 'Hedge Fund');
vertAt('Summer Analyst, Long/Short Equity', 'Point72', 'Hedge Fund');
vertAt('Multi-Strategy Summer Analyst', 'Millennium', 'Hedge Fund');
vertAt('Hedge Fund Investment Analyst', 'JPMorgan Chase', 'Hedge Fund');
// "Operations" is a service-provider word at a bank and an ordinary seat at a fund.
vertAt('Hedge Fund Operations Analyst', 'Citadel', 'Hedge Fund');
vertAt('Hedge Fund Operations Analyst', 'State Street', 'Operations');
// A firm with no context behaves as before, and "ing" is ING, not Wellington.
vert('Portfolio Management Summer Analyst', 'Hedge Fund');
vertAt('Portfolio Management Intern', 'Wellington Management', 'Hedge Fund');
vertAt('Intern, Portfolio Management', 'ING', 'Other');

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

// --- a role at an investment bank is not an investment banking role -------
// Every title here was live under Investment Banking on the 18 September
// 2026 sweep, and every one of them is another job. The employer-level
// prefix ("Commercial & Investment Bank") is stripped before the rules run,
// which is what lets the rest of the title decide.
vert('2027 Commercial & Investment Bank - Global Payments Analyst Program - Summer Internship - London', 'Corporate Banking');
vert('2027 Commercial & Investment Bank Global Payments Summer Analyst Program', 'Corporate Banking');
vert('2027 Commercial & Investment Bank - Securities Services Leadership Programme - Summer Internship - Dublin', 'Operations');
vert('2027 Commercial & Investment Banking - Sales - Off-cycle Internship - Frankfurt', 'Sales & Trading');
vert('2027 Commercial & Investment Banking - Markets - Off-cycle Internship – Istanbul', 'Sales & Trading');
vert('2027 Commercial & Investment Banking - Global Markets - Off-cycle Internship - London', 'Sales & Trading');
vert('2027 Commercial & Investment Banking - Risk Management Program - Summer Internship - London', 'Risk');
vert('2027 Retail, Business and Customer Banking Summer Internship Programme London', 'Other');
vert('2027 Retail, Business and Customer Banking Graduate Programme Northampton', 'Other');
vert('2027 Business Banking Degree Apprenticeship Programme Manchester', 'Corporate Banking');
vert('2027 Consumer Banking and Lending Summer Internship – Early Careers', 'Other');
vert('Branch Banking Management Military Apprentice (SAFE) San Tan Valley District', 'Other');
vert('Intern Corporate Sector Lending – Wholesale Banking (f/m/x)', 'Corporate Banking');
vert('Graduate Wholesale Banking - Energy & Infra', 'Corporate Banking');
vert('Internship Sustainable Finance Business Banking', 'Corporate Banking');
vert('Intern (Stagiaire) Administrative Support - Daily Banking Private Individuals', 'Other');
vert('INTERNSHIP - Client Relationship Officer- E Banking', 'Other');
vert('INTERNSHIP - Real Estate Valuation Expert - Property Valuer', 'Other');
vert('Banking – Corporate Baking, Internship, Bogotá – Colombia, 2026', 'Corporate Banking');
// Real estate debt is a lending seat (BREDS is Blackstone's real estate credit business).
vert('2027 Blackstone Real Estate Debt Strategies Summer Analyst - Private Investments & Capital Markets (London)', 'Private Credit');
vert('2027 Blackstone Real Estate Partners Summer Analyst – Acquisitions, Asset Management, Capital Markets and Core+ (London)', 'Private Equity');
vert('Intern, Business Transformation (TMT), Corporate Finance', 'Other');
vert('2027 Summer Internship Program - Private Client Banking Strategy, Analytics, & Sales Intern (St. Petersburg, FL)', 'Wealth Management');

// Rows outside banking that the new rules must leave alone, read from a diff
// of the whole committed feed before and after the change.
vert('Payment Risk Intern', 'Risk');
vert('2027 Investment Management Off-Cycle Internship - Real Estate Investing (Frankfurt)', 'Asset Management');
vert('2027 Global Payments & Liquidity Internship – Early Careers', 'Corporate Banking');
vert('Intern, Real Estate Investments – London (Off-Cycle January – June 2027)', 'Private Equity');

// ...and the banking rows beside them keep their answer, prefix or not.
vert('2027 Commercial & Investment Bank - Global Investment Banking Analyst Program - Off-Cycle Internship - Stockholm', 'Investment Banking');
vert('2027 - Commercial & Investment Bank - Global Investment Banking Summer Associate Program', 'Investment Banking');
vert('2026 Corporate & Investment Banking Summer Internship – Early Careers', 'Investment Banking');
vert('2027 Global Capital Markets Summer Analyst Programme (London)', 'Investment Banking');
vert('Capital Markets Off Cycle Internship Programme 2027 Milan', 'Investment Banking');
vert('Banking Associate Graduate Program 2027 New York City – Real Estate, Gaming and Lodging', 'Investment Banking');
vert('BMO Capital Markets Winter 2027 Investment Banking Analyst, Real Estate Brokerage, Toronto (Co-op/ Internship)', 'Investment Banking');
vert('Intern, Restructuring, Corporate Finance', 'Investment Banking');
vert('2027 Summer Associate – Corporate Finance – Valuation (New York and Boston)', 'Investment Banking');
vert('Off-Cycle Intern, Financial and Valuation Advisory - London', 'Investment Banking');
vert('Banking, Financing, Summer Analyst, London - United Kingdom 2027', 'Investment Banking');
vert('Intern, Asset Securitisation (Global Capital Markets)', 'Investment Banking');
vert('2027 - Investment Banking Off Cycle Internship – Milan Technology', 'Investment Banking');

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
/* ----------------------------- consulting -------------------------------- */

/**
 * Consulting is the only vertical whose rule reads the employer, so it is the
 * only one that can be wrong about a firm rather than about a title. The
 * fixtures are real rows from the step 3 sweep, grouped by what each one is
 * there to prove, and the reason each exists travels with it.
 *
 * The negative group is the load-bearing one. Accenture contributed 103 of the
 * 128 rows in that sweep and kept 25: everything else was a delivery centre, a
 * BPO seat or the firm's own back office, and a rule that could not tell those
 * apart would have put a student receptionist on a consulting board.
 */
const FIXTURES = JSON.parse(
  readFileSync(new URL('./fixtures/consulting-classification.json', import.meta.url), 'utf8')
);

const cls = (group) => {
  for (const f of FIXTURES[group] ?? []) {
    eq(
      `${group}: ${f.title.slice(0, 46).padEnd(48)} → ${f.want}   (${f.why})`,
      inferVertical(f.title, { firm: f.firm, department: f.department }),
      f.want
    );
  }
};

cls('positive');
cls('negative');
cls('ambiguous');
cls('regression');

for (const f of FIXTURES.seniority ?? []) {
  eq(
    `seniority: ${f.title.slice(0, 44).padEnd(46)} → ${f.early}   (${f.why})`,
    isEarlyCareer(f.title),
    f.early
  );
}

// A city variant is a separate opportunity. The step 3 analysis briefly
// collapsed these on title alone and understated the inventory by five rows.
for (const f of FIXTURES.duplicates ?? []) {
  const answers = f.titles.map((t) => inferVertical(t, { firm: f.firm }));
  eq(`duplicates: ${f.why}`, answers, Array(f.distinct).fill(f.want));
  eq(`duplicates: ${f.titles.length} titles stay ${f.distinct} rows`, new Set(f.titles).size, f.distinct);
}

// --- fund seats and venture, read beside the employer (November 2026) ------
// Real titles from the live feed and the boards added on 25 November 2026.
// Every one of the positives landed in Other before fundSeatVerdict existed.
const at = (title, firm, tier, want) =>
  eq(`${title.slice(0, 44).padEnd(46)} @ ${`${firm}/${tier}`.slice(0, 24).padEnd(24)} → ${want}`, inferVertical(title, { firm, tier }), want);
at('2027 Summer Internship - Sector Analyst, Proprietary Research', 'Point72', 'Multi-Manager', 'Hedge Fund');
at('2028 Point72 Academy Investment Analyst Summer Internship Program - US', 'Point72', 'Multi-Manager', 'Hedge Fund');
at('2027 Sector Specialist Intern, Tokyo', 'Millennium', 'Multi-Manager', 'Hedge Fund');
at('Public Equity Investment Intern - Summer 2027', 'Viking Global Investors', 'Single-Manager', 'Hedge Fund');
at('Private Equity Investment Intern - Summer 2027', 'Viking Global Investors', 'Single-Manager', 'Private Equity');
at('2027 Blackstone Credit & Insurance Summer Analyst, Tokyo', 'Blackstone', 'Megafund', 'Private Credit');
at('2027 Blackstone Strategic Partners Off Cycle Intern (London)', 'Blackstone', 'Megafund', 'Private Equity');
at('Investment Analyst Intern', 'Andreessen Horowitz', 'Growth Equity', 'Venture Capital');
at('Platform Associate, Summer 2027', 'Index Ventures', 'Growth Equity', 'Venture Capital');
at('Venture Investment Intern', 'Some Corporate', 'Other', 'Venture Capital');
// The negatives: a fund's own support seats, and the same words elsewhere.
at('2027 Summer Internship - Investment Services', 'Point72', 'Multi-Manager', 'Other');
at('2027 Marketing and Communications Intern, London', 'Millennium', 'Multi-Manager', 'Other');
at('Campus Recruitment Specialist', 'Squarepoint Capital', 'Systematic', 'Other');
at('Senior Fund Accounting Analyst Intern', 'Sixth Street', 'Megafund', 'Finance & Accounting');
at('Investment Analyst Intern', 'Aviva', 'Other', 'Other');
at('Software Engineer Intern', 'Andreessen Horowitz', 'Growth Equity', 'Software Engineering');
at('Executive Assistant Intern', 'Andreessen Horowitz', 'Growth Equity', 'Other');
at('Credit Risk Summer Analyst', 'Blackstone', 'Megafund', 'Risk');
// "accel" is matched whole: Accelerate is not Accel.
at('Investment Analyst Intern', 'Accelerate Diagnostics', 'Other', 'Other');

// --- consulting entry seats at the boutiques added in November 2026 -------
at('2027 Research Analyst - Competition - London', 'The Brattle Group', 'Consulting', 'Consulting');
at('Intern - Competition Economics', 'Berkeley Research Group', 'Independent Advisory', 'Consulting');
at('Summer Economist- 2027', 'Berkeley Research Group', 'Independent Advisory', 'Consulting');
at('London Office - Summer Associate 2027', 'L.E.K. Consulting', 'Consulting', 'Consulting');
at('Munich Office - Associate (m/f/d) (Entry level position) - Start October 2027', 'L.E.K. Consulting', 'Consulting', 'Consulting');
at('MBA Summer Associate, Education & Research - Summer 2027', 'Huron Consulting Group', 'Consulting', 'Consulting');
at('NERA Summer Internship 2027 - London', 'NERA Economic Consulting', 'Consulting', 'Consulting');
at('Intern | Competition Practice | Paris', 'Compass Lexecon', 'Consulting', 'Consulting');
// The same bare programme at Accenture stays where it was: its board is mostly
// delivery and back office, which is why the boutique rule leaves it out.
at('Accenture Spring Internship 2027', 'Accenture', 'Consulting', 'Other');
at('2027 Oliver Wyman – Intern Consultant - Spanish speaker (m/f/d) – Madrid', 'Oliver Wyman', 'Consulting', 'Consulting');
// A Big Four audit or tax associate is not a consulting seat, and a support
// seat at a strategy firm is not either.
at('Audit Associate - Graduate 2027', 'PwC', 'Consulting', 'Finance & Accounting');
at('Tax Associate Intern', 'PwC', 'Consulting', 'Finance & Accounting');
at('German-Speaking Executive Assistant (EA) (m/f/d) – Fixed-Term', 'L.E.K. Consulting', 'Consulting', 'Other');
at('Service Desk Analyst Intern – 6-Month Internship (M,F,D) - Munich Office', 'L.E.K. Consulting', 'Consulting', 'Other');
// Saying "consulting" outright still wins over the service-line exclusion.
at("(2028 Bachelor's/Master's graduates) Accounting/Business/Finance Consulting Analyst/Associate Intern (Summer 2027)", 'Charles River Associates', 'Consulting', 'Consulting');
// Asset-class words name an investing seat only at a private fund.
at('Trading Infrastructure Specialist – Graduate Program', 'Squarepoint Capital', 'Systematic', 'Sales & Trading');
// A case team's administrative support is not a consulting seat.
at('Case Team Assistant', 'Roland Berger', 'Consulting', 'Other');
// Sales & Trading inside Capital Markets is markets; origination is not.
at('2028 Capital Markets, Global Markets Sales & Trading Summer Analyst', 'Test Bank', 'Bulge Bracket', 'Sales & Trading');
at('2028 Capital Markets, Global Markets Origination Summer Analyst', 'Test Bank', 'Bulge Bracket', 'Investment Banking');
// Impact research at a buyout firm is left ambiguous, not forced into PE.
at('Y Analytics, Responsible Investing, Summer Research Assistant, Internship', 'TPG', 'Megafund', 'Other');
// From the stratified sample of 27 November.
at('2027 Credit Risk - Leveraged Finance Summer Intern', 'Santander', 'Bulge Bracket', 'Risk');
at('2027 - Global Markets - Summer Internship (Securitised Products and Private Credit Trading)', 'Nomura', 'Bulge Bracket', 'Sales & Trading');
at('2027 Blackstone Credit and Insurance, Private Credit Strategies Summer Analyst (London)', 'Blackstone', 'Megafund', 'Private Credit');
at('2027 MBA /MFE Summer Intern – Associate, Portfolio Management', 'PIMCO', 'Asset Manager', 'Asset Management');
at('Portfolio Management Intern', 'Man Group', 'Systematic', 'Hedge Fund');
// From l3vlup-skills #361 (superseded): "Consultant" is a grade in Big Four
// tax, and Internal Services is the firm's own back office (Deloitte US).
at('Tax - Tax Consultant - Legal Business Services - Summer 2027, Winter 2028', 'Deloitte', 'Consulting', 'Compliance & Legal');
at('Tax - Tax Delivery Consultant - International Tax/Transfer Pricing - Summer 2027', 'Deloitte', 'Consulting', 'Finance & Accounting');
eq('Deloitte Internal Services is not Consulting', inferVertical('Internal Services - Summer Associate - Internal Strategy - Summer 2027', { firm: 'Deloitte', tier: 'Consulting' }) === 'Consulting', false);
at('Consultative Offerings - Summer Associate - Enterprise Strategy', 'Deloitte', 'Consulting', 'Consulting');
// Business transformation is consulting at a consulting firm and nowhere else.
at('Business Transformation Analyst Intern', 'Barclays', 'Bulge Bracket', 'Other');

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

// --- Consulting launch review, 26 November 2026 ---------------------------
// Three live rows the hand review found in Consulting that are not consulting.
// "Execution consulting" at a bank is an algorithmic-trading sales seat, and a
// "Sales Consultant" at an asset manager sells funds.
eq('JPMorgan algo execution consulting VP is not Consulting',
  inferVertical('Algorithmic Trading - Execution Consulting - Vice President', { firm: 'JPMorgan Chase' }) !== 'Consulting', true);
eq('T. Rowe Price Associate Sales Consultant is not Consulting',
  inferVertical('Associate Sales Consultant (December 2026 & Spring 2027 Graduates)', { firm: 'T. Rowe Price' }) !== 'Consulting', true);
// The rule stays narrow: real consulting titles at the same kinds of firm hold.
vertAt('Visa Consulting & Analytics (VCA) Intern', 'Visa', 'Consulting');
vertAt('Associate Consultant Intern, Summer 2027', 'Mastercard', 'Consulting');

// A club or an event is not a posting; insight programmes still are.
eq('a graduate consulting club is not a posting', isNotAPosting('Boost Your Consulting Skills: Graduate Consulting Club x Roland Berger'), true);
eq('an insight day is still a posting', isNotAPosting('Spring Insight Day 2027'), false);
eq('a workshop is not a posting', isNotAPosting('Case Interview Workshop for Students'), true);

// A title whose every year is a past cycle is a posting left up.
const nov26 = new Date('2026-11-26T12:00:00Z');
eq('2024 internship in Nov 2026 is past', namesOnlyPastCycle('Accenture Summer Internship Program - Consulting (Aug to Dec2024)', nov26), true);
eq('2025 programme in Nov 2026 is past', namesOnlyPastCycle('2025 Markets Internship Colombia', nov26), true);
eq('2027 programme in Nov 2026 is current', namesOnlyPastCycle('2027 Summer Analyst', nov26), false);
eq('"2026/2027 grads" is current', namesOnlyPastCycle('Electronic Trading Support Engineer - 2026/2027 Grads', nov26), false);
eq('Class of 2026 in January 2027 is still current', namesOnlyPastCycle('Analyst - Class of 2026', new Date('2027-01-15T12:00:00Z')), false);
eq('Class of 2026 in July 2027 is past', namesOnlyPastCycle('Analyst - Class of 2026', new Date('2027-07-02T12:00:00Z')), true);
eq('no year is never past', namesOnlyPastCycle('Summer Analyst', nov26), false);
eq('toOpportunity drops a past-cycle posting',
  toOpportunity({ id: 'x1', title: 'Credit Summer Associate 2024, Sydney', location: 'Sydney' }, { ats: 'greenhouse', token: 't', firm: 'Bain Capital', tier: 'Private Equity' }), null);

// Precision audit of 27 November: every misfile in the Hedge Fund, Private
// Equity, Private Credit and Equity Research populations, with the reading.
at('Research & Portfolio Management Engineering - Analyst', 'AQR Capital Management', 'Systematic', 'Software Engineering');
at('Senior Associate, Portfolio Management Oversight', 'Ares Management', 'Megafund', 'Other');
at('Associate, Investment Professional Development', 'Point72', 'Multi-Manager', 'Other');
at('Investment Banking - EMEA Leveraged Finance - Analyst (German speaking) - London', 'JPMorgan Chase', 'Bulge Bracket', 'Investment Banking');
at('CCF Client Coverage, Credit, Associate', 'TPG', 'Megafund', 'Other');
at('2027 Blackstone Real Estate Debt Strategies Summer Analyst - Private Investments & Capital Markets (London)', 'Blackstone', 'Megafund', 'Private Credit');
at('2027 Blackstone Real Estate Partners Summer Analyst – Acquisitions, Asset Management, Capital Markets and Core+ (London)', 'Blackstone', 'Megafund', 'Private Equity');
at('Asset Management - Equity Research Analyst, Industrials - Associate', 'JPMorgan Chase', 'Bulge Bracket', 'Asset Management');
at('2027 China Seasonal Internship Program - Asset Management - Research Analyst', 'JPMorgan Chase', 'Bulge Bracket', 'Asset Management');
at('2027 MBA Summer Intern – Credit Research Analyst, US', 'PIMCO', 'Asset Manager', 'Asset Management');
at('Credit Research Analyst, Global Macro', 'Point72', 'Multi-Manager', 'Hedge Fund');
at('Client Investment Research Associate', 'Bridgewater Associates', 'Systematic', 'Hedge Fund');
at('Research Analyst, Capital Advisory', 'Lincoln International', 'Middle Market', 'Investment Banking');
at('Research Analyst (Equities)', 'IMC Trading', 'Trading Tech', 'Quant');
// With the Research & Ratings rule (#367) in place, a data firm's research desk is that vertical.
at('Senior Research Analyst, Gasoline', 'Kpler', 'Research & Ratings', 'Research & Ratings');
at('Intern – Software Asset Management Analyst', 'Intel', 'Big Tech', 'Other');
// What must not move: sell-side research and a bank's own credit research.
at('US Equity Research - Large Cap Software - Associate', 'JPMorgan Chase', 'Bulge Bracket', 'Equity Research');
at('Credit Research Analyst Summer Internship Program 2028 New York', 'Barclays', 'Bulge Bracket', 'Equity Research');
at('Research Analyst - Biotechnology', 'William Blair', 'Middle Market', 'Equity Research');
at('Analyst, Private Equity Secondaries', 'Ares Management', 'Megafund', 'Private Equity');
at('Associate, Credit, US Direct Lending', 'Ares Management', 'Megafund', 'Private Credit');

// Roland Berger's corporate functions, as its own page tags them (28 November feed).
eq('RB corporate communications is not Consulting',
  inferVertical('Praktikum Bereich Global Corporate Communications & PR (all genders)', { firm: 'Roland Berger', tier: 'Consulting', department: 'Corporate Functions' }) === 'Consulting', false);
eq('RB HR development is not Consulting',
  inferVertical('Praktikant/Werkstudent Personalentwicklung (all genders)', { firm: 'Roland Berger', tier: 'Consulting', department: 'Corporate Functions' }) === 'Consulting', false);
eq('RB consulting intern still is',
  inferVertical('Consulting Intern AI & Data (all genders)', { firm: 'Roland Berger', tier: 'Consulting', department: 'Consulting' }), 'Consulting');

// Research & Ratings (pending): the analytical seats at a ratings, data or index
// firm, read beside the tier only. Titles from the 27 November feed.
const RR = 'Research & Ratings';
at('Ratings Analytical Intern - Americas', 'S&P Global', RR, RR);
at('CREDit Graduate Program Analyst', 'S&P Global', RR, RR);
at('Student Worker - Credit Ratings Analyst', 'S&P Global', RR, RR);
at('Summer Intern, Fixed Income Pricing', 'S&P Global', RR, RR);
at('Manager Research Intern', 'Morningstar', RR, RR);
at('Multilingual Data Analyst Intern', 'Morningstar', RR, RR);
at('Index Analyst Graduate', 'FactSet', RR, RR);
// The boundaries: support, sales, client service, technology, quant, equity
// research and portfolio management keep their own readings.
at('Ratings Operations Specialist Intern', 'S&P Global', RR, 'Operations');
at('Summer Intern, Client Services, Equity Analytics Products', 'S&P Global', RR, 'Other');
at('Market Intelligence Sales Associate Internship', 'S&P Global', RR, 'FinTech Sales');
at('Commercial and CX Graduate Associate', 'S&P Global', RR, 'Other');
at('Facilities Intern', 'Morningstar', RR, 'Other');
at('Summer Intern, Quantitative Modeling', 'S&P Global', RR, 'Quant');
at('Software Engineer Intern', 'Bloomberg', RR, 'Software Engineering');
at('Research Scientist Intern, Machine Learning', 'Bloomberg', RR, 'AI Research');
at('Equity Research Analyst Intern', 'Morningstar', RR, 'Equity Research');
at('Portfolio Management Intern', 'Morningstar', RR, 'Asset Management');
// Not at a ratings or data firm: the same words keep their old readings.
at('Research Analyst Intern', 'Goldman Sachs', 'Bulge Bracket', 'Equity Research');
at('Ratings Analyst Intern', 'Goldman Sachs', 'Bulge Bracket', 'Other');

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
