/**
 * Which roles qualify as experienced, and under which area (13 October 2026):
 * Risk as its own area, engineering at trading firms only, treasury and
 * control functions out, the A0 decisions on junior and stated-level titles,
 * and the large-bank allowance from #152 left exactly as it was.
 *
 *   node scripts/__tests__/experienced-quality.test.mjs
 *
 * Titles are real, from the boards the collector read on 12 and 13 October
 * 2026. Where a boundary is unclear the fixtures expect exclusion.
 */
import { classifySeniority, experiencedVertical, juniorSeatAtTradingFirm, namesNonTargetFunction } from '../../lib/seniority.mjs';
import {
  EXPERIENCED_PER_FIRM_CEILING,
  LARGE_BANK_EXPERIENCED_CEILING,
  LARGE_BANK_TIERS,
  capExperienced,
  earlyCareerAdmission,
  experiencedAllowance,
  isEarlyCareer,
  toExperiencedOpportunity,
  toOpportunity,
} from '../sync-ats.mjs';

let pass = 0;
let fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
};

const IMC = { firm: 'IMC Trading', ats: 'greenhouse', token: 'imc', tier: 'Trading Tech' };
const JUMP = { firm: 'Jump Trading', ats: 'greenhouse', token: 'jumptrading', tier: 'Prop Trading' };
const SQ = { firm: 'Squarepoint Capital', ats: 'greenhouse', token: 'squarepointcapital', tier: 'Multi-Manager' };
const P72 = { firm: 'Point72', ats: 'greenhouse', token: 'point72', tier: 'Multi-Manager' };
const AQR = { firm: 'AQR Capital Management', ats: 'greenhouse', token: 'aqr', tier: 'Systematic' };
const JPM = { firm: 'JPMorgan Chase', ats: 'oracle', host: 'jpmc.fa.oraclecloud.com', site: 'CX', tier: 'Bulge Bracket', collect: 'complete' };
const BARC = { firm: 'Barclays', ats: 'workday', tenant: 'barclays', site: 'x', tier: 'Bulge Bracket', collect: 'complete' };
const WB = { firm: 'William Blair', ats: 'greenhouse', token: 'williamblair', tier: 'Middle Market' };
let n = 0;
const job = (title, extra = {}) => ({ id: String((n += 1)), title, location: `City ${n}`, url: `https://example.invalid/${n}`, ...extra });
const xp = (title, firm) => {
  const r = toExperiencedOpportunity(job(title), firm);
  return r ? `${r.vertical}/${r._seniority}` : null;
};
const early = (title, firm) => {
  const r = toOpportunity(job(title), firm);
  return r ? `${r.vertical}/${r.level}` : null;
};

/* ---------------------------------- 1. Risk ---------------------------------- */

for (const [title, firm, want] of [
  // Front-office risk: a book's or a market's risk.
  ['Market Risk Analyst', JPM, 'Risk/investment-professional'],
  ['Market Risk, Vice President', AQR, 'Risk/vp'],
  ['Investment Risk - Associate', JPM, 'Risk/associate'],
  ['Asset Management - Alternatives Investment Risk Associate', JPM, 'Risk/associate'],
  ['Counterparty Credit Risk Associate (Traded Products)', JPM, 'Risk/associate'],
  ['Quantitative Counterparty Credit Risk Associate', JPM, 'Risk/associate'],
  ['Strategist - Equity Risk', SQ, 'Risk/investment-professional'],
  // At a trading firm the risk seat sits on the desk.
  ['Risk Manager | Equities', JUMP, 'Risk/investment-professional'],
  ['Quantitative Risk Manager', IMC, 'Risk/investment-professional'],
  ['Experienced Risk Manager', IMC, 'Risk/investment-professional'],
]) {
  eq(`risk accepted: ${title} at ${firm.firm}`, xp(title, firm), want);
}
for (const [title, firm] of [
  // A bare risk seat at a bank is far more often the second line.
  ['Risk Manager', JPM],
  ['Credit Risk Sanctioner (VP)', BARC],
  // The second line, whatever else the title says.
  ['Operational Risk Manager', IMC],
  ['Enterprise Risk Associate, FX & Rates', SQ],
  ['Director - Operational Risk - Portfolio Oversight', BARC],
  ['Commercial and Investment Bank, Controls – Third Party and Resiliency Risk Vice President', JPM],
  ['Commercial and Investment Bank Credit Risk Control Management – Associate', JPM],
  ['Quant Model Risk Associate - Rates', JPM],
  ['Quant Model Risk Vice President', JPM],
  ['Funding and Liquidity Risk VP', BARC],
  ['Financial Crime Risk Transaction Monitoring Control Owner - AVP', BARC],
  ['Internal Audit AVP -Credit Risk', BARC],
  ['Cyber Risk Service Manager', BARC],
  ['IT Risk - Vol', SQ],
  ['Risk Reporting & Analytics Lead', SQ],
  ['Market Risk Fundamental Review of the Trading Book – Implementation & Analysis - Vice President', JPM],
  ['Counterparty Credit Risk - Collateral and Margin Associate', JPM],
  // Consumer lending risk is not a markets seat.
  ['Card Portfolio Risk Strategy Associate', JPM],
  ['Vice President, Card Portfolio Risk Strategy', JPM],
  ['CCB Risk - Card Portfolio Management - Executive Director', JPM],
]) {
  eq(`risk refused: ${title} at ${firm.firm}`, xp(title, firm), null);
}
eq('Risk is its own area, never Quant or Sales & Trading', experiencedVertical('Quant', { seniority: 'associate', function: 'risk' }, 'Bulge Bracket'), 'Risk');
eq('"risk" as a word alone is not a function', classifySeniority('Risk Associate', { firmType: 'finance' }), null);

