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

// REGRESSION (26 September audit): dedupe state is per firm, the replay check
// must be per query. A later query whose first page holds only postings an
// earlier query already collected is NOT a board ignoring the offset. The old
// loop stopped it after one page and recorded it as finished, so the board
// read as complete while the rest of that query was never fetched.
{
  // "intern" returns postings 0-19; "graduate" returns 0-19 again on its first
  // page (all already seen) and 20-34 on its second.
  const byQuery = { intern: 20, graduate: 35 };
  let calls = 0;
  const fetchPage = async (q, offset, limit) => {
    calls++;
    const total = byQuery[q];
    const jobPostings = [];
    for (let i = offset; i < Math.min(offset + limit, total); i++) jobPostings.push({ externalPath: `/job/R-${i}` });
    return { total, jobPostings };
  };
  const stats = { attempts: 0, failures: 0 };
  const seen = await paginateWorkday(fetchPage, { queries: ['intern', 'graduate'], page: 20, stats, retry: { delayMs: 0 } });
  eq('a query whose first page overlaps an earlier query still reads its second page', seen.size, 35);
  eq('...and is not flagged as capped', Boolean(stats.capped), false);
}

// The replay stop still works per query: a board ignoring the offset for the
// second query stops it after one repeat, not at maxPages.
{
  let calls = 0;
  const fetchPage = async (q) => {
    calls++;
    return { jobPostings: q === 'a' ? [{ externalPath: '/a/1' }] : [{ externalPath: '/b/1' }, { externalPath: '/b/2' }] };
  };
  const seen = await paginateWorkday(fetchPage, { queries: ['a', 'b'], page: 2, maxPages: 50, retry: { delayMs: 0 } });
  eq('a replaying query still stops after its repeat', [seen.size, calls], [3, 3]);
}

// One retry: a page that fails once and then answers costs a request, not the
// query. A page that fails twice is a failure, and the board is partial.
{
  const b = board(30);
  let failedOnce = false;
  const flaky = async (q, offset, limit) => {
    if (offset === 20 && !failedOnce) { failedOnce = true; throw new Error('timeout'); }
    return b.fetchPage(q, offset, limit);
  };
  const stats = { attempts: 0, failures: 0, retries: 0 };
  const seen = await paginateWorkday(flaky, { queries: ['intern'], page: 20, stats, retry: { delayMs: 0 } });
  eq('a page that fails once is retried and the walk completes', [seen.size, stats.failures, stats.retries], [30, 0, 1]);
}
{
  const b = board(30);
  const dead = async (q, offset, limit) => {
    if (offset === 20) throw new Error('timeout');
    return b.fetchPage(q, offset, limit);
  };
  const stats = { attempts: 0, failures: 0, retries: 0 };
  const seen = await paginateWorkday(dead, { queries: ['intern'], page: 20, stats, retry: { delayMs: 0 } });
  eq('a page that fails twice is one failure after one retry', [seen.size, stats.failures, stats.retries], [20, 1, 1]);
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
