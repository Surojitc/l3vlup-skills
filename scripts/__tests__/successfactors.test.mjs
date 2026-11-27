/**
 * SuccessFactors career sites (lib/successfactors.mjs), on rows trimmed from
 * careers.ey.com's live search of 27 November 2026.
 *
 *   node scripts/__tests__/successfactors.test.mjs
 */
import { readFileSync } from 'node:fs';
import { parseSuccessFactorsSearch, successFactorsSearchUrl } from '../../lib/successfactors.mjs';
import { toOpportunity } from '../sync-ats.mjs';

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
};

eq('the search url with a site path', successFactorsSearchUrl({ host: 'careers.ey.com', site: 'ey' }, 'summer analyst', 25),
  'https://careers.ey.com/ey/search/?q=summer%20analyst&startrow=25');
eq('the search url without one', successFactorsSearchUrl({ host: 'careers.fitch.group', site: '' }, 'intern'),
  'https://careers.fitch.group/search/?q=intern&startrow=0');
const url = successFactorsSearchUrl({ host: 'careers.ey.com', site: 'ey' }, 'x');
eq('the url never reaches a path robots.txt disallows', /\/(services|applybutton|talentcommunity|preapply|emailsubscribe)\//.test(url), false);

const page = parseSuccessFactorsSearch(readFileSync(new URL('./fixtures/successfactors-search.html', import.meta.url), 'utf8'), 'careers.ey.com');
eq('the stated total is read', page.total, 623);
eq('both rows read once each, though every row links its title twice', page.jobs.length, 2);
eq('the id is the number in the link', page.jobs[0].id, '1208472601');
eq('a relative link is made absolute', page.jobs[0].url.startsWith('https://careers.ey.com/ey/job/'), true);
eq('the location is the jobLocation span, its country spelled out', page.jobs[0].location, 'London, United Kingdom');
const { spellCountry } = await import('../../lib/successfactors.mjs');
eq('an Irish code becomes Ireland', spellCountry('Dublin, IE'), 'Dublin, Ireland');
eq('a Swiss code with a postcode', spellCountry('Geneva, CH, 1204'), 'Geneva, Switzerland');
eq('a location with no code is unchanged', spellCountry('Multiple Locations'), 'Multiple Locations');
eq('an empty page reads as nothing', parseSuccessFactorsSearch(''), { total: 0, jobs: [] });

const row = toOpportunity({ id: '1', title: 'Strategy and Transactions Summer Internship 2027 - London', location: 'London, GB, SE1 2AF', url: 'u' }, { firm: 'EY', ats: 'successfactors', host: 'careers.ey.com', tier: 'Consulting' });
eq('an EY London summer internship is a UK row', [row?.region, row?.level], ['UK', 'Internship']);
const tax = toOpportunity({ id: '2', title: 'Tax Consultant Graduate 2027', location: 'London, GB', url: 'u' }, { firm: 'EY', ats: 'successfactors', host: 'careers.ey.com', tier: 'Consulting' });
const steuer = toOpportunity({ id: '3', title: 'Karrierestart Consultant Unternehmenssteuerberatung (Graduate)', location: 'Munich, Germany', url: 'u' }, { firm: 'EY', ats: 'successfactors', host: 'careers.ey.com', tier: 'Consulting' });
eq('a German tax advisory consultant at EY is not Consulting', steuer?.vertical === 'Consulting', false);
eq('an EY tax consultant graduate is not Consulting', tax?.vertical === 'Consulting', false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
