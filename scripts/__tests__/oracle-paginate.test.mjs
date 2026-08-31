/**
 * Oracle Recruiting Cloud pagination and mapping.
 *
 * The fixture is the real JPMorgan payload, trimmed. The termination rules are
 * the interesting part: a board that ignores `offset` replays page one forever,
 * and this runs unattended in CI against live boards.
 */
import { firmKey, oracleToJob, paginateOracle } from '../sync-ats.mjs';

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
};

const QUERIES = ['q'];
const bundle = (reqs, total) => ({ items: [{ TotalJobsCount: total, requisitionList: reqs }] });
const req = (id) => ({ Id: id, Title: `Role ${id}` });

// --- the shape the API actually returns -----------------------------------
{
  const pages = [bundle([req(1), req(2)], 2)];
  const seen = await paginateOracle(async () => pages.shift() ?? bundle([], 2), { queries: QUERIES, page: 2 });
  eq('reads requisitionList out of items[0]', [...seen.keys()], ['1', '2']);
}

// --- the landmine ---------------------------------------------------------
// Dropping `expand` returns 200 with a full facet payload and NO requisitionList.
// A firm with thousands of roles then reads as a firm with none, silently.
{
  const noExpand = { items: [{ TotalJobsCount: 3679, Facets: [], SearchId: 'x' }] };
  const seen = await paginateOracle(async () => noExpand, { queries: QUERIES });
  eq('a payload with no requisitionList yields nothing rather than throwing', seen.size, 0);
}

// --- termination ----------------------------------------------------------
{
  let calls = 0;
  // A deployment that ignores offset: same page, forever.
  const seen = await paginateOracle(async () => { calls++; return bundle([req(1), req(2)], 999); },
    { queries: QUERIES, page: 2, maxPages: 50 });
  eq('a page that adds nothing new stops the loop', seen.size, 2);
  eq('  …after exactly two calls', calls, 2);
}
{
  let offsets = [];
  const seen = await paginateOracle(async (q, offset) => {
    offsets.push(offset);
    return bundle([req(offset + 1), req(offset + 2)], 6);
  }, { queries: QUERIES, page: 2, maxPages: 50 });
  eq('offset advances by the page size', offsets, [0, 2, 4]);
  eq('and stops at TotalJobsCount', seen.size, 6);
}
{
  const seen = await paginateOracle(async () => bundle([req(1)], 100), { queries: QUERIES, page: 25 });
  eq('a short page ends the query', seen.size, 1);
}
{
  const seen = await paginateOracle(async () => { throw new Error('502'); }, { queries: ['a', 'b'] });
  eq('a failing query is skipped, not fatal', seen.size, 0);
}
{
  let n = 0;
  const seen = await paginateOracle(async (q, offset) => bundle([req(`${q}-${offset}`)], 999),
    { queries: ['a', 'b'], page: 1, maxPages: 3 });
  eq('queries are unioned and deduped by Id', [...seen.keys()], ['a-0', 'a-1', 'a-2', 'b-0', 'b-1', 'b-2']);
}
{
  const seen = await paginateOracle(async (q, offset) => bundle([req(`${offset}`)], 999),
    { queries: QUERIES, page: 1, maxPages: 100, maxPostings: 4 });
  eq('the whole-firm budget is respected', seen.size, 4);
}

// --- mapping, against the real payload ------------------------------------
{
  const LIVE = {
    Id: '210784896',
    Title: '2027 Data and AI Program - Summer Analyst (Singapore)',
    PostedDate: '2026-08-30',
    PostingEndDate: null,
    PrimaryLocation: 'Singapore, Singapore',
    PrimaryLocationCountry: 'SG',
    JobFamily: 'Software Engineering',
    ShortDescriptionStr: 'Join our team.',
    ExternalQualificationsStr: 'A degree.',
  };
  const job = oracleToJob(LIVE, { host: 'jpmc.fa.oraclecloud.com', site: 'CX_1001' });
  eq('id is a string', job.id, '210784896');
  eq('apply url points at the SPA route a human can open', job.url,
     'https://jpmc.fa.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1001/job/210784896');
  eq('an exact posted date is taken as-is', job.postedAt, '2026-08-30');
  eq('a null PostingEndDate becomes no deadline', job.deadline, undefined);
  eq('description concatenates the prose fields', job.description, 'Join our team. A degree.');
  eq('JobFamily becomes the department tag', job.department, 'Software Engineering');
}
{
  const job = oracleToJob({ Id: 1, Title: 'X', PostingEndDate: '2026-11-30' }, { host: 'h', site: 's' });
  eq('a populated PostingEndDate is carried through', job.deadline, '2026-11-30');
  eq('missing fields degrade to empty rather than undefined strings', [job.title, job.location], ['X', '']);
}

// --- the id namespace -----------------------------------------------------
// Every family added after Greenhouse/Workday lacked token and tenant, so the
// id template interpolated `undefined` and put every tal.net firm in one
// namespace. A shared opportunity number would silently overwrite between firms.
eq('a greenhouse token is unchanged', firmKey({ token: 'point72' }), 'point72');
eq('a workday tenant is unchanged', firmKey({ tenant: 'citi' }), 'citi');
eq('token wins over tenant so existing ids are stable',
   firmKey({ token: 'a', tenant: 'b', host: 'c' }), 'a');
eq('a talnet host becomes the key', firmKey({ host: 'nomuracampus.tal.net' }), 'nomuracampus-tal-net');
eq('  …and differs per tenant', firmKey({ host: 'morganstanley.tal.net' }), 'morganstanley-tal-net');
eq('an eightfold domain becomes the key', firmKey({ domain: 'mlp.com' }), 'mlp-com');
eq('a bare firm name is the last resort', firmKey({ firm: 'Jane Street' }), 'jane-street');
eq('nothing at all still yields a key', firmKey({}), 'unknown');

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
