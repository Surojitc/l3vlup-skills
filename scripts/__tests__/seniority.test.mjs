/**
 * Experienced and lateral seats (lib/seniority.mjs), and how the collector
 * turns one into a row (scripts/sync-ats.mjs).
 *
 *   node scripts/__tests__/seniority.test.mjs
 *
 * The titles are real or real-shaped: almost all are from the Greenhouse,
 * Oracle and Workday boards the collector read on 12 October 2026. The
 * negatives matter more than the positives. A false positive puts a branch
 * banker or a payroll associate on a tracker read by people preparing for
 * banking and investing seats; a false negative costs one lateral row that
 * was never published before this existed anyway.
 */
import {
  SENIORITY_BUCKETS,
  classifySeniority,
  experiencedProgrammeType,
  experiencedVertical,
  firmTypeForTier,
} from '../../lib/seniority.mjs';
import {
  EXPERIENCED_PER_FIRM_CEILING,
  capExperienced,
  isEarlyCareer,
  isExperiencedRow,
  readsExperienced,
  toExperiencedOpportunity,
  toOpportunity,
} from '../sync-ats.mjs';

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
};

const seat = (title, firmType = 'finance', department) =>
  classifySeniority(title, { firmType, department })?.seniority ?? null;

/* ---------------------------- accepted, by bucket --------------------------- */

const ACCEPT = [
  // Banking and advisory: associates and VPs at William Blair and Lincoln.
  ['Investment Banking Associate - Biotechnology', 'finance', 'associate'],
  ['Investment Banking Associate, Private Capital Markets', 'finance', 'associate'],
  ['Investment Banking Associate - Aerospace/Defense & Government Services (ADGS)', 'finance', 'associate'],
  ['Associate, Industrials M&A (FDD/TAS Experience Required)', 'finance', 'associate'],
  ['Experienced Associate, Transaction Opinions & Board Advisory', 'finance', 'associate'],
  ['Associate, Capital Advisory', 'finance', 'associate'],
  ['Investment Banking Vice President - Insurance', 'finance', 'vp'],
  ['Investment Banking Vice President 1, Services & Industrials', 'finance', 'vp'],
  ['Vice President, Portfolio Valuations', 'finance', 'vp'],
  ['Vice President, Business Services M&A', 'finance', 'vp'],
  ['Leveraged Finance - Assistant Vice President', 'finance', 'vp'],
  ['Restructuring Director', 'finance', 'vp'],
  // Experienced analysts.
  ['Investment Banking Senior Analyst - Technology', 'finance', 'experienced-analyst'],
  ['Analyst, Healthcare M&A', 'finance', 'experienced-analyst'],
  ['ECM Analyst II', 'finance', 'experienced-analyst'],
  ['Senior Analyst, Debt Capital Markets', 'finance', 'experienced-analyst'],
  // MBA hires carry a class year by design.
  ['2027 Investment Banking Full-Time MBA Associate', 'finance', 'mba-associate'],
  ['Post-MBA Associate, Private Equity', 'finance', 'mba-associate'],
  // Research and buy-side seats.
  ['US Equity Research - SMid Technology - Associate', 'finance', 'associate'],
  ['Research Associate, Global Financials', 'finance', 'associate'],
  ['Research Analyst - U.S. Growth & Core Equity (Generalist)', 'finance', 'investment-professional'],
  ['Cubist Portfolio Manager', 'trading', 'investment-professional'],
  ['Sector Analyst, Proprietary Research', 'trading', 'investment-professional'],
  ['Credit Research Analyst, Global Macro', 'trading', 'investment-professional'],
  ['Point72 Academy 2026-2027 Investment Analyst Program for Experienced Professionals - US', 'trading', 'investment-professional'],
  ['Global Stock Selection Research VP/ED – Technical Signals', 'trading', 'vp'],
  ['Discretionary Macro - Vice President', 'trading', 'vp'],
  ['Private Equity Associate', 'finance', 'associate'],
  ['Growth Equity Vice President', 'finance', 'vp'],
  ['Private Credit Senior Associate', 'finance', 'associate'],
  // Trading and quant.
  ['Equity Options Volatility Trader', 'trading', 'investment-professional'],
  ['Senior Discretionary Trader - Credit', 'trading', 'investment-professional'],
  ['Experienced Options Trader - SOFR', 'trading', 'investment-professional'],
  ['Quantitative Researcher - HFT Commodity Futures', 'trading', 'investment-professional'],
  ['Senior Quant Researcher - Intraday Statistical Arbitrage', 'trading', 'investment-professional'],
  ['Quantitative Developer - Ultra Low-Latency (C++)', 'trading', 'investment-professional'],
  ['Desk Quant Analyst', 'trading', 'investment-professional'],
  ['Quant Strategist / Researcher - FX Volatility', 'trading', 'investment-professional'],
  ['Quantitative Trading Associate', 'trading', 'associate'],
  ['Quantitative Analyst AVP - Treasury', 'finance', 'vp'],
  ['Quant Risk Analyst', 'trading', 'investment-professional'],
  // Engineering, at a trading or quant firm only.
  ['C++ Software Engineer', 'trading', 'technologist'],
  ['Senior Software Engineer, C++ (Market Data)', 'trading', 'technologist'],
  ['Software Developer - Order Gateway', 'trading', 'technologist'],
  ['Data Scientist - Options', 'trading', 'technologist'],
  ['Machine Learning Engineer, GenAI Technology', 'trading', 'technologist'],
  ['FPGA Engineer', 'trading', 'technologist'],
  ['Trading Engineer - Execution', 'trading', 'technologist'],
  // Corporate development.
  ['Corporate Development Associate', 'finance', 'associate'],
];
for (const [title, firmType, want] of ACCEPT) eq(`accept: ${title}`, seat(title, firmType), want);

