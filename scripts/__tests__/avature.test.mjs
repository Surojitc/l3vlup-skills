/**
 * Avature career sites (lib/avature.mjs), on three results trimmed from
 * Deloitte US's live search page of 27 November 2026, and the Big Four rule
 * that keeps a service-line "Tax Consultant" out of Consulting.
 *
 *   node scripts/__tests__/avature.test.mjs
 */
import { readFileSync } from 'node:fs';
import { avatureSearchUrl, parseAvatureSearch } from '../../lib/avature.mjs';
import { inferVertical, toOpportunity } from '../sync-ats.mjs';

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
};

const board = { host: 'apply.deloitte.com', locale: 'en_US', portal: 'careers' };
const url = avatureSearchUrl(board, '2027', 20);
eq('the search url', url, 'https://apply.deloitte.com/en_US/careers/SearchJobs/?search=2027&jobOffset=20');
eq('the url never carries qtvc, which robots.txt disallows', /qtvc/i.test(url), false);

const html = readFileSync(new URL('./fixtures/avature-search.html', import.meta.url), 'utf8');
const page = parseAvatureSearch(html);
eq('three results read', page.jobs.length, 3);
eq('the stated total is read', page.total > 100, true);
eq('the id is the number the detail link ends in', page.jobs.every((j) => /^\d+$/.test(j.id) && j.url.endsWith(`/${j.id}`)), true);
eq('titles are trimmed', page.jobs.every((j) => j.title === j.title.trim() && j.title.length > 10), true);
eq('the location is the last subtitle span', page.jobs.every((j) => j.location.length > 0), true);
eq('an empty page reads as nothing', parseAvatureSearch('<html></html>'), { total: 0, jobs: [] });

// Bloomberg's markup: class before href, a classed location span, no total.
const bb = parseAvatureSearch(`<article class="article article--result" id="article--1"><h3><a class="link" href="https://bloomberg.avature.net/careers/JobDetail/2027-London-Summer-Internship-Client-Financial-Services/45689">
  2027 London Summer Internship -Client Financial Services
</a></h3><div class="article__header__text__subtitle"><span class="list-item-location">London, United Kingdom</span></div></article>`);
eq('a Bloomberg card is read', bb.jobs.map((j) => [j.id, j.title, j.location]), [['45689', '2027 London Summer Internship -Client Financial Services', 'London, United Kingdom']]);
eq('a tenant without a total reads as zero, and pagination stops on a page with nothing new', bb.total, 0);
eq('a tenant with no locale has no empty path segment', avatureSearchUrl({ host: 'bloomberg.avature.net', locale: '', portal: 'careers' }, 'intern'), 'https://bloomberg.avature.net/careers/SearchJobs/?search=intern&jobOffset=0');

// The Big Four rule.
eq('a Deloitte tax consultant is not Consulting', inferVertical('Tax - Tax Consultant - Japanese Services Group - Summer 2027', { firm: 'Deloitte' }) === 'Consulting', false);
eq('an audit associate at PwC is not Consulting', inferVertical('Audit Associate - Summer 2027', { firm: 'PwC' }) === 'Consulting', false);
eq('a Deloitte strategy consulting analyst is', inferVertical('Strategy & Analytics Consulting Analyst - Summer 2027', { firm: 'Deloitte' }), 'Consulting');
eq("Deloitte's own Internal Services is not Consulting", inferVertical('Internal Services - Associate Analyst - Cybersecurity Architecture - Summer/Fall 2027', { firm: 'Deloitte' }) === 'Consulting', false);
eq("Deloitte's Consultative Offerings is", inferVertical('Consultative Offerings - Summer Associate - Enterprise Strategy', { firm: 'Deloitte' }), 'Consulting');
eq('a CRA accounting consulting analyst still is', inferVertical('Accounting/Business/Finance Consulting Analyst Intern', { firm: 'Charles River Associates' }), 'Consulting');

const row = toOpportunity({ ...page.jobs[0], location: 'United States' }, { firm: 'Deloitte', ats: 'avature', host: 'apply.deloitte.com', tier: 'Consulting' });
eq('a Deloitte row has an avature id and a US region', [row?.id.startsWith('avature-apply-deloitte-com-'), row?.region], [true, 'US']);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
