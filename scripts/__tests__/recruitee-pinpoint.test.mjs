/**
 * The Recruitee and Pinpoint readers, offline.
 *
 *   node scripts/__tests__/recruitee-pinpoint.test.mjs
 *
 * The fixtures are cut down from the real boards read on 20 November 2026
 * (PAI Partners and bunq on Recruitee, Cinven on Pinpoint, and the sample
 * board an unused Pinpoint account serves). What they pin: what a posting
 * becomes, which notices are refused, that the sample board can never become
 * roles, and that the discovery rules recognise both families from a link.
 */

import { recruiteeDate, recruiteeLocation, recruiteeToJobs, recruiteeUrl } from '../../lib/recruitee.mjs';
import { isPinpointSample, pinpointLocation, pinpointToJobs, pinpointUrl } from '../../lib/pinpoint.mjs';
import { boardApiUrl, detectBoard } from '../../lib/ats-discover.mjs';
import { FETCHERS, readsExperienced, toOpportunity } from '../sync-ats.mjs';

let pass = 0;
let fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
};

/* -------------------------------- Recruitee -------------------------------- */

const offer = (id, title, extra = {}) => ({
  id,
  title,
  status: 'published',
  company_name: 'PAI PARTNERS SAS',
  department: 'Finance',
  careers_url: `https://careers.paipartners.com/o/${id}`,
  published_at: '2026-10-26 09:49:56 UTC',
  close_at: null,
  locations: [{ city: 'Luxembourg', country: 'Luxembourg' }],
  ...extra,
});

const pai = {
  offers: [
    offer(2790715, 'Valuation Intern | Paris | 6 Months | Starting January 2027'),
    offer(2745513, 'CLOSED: Munich Investment Group Internship (Large Cap + MMF) | 3-months | Q4-27', {
      locations: [{ city: 'Munich', country: 'Germany' }],
    }),
    offer(2782343, 'Talent & Development HR Internship | 6 Months', {
      locations: [{ city: 'Paris', country: 'France' }, { city: 'London', country: 'United Kingdom' }],
    }),
    offer(9, 'Draft role', { status: 'draft' }),
    offer(10, 'Analyst', { company_name: 'Another Company Ltd' }),
    offer(11, '   '),
    offer(12, 'No link', { careers_url: null, careers_apply_url: null }),
  ],
};

const jobs = recruiteeToJobs(pai);
eq('the URL is the board subdomain\'s offers endpoint', recruiteeUrl('paipartnerssas'), 'https://paipartnerssas.recruitee.com/api/offers/');
eq('a published offer becomes a job; a closed notice, a draft, another company, a blank title and no link do not',
  jobs.map((j) => j.id), ['2790715', '2782343']);
eq('the job carries the employer\'s own careers URL', jobs[0].url, 'https://careers.paipartners.com/o/2790715');
eq('Recruitee\'s date is read as ISO', recruiteeDate('2026-11-13 14:53:05 UTC'), '2026-11-13T14:53:05Z');
eq('an unreadable date is no date', recruiteeDate('soon'), undefined);
eq('several locations are listed once each', jobs[1].location, 'Paris, France; London, United Kingdom');
eq('without a locations list, city and country are used', recruiteeLocation({ city: 'Amsterdam', country: 'Netherlands' }), 'Amsterdam, Netherlands');
eq('a "(Closed)" prefix is refused too', recruiteeToJobs({ offers: [offer(1, '(Closed) Summer Analyst')] }).length, 0);
eq('an empty or malformed board is no jobs, not an error', [recruiteeToJobs({}).length, recruiteeToJobs(null).length], [0, 0]);

{
  const firm = { firm: 'PAI Partners', ats: 'recruitee', token: 'paipartnerssas', tier: 'Megafund' };
  const row = toOpportunity(jobs[0], firm);
  eq('a valuation internship is published as an early-career row with the employer\'s link',
    [row?.programmeType, row?.applicationUrl, row?.openingDate], ['Summer Internship', 'https://careers.paipartners.com/o/2790715', '2026-10-26']);
  eq('a Recruitee board at a sponsor is read for experienced roles', readsExperienced(firm), true);
}