/* -------------------------------- refused -------------------------------- */

const REFUSE = [
  // Retail and branch banking, and wealth advice sold to individuals.
  ['Associate Banker, 30 Hours, Fresh Meadows Branch, Fresh Meadows, NY', 'finance'],
  ['Part Time (20 Hours) Associate Banker, Orem Branch, Orem, UT', 'finance'],
  ['Associate Relationship Banker - Boston Metro South Market - Milford, MA', 'finance'],
  ['Private Client Banker - (New Build) Hayden - Hayden Lake, ID', 'finance'],
  ['J.P. Morgan Wealth Management – Private Client Advisor - Denver, CO (Denver Metro)', 'finance'],
  ['J.P. Morgan Wealth Management - Private Client Investment Associate - Manhattan, NY', 'finance'],
  ['Client Associate', 'finance'],
  ['Financial Advisor Associate', 'finance'],
  ['Senior Home Lending Advisor- Carol Stream, IL', 'finance'],
  ['Branch Manager- Northwest Indiana Market- Merrillville, IN', 'finance'],
  ['Teller', 'finance'],
  // Operations, administration, HR, legal, compliance, internal finance.
  ['Operations Associate', 'finance'],
  ['Back Office Operations Senior Associate', 'trading'],
  ['Mid Office Associate - Digital Assets', 'trading'],
  ['Corporate & Investment Banking – Markets Operations – Analyst', 'finance'],
  ['Trade Support - Associate II', 'finance'],
  ['Executive Assistant', 'trading'],
  ['PM Administrative Assistant', 'trading'],
  ['Investment Banking Executive Assistant', 'finance'],
  ['Recruiter, Talent Acquisition', 'trading'],
  ['Experienced Recruiter – Technology and Business Operations', 'trading'],
  ['Associate, Payroll', 'trading'],
  ['Associate Counsel, PM Legal and Fund Formation', 'trading'],
  ['Compliance Associate, Trading Compliance', 'trading'],
  ['Senior Surveillance Associate - Market Abuse', 'trading'],
  ['Product Controller Senior Associate', 'trading'],
  ['Assistant Vice President - Treasury Hedge Accounting', 'finance'],
  ['Barclays Internal Audit Prudential Regulatory Reporting VP', 'finance'],
  // IT support and infrastructure, even at a trading firm.
  ['Service Desk Engineer, Technology', 'trading'],
  ['IT Operations Engineer, End User Computing', 'trading'],
  ['Network Engineer', 'trading'],
  ['Site Reliability Engineer', 'trading'],
  ['Data Center Engineer', 'trading'],
  ['Senior Security Engineer', 'trading'],
  ['Barista & Facilities Assistant', 'trading'],
  // Sales and marketing, and fund distribution.
  ['Sales Development Representative', 'finance'],
  ['Brand Marketing Lead-JPMorgan Payments', 'finance'],
  ['US Institutional Sales - Vice President/Director', 'trading'],
  ['Client Portfolio Manager - Systematic', 'trading'],
  ['Business Development Associate - Dubai', 'trading'],
  // Too senior.
  ['Managing Director, Head of Leveraged Finance', 'finance'],
  ['Head of Compliance, Hong Kong', 'trading'],
  ['Partner, Private Equity', 'finance'],
  ['Chief Investment Officer', 'finance'],
  ['US Equities COO', 'trading'],
  ['Director of Risk, Fundamental Equity', 'trading'],
  // Early career and near-campus, which stay with the existing path.
  ['Summer Associate', 'finance'],
  ['Investment Banking Summer Associate', 'finance'],
  ['2027 Full-Time Analyst, Valuations & Opinions Group', 'finance'],
  ['2027 Trading Analyst', 'trading'],
  ['Quantitative Portfolio Analyst – 2026 Grad', 'trading'],
  ['Junior Quant Researcher', 'trading'],
  ['Software Engineer (Entry-Level) - C++', 'trading'],
  ['Fundamental Research Fellow, Canvas', 'trading'],
  ['Stagiaire Corporate Lending - Origination & Execution / Credit Analyst', 'finance'],
  // Not roles.
  ['Akuna Capital\'s Talent Community', 'trading'],
  ['Expression of Interest: 2027 Trading Sneak Peek Weeks', 'trading'],
  ['Quant Signals External Contributors', 'trading'],
  // A finance word with no seat, or no finance function at all.
  ['Mortgage Valuation Specialist', 'trading'],
  ['Senior Analyst', 'finance'],
  ['Principal Associate, Business Analysis', 'finance'],
  ['Senior Associate, Corporate Communications', 'finance'],
  ['Associate Product Manager', 'finance'],
  // Engineering at a bank or a firm that is not a finance firm.
  ['Senior Software Engineer', 'finance'],
  ['Full Stack Engineer', 'finance'],
  ['Senior Software Engineer', null],
  ['Quantitative Researcher', null],
  ['Investment Banking Associate', 'technology'],
];
for (const [title, firmType] of REFUSE) eq(`refuse: ${title} (${firmType ?? 'no firm type'})`, seat(title, firmType), null);

