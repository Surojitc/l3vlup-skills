/**
 * Apparent duplicates: which are one posting, and which are one programme
 * posted per city.
 *
 * The Stripe rows are real, from the feed of 2026-09-20: seven slugs an audit
 * read as copies, each its own Greenhouse posting in its own city. They must
 * be reported as a programme in several locations and never as one posting.
 */
import { canonicalPostingUrl, duplicateGroups, titleCore } from '../../lib/role-duplicates.mjs';

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
};

const stripe = (jid, location, role = 'Software Engineer, New Grad') => ({
  id: `greenhouse-stripe-${jid}`,
  firm: 'Stripe',
  role,
  location,
  applicationUrl: `https://stripe.com/jobs/search?gh_jid=${jid}`,
});
const STRIPE = [
  stripe(8128744, 'San Francisco, Seattle, New York'),
  stripe(8157838, 'Toronto'),
  stripe(8130881, 'Dublin'),
  stripe(8160776, 'Singapore'),
  stripe(8130922, 'Bucharest'),
  stripe(8130930, 'London'),
  stripe(8130927, 'Barcelona', 'Software Engineer, New Grad - Frontend'),
];

{
  const g = duplicateGroups(STRIPE);
  eq('the Stripe new-grad rows are not one posting', g.samePosting.length, 0);
  eq('  …they are one programme posted in several cities', g.sameTitleManyLocations.length, 1);
  eq('  …of six rows, the Frontend role being a different role', g.sameTitleManyLocations[0].rows.length, 6);
  eq('  …and no two share a city', g.sameTitleSameLocation.length, 0);
}

// --- one posting collected twice -------------------------------------------
{
  // The shape a firm registered twice would produce: two ids, one URL.
  const a = stripe(8128744, 'San Francisco');
  const b = { ...a, id: 'greenhouse-stripe-payments-8128744', applicationUrl: 'https://STRIPE.com/jobs/search?gh_jid=8128744&utm_source=x#apply' };
  const g = duplicateGroups([a, b]);
  eq('two ids with one application URL are one posting', g.samePosting.length, 1);
  eq('  …keyed by the canonical URL', g.samePosting[0].key, 'url:https://stripe.com/jobs/search?gh_jid=8128744');
  eq('the same id twice is one posting', duplicateGroups([a, { ...a }]).samePosting.length, 1);
  eq('  …reported once, not once per rule', duplicateGroups([a, { ...a }]).samePosting.length, 1);
}

// --- same title, same city, different requisitions -------------------------
{
  // Real: Houlihan Lokey, Amsterdam, two requisitions two days apart.
  const rows = [
    { id: 'workday-hl-R3560', firm: 'Houlihan Lokey', role: '3-Month Off-Cycle Internship - Corporate Finance', location: 'Amsterdam, Netherlands', applicationUrl: 'https://hl.wd1.myworkdayjobs.com/Campus/job/Amsterdam-Netherlands/XMLNAME-3-Month-Off-Cycle-Internship---Corporate-Finance_R3560' },
    { id: 'workday-hl-R3549', firm: 'Houlihan Lokey', role: '3-Month Off-Cycle Internship - Corporate Finance', location: 'Amsterdam, Netherlands', applicationUrl: 'https://hl.wd1.myworkdayjobs.com/Campus/job/Amsterdam-Netherlands/XMLNAME-3-Month-Off-Cycle-Internship---Corporate-Finance_R3549' },
  ];
  const g = duplicateGroups(rows);
  eq('two requisitions for one seat are reported, not merged', [g.samePosting.length, g.sameTitleSameLocation.length], [0, 1]);
  eq('  …in id order', g.sameTitleSameLocation[0].rows.map((r) => r.id), ['workday-hl-R3549', 'workday-hl-R3560']);
}

// --- determinism -----------------------------------------------------------
{
  const shuffled = [...STRIPE].reverse();
  eq('the same rows in another order give the same groups',
     JSON.stringify(duplicateGroups(shuffled)), JSON.stringify(duplicateGroups(STRIPE)));
}

// --- title cores -----------------------------------------------------------
eq('a trailing city that is the row’s own location is dropped',
   titleCore('2027 Point72 Academy Investment Analyst Summer Internship Program - Hong Kong', 'Hong Kong'),
   '2027 point72 academy investment analyst summer internship program');
eq('a region in parentheses is dropped',
   titleCore('Summer Analyst (EMEA)', 'London'), 'summer analyst');
eq('a trailing specialism is not a place and stays',
   titleCore('Software Engineer, New Grad - Frontend', 'Barcelona'), 'software engineer new grad frontend');
eq('a comma phrase that is not a place stays',
   titleCore('Software Engineer, New Grad', 'Toronto'), 'software engineer new grad');

// --- URLs ------------------------------------------------------------------
eq('the posting id in a query survives', canonicalPostingUrl('https://stripe.com/jobs/search?gh_jid=1'), 'https://stripe.com/jobs/search?gh_jid=1');
eq('tracking, fragment and trailing slash do not', canonicalPostingUrl('https://Jobs.Lever.co/x/abc/?utm_medium=a&lever-source=b#top'), 'https://jobs.lever.co/x/abc');
eq('no URL is no key', canonicalPostingUrl(undefined), null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
