// The daily health check's judgements: lib/data-health.mjs.
import { productionLag, letterFunnel, LAG_HOURS } from '../../lib/data-health.mjs';

let failed = 0, passed = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${JSON.stringify(detail)}`}`);
  ok ? passed++ : failed++;
};
const now = new Date('2026-11-08T18:00:00Z');

let r = productionLag({ main: '2026-11-07T23:32:07Z', mainCommitted: '2026-11-07T23:40:00Z', live: '2026-11-07T23:32:07Z', now });
check('live equal to main is healthy', !r.problem && !r.warning, r);
r = productionLag({ main: '2026-11-08T16:00:00Z', mainCommitted: '2026-11-08T16:10:00Z', live: '2026-11-07T23:32:07Z', now });
check(`a lag inside the ${LAG_HOURS}h the caches may take is not a failure`, !r.problem, r);
r = productionLag({ main: '2026-11-07T06:00:00Z', mainCommitted: '2026-11-07T06:30:00Z', live: '2026-10-11T18:08:50Z', now });
check('the live site a month behind main, hours after it landed, fails', Boolean(r.problem), r);
r = productionLag({ main: null, live: '2026-11-07T23:32:07Z', now });
check('main unreadable fails', Boolean(r.problem), r);
r = productionLag({ main: '2026-11-07T23:32:07Z', live: null, now });
check('a page with no date warns, not fails', !r.problem && Boolean(r.warning), r);
r = productionLag({ main: '2026-11-07T23:32:07Z', live: '2026-11-07T23:00:00Z', now });
check('under an hour apart is the same collection', !r.problem && !r.warning, r);

r = productionLag({ main: '2026-11-07T23:32:07Z', mainCommitted: '2026-11-07T23:40:00Z', live: '2026-11-07', now });
check('a page printing the same day alone matches', !r.problem && !r.warning, r);
r = productionLag({ main: '2026-11-07T06:00:00Z', mainCommitted: '2026-11-07T06:30:00Z', live: '2026-11-06', now });
check('a page printing an earlier day, long after main landed, fails', Boolean(r.problem), r);

r = productionLag({ main: '2026-11-07T22:00:00Z', mainCommitted: '2026-11-07T22:10:00Z', live: '2026-11-06', now });
check('a page rebuilt daily, 20 hours after main landed, is not yet a failure', !r.problem, r);

const f = letterFunnel(
  { entries: [{ status: 'review', classification: 'investor-letter' }, { status: 'review', classification: 'other' }, { status: 'published', classification: 'investor-letter' }, { status: 'rejected', classification: 'investor-letter' }] },
  { keys: [{}, {}, {}] },
);
check('the funnel counts queue, likely letters, decided and published', f.queued === 2 && f.likely === 1 && f.decided === 2 && f.published === 3, f);
const empty = letterFunnel(null, null);
check('no queue and no keys is all zeros', empty.queued === 0 && empty.published === 0, empty);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
