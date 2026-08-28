import {
  extractDeadline,
  toPlainText,
  applyManualDeadlines,
  extractJsonLdDeadline,
} from '../../lib/deadline-extract.mjs';

const NOW = new Date('2026-08-26T00:00:00Z');
let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
};
const run = (t) => extractDeadline(t, { now: NOW });

// --- the formats a real posting uses ---------------------------------------
eq('UK long date', run('Applications close on 31 October 2026.'), { closingDate: '2026-10-31' });
eq('UK ordinal + abbrev', run('Applications close 3rd Nov 2026.'), { closingDate: '2026-11-03' });
eq('US month-first', run('Apply by October 31, 2026 to be considered.'), { closingDate: '2026-10-31' });
eq('US abbrev no comma', run('Deadline: Nov 3 2026'), { closingDate: '2026-11-03' });
eq('ISO', run('Closing date: 2026-12-01.'), { closingDate: '2026-12-01' });
eq('deadline for applications', run('The deadline for applications is 15 January 2027.'), { closingDate: '2027-01-15' });
eq('last day to apply', run('Last day to apply is December 5, 2026.'), { closingDate: '2026-12-05' });
eq('inside HTML', run('<p><strong>Applications close</strong> 30 September 2026</p>'), { closingDate: '2026-09-30' });

// --- rolling ---------------------------------------------------------------
eq('rolling basis', run('We review applications on a rolling basis.'), { rolling: true });
eq('open until filled', run('This role is open until filled.'), { rolling: true });

// --- the refusals: where guessing would put a wrong date on the site -------
eq('ambiguous slash date is refused', run('Apply by 10/11/2026.'), {});
eq('unambiguous slash is read', run('Apply by 31/10/2026.'), { closingDate: '2026-10-31' });
eq('a date with no deadline cue is ignored', run('The programme starts 8 June 2027 in New York.'), {});
eq('start date near no cue stays ignored', run('Summer Analyst Program. Start date: 1 June 2027.'), {});
eq('a past deadline is not a deadline', run('Applications closed 1 January 2020.'), {});
eq('implausibly distant date rejected', run('Apply by 1 January 2040.'), {});
eq('impossible date rejected', run('Apply by 31 February 2027.'), {});
eq('empty input', run(''), {});
eq('no dates at all', run('We are hiring summer analysts in New York.'), {});

// --- the cue must be near the date, not anywhere in a long posting ---------
const longPost = `About the role. Applications close soon so do not delay. ${'Filler sentence about the team. '.repeat(40)} Our office opened 4 July 1999.`;
eq('distant date not attributed to a far-away cue', run(longPost), {});

// --- a realistic full posting ---------------------------------------------
const real = `<div><h2>2027 Investment Banking Summer Analyst Program &ndash; New York</h2>
<p>Our ten-week Summer Analyst Program begins June 2027. You will be staffed on live transactions.</p>
<ul><li>Rising junior, expected graduation December 2027 &ndash; June 2028</li>
<li>Minimum GPA of 3.5</li></ul>
<p><strong>Applications close 15 November 2026.</strong> We encourage you to apply early.</p></div>`;
eq('realistic posting picks the deadline, not the start or graduation dates', run(real), { closingDate: '2026-11-15' });

// --- helper ----------------------------------------------------------------
eq('toPlainText strips tags and entities', toPlainText('<p>A&nbsp;&amp;&nbsp;B</p>'), 'A & B');

// --- manual overrides ------------------------------------------------------
const TODAY = '2026-08-26';
const roles = () => [
  { id: 'gh-gs-1', firm: 'Goldman Sachs', role: 'Investment Banking Summer Analyst' },
  { id: 'gh-gs-2', firm: 'Goldman Sachs', role: 'Engineering Summer Analyst' },
  { id: 'lv-ms-1', firm: 'Morgan Stanley', role: 'IBD Summer Analyst', closingDate: '2026-09-01' },
];

let r = roles();
eq('exact id override', [applyManualDeadlines(r, [{ id: 'gh-gs-1', closingDate: '2026-11-15' }], TODAY), r[0].closingDate, r[1].closingDate],
   [1, '2026-11-15', undefined]);

