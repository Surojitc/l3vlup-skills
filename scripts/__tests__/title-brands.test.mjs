/**
 * Which firm a posting belongs to when one board serves several.
 *
 * Marsh McLennan's single Workday board carries Oliver Wyman and NERA, who put
 * their own name at the front of the title. Read as one firm, every Oliver Wyman
 * intern consultant role would be published as Marsh McLennan. The titles here
 * were read off the live board on 25 November 2026.
 *
 *   node scripts/__tests__/title-brands.test.mjs
 */
import { brandForTitle } from '../../lib/title-brands.mjs';
import { toOpportunity } from '../sync-ats.mjs';

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
};

const MMC = {
  firm: 'Marsh McLennan', ats: 'workday', tenant: 'mmc', shard: 'wd1', site: 'MMC', tier: 'Other',
  titleBrands: [
    { match: 'Oliver Wyman', firm: 'Oliver Wyman', tier: 'Consulting' },
    { match: 'NERA', firm: 'NERA Economic Consulting', tier: 'Consulting' },
  ],
};

eq('a leading brand is the owner', brandForTitle('Oliver Wyman - Consulting Intern (m/f/d) - Germany', MMC), { firm: 'Oliver Wyman', tier: 'Consulting' });
eq('a leading year does not hide it', brandForTitle('2027 Oliver Wyman – Intern Consultant - Spanish speaker (m/f/d) – Madrid', MMC).firm, 'Oliver Wyman');
eq('case does not matter', brandForTitle('OLIVER WYMAN - INTERN CONSULTANT – 2027  – NETHERLANDS', MMC).firm, 'Oliver Wyman');
eq('NERA with a colon', brandForTitle('NERA: Internship (Berlin, Frankfurt, and Paris)', MMC).firm, 'NERA Economic Consulting');
eq('NERA with a space', brandForTitle('NERA Summer Internship 2027 - London', MMC).firm, 'NERA Economic Consulting');
eq('a word that starts with the brand is not the brand', brandForTitle('Neral Systems Intern', MMC).firm, 'Marsh McLennan');
eq('an unbranded title keeps the board', brandForTitle('Workforce and Rewards Summer Intern- Atlanta GA- College Program 2027', MMC), { firm: 'Marsh McLennan', tier: 'Other' });
eq('a brand mentioned late is not the owner', brandForTitle('Mercer Consulting Intern supporting the Oliver Wyman alliance', MMC).firm, 'Marsh McLennan');
eq('a board with no brands is unchanged', brandForTitle('Anything', { firm: 'Brattle', tier: 'Consulting' }), { firm: 'Brattle', tier: 'Consulting' });

// Through the row builder: the firm and tier change, the id does not, so a
// slug pinned to the source job id stays put whichever brand a row carries.
const row = toOpportunity({ id: 'R_366245', title: 'Oliver Wyman - Consulting Intern (m/f/d) - Austria', location: 'Vienna - Millennium', url: 'u' }, MMC);
eq('the row is published under the brand', [row?.firm, row?.tier], ['Oliver Wyman', 'Consulting']);
eq('and classified as consulting', row?.vertical, 'Consulting');
eq('its id comes from the board', row?.id, 'workday-mmc-R_366245');
const plain = toOpportunity({ id: 'R_370714', title: 'Workforce and Rewards Summer Intern- Atlanta GA- College Program 2027', location: 'Atlanta - Lenox', url: 'u' }, MMC);
eq('an unbranded row keeps the board firm', plain?.firm, 'Marsh McLennan');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
