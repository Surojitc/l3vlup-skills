/**
 * Board detection, tested against the URL shapes real careers pages link to.
 *
 * The negatives carry the weight. A wrong tenant does not error — it returns an
 * empty board, which reads as "this firm has no early-career roles" and is
 * indistinguishable from the truth until someone notices a bank has vanished
 * from the tracker.
 */
import { detectBoard, boardApiUrl, detectUnsupportedFamily, firstBoard } from '../../lib/ats-discover.mjs';

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
};

// --- Workday, which is what the banks and funds are on ---------------------
eq('workday plain',
   detectBoard('https://blackstone.wd1.myworkdayjobs.com/Blackstone_Careers'),
   { ats: 'workday', tenant: 'blackstone', shard: 'wd1', site: 'Blackstone_Careers' });
eq('workday with locale segment',
   detectBoard('https://aresmgmt.wd1.myworkdayjobs.com/en-US/External'),
   { ats: 'workday', tenant: 'aresmgmt', shard: 'wd1', site: 'External' });
eq('workday wd5 shard, trailing path ignored',
   detectBoard('https://example.wd5.myworkdayjobs.com/Careers/job/London/Analyst_R-123'),
   { ats: 'workday', tenant: 'example', shard: 'wd5', site: 'Careers' });
eq('workday query string stripped',
   detectBoard('https://example.wd3.myworkdayjobs.com/Grads?q=analyst'),
   { ats: 'workday', tenant: 'example', shard: 'wd3', site: 'Grads' });

// --- the others ------------------------------------------------------------
eq('greenhouse', detectBoard('https://boards.greenhouse.io/stripe'), { ats: 'greenhouse', token: 'stripe' });
eq('greenhouse new host', detectBoard('https://job-boards.greenhouse.io/Databricks'), { ats: 'greenhouse', token: 'databricks' });
eq('lever', detectBoard('https://jobs.lever.co/notion/abc-123'), { ats: 'lever', token: 'notion' });
eq('lever eu host', detectBoard('https://jobs.eu.lever.co/imc'), { ats: 'lever', token: 'imc' });
eq('ashby', detectBoard('https://jobs.ashbyhq.com/ramp/1234'), { ats: 'ashby', token: 'ramp' });

// --- must NOT resolve ------------------------------------------------------
eq('a firm careers page is not a board', detectBoard('https://www.goldmansachs.com/careers/students'), null);
eq('oracle cloud is not a board we poll', detectBoard('https://jpmc.fa.oraclecloud.com/hcmUI/CandidateExperience'), null);
eq('linkedin is not a board', detectBoard('https://www.linkedin.com/jobs/view/123'), null);
eq('empty', detectBoard(''), null);
eq('not a url', detectBoard('careers'), null);

// --- unsupported families are named, not silently dropped ------------------
eq('oracle named', detectUnsupportedFamily('https://jpmc.fa.oraclecloud.com/hcmUI/x'), 'oracle-cloud');
eq('successfactors named', detectUnsupportedFamily('https://career5.successfactors.eu/career'), 'successfactors');
eq('icims named', detectUnsupportedFamily('https://careers-firm.icims.com/jobs'), 'icims');
eq('eightfold named', detectUnsupportedFamily('https://firm.eightfold.ai/careers'), 'eightfold');
eq('a real board is not "unsupported"', detectUnsupportedFamily('https://boards.greenhouse.io/stripe'), null);

// --- endpoints -------------------------------------------------------------
eq('greenhouse endpoint', boardApiUrl({ ats: 'greenhouse', token: 'stripe' }),
   'https://boards-api.greenhouse.io/v1/boards/stripe/jobs?content=false');
eq('workday endpoint is the CxS path',
   boardApiUrl({ ats: 'workday', tenant: 'blackstone', shard: 'wd1', site: 'Blackstone_Careers' }),
   'https://blackstone.wd1.myworkdayjobs.com/wday/cxs/blackstone/Blackstone_Careers/jobs');
eq('unknown ats has no endpoint', boardApiUrl({ ats: 'oracle-cloud' }), null);
eq('null board', boardApiUrl(null), null);

// --- scraping a careers page ----------------------------------------------
const page = `<html><body>
  <a href="https://www.linkedin.com/company/firm">LinkedIn</a>
  <a href="https://boards.greenhouse.io/firmtech">Tech roles</a>
  <a href="https://firm.wd3.myworkdayjobs.com/en-GB/Campus">Students &amp; graduates</a>
</body></html>`;
eq('prefers Workday over Greenhouse on a mixed page',
   firstBoard(page, 'https://firm.com/careers'),
   { ats: 'workday', tenant: 'firm', shard: 'wd3', site: 'Campus' });
eq('falls back to whatever is there',
   firstBoard('<a href="https://jobs.lever.co/firm">Jobs</a>', 'https://firm.com/careers'),
   { ats: 'lever', token: 'firm' });
eq('a page with no board resolves to nothing',
   firstBoard('<html><p>Email us at grads@firm.com</p></html>', 'https://firm.com/careers'), null);
eq('protocol-relative link is still found',
   firstBoard('<script src="//firm.wd1.myworkdayjobs.com/External"></script>', null),
   { ats: 'workday', tenant: 'firm', shard: 'wd1', site: 'External' });

// --- choosing between a firm's several Workday sites -----------------------
// Every case here is drawn from the first live run, which put Bank of America
// on 'lateral-us' and Moelis on 'Experienced-Hires'. Both validated — they are
// real boards with hundreds of postings — so nothing downstream could tell.
eq('the campus site wins even when the lateral one is linked first',
   firstBoard(`<a href="https://ghr.wd1.myworkdayjobs.com/lateral-us">Experienced professionals</a>
               <a href="https://ghr.wd1.myworkdayjobs.com/Campus_Careers">Students</a>`, null),
   { ats: 'workday', tenant: 'ghr', shard: 'wd1', site: 'Campus_Careers' });
eq('Experienced-Hires loses to anything else',
   firstBoard(`<a href="https://moelis.wd1.myworkdayjobs.com/Experienced-Hires">Exp</a>
               <a href="https://moelis.wd1.myworkdayjobs.com/Campus">Campus</a>`, null),
   { ats: 'workday', tenant: 'moelis', shard: 'wd1', site: 'Campus' });
eq('with no campus site, a neutral one still beats the lateral one',
   firstBoard(`<a href="https://firm.wd1.myworkdayjobs.com/lateral-us">A</a>
               <a href="https://firm.wd1.myworkdayjobs.com/External">B</a>`, null),
   { ats: 'workday', tenant: 'firm', shard: 'wd1', site: 'External' });
// Visible and wrong beats absent: someone can correct a board they can see.
eq('a lateral board is still taken when it is the only one',
   firstBoard('<a href="https://firm.wd1.myworkdayjobs.com/lateral-us">A</a>', null),
   { ats: 'workday', tenant: 'firm', shard: 'wd1', site: 'lateral-us' });
eq('site preference does not override the Workday-over-Greenhouse rule',
   firstBoard(`<a href="https://boards.greenhouse.io/firmcampus">Campus</a>
               <a href="https://firm.wd1.myworkdayjobs.com/lateral-us">Lateral</a>`, null),
   { ats: 'workday', tenant: 'firm', shard: 'wd1', site: 'lateral-us' });

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