eq('at least 60 title cases', ACCEPT.length + REFUSE.length >= 60, true);

/* ------------------------------- department ------------------------------- */

// JPMorgan's Oracle job family is evidence against, never evidence for.
eq('a branch job family refuses an otherwise clean title', seat('Associate', 'finance', 'Associate Bankers'), null);
eq('an advisory sales force refuses it too', seat('Investment Associate', 'finance', 'Advisors'), null);
eq('a desk job family does not refuse a desk title', seat('Equity Research Associate', 'finance', 'Analysts'), 'associate');
eq('a department alone never supplies the function', seat('Associate', 'finance', 'Investment Banking'), null);

/* ------------------------------ what it returns ----------------------------- */

eq('the function travels with the seat', classifySeniority('Investment Banking Associate - Technology', { firmType: 'finance' }), { seniority: 'associate', function: 'banking' });
eq('MBA hire programme type', experiencedProgrammeType({ seniority: 'mba-associate' }), 'MBA Hire');
eq('every other seat is lateral', experiencedProgrammeType({ seniority: 'vp' }), 'Lateral / Experienced');
eq('buckets are ordered most specific first', SENIORITY_BUCKETS[0], 'mba-associate');
eq('empty title', classifySeniority('', { firmType: 'finance' }), null);

/* ---------------------------------- tiers ---------------------------------- */