/* ------------------------ 2. Engineering at trading firms ------------------------ */

for (const title of ['C++ Software Engineer', 'C++ Trading Systems Engineer', 'Java Software Engineer', 'Low Latency C++ Engineer', 'Quantitative Developer', 'Trading Systems Developer']) {
  eq(`${title}: accepted at IMC`, xp(title, IMC) !== null, true);
  eq(`${title}: accepted at Jump`, xp(title, JUMP) !== null, true);
  eq(`${title}: refused at JPMorgan, a bank`, xp(title, JPM) === null || /^Quant\//.test(xp(title, JPM)), true);
}
eq('a plain software engineer is never an experienced row at a bank', xp('C++ Software Engineer', JPM), null);
eq('and is published as software engineering at a trading firm', xp('C++ Software Engineer', IMC), 'Software Engineering/technologist');
for (const title of ['Production Support Engineer - Trading Systems', 'Trading Systems Reliability Engineer (C++)', 'Software Engineer - Cloud Infrastructure', 'Software Engineer, Macro Middle Office', 'Junior Desktop Support Analyst', 'Network Engineer', 'Help Desk Analyst', 'Business Analyst – Trading System', 'Software Engineer, Enterprise Systems']) {
  eq(`support and infrastructure refused at a trading firm: ${title}`, xp(title, IMC), null);
}
// An engineer building a trading firm's risk platform stays an engineer.
eq('risk-platform engineering at a trading firm stays engineering', xp('Software Developer - Risk Data Pipelines', SQ), 'Software Engineering/technologist');
eq('risk technology engineering at a trading firm stays engineering', xp('Software Engineer, Risk Technology', P72), 'Software Engineering/technologist');

/* ------------------------------ 3. Treasury and control ------------------------------ */

for (const title of [
  'Treasury Operations Analyst',
  'Treasury Accounting Associate',
  'Treasury Control - Vice President',
  'Product Control Associate',
  'Financial Control Vice President',
  'Balance Sheet Control Associate',
  'Regulatory Reporting Associate',
  'Commercial & Investment Bank Treasury - Advanced Treasury Analytics – Senior Associate',
  'Commercial and Investment Bank Treasury Liquidity Analytics-Vice President',
  'Treasury Management Officer - Commercial & Investment Bank - Vice President',
  'Control Manager - Corporate and Investment Banking - Vice President',
  'Hedge Fund Services - Financial Reporting - Associate',
]) {
  eq(`refused: ${title}`, xp(title, JPM), null);
}
eq('treasury technology at a fund is internal treasury', xp('Software Engineer, Treasury Technology', P72), null);
// The function decides, never the word.
eq('a quant treasury seat is kept', xp('Quantitative Analyst AVP - Treasury', BARC), 'Quant/vp');
eq('treasuries as the instrument is kept', xp('US Treasuries Trader - Vice President', JPM), 'Sales & Trading/vp');

/* --------------------------- 4. The A0 decisions --------------------------- */

eq('Junior Software Developer (C++) at a trading firm is early career, software engineering', early('Junior Software Developer (C++)', SQ), 'Software Engineering/Graduate');
eq('Junior Developer - C++ likewise', early('Junior Developer - C++', SQ), 'Software Engineering/Graduate');
eq('Junior Commodities Fundamental Analyst at a fund is early career, hedge fund', early('Junior Commodities Fundamental Analyst', SQ), 'Hedge Fund/Graduate');
eq('a junior software developer at a bank is not admitted', early('Junior Software Developer (C++)', JPM), null);
eq('Junior Risk Manager stays out', early('Junior Risk Manager', SQ), null);
for (const title of ['Junior Desktop Support Analyst', 'Junior SRE', 'Junior UX/UI Engineer', 'Junior Platform Specialist', 'Junior Executive Assistant', 'AI Engineer (Junior/Senior)']) {
  eq(`junior alone admits nothing: ${title}`, early(title, SQ), null);
}
eq('a junior seat is never also an experienced row', xp('Junior Software Developer (C++)', SQ), null);
eq('juniorSeatAtTradingFirm reads the tier', [juniorSeatAtTradingFirm('Junior Quant Developer', 'Multi-Manager') !== null, juniorSeatAtTradingFirm('Junior Quant Developer', 'Bulge Bracket')], [true, null]);
// Stated level alone must name work this tracker covers.
eq('a stated level on its own is recorded as such', earlyCareerAdmission('Collections, Fraud & Accounts Entry-Level Specialist'), 'stated-level');
eq('a campus word beside it is campus', earlyCareerAdmission('Software Engineer, New Grad (Entry-Level)'), 'campus');
eq('collections is not published', early('Collections, Fraud & Accounts Entry-Level Specialist', JPM), null);
eq('client services is not published', early('Client Services Associate (Entry-Level)', WB), null);
eq('a manufacturing technician is not published', early('Early Careers Manufacturing Technician', { firm: 'Intel', ats: 'workday', tier: 'Big Tech' }), null);
eq('an entry-level engineer is', early('Software Engineer (Entry-Level) - C++', { firm: 'Akuna Capital', ats: 'greenhouse', token: 'akunacapital', tier: 'Trading Tech' }), 'Software Engineering/Graduate');
eq('namesNonTargetFunction reads the function', [namesNonTargetFunction('Client Services Associate'), namesNonTargetFunction('Software Engineer')], [true, false]);

/* ------------------------- 5. Early career not regressed ------------------------- */

for (const title of [
  'Investment Banking Summer Analyst',
  '2027 Asset & Wealth Management U.S. Private Bank MBA Summer Associate Program',
  'Software Engineer (Entry-Level) - Python',
  '2027 Trading Analyst',
  'Quantitative Portfolio Analyst – 2026 Grad',
  'Junior Quant Researcher',
  'Junior Execution Trader - Equity',
  '2027 Spring Insights: Analyse & Trade at JPMorganChase – London',
  '2027 Commercial Real Estate Full-Time Analyst Program',
]) {
  eq(`still early career: ${title}`, isEarlyCareer(title), true);
  for (const firm of [JPM, SQ, IMC]) eq(`and never experienced at ${firm.firm}: ${title}`, xp(title, firm), null);
}

/* ----------------------- 6. The #152 allowance, unchanged ----------------------- */

eq('the bulge-bracket allowance is 150', LARGE_BANK_EXPERIENCED_CEILING, 150);
eq('every other firm keeps 60', EXPERIENCED_PER_FIRM_CEILING, 60);
eq('the large-bank tier is bulge bracket only', [...LARGE_BANK_TIERS], ['Bulge Bracket']);
eq('JPMorgan and Barclays are spread', [experiencedAllowance(JPM), experiencedAllowance(BARC)], [{ ceiling: 150, stratified: true }, { ceiling: 150, stratified: true }]);
eq('trading and quant firms keep 60 in seat order', [IMC, JUMP, SQ, P72, AQR].map(experiencedAllowance), Array(5).fill({ ceiling: 60, stratified: false }));
eq('as does a middle-market adviser', experiencedAllowance(WB), { ceiling: 60, stratified: false });
{
  const titles = ['Investment Banking Associate', 'Investment Banking Analyst', 'Investment Banking - Vice President', 'Global Credit Trading - Associate', 'Market Risk Analyst', 'Investment Risk - Associate'];
  const bank = [];
  for (let i = 0; i < 240; i += 1) bank.push(toExperiencedOpportunity(job(titles[i < 180 ? 0 : i % titles.length]), JPM));
  const seats = new Map(bank.map((o) => [o.id, `${o._seniority}|${o.vertical}`]));
  const a = experiencedAllowance(JPM);
  const out = capExperienced(bank, a.ceiling, a);
  const pairs = new Set(out.rows.map((o) => seats.get(o.id)));
  eq('a JPMorgan-like board keeps 150', out.rows.length, 150);
  eq('across several seats and areas, Risk among them', [pairs.size >= 5, [...pairs].some((p) => p.endsWith('|Risk'))], [true, true]);
  eq('in the same order whatever order the board answered in', capExperienced(bank.slice().reverse(), a.ceiling, a).rows.map((o) => o.id), out.rows.map((o) => o.id));
  const small = bank.slice(180, 202);
  eq('a Barclays-sized board under 150 is kept whole', capExperienced(small, a.ceiling, a).rows.length, small.length);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
