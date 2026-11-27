/**
 * The hosts an agent must not request (lib/restricted-hosts.mjs): every board
 * the terms review excluded is caught before a request, suffixes match only on a
 * dot boundary, and the CLI's exit code stops a script.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { RESTRICTED_HOSTS, verdictFor } from '../../lib/restricted-hosts.mjs';

let pass = 0, fail = 0;
const check = (name, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); ok ? pass++ : fail++; };

for (const u of ['https://jobs.sequoiacap.com/jobs', 'jobs.lsvp.com', 'https://careers.balderton.com/', 'https://jobs.accel.com/companies',
  'https://vistaequitypartners.getro.com/jobs', 'https://www.linkedin.com/jobs/view/1', 'https://api.smartrecruiters.com/v1/companies/x/postings',
  'https://www.mckinsey.com/careers/search-jobs', 'https://www.alvarezandmarsal.com/careers']) {
  check(`blocked before any request: ${u}`, verdictFor(u) === 'blocked');
}
check('Workday is ask, not allowed', verdictFor('https://pwc.wd3.myworkdayjobs.com/Global_Campus_Careers') === 'ask');
check('a Greenhouse board is allowed', verdictFor('https://boards-api.greenhouse.io/v1/boards/brattle/jobs') === 'allowed');
check('a suffix matches only on a dot boundary', verdictFor('https://notlinkedin.com/') === 'allowed' && verdictFor('https://uk.linkedin.com/') === 'blocked');
check('an unparseable target is refused, not allowed', verdictFor('http://') === 'blocked');
check('every entry gives a reason', RESTRICTED_HOSTS.every((e) => e.reason.length > 10 && ['blocked', 'ask'].includes(e.verdict)));

// Agreement with the collector's own terms: a method recorded as not permitted
// has its host here.
const terms = JSON.parse(readFileSync(new URL('../../lib/sources/source-terms.json', import.meta.url), 'utf8'));
for (const [method, t] of Object.entries(terms.methods)) {
  if (t.permitted !== false) continue;
  const host = String(t.endpoint).split('/')[0];
  check(`${method} (not permitted in source-terms) is blocked here`, verdictFor(host) === 'blocked');
}

const run = (u) => { try { execFileSync('node', ['lib/restricted-hosts.mjs', u], { stdio: 'pipe' }); return 0; } catch (e) { return e.status; } };
check('the CLI exits 3 for blocked', run('https://jobs.sequoiacap.com') === 3);
check('the CLI exits 2 for ask', run('https://x.wd1.myworkdayjobs.com') === 2);
check('the CLI exits 0 for allowed', run('https://api.lever.co/v0/postings/x') === 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
