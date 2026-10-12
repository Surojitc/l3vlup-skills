/**
 * Programme-type inference, exercised against the title patterns US banks
 * actually use for sophomore and diversity insight programmes.
 *
 * The negatives matter more than the positives: nearly every one of these
 * titles also contains "program" or "intern", so a loose pattern would file
 * ordinary summer internships as insight programmes and quietly corrupt the
 * tracker's biggest category.
 *
 * The function is lifted out of the sync script rather than imported, because
 * sync-ats.mjs runs network fetches at module load.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const src = readFileSync(join(ROOT, 'scripts/sync-ats.mjs'), 'utf8');
const body = src.slice(src.indexOf('function inferProgrammeAndLevel'));
const fn = body.slice(0, body.indexOf('\n}\n') + 3);
const inferProgrammeAndLevel = new Function(`${fn}; return inferProgrammeAndLevel;`)();

const cases = [
  ['Sophomore Insight Program - Investment Banking', 'Insight Program'],
  ['2027 Freshman Discovery Program', 'Insight Program'],
  ['Early Insights Program, Global Markets', 'Insight Program'],
  ['Women in Finance Immersion Program', 'Insight Program'],
  ['Explore Program – Sales & Trading', 'Insight Program'],
  ['First-Year Analyst Insight Series', 'Insight Program'],
  ['Spring Week - Investment Banking', 'Spring Week'],
  ['Spring Insight Week 2027', 'Spring Week'],
  // Must NOT be swallowed by the insight branch:
  ['Investment Banking Summer Analyst Intern 2027', 'Summer Internship'],
  ['Quantitative Research Intern', 'Summer Internship'],
  ['Software Engineer Co-op', 'Summer Internship'],
  ['Graduate Analyst Programme', 'Graduate Programme'],
  ['Investment Banking Analyst', 'Graduate Programme'],
  // Summer seats are internships whether or not the title says "intern".
  ['Banking - Corporate Banking, Summer Analyst, Hong Kong – APAC, 2027', 'Summer Internship'],
  ['2027 Asset & Wealth Management U.S. Private Bank MBA Summer Associate Program', 'Summer Internship'],
  ['MBA, Investment Banking Summer Associate - Summer 2027', 'Summer Internship'],
  ['Working in Technology (WiT) Software Engineering - Summer 2027', 'Summer Internship'],
  // …and nothing else is: not a full-time hire, a town, or a season with no class year.
  ['2027 Investment Banking Full-Time MBA Associate', 'Graduate Programme'],
  ['2027 Commercial Real Estate Full-Time Analyst Program', 'Graduate Programme'],
  ['Private Client Banker - Summerville, SC', 'Graduate Programme'],
  ['2027 Spring Insights: Analyse & Trade at JPMorganChase – London', 'Spring Week'],
];

let pass = 0, fail = 0;
for (const [title, want] of cases) {
  const got = inferProgrammeAndLevel(title).programmeType;
  const ok = got === want;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${title}\n        -> ${got}${ok ? '' : `  (want ${want})`}`);
  ok ? pass++ : fail++;
}
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
