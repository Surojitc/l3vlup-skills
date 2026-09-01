/**
 * Carrying roles through a board failure.
 *
 * The case this exists for is real and current: tal.net serves its boards to a
 * residential address and refuses datacentre ranges, so Morgan Stanley, Nomura
 * and BlackRock collate perfectly by hand and have never survived a CI run.
 */
import { RETENTION_DAYS, lastConfirmed, retainRoles } from '../../lib/role-retention.mjs';

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
};

const TODAY = '2026-09-01';
const role = (o = {}) => ({
  id: 'talnet-nomuracampus-tal-net-1487',
  firm: 'Nomura',
  role: '2027 Global Markets Graduate Internship',
  closingDate: '2026-09-30',
  lastConfirmedAt: '2026-08-31',
  tags: ['Auto-sourced'],
  ...o,
});

// --- the distinction that matters -----------------------------------------
// A board that ANSWERED with nothing has told us something true. Only failures
// are carried.
eq('a failed board has its roles carried',
   retainRoles([role()], ['Nomura'], TODAY).length, 1);
eq('a board that simply is not in the failed list is not carried',
   retainRoles([role()], [], TODAY).length, 0);
eq('another firm failing does not carry this one',
   retainRoles([role()], ['Morgan Stanley'], TODAY).length, 0);
eq('a Set works as well as an array',
   retainRoles([role()], new Set(['Nomura']), TODAY).length, 1);

// --- staleness is visible -------------------------------------------------
{
  const [r] = retainRoles([role()], ['Nomura'], TODAY);
  eq('the row is tagged Unconfirmed', r.tags.includes('Unconfirmed'), true);
  eq('  …without losing its own tags', r.tags.includes('Auto-sourced'), true);
  eq('it records when it was last really seen', r.unconfirmedSince, '2026-08-31');
  eq('and how stale that makes it', r.unconfirmedDays, 1);
  eq('the rest of the role is untouched', r.role, '2027 Global Markets Graduate Internship');
}
{
  // Carrying an already-carried role must not stack the tag every day.
  const once = retainRoles([role()], ['Nomura'], TODAY);
  const twice = retainRoles(once, ['Nomura'], '2026-09-02');
  eq('the Unconfirmed tag is not duplicated',
     twice[0].tags.filter((t) => t === 'Unconfirmed').length, 1);
  eq('  …and staleness keeps counting from the real sighting', twice[0].unconfirmedDays, 2);
}

// --- the window -----------------------------------------------------------
eq('a role confirmed inside the window is kept',
   retainRoles([role({ lastConfirmedAt: '2026-08-26' })], ['Nomura'], TODAY).length, 1);
eq('a role confirmed exactly at the limit is kept',
   retainRoles([role({ lastConfirmedAt: '2026-08-25' })], ['Nomura'], TODAY).length, 1);
eq('a role older than the window is dropped',
   retainRoles([role({ lastConfirmedAt: '2026-08-24' })], ['Nomura'], TODAY).length, 0);
eq('the window is configurable',
   retainRoles([role({ lastConfirmedAt: '2026-08-24' })], ['Nomura'], TODAY, { retentionDays: 30 }).length, 1);
eq('the default window is a week', RETENTION_DAYS, 7);

// --- things not worth carrying --------------------------------------------
eq('a role whose deadline has passed is not carried',
   retainRoles([role({ closingDate: '2026-08-31' })], ['Nomura'], TODAY).length, 0);
eq('a role closing today still is',
   retainRoles([role({ closingDate: TODAY })], ['Nomura'], TODAY).length, 1);
eq('an undated role is fine',
   retainRoles([role({ closingDate: undefined })], ['Nomura'], TODAY).length, 1);

// --- roles written before this field existed ------------------------------
// They carry no lastConfirmedAt, so the previous file's own timestamp stands in.
eq('the previous run date stands in when the role has no stamp',
   retainRoles([role({ lastConfirmedAt: undefined })], ['Nomura'], TODAY,
     { fallbackConfirmedAt: '2026-08-31' }).length, 1);
eq('  …and the window still applies to it',
   retainRoles([role({ lastConfirmedAt: undefined })], ['Nomura'], TODAY,
     { fallbackConfirmedAt: '2026-08-01' }).length, 0);
eq('with no stamp and no fallback, nothing is guessed',
   retainRoles([role({ lastConfirmedAt: undefined })], ['Nomura'], TODAY).length, 0);
eq('a full timestamp is accepted and truncated',
   lastConfirmed({ lastConfirmedAt: '2026-08-31T14:20:26.371Z' }), '2026-08-31');

// --- defensive ------------------------------------------------------------
eq('no previous roles yields nothing', retainRoles([], ['Nomura'], TODAY), []);
eq('undefined previous roles yields nothing', retainRoles(undefined, ['Nomura'], TODAY), []);
eq('a bad run date yields nothing', retainRoles([role()], ['Nomura'], 'today'), []);
eq('a null row is skipped', retainRoles([null, role()], ['Nomura'], TODAY).length, 1);

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
