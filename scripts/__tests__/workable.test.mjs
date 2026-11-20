/**
 * The Workable reader, offline.
 *
 *   node scripts/__tests__/workable.test.mjs
 *
 * The fixtures follow Workable's widget schema, which the live boards read on
 * 20 November 2026 (Capula, Hayfin) carry key for key. What is pinned: an
 * answer of any other shape throws (a failed board, which carries nothing),
 * and one posting listed once per city becomes one job naming every city.
 */

import { workableLocation, workableToJobs, workableUrl } from '../../lib/workable.mjs';
import { FETCHERS, readsExperienced, toOpportunity } from '../sync-ats.mjs';

let pass = 0;
let fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
};
const throws = (fn) => { try { fn(); return false; } catch { return true; } };

const job = (shortcode, title, extra = {}) => ({
  title,
  shortcode,
  department: 'Trading',
  url: `https://apply.workable.com/j/${shortcode}`,
  shortlink: `https://apply.workable.com/j/${shortcode}`,
  application_url: `https://apply.workable.com/j/${shortcode}/apply`,
  published_on: '2026-11-10',
  created_at: '2026-11-08',
  city: 'London',
  state: 'England',
  country: 'United Kingdom',
  telecommuting: false,
  locations: [{ city: 'London', region: 'England', country: 'United Kingdom', countryCode: 'GB', hidden: false }],
  ...extra,
});

const board = {
  name: 'Capula Investment Management LLP',
  jobs: [
    job('A1B2C3', 'Graduate Analyst, Quantitative Research'),
    job('D4E5F6', 'Portfolio Manager', { locations: [{ city: 'Greenwich', country: 'United States', hidden: false }, { city: 'London', country: 'United Kingdom', hidden: false }, { city: 'Secret', country: 'Nowhere', hidden: true }] }),
    job('', 'No code'),
    job('G7H8', '   '),
    job('J9K0', 'No link', { url: '', shortlink: '', application_url: '' }),
  ],
};

eq('the URL is the public widget endpoint, account escaped', workableUrl('capula-investment-management-ltd'), 'https://apply.workable.com/api/v1/widget/accounts/capula-investment-management-ltd');
const jobs = workableToJobs(board);
eq('a job needs a code, a title and a link', jobs.map((j) => j.id), ['A1B2C3', 'D4E5F6']);
eq('a job becomes the common shape', jobs[0], {
  id: 'A1B2C3', title: 'Graduate Analyst, Quantitative Research', location: 'London, United Kingdom',
  url: 'https://apply.workable.com/j/A1B2C3', department: 'Trading', postedAt: '2026-11-10', description: '',
});
eq('every visible location is listed once; a hidden one never', jobs[1].location, 'Greenwich, United States; London, United Kingdom');
{
  const multi = workableToJobs({ jobs: ['London|United Kingdom', 'New York|United States', 'Singapore|Singapore', 'London|United Kingdom'].map((c) => {
    const [city, country] = c.split('|');
    return job('A15A62A8BE', '2027 Trading and Research Summer Internship', { city, country, locations: [{ city, country, hidden: false }] });
  }) });
  eq('one posting listed once per city is one job', multi.length, 1);
  eq('naming every city once, in the order listed', multi[0].location, 'London, United Kingdom; New York, United States; Singapore');
}
eq('remote is said', workableLocation({ city: 'London', country: 'United Kingdom', telecommuting: true }), 'London, United Kingdom (Remote)');
eq('an answer that is not the widget shape throws (a failed board, nothing published)',
  [throws(() => workableToJobs({ error: 'rate limited' })), throws(() => workableToJobs(null)), throws(() => workableToJobs({ jobs: 'x' }))], [true, true, true]);
eq('an empty board is no jobs, not an error', workableToJobs({ name: 'X', jobs: [] }).length, 0);
{
  const firm = { firm: 'Capula Investment Management', ats: 'workable', token: 'capula-investment-management-ltd', tier: 'Multi-Manager' };
  const row = toOpportunity(jobs[0], firm);
  eq('a graduate quant seat is published, linking to the posting', [row?.programmeType, row?.applicationUrl], ['Graduate Programme', 'https://apply.workable.com/j/A1B2C3']);
  eq('a Workable board at a fund is read for experienced roles', readsExperienced(firm), true);
}
eq('the collector has a fetcher for it', typeof FETCHERS.workable, 'function');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
