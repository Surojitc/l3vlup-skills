/**
 * Workday pagination, and the four ways it must stop.
 *
 * The old loop read fixed offsets [0, 20] — 40 postings from boards holding
 * hundreds, so which roles reached the tracker was decided by Workday's result
 * order. Paginating properly means the loop now has to terminate on its own,
 * against real boards, in CI. These are the cases that make that safe.
 */
import { paginateWorkday } from '../sync-ats.mjs';

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `   got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
};

/** A board of `total` postings that honours limit/offset. */
const board = (total) => {
  let calls = 0;
  const fetchPage = async (_q, offset, limit) => {
    calls++;
    const jobPostings = [];
    for (let i = offset; i < Math.min(offset + limit, total); i++) {
      jobPostings.push({ externalPath: `/job/R-${i}`, title: `Analyst ${i}` });
    }
    return { total, jobPostings };
  };
  return { fetchPage, calls: () => calls };
};

const one = { queries: ['intern'], page: 10 };

// Walks the whole board rather than the first page.
{
  const b = board(95);
  const seen = await paginateWorkday(b.fetchPage, one);
  eq('collects every posting on a 95-posting board', seen.size, 95);
}

// The old behaviour, for contrast: two fixed pages would have stopped at 20.
{
  const b = board(400);
  const seen = await paginateWorkday(b.fetchPage, { ...one, maxPages: 15 });
  eq('reads far past the old 2-page ceiling', seen.size, 150);
}

// Stop 1: the board reports a total and we reach it.
{
  const b = board(25);
  const seen = await paginateWorkday(b.fetchPage, one);
  eq('stops at the reported total', seen.size, 25);
  eq('...without an extra probe past the end', b.calls(), 3);
}

// Stop 2: a short page means the end, even with no total.
{
  const fetchPage = async (_q, offset, limit) => ({
    jobPostings: offset === 0 ? Array.from({ length: limit }, (_, i) => ({ externalPath: `/j/${i}` }))
                              : [{ externalPath: '/j/last' }],
  });
  const seen = await paginateWorkday(fetchPage, one);
  eq('a short page ends the walk when no total is given', seen.size, 11);
}

// Stop 3: THE important one. A board that ignores offset replays page one
// forever; without the no-new-results check this loops until maxPages and
// hammers the board for nothing.
{
  let calls = 0;
  const fetchPage = async () => {
    calls++;
    return { jobPostings: [{ externalPath: '/j/1' }, { externalPath: '/j/2' }] };
  };
  const seen = await paginateWorkday(fetchPage, { queries: ['intern'], page: 2, maxPages: 50 });
  eq('a board replaying page one stops after the repeat', seen.size, 2);
  eq('...having made 2 calls, not 50', calls, 2);
}

// Stop 4: an empty first page.
{
  const seen = await paginateWorkday(async () => ({ total: 0, jobPostings: [] }), one);
  eq('an empty board yields nothing and does not hang', seen.size, 0);
}

// A failing query must not abort the remaining queries.
{
  let calls = 0;
  const fetchPage = async (q) => {
    calls++;
    if (q === 'intern') throw new Error('boom');
    return { total: 1, jobPostings: [{ externalPath: `/j/${q}` }] };
  };
  const seen = await paginateWorkday(fetchPage, { queries: ['intern', 'graduate'], page: 20 });
  eq('one failing query does not abort the rest', seen.size, 1);
}

// Dedupe across queries: the same posting matches several search terms.
{
  const fetchPage = async () => ({ total: 1, jobPostings: [{ externalPath: '/j/same' }] });
  const seen = await paginateWorkday(fetchPage, { queries: ['intern', 'graduate', 'new grad'], page: 20 });
  eq('the same posting found by three queries is stored once', seen.size, 1);
}

// The whole-firm budget caps a very large board.
{
  const b = board(5000);
  const seen = await paginateWorkday(b.fetchPage, { queries: ['a', 'b'], page: 20, maxPages: 100, maxPostings: 120 });
  eq('the per-firm budget caps a huge board', seen.size <= 140, true);
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
