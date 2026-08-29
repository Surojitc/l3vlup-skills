/**
 * Workday detail parsing.
 *
 * The payload here is the real Mastercard response the CI probe returned,
 * trimmed. Writing the parser against an invented shape is how the earlier
 * 406 happened, and the fixture is the guard against repeating that.
 */
import { detailUrl, parseWorkdayDetail, plausibleDeadline, plausiblePostedDate } from '../../lib/workday-detail.mjs';

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
};

const NOW = new Date('2026-08-29T00:00:00Z');

// --- the URL, which is where this went wrong the first time ---------------
eq('detail url puts nothing between site and externalPath',
   detailUrl('mastercard.wd1.myworkdayjobs.com', 'mastercard', 'CorporateCareers', '/job/Bogota-Colombia/x_R-1'),
   'https://mastercard.wd1.myworkdayjobs.com/wday/cxs/mastercard/CorporateCareers/job/Bogota-Colombia/x_R-1');
eq('no url without an externalPath', detailUrl('h', 't', 's', ''), null);

// --- the real payload -----------------------------------------------------
const LIVE = {
  jobPostingInfo: {
    id: 'b99d42bd25631002037b0004e6630000',
    title: 'Information Security Operations Analyst (IAM)',
    jobDescription: '<p>...</p>',
    location: 'Bogota, Colombia',
    postedOn: 'Posted Yesterday',
    startDate: '2026-08-28',
    timeType: 'Full time',
    jobReqId: 'R-276438',
    country: { descriptor: 'Colombia', id: 'e8106', alpha2Code: 'CO' },
    jobRequisitionLocation: {
      descriptor: 'Bogota, Colombia',
      country: { descriptor: 'Colombia', id: 'e8106', alpha2Code: 'CO' },
    },
    endDate: '2026-09-30',
  },
};
eq('parses the live Mastercard payload', parseWorkdayDetail(LIVE, { now: NOW }), {
  closingDate: '2026-09-30',
  openingDate: '2026-08-28',
  location: 'Bogota, Colombia',
  countryCode: 'CO',
  timeType: 'Full time',
});

// --- guards ---------------------------------------------------------------
// A requisition left open with a placeholder end date years out is not a
// deadline anyone should see counting down.
eq('a placeholder endDate years out is refused', plausibleDeadline('2031-01-01', { now: NOW }), undefined);
eq('a past endDate is refused', plausibleDeadline('2026-08-01', { now: NOW }), undefined);
eq('today is still a deadline', plausibleDeadline('2026-08-29', { now: NOW }), '2026-08-29');
eq('a timestamp is truncated to the date', plausibleDeadline('2026-09-30T12:00:00Z', { now: NOW }), '2026-09-30');
eq('a future startDate is not a posting date', plausiblePostedDate('2027-01-01', { now: NOW }), undefined);
eq('nonsense is refused', plausibleDeadline('soon', { now: NOW }), undefined);

// --- partial payloads must not erase good data ----------------------------
// The result is spread over an existing role, so a missing field has to be
// absent rather than undefined.
eq('an empty payload yields no keys', parseWorkdayDetail({}, { now: NOW }), {});
eq('no jobPostingInfo yields no keys', parseWorkdayDetail(null, { now: NOW }), {});
eq('a payload with only a bad endDate yields no closingDate',
   parseWorkdayDetail({ jobPostingInfo: { endDate: '2019-01-01' } }, { now: NOW }), {});
eq('falls back to the flat location when the structured one is missing',
   parseWorkdayDetail({ jobPostingInfo: { location: 'London' } }, { now: NOW }), { location: 'London' });
eq('a malformed country code is dropped',
   parseWorkdayDetail({ jobPostingInfo: { location: 'X', country: { alpha2Code: 'gbr' } } }, { now: NOW }),
   { location: 'X' });

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
