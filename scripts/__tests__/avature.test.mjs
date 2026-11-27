/**
 * Avature search results (lib/avature.mjs), on markup lifted from Deloitte US's
 * career site on 27 November 2026 and trimmed to two results. The fixture is
 * what tells us the page changed shape before the board quietly empties out.
 */
import { avatureSearchUrl, isAvatureEmptyShell, parseAvatureResults } from '../../lib/avature.mjs';

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
};

eq('search url', avatureSearchUrl('apply.deloitte.com', 'entry level', 20),
  'https://apply.deloitte.com/en_US/careers/SearchJobs/entry%20level?jobOffset=20');
eq('no host, no url', avatureSearchUrl('', 'intern'), null);

const PAGE = `
<div class="list-controls"></div>
<article class="article--result " data-total="473"> <div class="article__content--result"> <div class="article__header__text"> <h3 class="article__header__text__title article__header__text__title--2"> <a href="https://apply.deloitte.com/en_US/careers/JobDetail/Consulting-Summer-Scholar-Strategy-Summer-2027/370001" class="link"> Consulting – Summer Scholar – Strategy &amp; Analytics – Summer 2027 </a> </h3> <div class="article__header__text__subtitle"> <span> Deloitte US </span> | <span> Deloitte Consulting LLP </span> | <span>New York, New York, United States</span> </div> </div> </div> </article>
<article class="article--result " data-total="473"> <div class="article__content--result"> <div class="article__header__text"> <h3 class="article__header__text__title article__header__text__title--2"> <a href="https://apply.deloitte.com/en_US/careers/JobDetail/Audit-Assurance-Intern-Financial-Statement-Audit-Japanese-Services-Group-Summer-2027/361864" class="link"> Audit &amp; Assurance – Intern – Financial Statement Audit (Japanese Services Group) – Summer 2027 </a> </h3> <div class="article__header__text__subtitle"> <span> Deloitte US </span> | <span> Deloitte &amp; Touche LLP </span> | <span>Multiple Locations</span> </div> </div> </div> </article>
</div> <div class="list-controls list-controls--bottom"></div>`;

const { total, rows } = parseAvatureResults(PAGE);
eq('the stated total', total, 473);
eq('two rows', rows.length, 2);
eq('first row', rows[0], {
  id: '370001',
  title: 'Consulting – Summer Scholar – Strategy & Analytics – Summer 2027',
  url: 'https://apply.deloitte.com/en_US/careers/JobDetail/Consulting-Summer-Scholar-Strategy-Summer-2027/370001',
  location: 'New York, New York, United States',
  entity: 'Deloitte Consulting LLP',
});
eq('entities decoded', rows[1].entity, 'Deloitte & Touche LLP');
eq('a page with no total reads as null, never zero', parseAvatureResults('<html></html>').total, null);
eq('a results page is not an empty shell', isAvatureEmptyShell(PAGE), false);
eq('a bot check or changed template is', isAvatureEmptyShell('<html><body>Please wait</body></html>'), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
