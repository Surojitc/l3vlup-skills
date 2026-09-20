/**
 * The published taxonomy is a declaration, not a census.
 *
 * WHY THIS EXISTS
 * The collector and the site live in different repositories, and the thing
 * that connects them is a feed. When the collector learned to emit a vertical
 * the site had never heard of, nothing failed: the site cast the string,
 * rendered the row, generated a page for it and put the URL in the sitemap,
 * while the filter that should have found it was built from the site's own
 * list and therefore never offered it. A row visible to Google and unreachable
 * on the board is the worst of both, and it happened silently.
 *
 * So the collector declares what it supports and the site checks the
 * declaration at build time. This test guards the producer's half: that the
 * file exists, that it is a declaration rather than a count, and that it
 * agrees with the classifier it claims to describe.
 *
 *   node scripts/__tests__/taxonomy-contract.test.mjs
 */
import { readFileSync } from 'node:fs';
import { inferVertical } from '../sync-ats.mjs';

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
};
const ok = (name, cond) => eq(name, Boolean(cond), true);

const t = JSON.parse(readFileSync(new URL('../../data/taxonomy.json', import.meta.url), 'utf8'));

ok('the file declares a schema version', Number.isInteger(t.schemaVersion) && t.schemaVersion >= 1);
ok('it names the producer that writes it', typeof t.producer === 'string' && t.producer.includes('sync-ats'));
ok('it carries a generation timestamp', !Number.isNaN(Date.parse(t.generatedAt)));

ok('pending is an array, even when empty', Array.isArray(t.pending));
ok('nothing is both supported and pending', !t.pending.some((v) => t.verticals.includes(v)));

for (const key of ['verticals', 'regions', 'levels', 'programmeTypes']) {
  ok(`${key} is a non-empty array`, Array.isArray(t[key]) && t[key].length > 0);
  eq(`${key} has no duplicates`, t[key].length, new Set(t[key]).size);
  ok(`${key} holds only non-empty strings`, t[key].every((v) => typeof v === 'string' && v.trim()));
}

// A declaration, not a census. Counts must never appear: the moment they do,
// somebody will be tempted to derive the list from them.
ok('no row counts are published', !JSON.stringify(t).match(/"count"|"rows"|"total"/i));

// Every vertical the classifier can actually return must be declared.
ok('Other is declared, because the classifier falls back to it', t.verticals.includes('Other'));
// Consulting is added to `pending` by the classifier pull request, in the same
// commit as the rule that can emit it, and promoted into `verticals` once the
// site understands it. Declaring a capability the producer does not have would
// be as wrong as the reverse.
ok('Consulting is not declared before the classifier can emit it',
  !t.verticals.includes('Consulting') || t.pending.includes('Consulting'));

const SAMPLES = [
  ['Investment Banking Summer Analyst', 'Investment Banking'],
  ['Quantitative Research Intern', 'Quant'],
  ['Software Engineer Intern', 'Software Engineering'],
  ['Research Engineer Intern', 'AI Research'],
  ['Private Equity Summer Analyst', 'Private Equity'],
  ['Markets Graduate Programme 2027', 'Sales & Trading'],
  ['Wealth Management Internship', 'Wealth Management'],
  ['Totally Unclassifiable Graduate Role', 'Other'],
];
for (const [title, want] of SAMPLES) {
  const got = inferVertical(title, { firm: 'Accenture' });
  // The contract's job is that every answer the classifier CAN give is
  // declared somewhere. Which answer it gives for a given title is the
  // classifier's own test, not this one.
  eq(`the classifier's answer for "${title.slice(0, 38)}" is declared`,
    t.verticals.includes(got) || t.pending.includes(got), true);
}

// A supported vertical with no rows today is still supported. This asserts the
// property directly, because it is the one a future maintainer is most likely
// to break by "tidying" the list against the feed.
ok('a vertical may be declared with zero current rows', t.verticals.includes('Hedge Fund'));

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
