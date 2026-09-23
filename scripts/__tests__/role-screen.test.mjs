/**
 * Records that are not roles, and the real roles that look like them.
 *
 * Every positive here was on the live board on 2026-09-20 or is the same shape
 * as one that was. The negatives matter more: a false positive silently
 * deletes a real seat, so each near-miss the rules were written around is
 * pinned, most of them real titles from the same feed.
 */
import { cleanRoleTitle, isNonRoleTitle, nonRoleReason, screenRoles } from '../../lib/role-screen.mjs';
import { updateArchive } from '../sync-ats.mjs';

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
};

// --- dropped: things a candidate attends, not seats they fill ---------------
const DROP = [
  // Real, CIBC Workday, 2026-09-20.
  'CIBC- Private Wealth Rotational Program - Virtual Information Session-Bilingual',
  // Real, IMC Greenhouse, 2026-09-20.
  'INVITE ONLY | EU Campus | London Networking Event 1 Oct',
  'Summer Analyst Program - Information Session',
  'Investment Banking Webinar: Life as a Summer Analyst Webinar',
  'Women in Markets Open Day',
  'Graduate Programme Open Evening (London)',
  'Meet the Team: Global Markets',
  'Campus Recruiting Event - New York',
  'Virtual Coffee Chat with our Graduate Recruiters',
];
for (const t of DROP) eq(`dropped as a session: ${t}`, nonRoleReason(t), 'attendance');

// --- kept: real roles and programmes that share words with sessions --------
const KEEP = [
  // Real titles from the same feed.
  'Spring Insight Event',
  '2027 EMEA Future Leaders Spring Insight Programme',
  'Strategic Events Intern - London',
  'Intern (m/f/d) - Competition Economics (E.CA)',
  'Software Engineer Intern, Test Automation (Summer 2027)',
  '2027 Point72 Academy Investment Analyst Summer Internship Program - Hong Kong',
  '2027 EU Campus Programme Talent Community',
  'Future Opportunities: Early Career Sales Talent',
  'PeopleX Insights & Analytics Intern (Summer 2027)',
  'Insights Summer Associate (New York, NY)',
  '2027 Summer Associate - Marketing Data Insights - St. Petersburg, FL (Hybrid or Virtual)',
  // Near-misses written for the guards.
  'Webinar Producer Intern',
  'Intern - Webinar Operations',
  'Open Day Coordinator (Graduate Recruitment)',
  'Events & Networking Analyst, Graduate Programme',
  'Spring Week 2027 - Open Day',
  'Discovery Day: Investment Banking',
  'Summer Analyst - Event-Driven Strategies',
  '10,000 Black Interns Programme 2027',
];
for (const t of KEEP) eq(`kept: ${t}`, nonRoleReason(t), null);

// --- requisition labels are cleaned, not dropped ---------------------------
eq('the Citi India apprenticeship keeps its programme name',
   cleanRoleTitle('Job Requisition: 25843173 Citi India Apprenticeship Program - SS Ops'),
   'Citi India Apprenticeship Program - SS Ops');
eq('  …and is a role', nonRoleReason('Job Requisition: 25843173 Citi India Apprenticeship Program - SS Ops'), null);
eq('a trailing requisition label goes too',
   cleanRoleTitle('2027 Summer Analyst Program (Req ID: R-12345)'), '2027 Summer Analyst Program');
eq('a Workday-style label with letters',
   cleanRoleTitle('Requisition JR0287022 - Module Engineering PhD Intern'), 'Module Engineering PhD Intern');
eq('a title without a label is unchanged', cleanRoleTitle('Software Engineer, New Grad'), 'Software Engineer, New Grad');
eq('a bare leading number is not a label', cleanRoleTitle('10000 Black Interns 2027'), '10000 Black Interns 2027');
eq('"Requisition" as a word is not a label', cleanRoleTitle('Requisition Analyst Intern'), 'Requisition Analyst Intern');
eq('a year after a label word is left alone when it is the only digits', cleanRoleTitle('2027 Graduate Programme'), '2027 Graduate Programme');

// --- placeholders -----------------------------------------------------------
eq('nothing but a requisition label is a placeholder', nonRoleReason('Job Requisition 25843173'), 'placeholder');
eq('a self-declared test posting is a placeholder', nonRoleReason('Test Posting - Summer Intern - DO NOT APPLY'), 'placeholder');
eq('"test" in a real title is not', nonRoleReason('NVIDIA 2027 Internships: Hardware Design for Test (DFT)'), null);
eq('an empty title is not judged', nonRoleReason(''), null);
eq('invisible characters do not hide a session',
   nonRoleReason('Rotational Program - Virtual\u00A0Information\u200B Session'), 'attendance');

// --- screening a board ------------------------------------------------------
{
  const rows = [
    { id: 'workday-cibc-2616214', firm: 'CIBC', role: DROP[0], slug: 'cibc-x' },
    { id: 'workday-citi-25843180', firm: 'Citi', role: 'Job Requisition: 25843173 Citi India Apprenticeship Program - SS Ops', slug: 'citi-job-requisition-25843173-citi-india-apprenticeship-program-ss-ops' },
    { id: 'tal-blackrock-1', firm: 'BlackRock', role: 'Spring Insight Event', slug: 'blackrock-spring-insight-event' },
  ];
  const before = JSON.stringify(rows);
  const { kept, dropped, cleaned } = screenRoles(rows);
  eq('one dropped, two kept', [dropped.length, kept.length], [1, 2]);
  eq('the dropped row says why', dropped[0].reason, 'attendance');
  eq('the cleaned row keeps its id', kept[0].id, 'workday-citi-25843180');
  eq('  …and its slug, which the registry pins to the id', kept[0].slug, 'citi-job-requisition-25843173-citi-india-apprenticeship-program-ss-ops');
  eq('  …with the new title', kept[0].role, 'Citi India Apprenticeship Program - SS Ops');
  eq('the cleaning is reported', cleaned.map((c) => c.to), ['Citi India Apprenticeship Program - SS Ops']);
  eq('the input rows are not mutated', JSON.stringify(rows), before);
  eq('screening is idempotent', screenRoles(kept).kept, kept);
}

// --- the archive forgets records that were never roles ---------------------
{
  const previous = {
    'cibc-x': { id: 'workday-cibc-2616214', slug: 'cibc-x', firm: 'CIBC', role: DROP[0], firstSeen: '2026-09-11', lastSeen: '2026-09-20' },
    'citi-2025-markets-internship-colombia': { id: 'workday-citi-25836348', slug: 'citi-2025-markets-internship-colombia', firm: 'Citi', role: '2025 Markets Internship Colombia', firstSeen: '2026-09-01', lastSeen: '2026-09-10' },
  };
  const { roles, screened } = updateArchive(previous, [], new Map(), '2026-09-21');
  eq('an archived information session is removed', 'cibc-x' in roles, false);
  eq('  …and counted', screened, 1);
  eq('a departed real role stays archived', 'citi-2025-markets-internship-colombia' in roles, true);
  eq('isNonRoleTitle agrees with nonRoleReason', [isNonRoleTitle(DROP[0]), isNonRoleTitle('Spring Insight Event')], [true, false]);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