eq('trading tiers', ['Trading Tech', 'Multi-Manager', 'Systematic', 'Prop Trading'].map(firmTypeForTier), ['trading', 'trading', 'trading', 'trading']);
eq('finance tiers', ['Bulge Bracket', 'Elite Boutique', 'Middle Market', 'Megafund', 'Asset Manager'].map(firmTypeForTier), ['finance', 'finance', 'finance', 'finance', 'finance']);
eq('technology, fintech and consulting are neither', ['Fintech', 'Big Tech', 'AI Lab', 'Enterprise Tech', 'Consulting', 'Independent Advisory', undefined].map(firmTypeForTier), [null, null, null, null, null, null, null]);

/* --------------------------------- vertical -------------------------------- */

eq('inferVertical wins when it names one', experiencedVertical('Quant', { function: 'investing' }, 'Multi-Manager'), 'Quant');
eq('a banking phrase in Other is banking', experiencedVertical('Other', { function: 'banking' }, 'Middle Market'), 'Investment Banking');
eq('a private-markets phrase in Other is private equity', experiencedVertical('Other', { function: 'private-markets' }, 'Megafund'), 'Private Equity');
eq('an investing seat at a fund is a hedge fund seat', experiencedVertical('Other', { function: 'investing' }, 'Systematic'), 'Hedge Fund');
eq('an investing seat at a market maker is dropped, not guessed', experiencedVertical('Other', { function: 'investing' }, 'Trading Tech'), null);
eq('a trading seat in Other is dropped', experiencedVertical('Other', { function: 'trading-quant' }, 'Multi-Manager'), null);
eq('never Other', experiencedVertical('Other', null, 'Multi-Manager'), null);

/* ------------------------- the collector's experienced path ------------------------- */

const WB = { firm: 'William Blair', ats: 'greenhouse', token: 'williamblair', tier: 'Middle Market' };
const IMC = { firm: 'IMC Trading', ats: 'greenhouse', token: 'imc', tier: 'Trading Tech' };
const STRIPE = { firm: 'Stripe', ats: 'greenhouse', token: 'stripe', tier: 'Fintech' };
const CITI = { firm: 'Citi', ats: 'workday', tenant: 'citi', site: 'x', tier: 'Bulge Bracket' };
const JPM = { firm: 'JPMorgan Chase', ats: 'oracle', host: 'jpmc.fa.oraclecloud.com', site: 'CX', tier: 'Bulge Bracket', collect: 'complete' };
const job = (id, title, extra = {}) => ({ id: String(id), title, location: 'Chicago, IL', url: `https://boards.greenhouse.io/x/jobs/${id}`, ...extra });

eq('greenhouse finance boards are read', readsExperienced(WB), true);
eq('complete-read boards are read', readsExperienced(JPM), true);
eq('keyword-searched Workday boards are not (phase 2)', readsExperienced(CITI), false);
eq('fintech boards are not', readsExperienced(STRIPE), false);
eq('parked boards are not', readsExperienced({ ...WB, parked: true }), false);

