/**
 * tal.net board and deadline parsing.
 *
 * The markup is lifted from the live Morgan Stanley board. This is the only
 * HTML parser in the collector, so the fixture matters more than usual: it is
 * the thing that tells us the page changed shape before the tracker quietly
 * empties out.
 */
import { parseTalnetBoard, parseTalnetDeadline, talnetBoardUrl } from '../../lib/talnet.mjs';

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
};

const NOW = new Date('2026-08-30T00:00:00Z');

// --- the URL --------------------------------------------------------------
eq('board url', talnetBoardUrl('morganstanley.tal.net'),
   'https://morganstanley.tal.net/vx/lang-en-GB/mobile-0/appcentre-ext/brand-4/candidate/jobboard/vacancy/1/adv/');
eq('brand is overridable', talnetBoardUrl('x.tal.net', 'brand-2').includes('/brand-2/'), true);
eq('no host, no url', talnetBoardUrl(''), null);

// --- real board markup, trimmed to two rows -------------------------------
const BOARD = `
<table>
<tr>
  <td class="comm_list_tbody">
    <a class="subject" href="https://morganstanley.tal.net/vx/lang-en-GB/mobile-0/brand-2/xf-5f2c6550f46e/candidate/so/pm/1/pl/1/opp/21829-2027-Investment-Banking-Off-Cycle-Internship-Frankfurt-or-Munich/en-GB">
      2027 Investment Banking Off-Cycle Internship (Frankfurt or Munich)                      </a>
  </td>
  <td class="comm_list_tbody">
    Frankfurt                    </td>
</tr>
<tr>
  <td class="comm_list_tbody">
    <a class="subject" href="https://morganstanley.tal.net/vx/x/opp/21851-2027-Wealth-Management/en-GB">
      2027 Wealth Management Full-time Branch Analyst Program (Atlanta) &amp; more</a>
  </td>
  <td class="comm_list_tbody">Atlanta</td>
</tr>
</table>`;

{
  const rows = parseTalnetBoard(BOARD);
  eq('both rows parsed', rows.length, 2);
  eq('id comes off the opp path', rows[0].id, '21829');
  eq('title is collapsed and trimmed', rows[0].title,
     '2027 Investment Banking Off-Cycle Internship (Frankfurt or Munich)');
  eq('location comes from the next cell', rows[0].location, 'Frankfurt');
  eq('entities are decoded', rows[1].title,
     '2027 Wealth Management Full-time Branch Analyst Program (Atlanta) & more');
}

// Tenants render each anchor twice, once for the desktop table and once for
// mobile. Counting anchors gives double the real number of roles.
{
  const rows = parseTalnetBoard(BOARD + BOARD);
  eq('duplicate anchors are deduped on id', rows.length, 2);
}

eq('junk input yields nothing', parseTalnetBoard('<html>no board</html>'), []);
eq('non-string input yields nothing', parseTalnetBoard(null), []);

// --- deadlines, which are day-first ---------------------------------------
// This is the whole reason the date is not handed to `new Date()`: it reads
// "30/09/2026" as invalid, and "05/09/2026" as 9 May. A transposed deadline is
// the one error that must never reach a page.
eq('a stated deadline with a time', parseTalnetDeadline('Deadline: 30/09/2026, 23:55', { now: NOW }), '2026-09-30');
eq('day-first, not month-first', parseTalnetDeadline('Deadline: 05/09/2026', { now: NOW }), '2026-09-05');
eq('an impossible day-month pair is refused', parseTalnetDeadline('Deadline: 31/02/2026', { now: NOW }), undefined);
eq('a month over 12 is refused', parseTalnetDeadline('Deadline: 01/13/2026', { now: NOW }), undefined);
eq('a deadline that has passed is refused', parseTalnetDeadline('Deadline: 01/01/2020', { now: NOW }), undefined);
eq('a placeholder years out is refused', parseTalnetDeadline('Deadline: 01/01/2031', { now: NOW }), undefined);
eq('today still counts', parseTalnetDeadline('Deadline: 30/08/2026', { now: NOW }), '2026-08-30');
eq('no deadline on the page', parseTalnetDeadline('<p>Apply now</p>', { now: NOW }), undefined);
eq('non-string input', parseTalnetDeadline(undefined, { now: NOW }), undefined);
// The real markup has it inside an attribute, not as visible text.
eq('found inside an attribute', parseTalnetDeadline('<meta content="Deadline: 30/09/2026, 23:55" />', { now: NOW }), '2026-09-30');

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
