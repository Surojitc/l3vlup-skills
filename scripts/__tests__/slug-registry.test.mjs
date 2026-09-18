/**
 * Canonical tracker URLs: assigned once, kept for good, and unmoved by anything
 * that happens to the records around them.
 *
 * The failure this exists to stop: a slug used to be `firm role` with the
 * region appended on collision, assigned in id order across the whole board, so
 * a record's URL depended on the other records present. When the row holding
 * the base slug left, the row that had been pushed to `-asia` was promoted into
 * the base slug and its own URL ceased to exist, with no role deleted.
 *
 *   node scripts/__tests__/slug-registry.test.mjs
 */

import { normaliseText, normaliseRoleText, sameText } from '../../lib/text-normalise.mjs';
import {
  assignSlugs,
  baseSlugFor,
  buildRegistry,
  emptyRegistry,
  recordFormerSlug,
  serialiseRegistry,
  slugifyProgramme,
  updateRegistry,
} from '../../lib/slug-registry.mjs';

let pass = 0;
let fail = 0;
const check = (name, cond, detail) => {
  if (cond) {
    pass += 1;
    console.log(`PASS  ${name}`);
  } else {
    fail += 1;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
};
const eq = (name, got, want) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const role = (id, firm, name, region = 'US') => ({ id, firm, role: name, region });
const slugs = (records, registry) => Object.fromEntries(assignSlugs(records, registry));

/* --------------------------------------------- invisible Unicode fixtures -- */
//
// Every one of these is a title an ATS has actually served. None of them should
// produce a different identity or a different URL from the plain form.

const PLAIN = '2027 Commercial Banking Summer Internship';
const FIXTURES = [
  ['an ordinary role', PLAIN],
  ['a trailing zero-width space', `${PLAIN}​`],
  ['a zero-width space inside a word', '2027 Commercial​ Banking Summer Internship'],
  ['a non-breaking space', '2027 Commercial Banking Summer Internship'],
  ['a narrow no-break space', '2027 Commercial Banking Summer Internship'],
  ['repeated whitespace', '2027  Commercial   Banking Summer Internship'],
  ['leading and trailing whitespace', `  ${PLAIN}  `],
  ['a tab', '2027\tCommercial Banking Summer Internship'],
  ['a soft hyphen', '2027 Commer­cial Banking Summer Internship'],
  ['a byte-order mark', `﻿${PLAIN}`],
  ['a left-to-right mark', `${PLAIN}‎`],
];

for (const [label, text] of FIXTURES) {
  check(`${label} normalises to the plain title`, normaliseText(text) === PLAIN,
    JSON.stringify(normaliseText(text)));
  check(`${label} produces the plain slug`,
    slugifyProgramme(text) === slugifyProgramme(PLAIN),
    slugifyProgramme(text));
}

// Unicode-equivalent text: the same characters composed two ways.
eq('decomposed and composed accents are one title',
  normaliseText('Société Générale'), 'Société Générale');
check('and one slug',
  slugifyProgramme('Société Générale') === slugifyProgramme('Société Générale'));
check('full-width Latin folds onto the ordinary form', sameText('ＡＢＣ', 'ABC'));

// The fields that reach a URL are cleaned; nothing else is invented.
{
  const cleaned = normaliseRoleText(role('x', ' IMC Trading ', `Quant Trader​`, 'UK'));
  eq('a record’s text fields are normalised together',
    [cleaned.firm, cleaned.role], ['IMC Trading', 'Quant Trader']);
  eq('and its durable id is left alone', cleaned.id, 'x');
}

// Cleaned text is not identity. Two genuinely different roles whose titles
// differ only by an invisible character are still two records, with two URLs.
{
  const a = role('workday-wf-R-555720', 'Wells Fargo', PLAIN, 'US');
  const b = role('workday-wf-R-573977', 'Wells Fargo', `${PLAIN}​`, 'Asia');
  const assigned = slugs([a, b]);
  check('two records with visually identical titles keep two URLs',
    assigned[a.id] !== assigned[b.id], JSON.stringify(assigned));
  eq('the first by id takes the base slug',
    assigned[a.id], 'wells-fargo-2027-commercial-banking-summer-internship');
  eq('and the second the region suffix',
    assigned[b.id], 'wells-fargo-2027-commercial-banking-summer-internship-asia');
}

/* ------------------------------------------------------------ stability -- */

const US = role('workday-wf-R-555720', 'Wells Fargo', PLAIN, 'US');
const ASIA = role('workday-wf-R-573977', 'Wells Fargo', `${PLAIN}​`, 'Asia');
const BASE = 'wells-fargo-2027-commercial-banking-summer-internship';

const roles = {};
updateRegistry(roles, [US, ASIA], '2026-09-18');
const registry = buildRegistry({ roles });

eq('the first run records what the old rule published',
  [roles[US.id].slug, roles[ASIA.id].slug], [BASE, `${BASE}-asia`]);

eq('a collision leaving does not move the survivor',
  slugs([ASIA], registry)[ASIA.id], `${BASE}-asia`);
eq('and the rule this replaces promoted it',
  slugs([ASIA], emptyRegistry())[ASIA.id], BASE);

{
  const arrival = role('workday-wf-R-999999', 'Wells Fargo', PLAIN, 'UK');
  const after = slugs([US, ASIA, arrival], registry);
  eq('a collision arriving moves nothing', [after[US.id], after[ASIA.id]], [BASE, `${BASE}-asia`]);
  eq('and the arrival takes a suffix of its own', after[arrival.id], `${BASE}-uk`);
}

{
  // Compared as sorted pairs: the assignment is a mapping, and which key the
  // object happened to be built with first is not part of it.
  const sorted = (m) => Object.entries(m).sort(([a], [b]) => a.localeCompare(b));
  eq('feed order changes no URL',
    sorted(slugs([US, ASIA], registry)), sorted(slugs([ASIA, US], registry)));
}

{
  const noise = role('000-sorts-first', 'Citadel', 'Quant Researcher', 'US');
  const after = slugs([noise, US, ASIA], registry);
  eq('a record that sorts before everything moves no URL',
    [after[US.id], after[ASIA.id]], [BASE, `${BASE}-asia`]);
}

{
  // A record that has left the board keeps its reservation, so tomorrow's
  // arrival cannot be handed a URL that has already been published.
  const departed = buildRegistry({ roles: { 'old-record': { slug: 'imc-trading-quant-trader' } } });
  const newcomer = role('new-record', 'IMC Trading', 'Quant Trader', 'UK');
  eq('a slug issued to a departed record is not reissued',
    slugs([newcomer], departed)[newcomer.id], 'imc-trading-quant-trader-uk');
}

{
  // An employer rewriting a title no longer moves the URL. This is why no new
  // alias is ever created after the seed.
  const renamed = { ...US, role: '2027 Commercial Banking Internship (Early Careers)' };
  eq('a retitled record keeps the URL it was assigned',
    slugs([renamed], registry)[US.id], BASE);
  const again = { ...roles };
  updateRegistry(again, [renamed], '2026-10-01');
  eq('and the registry is not rewritten', again[US.id].slug, BASE);
  eq('nor is its assignment date', again[US.id].since, '2026-09-18');
}

/* -------------------------------------------------------------- aliases -- */

{
  const withHistory = { ...roles };
  check('a former URL is recorded', recordFormerSlug(withHistory, ASIA.id, `${BASE}-apac`));
  eq('once', recordFormerSlug(withHistory, ASIA.id, `${BASE}-apac`), false);
  const built = buildRegistry({ roles: withHistory });
  eq('and resolves to the slug the record holds now',
    built.aliases.get(`${BASE}-apac`), `${BASE}-asia`);
  check('a former URL stays reserved against reuse', built.reserved.has(`${BASE}-apac`));

  check('a slug that is another record’s current URL is never recorded as a former one',
    recordFormerSlug(withHistory, ASIA.id, BASE) === false);
}

/* ----------------------------------------------------- the seeded file --- */

{
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
  const file = JSON.parse(readFileSync(join(ROOT, 'data/tracker-slugs.json'), 'utf8'));
  const ids = Object.keys(file.roles ?? {});

  check('the registry is seeded', ids.length > 1000, `${ids.length} records`);
  const all = ids.map((id) => file.roles[id].slug);
  check('every record has a slug', all.every(Boolean));
  check('no two records claim the same slug', new Set(all).size === all.length);

  // Replaying the registry over its own records must move nothing: that is what
  // makes the seed a no-op on live URLs.
  const records = ids.map((id) => ({ id, firm: 'x', role: 'y', region: 'US' }));
  const replayed = assignSlugs(records, buildRegistry(file));
  const moved = ids.filter((id) => replayed.get(id) !== file.roles[id].slug);
  check('replaying the registry over its own records moves no URL', moved.length === 0,
    moved.slice(0, 3).join(', '));
}

eq('the serialised form is ordered and counted',
  Object.keys(serialiseRegistry({ b: { slug: 'b' }, a: { slug: 'a' } }, 'now')),
  ['generatedAt', 'count', 'roles']);
eq('with the records sorted by id',
  Object.keys(serialiseRegistry({ b: { slug: 'b' }, a: { slug: 'a' } }, 'now').roles), ['a', 'b']);

/* ------------------------------------------------------ the sync wiring -- */

{
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
  const sync = readFileSync(join(ROOT, 'scripts/sync-ats.mjs'), 'utf8');

  check('the collector publishes the slug in the feed', /if \(slug\) o\.slug = slug;/.test(sync));
  check('and normalises the text before assigning one',
    sync.indexOf('normaliseRoleText') < sync.indexOf('updateRegistry(slugRoles'));
  check('the registry is written only after the collapse guard',
    sync.indexOf('ABORT: collated') < sync.indexOf('updateRegistry(slugRoles'));
  // Every published file goes through writeAtomic, and the only bare writeFile
  // left is the one inside it that writes the temporary copy.
  check('every published file is written atomically',
    (sync.match(/await writeFile\(/g) ?? []).length === 1 &&
      /await writeFile\(temp, contents\)/.test(sync) &&
      (sync.match(/await writeAtomic\(/g) ?? []).length >= 4);
  check('the archive is maintained here rather than downstream',
    /function updateArchive\(/.test(sync) && /data\/tracker-archive\.json/.test(sync));
  check('nothing adds a second scheduled workflow for slugs',
    !/schedule:/.test(sync));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