const ib = toExperiencedOpportunity(job(4100, 'Investment Banking Associate - Technology'), WB);
eq('an associate becomes a lateral row', ib && [ib.programmeType, ib.level, ib.vertical, ib.region], ['Lateral / Experienced', 'Experienced', 'Investment Banking', 'US']);
eq('in the same id namespace as every other row, so its slug pins to the job id', ib?.id, 'greenhouse-williamblair-4100');
eq('with the employer\'s application URL from the ATS', ib?.applicationUrl, 'https://boards.greenhouse.io/x/jobs/4100');
eq('and the prep path for its vertical', ib?.recommendedPrepSlug, 'investment-banking-interview-prep');
eq('it is an experienced row', isExperiencedRow(ib), true);
const mba = toExperiencedOpportunity(job(4101, '2027 Investment Banking Full-Time MBA Associate'), WB);
eq('an MBA associate is an MBA hire', mba && [mba.programmeType, mba.level], ['MBA Hire', 'Experienced']);
eq('a posting the early-career path takes is never an experienced row', toExperiencedOpportunity(job(4102, 'Investment Banking Summer Analyst'), WB), null);
eq('nor one whose source confirmed it early career', toExperiencedOpportunity(job(4103, 'Investment Banking Associate', { earlyCareerConfirmed: true }), WB), null);
eq('nothing from a fintech board', toExperiencedOpportunity(job(4104, 'Senior Software Engineer'), STRIPE), null);
eq('nothing that would be Other', toExperiencedOpportunity(job(4105, 'Business Strategist'), IMC), null);
eq('an engineer at a trading firm', toExperiencedOpportunity(job(4106, 'C++ Software Engineer'), IMC)?.vertical, 'Software Engineering');

// The early-career path is untouched: the same postings give the same rows.
const early = toOpportunity(job(4107, 'Investment Banking Summer Analyst'), WB);
eq('early-career rows keep their programme and level', early && [early.programmeType, early.level], ['Graduate Programme', 'Graduate']);
eq('and are not experienced rows', isExperiencedRow(early), false);
eq('the experienced title still fails the early-career filter', isEarlyCareer('Investment Banking Associate - Technology'), false);
eq('a residency row is level Experienced but is not an experienced row', isExperiencedRow({ programmeType: 'Graduate Programme', level: 'Experienced' }), false);

/* ------------------------------------ cap ----------------------------------- */

const rows = [];
for (let i = 0; i < 70; i += 1) rows.push(toExperiencedOpportunity(job(5000 + i, 'C++ Software Engineer', { location: `City ${i}` }), IMC));
rows.push(toExperiencedOpportunity(job(6000, 'Quantitative Researcher', { location: 'Chicago, IL' }), IMC));
rows.push(toExperiencedOpportunity(job(6001, 'Quantitative Trading Associate', { location: 'Chicago, IL' }), IMC));
const capped = capExperienced(rows.slice().reverse());
eq('the cap holds', capped.rows.length, EXPERIENCED_PER_FIRM_CEILING);
eq('and says how many it left out', capped.overCeiling, 72 - EXPERIENCED_PER_FIRM_CEILING);
eq('engineers go before any desk seat', capped.rows.slice(0, 2).map((o) => o.id), ['greenhouse-imc-6001', 'greenhouse-imc-6000']);
eq('the same rows whatever order the board answered in', capExperienced(rows.slice()).rows.map((o) => o.id), capped.rows.map((o) => o.id));
eq('the internal seat field never reaches the feed', capped.rows.some((o) => '_seniority' in o), false);

const repeat = [
  toExperiencedOpportunity(job(7001, 'Investment Banking Associate - Technology', { postedAt: '2026-09-01' }), WB),
  toExperiencedOpportunity(job(7000, 'Investment Banking Associate - Technology', { postedAt: '2026-10-01' }), WB),
  toExperiencedOpportunity(job(7002, 'Investment Banking Associate - Technology', { location: 'New York, NY' }), WB),
];
const once = capExperienced(repeat);
eq('a same-city repost is collapsed to the first posted', once.rows.map((o) => o.id).sort(), ['greenhouse-williamblair-7001', 'greenhouse-williamblair-7002']);
eq('and counted', once.repeats, 1);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