r = roles();
eq('firm-wide override hits every role at that firm',
   [applyManualDeadlines(r, [{ firm: 'Goldman Sachs', closingDate: '2026-11-15' }], TODAY), r[0].closingDate, r[1].closingDate],
   [2, '2026-11-15', '2026-11-15']);

r = roles();
eq('rolePattern narrows a firm-wide override',
   [applyManualDeadlines(r, [{ firm: 'Goldman Sachs', rolePattern: 'investment banking', closingDate: '2026-11-15' }], TODAY),
    r[0].closingDate, r[1].closingDate],
   [1, '2026-11-15', undefined]);

r = roles();
eq('manual date beats a scraped one',
   [applyManualDeadlines(r, [{ id: 'lv-ms-1', closingDate: '2026-12-20' }], TODAY), r[2].closingDate],
   [1, '2026-12-20']);

r = roles();
eq('a past manual row is ignored',
   [applyManualDeadlines(r, [{ id: 'gh-gs-1', closingDate: '2020-01-01' }], TODAY), r[0].closingDate],
   [0, undefined]);

r = roles();
eq('firm match is case-insensitive',
   applyManualDeadlines(r, [{ firm: 'goldman sachs', rolePattern: 'ENGINEERING', closingDate: '2026-11-15' }], TODAY), 1);

r = roles();
eq('unknown firm changes nothing',
   [applyManualDeadlines(r, [{ firm: 'Nobody LLP', closingDate: '2026-11-15' }], TODAY), r[0].closingDate], [0, undefined]);

eq('missing manual list is safe', applyManualDeadlines(roles(), undefined, TODAY), 0);

// --- JobPosting structured data -------------------------------------------
const ld = (obj) => `<html><head><script type="application/ld+json">${JSON.stringify(obj)}</script></head></html>`;

eq('plain JobPosting validThrough',
   extractJsonLdDeadline(ld({ '@type': 'JobPosting', title: 'Summer Analyst', validThrough: '2026-11-15' })),
   { closingDate: '2026-11-15' });

eq('validThrough with a timestamp is truncated to the date',
   extractJsonLdDeadline(ld({ '@type': 'JobPosting', validThrough: '2026-11-15T23:59:59+00:00' })),
   { closingDate: '2026-11-15' });

eq('array payload',
   extractJsonLdDeadline(ld([{ '@type': 'Organization', name: 'A Bank' }, { '@type': 'JobPosting', validThrough: '2026-12-01' }])),
   { closingDate: '2026-12-01' });

eq('@graph wrapper',
   extractJsonLdDeadline(ld({ '@context': 'https://schema.org', '@graph': [{ '@type': 'WebSite' }, { '@type': 'JobPosting', validThrough: '2027-01-09' }] })),
   { closingDate: '2027-01-09' });

eq('@type as an array',
   extractJsonLdDeadline(ld({ '@type': ['JobPosting', 'Thing'], validThrough: '2026-10-02' })),
   { closingDate: '2026-10-02' });

eq('non-JobPosting validThrough is ignored',
   extractJsonLdDeadline(ld({ '@type': 'Offer', validThrough: '2026-11-15' })), {});

eq('JobPosting without validThrough', extractJsonLdDeadline(ld({ '@type': 'JobPosting', title: 'X' })), {});
eq('malformed JSON-LD does not throw',
   extractJsonLdDeadline('<script type="application/ld+json">{ not json ,,</script>'), {});
eq('malformed block does not hide a later good one',
   extractJsonLdDeadline('<script type="application/ld+json">{oops</script>' + ld({ '@type': 'JobPosting', validThrough: '2026-11-20' })),
   { closingDate: '2026-11-20' });
eq('no markup at all', extractJsonLdDeadline('<html><body>Summer Analyst</body></html>'), {});
eq('empty input', extractJsonLdDeadline(''), {});
eq('non-date validThrough refused',
   extractJsonLdDeadline(ld({ '@type': 'JobPosting', validThrough: 'when filled' })), {});

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
