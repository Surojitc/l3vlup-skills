/**
 * The employer permission register (lib/description-permissions.mjs): what a
 * record must hold, when it is in force, that nothing is published without one,
 * and that the shard rule is the site's. Pure; no network.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const ROOT = new URL('../../', import.meta.url).pathname;
const P = await import(`${ROOT}lib/description-permissions.mjs`);

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
  if (ok) pass++; else fail++;
};

const rec = (over = {}) => ({
  id: 'perm-2026-12-jump-trading', employer: 'Jump Trading', systems: ['greenhouse'], scope: ['republish-description'],
  attribution: 'employer-name-and-link', granted: '2026-12-01', expires: '2027-12-01', withdrawn: null, evidence: 'grants/2026-12-jump-trading.pdf', ...over,
});
const NOW = new Date('2027-01-15T06:00:00Z');

eq('a complete record has no problems', P.recordProblems(rec()), []);
eq('no evidence, no record', P.recordProblems(rec({ evidence: '' })).length > 0, true);
eq('scope must name republication', P.recordProblems(rec({ scope: ['link-only'] })).length > 0, true);
eq('a grant is recorded for at most twelve months', P.recordProblems(rec({ expires: '2028-06-01' })).some((p) => /twelve months/.test(p)), true);
eq('expiry after the grant', P.recordProblems(rec({ expires: '2026-11-01' })).some((p) => /after granted/.test(p)), true);

eq('in force between grant and expiry', P.active([rec()], NOW).length, 1);
eq('not yet in force before the grant', P.active([rec()], new Date('2026-11-30T12:00:00Z')).length, 0);
eq('lapsed on its expiry date', P.active([rec()], new Date('2027-12-01T00:00:00Z')).length, 0);
eq('withdrawn is withdrawn, whatever the dates', P.active([rec({ withdrawn: '2027-01-10' })], NOW).length, 0);
eq('a malformed record is never in force', P.active([rec({ evidence: '' })], NOW).length, 0);

eq('covers its own employer and system', P.permissionFor([rec()], 'Jump Trading', 'greenhouse', NOW)?.id, 'perm-2026-12-jump-trading');
eq('not another system', P.permissionFor([rec()], 'Jump Trading', 'workday', NOW), null);
eq('not another employer', P.permissionFor([rec()], 'Jump Capital', 'greenhouse', NOW), null);
eq('"*" covers every system', P.permissionFor([rec({ systems: ['*'] })], 'Jump Trading', 'oracle', NOW)?.id, 'perm-2026-12-jump-trading');

const captured = [
  { id: 'greenhouse-jumptrading-1', employer: 'Jump Trading', system: 'greenhouse', sourceUrl: 'https://x/1', html: '<p>text</p>' },
  { id: 'greenhouse-stripe-8131339', employer: 'Stripe', system: 'greenhouse', sourceUrl: 'https://x/2', html: '<p>text</p>' },
];
const files = P.descriptionFiles(captured, [rec()], NOW);
const entries = Object.entries(files).filter(([k]) => k !== 'index.json').flatMap(([, v]) => Object.keys(v));
eq('only the permitted employer is published', entries, ['greenhouse-jumptrading-1']);
eq('each entry names its permission', Object.values(files).find((v) => v['greenhouse-jumptrading-1'])['greenhouse-jumptrading-1'].permission, 'perm-2026-12-jump-trading');
eq('the manifest carries the active permissions, with no evidence or contact', files['index.json'].permissions, [{ id: 'perm-2026-12-jump-trading', employer: 'Jump Trading', systems: ['greenhouse'], attribution: 'employer-name-and-link', granted: '2026-12-01', expires: '2027-12-01' }]);
const none = P.descriptionFiles(captured, [], NOW);
eq('no permission: an empty manifest and no shard', [Object.keys(none), none['index.json'].shards, none['index.json'].permissions], [['index.json'], [], []]);

// The site reads the shard by the same FNV-1a rule (L3VLUP lib/job-descriptions.ts); values from the site's own function.
eq('the shard rule is the site\'s', ['greenhouse-stripe-8131339', 'workday-jpmorgan-R1', 'oracle-jpmc-210000000'].map(P.shardOf), ['b8', 'db', '5d']);

const register = JSON.parse(readFileSync(join(ROOT, 'lib/sources/description-permissions.json'), 'utf8'));
eq('the committed register is well formed', P.registerProblems(register), []);
eq('it records no contact details (a public repository)', /@[a-z0-9-]+\.[a-z]/i.test(JSON.stringify(register.permissions)), false);

const sync = readFileSync(join(ROOT, 'scripts/sync-ats.mjs'), 'utf8');
eq('the collector keeps a description only behind permissionFor', /if \(permissionFor\(DESCRIPTION_PERMISSIONS, f\.firm, f\.ats\)\)/.test(sync), true);
eq('and writes only through descriptionFiles', /descriptionFiles\(capturedDescriptions/.test(sync), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
