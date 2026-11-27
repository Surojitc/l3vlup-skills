/**
 * Roland Berger's own careers page, which replaced SmartRecruiters' Posting API
 * for this firm on 27 November 2026 (that host's robots.txt disallows all
 * crawlers but LinkedInBot). The fixture is trimmed from the live page.
 *
 *   node scripts/__tests__/rolandberger.test.mjs
 */
import { readFileSync } from 'node:fs';
import { parseRolandBergerJobs, rolandBergerLevelIsEarly } from '../../lib/rolandberger.mjs';
import { toOpportunity } from '../sync-ats.mjs';

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
};

const html = readFileSync(new URL('./fixtures/rolandberger-jobs.html', import.meta.url), 'utf8');
const jobs = parseRolandBergerJobs(html);

eq('every entry with an apply link is read, and one without is skipped', jobs.length, 3);
const summer = jobs.find((j) => j.id === '744000154944720');
eq('the id is the SmartRecruiters posting id', summer?.url, 'https://jobs.smartrecruiters.com/RolandBerger/744000154944720');
eq('the title is decoded and trimmed', summer?.title, 'Junior Consultant Summer Internship 2027');
eq('the city carries its country', summer?.location, 'London, United Kingdom');
eq("the employer's level confirms an internship", summer?.earlyCareerConfirmed, true);
const mixed = jobs.find((j) => /AI & Data Specialist/.test(j.title));
eq('an entry tagged both graduate and experienced is left to the title', mixed?.earlyCareerConfirmed, undefined);
eq('an entity in a title is decoded', mixed?.title.includes('&amp;'), false);
eq('corporate functions are labelled as such', jobs.find((j) => /Praktikum/.test(j.title))?.department, 'Corporate Functions');

eq('internship level is early', rolandBergerLevelIsEarly('consulting-internship'), true);
eq('graduate hire is early', rolandBergerLevelIsEarly('corporate-functions-graduate-hire'), true);
eq('MBA internship is early', rolandBergerLevelIsEarly('consulting-mba-internship'), true);
eq('an MBA full-time hire is not confirmed', rolandBergerLevelIsEarly('consulting-mba-full-time-hire'), false);
eq('graduate and experienced together is not confirmed', rolandBergerLevelIsEarly('consulting-graduate-hire consulting-experienced-hire'), false);
eq('no level is not confirmed', rolandBergerLevelIsEarly(''), false);
// The employer's level is overridden by a title that names seniority.
const mis = parseRolandBergerJobs('<li data-country="germany" data-level="consulting-graduate-hire"><h1 class="headline"><a href="x">Senior Consultant for cost/value management</a></h1><p class="subline">Munich</p><a href="https://jobs.smartrecruiters.com/RolandBerger/1">Apply</a></li>');
eq('a senior title tagged graduate-hire is not confirmed', mis[0]?.earlyCareerConfirmed, undefined);
eq('a page with nothing on it reads as no jobs', parseRolandBergerJobs('<html></html>'), []);

// The id a row gets is the one the API route gave it, so its tracker URL is unchanged.
const board = { firm: 'Roland Berger', ats: 'rolandberger', idAts: 'smartrecruiters', token: 'RolandBerger', tier: 'Consulting' };
const row = toOpportunity(summer, board);
eq('the row id stays in the SmartRecruiters namespace', row?.id, 'smartrecruiters-rolandberger-744000154944720');
eq('and the row is a UK consulting internship', [row?.region, row?.vertical, row?.level], ['UK', 'Consulting', 'Internship']);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
