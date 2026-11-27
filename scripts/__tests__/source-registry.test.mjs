/**
 * The source registry and its daily alerts (lib/source-registry.mjs), and the
 * rule that no active registry row is read through a method its terms forbid.
 *
 *   node scripts/__tests__/source-registry.test.mjs
 */
import { readFileSync } from 'node:fs';
import { buildSourceRegistry, sourceAlerts } from '../../lib/source-registry.mjs';

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
};
const kinds = (alerts, firm) => alerts.filter((a) => a.firm === firm).map((a) => a.kind).sort();

const terms = {
  methods: {
    greenhouse: { permitted: true, basis: 'documented' },
    smartrecruiters: { permitted: false, basis: 'robots.txt disallows' },
    workday: { permitted: 'unclear', basis: 'no published API' },
    recruitee: { permitted: true, basis: 'public', breaking: [{ on: '2027-02-10', what: 'token required' }] },
  },
};
const day = (date, boards) => ({ date, boards });
const registry = [
  { firm: 'Healthy', ats: 'greenhouse' },
  { firm: 'Forbidden', ats: 'smartrecruiters' },
  { firm: 'Parked', ats: 'smartrecruiters', parked: true, parkedReason: 'suspended' },
  { firm: 'Broken', ats: 'greenhouse' },
  { firm: 'Emptied', ats: 'greenhouse' },
  { firm: 'QuietlyEmpty', ats: 'greenhouse' },
  { firm: 'Gone', ats: 'greenhouse' },
  { firm: 'Reshaped', ats: 'greenhouse' },
  { firm: 'Undecided', ats: 'workday' },
  { firm: 'Tokened', ats: 'recruitee' },
  { firm: 'Twice', ats: 'greenhouse' },
  { firm: 'Twice', ats: 'greenhouse' },
];
const checks = ['2026-11-20', '2026-11-21', '2026-11-22', '2026-11-23', '2026-11-24', '2026-11-25', '2026-11-26'].map((d, i, all) =>
  day(d, {
    Healthy: { s: 'ok', n: 4 },
    Forbidden: { s: 'ok', n: 9 },
    Broken: i >= all.length - 3 ? { s: 'failed', reason: 'every Workday request failed (9)' } : { s: 'ok', n: 2 },
    Emptied: { s: 'ok', n: i === all.length - 1 ? 0 : 6 },
    QuietlyEmpty: { s: 'ok', n: 0 },
    ...(i < 2 ? { Gone: { s: 'ok', n: 1 } } : { Gone: { s: 'failed', reason: '404' } }),
    Reshaped: i === all.length - 1 ? { s: 'failed', reason: 'no jobs parsed: the page has changed shape' } : { s: 'ok', n: 3 },
    Undecided: { s: 'ok', n: 1 },
    Tokened: { s: 'ok', n: 1 },
    Twice: { s: 'ok', n: 1 },
  })
);

// Files arrive in any order; the registry sorts them.
const records = buildSourceRegistry(registry, terms, [...checks].reverse());
const alerts = sourceAlerts(records, { today: '2026-11-27' });

const healthy = records.find((r) => r.firm === 'Healthy');
eq('a record names its method, permission and last success', [healthy.ats, healthy.permitted, healthy.lastSuccess, healthy.roles], ['greenhouse', true, '2026-11-26', 4]);
eq('a healthy, permitted board raises nothing', kinds(alerts, 'Healthy'), []);
eq('an active row on a forbidden method is a problem', alerts.find((a) => a.firm === 'Forbidden')?.level, 'problem');
eq('a parked row on the same method raises nothing', kinds(alerts, 'Parked'), []);
eq('three failed checks in a row is failing, and four days since a success is stale', kinds(alerts, 'Broken'), ['failing', 'stale']);
eq('a board emptied after holding roles is flagged', kinds(alerts, 'Emptied'), ['unexpected-zero']);
eq('a board that has always been empty is not', kinds(alerts, 'QuietlyEmpty'), []);
eq('a board with no success in three days is stale and failing', kinds(alerts, 'Gone'), ['failing', 'stale']);
eq('a fetcher reporting a changed shape is flagged on the first day', kinds(alerts, 'Reshaped'), ['shape']);
eq('an undecided method is one warning, not one per board', alerts.filter((a) => a.kind === 'undecided').length, 1);
eq('a breaking change within 75 days is announced', alerts.filter((a) => a.kind === 'breaking').map((a) => a.level), ['warning']);
eq('and becomes a problem in its last fortnight',
  sourceAlerts(records, { today: '2027-02-01' }).filter((a) => a.kind === 'breaking').map((a) => a.level), ['problem']);
eq('two active rows with one name collide', kinds(alerts, 'Twice'), ['duplicate-firm']);
eq('a board never checked is named', kinds(sourceAlerts(buildSourceRegistry([{ firm: 'New', ats: 'greenhouse' }], terms, checks), { today: '2026-11-27' }), 'New'), ['stale']);

// --- the real files ----------------------------------------------------------
const real = JSON.parse(readFileSync(new URL('../../lib/sources/ats-registry.json', import.meta.url), 'utf8')).firms;
const realTerms = JSON.parse(readFileSync(new URL('../../lib/sources/source-terms.json', import.meta.url), 'utf8'));
const methods = new Set(real.map((r) => r.ats));
eq('every method in the registry has terms recorded', [...methods].filter((m) => !realTerms.methods[m]).sort(), []);
eq('no active row is read through a forbidden method',
  real.filter((r) => !r.parked && realTerms.methods[r.ats]?.permitted === false).map((r) => r.firm), []);
eq('every parked row says why', real.filter((r) => r.parked && !r.parkedReason).map((r) => r.firm), []);
eq('terms carry a checked date', /^\d{4}-\d{2}-\d{2}$/.test(realTerms.checked), true);
eq('every breaking change is dated', Object.values(realTerms.methods).flatMap((m) => m.breaking ?? []).every((b) => /^\d{4}-\d{2}-\d{2}$/.test(b.on) && b.what), true);
eq('no credential is written into the terms or the registry',
  /token"\s*:\s*"[A-Za-z0-9]{24,}|bearer\s+[a-z0-9]/i.test(JSON.stringify(realTerms)), false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
