/**
 * Eightfold pagination and Jane Street feed parsing.
 *
 * Both fixtures are the real payloads, trimmed. The two cases worth reading are
 * the Eightfold page cap (asking for 100 returns 10, silently) and the Jane
 * Street homoglyph fold.
 */
import { eightfoldToJob, eightfoldUrl, paginateEightfold } from '../../lib/eightfold.mjs';
import {
  deobfuscate,
  expandCity,
  isEarlyCareerAvailability,
  janeStreetToJob,
  parseJaneStreetFeed,
} from '../../lib/janestreet.mjs';

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
};

/* ------------------------------- Eightfold ------------------------------- */
eq('url carries domain, start and num',
   eightfoldUrl('campusjobs.mlp.com', 'mlp.com', 20, 10),
   'https://campusjobs.mlp.com/api/apply/v2/jobs?domain=mlp.com&start=20&num=10');

const pos = (id) => ({ id, name: `Role ${id}`, location: 'London' });
const bundle = (ps, count) => ({ count, positions: ps });

{
  // The board reports 59 and hands back 10 at a time whatever you ask for.
  const starts = [];
  const seen = await paginateEightfold(async (start) => {
    starts.push(start);
    const page = Array.from({ length: 10 }, (_, i) => pos(start + i));
    return bundle(start + 10 >= 59 ? page.slice(0, 9) : page, 59);
  });
  eq('pages through the whole board', seen.size, 59);
  eq('  …advancing start by the page size', starts, [0, 10, 20, 30, 40, 50]);
}
{
  // A board that ignores `start` and replays page one. The page is full, so
  // the short-page rule cannot save us — only the "added nothing new" rule can.
  let calls = 0;
  const full = Array.from({ length: 10 }, (_, i) => pos(i));
  const seen = await paginateEightfold(async () => { calls++; return bundle(full, 999); });
  eq('a repeated full page stops the loop', seen.size, 10);
  eq('  …after exactly two calls', calls, 2);
}
{
  // A short page ends the board even when `count` claims more.
  const seen = await paginateEightfold(async () => bundle([pos(1), pos(2)], 999));
  eq('a short page ends the board', seen.size, 2);
}
eq('an empty board yields nothing', (await paginateEightfold(async () => bundle([], 0))).size, 0);
eq('a throwing page is not fatal', (await paginateEightfold(async () => { throw new Error('500'); })).size, 0);

{
  const LIVE = {
    id: 755957853409,
    name: '2027 Quantitative Developer Intern, London',
    location: 'London, United Kingdom',
    locations: ['London, United Kingdom'],
    department: 'Information Technology',
    t_create: 1785369600,
    job_description: '<p>Join us.</p>',
    canonicalPositionUrl: 'https://mlp.eightfold.ai/careers/job/755957853409',
  };
  const j = eightfoldToJob(LIVE, { host: 'campusjobs.mlp.com' });
  eq('id is a string', j.id, '755957853409');
  eq('canonical url is preferred', j.url, 'https://mlp.eightfold.ai/careers/job/755957853409');
  eq('epoch seconds become an ISO instant', j.postedAt?.slice(0, 10), '2026-07-30');
  eq('department comes through', j.department, 'Information Technology');
}
// t_create in milliseconds would date the posting to the year 58000 and still
// parse as a valid Date. The unit is checked rather than trusted.
eq('a millisecond timestamp is refused',
   eightfoldToJob({ id: 1, name: 'X', t_create: 1785369600000 }).postedAt, undefined);
eq('a missing timestamp is fine', eightfoldToJob({ id: 1, name: 'X' }).postedAt, undefined);
eq('an array of locations is joined',
   eightfoldToJob({ id: 1, name: 'X', locations: ['London', 'NYC'] }).location, 'London, NYC');

/* ------------------------------ Jane Street ------------------------------ */
// The feed writes titles in Lisu lookalikes. Left alone, this reaches a public
// page as mojibake and hides "Machine Learning" from the vertical classifier.
eq('lisu lookalikes fold to latin', deobfuscate('ꓟachine ꓡearning ꓣesearcher'), 'Machine Learning Researcher');
eq('cyrillic lookalikes fold too', deobfuscate('Тrader'), 'Trader');
eq('plain ascii is untouched', deobfuscate('Software Engineer'), 'Software Engineer');
eq('whitespace is collapsed', deobfuscate('  Quant   Trader  '), 'Quant Trader');
eq('non-strings yield empty', deobfuscate(null), '');

eq('city codes expand', expandCity('NYC'), 'New York, United States');
eq('  …including multiples', expandCity('LDN, HKG'), 'London, United Kingdom, Hong Kong');
eq('an unknown code passes through', expandCity('ZZZ'), 'ZZZ');
eq('an empty code yields empty', expandCity(''), '');

// availability is authoritative: a Jane Street title says "Trader" whether the
// seat is graduate or senior.
eq('summer internship is early career', isEarlyCareerAvailability('Summer Internship'), true);
eq('new grad is early career', isEarlyCareerAvailability('Full-Time: New Grad'), true);
eq('winter co-op is early career', isEarlyCareerAvailability('Winter Co-Op'), true);
eq('experienced is not', isEarlyCareerAvailability('Full-Time: Experienced'), false);
eq('missing availability is not', isEarlyCareerAvailability(undefined), false);

{
  const FEED = [
    { id: 8596771002, position: 'ꓟachine ꓡearning ꓣesearcher', city: 'HKG', availability: 'Summer Internship', category: 'Trading, Research, and Machine Learning', overview: '<p>x</p>' },
    { id: 8631912002, position: 'Accounting Coordinator', city: 'NYC', availability: 'Full-Time: Experienced' },
    { id: 1, position: 'Software Engineer', city: 'LDN', availability: 'Full-Time: New Grad' },
  ];
  const jobs = parseJaneStreetFeed(FEED);
  eq('experienced roles are dropped', jobs.length, 2);
  eq('titles are folded', jobs[0].title, 'Machine Learning Researcher');
  eq('cities are expanded', jobs[0].location, 'Hong Kong');
  eq('url is built from the id', jobs[1].url, 'https://www.janestreet.com/join-jane-street/position/1/');
  // The feed has neither; inferring one would invalidate the JobPosting markup.
  eq('no posting date is invented', jobs[0].postedAt, undefined);
  eq('no deadline is invented', jobs[0].deadline, undefined);
  // Without this the shared title filter drops the whole board: none of these
  // titles contains an early-career word, however plainly `availability` said so.
  eq('rows are flagged as already level-checked', jobs.every((j) => j.earlyCareerConfirmed), true);
}
eq('a non-array feed yields nothing', parseJaneStreetFeed({ jobs: [] }), []);
eq('a row with no id is skipped', parseJaneStreetFeed([{ position: 'X', availability: 'Summer Internship' }]), []);

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
