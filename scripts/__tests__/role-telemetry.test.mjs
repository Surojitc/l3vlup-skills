/**
 * The derived age of a role: its recruiting year, how long since it was
 * posted, when we first saw it. Measurement only; nothing here closes a role.
 */
import { absenceSpells, firstSeenIndex, inferCohortYear, postedAgeDays, sourceFamily } from '../../lib/role-telemetry.mjs';

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
};
const year = (t) => inferCohortYear(t).cohortYear;

// --- recruiting year --------------------------------------------------------
eq('a plain year', year('2025 Markets Internship Colombia'), 2025);
eq('a year run into a word', year('Accenture Summer Internship Program - Consulting (Aug to Dec2024)'), 2024);
eq('a hyphenated cycle is its later year', year('2025-2026 Graduate Programme'), 2026);
eq('a slashed short cycle', year('Graduate Scheme 2026/27'), 2027);
eq('a short cycle with a hyphen', year('Off-Cycle Internship 2025-26'), 2026);
eq('the latest named year wins', year('Summer 2026 / Full-time 2027 Analyst'), 2027);
eq('a fiscal year', year('FY26 Summer Analyst'), 2026);
eq('a requisition number is not a year', year('Job Requisition: 25843173 Citi India Apprenticeship Program'), null);
eq('a date without a year names none', year('London Networking Event 1 Oct'), null);
eq('"Off-Cycle" is not a cycle', year('3-Month Off-Cycle Internship - Corporate Finance'), null);
eq('an implausible year is ignored', year('Class of 2099 Intern'), null);
eq('every year is listed', inferCohortYear('2025-2026 and 2027').years, [2025, 2026, 2027]);

// --- posted age -------------------------------------------------------------
eq('days since posting', postedAgeDays('2026-09-01', '2026-09-20'), 19);
eq('no date, no age', postedAgeDays(undefined, '2026-09-20'), null);
eq('a future posting date is not an age', postedAgeDays('2026-10-01', '2026-09-20'), null);
eq('a malformed date is not an age', postedAgeDays('Posted 30+ Days Ago', '2026-09-20'), null);

// --- history ------------------------------------------------------------------
{
  const snaps = [
    { date: '2026-09-03', ids: ['a', 'b'] },
    { date: '2026-09-01', ids: ['a'] },
    { date: '2026-09-02', ids: [] },
    { date: '2026-09-04', ids: ['a'] },
  ];
  const first = firstSeenIndex(snaps);
  eq('first seen is the earliest snapshot, whatever the file order', first.get('a'), '2026-09-01');
  eq('  …for every id', first.get('b'), '2026-09-03');
  eq('an absence that ended is one spell', absenceSpells(snaps, 'a'), 1);
  eq('an absence that has not ended is not counted as a return', absenceSpells(snaps, 'b'), 0);
}

eq('source family from the id', sourceFamily({ id: 'workday-citi-25836348' }), 'workday');
eq('an id with no family', sourceFamily({}), 'unknown');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
