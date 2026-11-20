/**
 * Roles an employer listed with us directly, offline.
 *
 *   node scripts/__tests__/employer-listings.test.mjs
 *
 * What is pinned: a listing is published only between its approval and its
 * expiry, never for more than sixty days on one approval, always labelled,
 * never as "Auto-sourced"; the employer's own board wins when it carries the
 * same link; a bad entry is reported and left out without touching the rest;
 * and the committed file is valid.
 */

import { readFileSync } from 'node:fs';
import { LISTED_TAG, MAX_DAYS, employerListings, listingProblems } from '../../lib/employer-listings.mjs';

let pass = 0;
let fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
};

const taxonomy = JSON.parse(readFileSync(new URL('../../data/taxonomy.json', import.meta.url), 'utf8'));

const entry = (over = {}) => ({
  key: 'acme-advisory-off-cycle-analyst-2026',
  firm: 'Acme Advisory',
  role: 'Off-Cycle Analyst',
  vertical: 'Investment Banking',
  programmeType: 'Off-Cycle Internship',
  location: 'London',
  region: 'UK',
  level: 'Internship',
  applicationUrl: 'https://acme-advisory.example/careers/off-cycle-analyst',
  approvedAt: '2026-11-20',
  expiresAt: '2027-01-15',
  ...over,
});

{
  const { rows, skipped } = employerListings([entry()], taxonomy, '2026-11-25');
  eq('an approved, current listing is published', rows.length, 1);
  eq('it is labelled and never auto-sourced', rows[0].tags, [LISTED_TAG]);
  eq('its id is pinned to its key', rows[0].id, 'employer-acme-advisory-off-cycle-analyst-2026');
  eq('it carries the day it is listed until', rows[0].listedUntil, '2027-01-15');
  eq('it is open, and nothing is skipped', [rows[0].status, skipped.length], ['Open', 0]);
}
eq('not before the day it was approved', employerListings([entry()], taxonomy, '2026-11-19').rows.length, 0);
eq('still on its expiry day', employerListings([entry()], taxonomy, '2027-01-15').rows.length, 1);
eq('gone the day after', employerListings([entry()], taxonomy, '2027-01-16').skipped[0].reason, 'expired 2027-01-15');
eq('gone after its own closing date', employerListings([entry({ closingDate: '2026-12-01' })], taxonomy, '2026-12-02').skipped[0].reason, 'closed 2026-12-01');
eq(`one approval lasts at most ${MAX_DAYS} days`, listingProblems(entry({ expiresAt: '2027-03-01' }), taxonomy), [`expiresAt is more than ${MAX_DAYS} days after approvedAt`]);
eq('the employer\'s board wins when it carries the same link',
  employerListings([entry()], taxonomy, '2026-11-25', [{ applicationUrl: 'https://acme-advisory.example/careers/off-cycle-analyst/' }]).skipped[0].reason,
  'now on the employer\'s board, which wins');
eq('a vocabulary the tracker does not know is refused', listingProblems(entry({ vertical: 'Investment banking', region: 'London' }), taxonomy).length, 2);
eq('an experienced listing is allowed', listingProblems(entry({ programmeType: 'Lateral / Experienced', level: 'Experienced' }), taxonomy), []);
eq('a non-https link is refused', listingProblems(entry({ applicationUrl: 'http://acme.example/x' }), taxonomy), ['applicationUrl is not https']);
eq('a key is required, to pin the URL', listingProblems(entry({ key: 'Has Spaces' }), taxonomy).length, 1);
{
  const { rows, skipped } = employerListings([entry(), entry({ firm: '' }), entry()], taxonomy, '2026-11-25');
  eq('a bad entry and a reused key are left out; the good one stands', [rows.length, skipped.map((s) => s.reason)], [1, ['firm missing', 'key "acme-advisory-off-cycle-analyst-2026" used twice']]);
}
eq('a missing or malformed list is no listings, not an error', [employerListings(undefined, taxonomy, '2026-11-25').rows.length, employerListings({}, taxonomy, '2026-11-25').rows.length], [0, 0]);

{
  const file = JSON.parse(readFileSync(new URL('../../data/opportunities.employer.json', import.meta.url), 'utf8'));
  eq('the committed file has a listings array', Array.isArray(file.listings), true);
  const bad = file.listings.map((e) => [e.key, listingProblems(e, taxonomy)]).filter(([, p]) => p.length);
  eq('every committed listing is valid', bad, []);
}
{
  const sync = readFileSync(new URL('../sync-ats.mjs', import.meta.url), 'utf8');
  const at = (s) => sync.indexOf(s);
  eq('listings join after retention and before screening and slugs',
    at('retainRoles(previousRoles') < at('employerListings(file.listings') && at('employerListings(file.listings') < at('screenRoles(all)') && at('screenRoles(all)') < at('updateRegistry(slugRoles'), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
