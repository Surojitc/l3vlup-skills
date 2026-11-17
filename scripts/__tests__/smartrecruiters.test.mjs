/**
 * The SmartRecruiters reader, offline.
 *
 *   node scripts/__tests__/smartrecruiters.test.mjs
 *
 * The fixtures are written from SmartRecruiters' documented Posting API
 * schema, not recorded from a board (the session that wrote the adapter had no
 * network). What they pin is the reader's own behaviour: when the walk stops,
 * what a posting becomes, and what it refuses. A verification read of a real
 * board comes before any registry row uses the family.
 */

import {
  paginateSmartRecruiters,
  smartRecruitersLocation,
  smartRecruitersToJob,
  smartRecruitersUrl,
} from '../../lib/smartrecruiters.mjs';
import { isEarlyCareer } from '../sync-ats.mjs';
import { boardApiUrl, detectBoard } from '../../lib/ats-discover.mjs';

let pass = 0;
let fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
};

const posting = (id, name, extra = {}) => ({
  id: String(id),
  name,
  company: { identifier: 'PAConsulting', name: 'PA Consulting' },
  location: { city: 'London', region: 'England', country: 'gb', remote: false },
  releasedDate: '2026-10-20T09:00:00.000Z',
  ...extra,
});

// A board of 250 postings served 100 at a time.
function board(n, { ignoreOffset = false } = {}) {
  const all = Array.from({ length: n }, (_, i) => posting(1000 + i, `Role ${i}`));
  const calls = [];
  return {
    calls,
    fetchPage: async (offset, limit) => {
      calls.push(offset);
      const from = ignoreOffset ? 0 : offset;
      return { offset, limit, totalFound: n, content: all.slice(from, from + limit) };
    },
  };
}

eq('the URL is the public postings endpoint, company escaped',
  smartRecruitersUrl('PA Consulting', 200), 'https://api.smartrecruiters.com/v1/companies/PA%20Consulting/postings?limit=100&offset=200');

{
  const b = board(250);
  const stats = {};
  const seen = await paginateSmartRecruiters(b.fetchPage, { stats });
  eq('every posting is read across pages', seen.size, 250);
  eq('and the walk stops at totalFound, without a fourth request', b.calls, [0, 100, 200]);
  eq('three requests counted', stats.attempts, 3);
}
{
  const b = board(250, { ignoreOffset: true });
  const seen = await paginateSmartRecruiters(b.fetchPage);
  eq('a server that ignores offset is read once, not replayed to the budget', [seen.size, b.calls.length], [100, 2]);
}
{
  const b = board(1000);
  const stats = {};
  const seen = await paginateSmartRecruiters(b.fetchPage, { stats });
  eq('the per-firm budget holds, and is reported', [seen.size, stats.capped], [600, true]);
}
{
  const seen = await paginateSmartRecruiters(async () => ({ totalFound: 0, content: [] }));
  eq('an empty board is one request and nothing', seen.size, 0);
}

eq('a location from its parts, the country spelled out for the region rules',
  smartRecruitersLocation({ city: 'London', region: 'England', country: 'gb' }), 'London, England, United Kingdom');
eq('fullLocation wins when the API gives it',
  smartRecruitersLocation({ fullLocation: 'Cambridge, England, United Kingdom', city: 'Cambridge' }), 'Cambridge, England, United Kingdom');
eq('a region repeating the city is said once', smartRecruitersLocation({ city: 'Singapore', region: 'Singapore', country: 'sg' }), 'Singapore');
eq('remote is kept', smartRecruitersLocation({ country: 'us', remote: true }), 'United States (Remote)');

const f = { firm: 'PA Consulting', ats: 'smartrecruiters', token: 'PAConsulting' };
eq('a posting becomes the common job shape, applied for on SmartRecruiters\' own host',
  smartRecruitersToJob(posting(744000012345, '2027 Industrial Placement - Consulting - London', { department: { label: 'Consulting' } }), f),
  {
    id: '744000012345',
    title: '2027 Industrial Placement - Consulting - London',
    location: 'London, England, United Kingdom',
    url: 'https://jobs.smartrecruiters.com/PAConsulting/744000012345',
    department: 'Consulting',
    postedAt: '2026-10-20T09:00:00.000Z',
    description: '',
  });
eq('a posting filed under another company is refused',
  smartRecruitersToJob(posting(1, 'Graduate Analyst', { company: { identifier: 'SomeoneElse' } }), f), null);
eq('identifiers compare without case', smartRecruitersToJob(posting(2, 'Graduate Analyst', { company: { identifier: 'paconsulting' } }), f)?.id, '2');
eq('a posting with no title is refused', smartRecruitersToJob(posting(3, '   '), f), null);
eq('experienceLevel is not trusted: the title still decides',
  [isEarlyCareer(smartRecruitersToJob(posting(4, 'Senior Consultant', { experienceLevel: { id: 'entry_level' } }), f).title),
   isEarlyCareer(smartRecruitersToJob(posting(5, '2027 Graduate Consultant - Digital Transformation'), f).title)],
  [false, true]);

eq('discovery reads a careers link as a SmartRecruiters board, case kept',
  detectBoard('https://careers.smartrecruiters.com/PAConsulting/'), { ats: 'smartrecruiters', token: 'PAConsulting' });
eq('...and a job link to its board', detectBoard('https://jobs.smartrecruiters.com/EvelynPartners/744000099999-graduate'), { ats: 'smartrecruiters', token: 'EvelynPartners' });
eq('and validates it on the postings endpoint', boardApiUrl({ ats: 'smartrecruiters', token: 'PAConsulting' }),
  'https://api.smartrecruiters.com/v1/companies/PAConsulting/postings?limit=100');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