/* --------------------------------- Pinpoint -------------------------------- */

const cinven = {
  data: [
    {
      id: '210850',
      title: 'Frankfurt Private Equity Intern ',
      url: 'https://Cinven.pinpointhq.com/en/postings/e422c932-28c4-4af4-bb89-d559bda204a0',
      deadline_at: null,
      employment_type: 'internship',
      description: '<div>Cinven GmbH is a local advisory company to Cinven.</div>',
      location: { id: '26834', city: 'Frankfurt', name: 'Frankfurt', province: 'Frankfurt' },
      job: { id: '228860', requisition_id: 'ID0022', department: { id: '33783', name: 'Investment Team - Internship' } },
    },
  ],
};

// The sample board an opened, unused account serves, in both forms seen.
const sample = (titles) => ({
  data: titles.map((title, i) => ({
    id: String(456950 + i),
    title,
    url: `https://atomico.pinpointhq.com/en/postings/${i}`,
    location: { city: null, name: ['London', 'Paris', 'New York', 'Paris'][i] },
    job: { requisition_id: ['0003', '0002', '0001', '0002'][i], department: { name: 'Finance' } },
  })),
});

eq('the URL is the board subdomain\'s postings feed', pinpointUrl('cinven'), 'https://cinven.pinpointhq.com/postings.json');
{
  const [job] = pinpointToJobs(cinven);
  eq('a posting becomes a job with its title trimmed, department and location',
    [job.id, job.title, job.department, job.location], ['210850', 'Frankfurt Private Equity Intern', 'Investment Team - Internship', 'Frankfurt']);
  const row = toOpportunity(job, { firm: 'Cinven', ats: 'pinpoint', token: 'cinven', tier: 'Megafund' });
  eq('a private equity internship is published, linking to the posting', [row?.level, row?.applicationUrl], ['Internship', cinven.data[0].url]);
}
eq('the plain sample board is recognised', isPinpointSample(sample(['Head of DEI - UK', 'Marketing Manager', 'Customer Service Rep', 'Marketing Executive']).data), true);
eq('the sample board with a firm\'s name spliced in is recognised',
  isPinpointSample(sample(['Investment Oversight Officer, Baillie Gifford Europe', 'Early Careers: Graduate programme', 'Compliance & Risk Officer, Baillie Gifford Europe', 'Marketing Executive']).data), true);
{
  let threw = false;
  try { pinpointToJobs(sample(['Head of DEI - UK', 'Early Careers: Graduate programme', 'Customer Service Rep'])); } catch { threw = true; }
  eq('the sample board throws, so it reads as a failed board and never as roles', threw, true);
}
eq('a real board is not the sample', isPinpointSample(cinven.data), false);
eq('a real board in London on its own numbering is not the sample',
  isPinpointSample([{ title: 'Analyst', location: { name: 'London' }, job: { requisition_id: 'ID0007' } }]), false);
eq('a location without a city keeps its name', pinpointLocation({ city: null, name: 'London' }), 'London');

/* -------------------------- discovery and wiring -------------------------- */

eq('a Recruitee link is recognised', detectBoard('https://paipartnerssas.recruitee.com/o/valuation-intern'), { ats: 'recruitee', token: 'paipartnerssas' });
eq('a Pinpoint link is recognised, the subdomain lower-cased', detectBoard('https://Cinven.pinpointhq.com/en/postings/e422c932'), { ats: 'pinpoint', token: 'cinven' });
eq('Pinpoint\'s own marketing site is not a board', detectBoard('https://www.pinpointhq.com/customers'), null);
eq('discovery proves both families against the same endpoints the collector reads',
  [boardApiUrl({ ats: 'recruitee', token: 'bunq' }), boardApiUrl({ ats: 'pinpoint', token: 'cinven' })],
  [recruiteeUrl('bunq'), pinpointUrl('cinven')]);
eq('the collector has a fetcher for both', [typeof FETCHERS.recruitee, typeof FETCHERS.pinpoint], ['function', 'function']);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
