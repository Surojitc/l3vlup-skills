/**
 * The Finance OS public schemas, their fixtures, and every published workflow.
 *
 *   node scripts/__tests__/finance-os-schemas.test.mjs
 *
 * The schemas are the open half of a contract whose TypeScript half lives in
 * the hosted product. This suite holds the open half to its own rules: the
 * schemas parse and use only the keywords the validator knows, the
 * known-good fixtures pass, each kind of bad document fails for the reason
 * it should, and every workflow published under workflows/ validates.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { validate, validateEvidence, validateWorkflowDoc, loadSchema } from '../../lib/finance-os-schema.mjs';

const ROOT = new URL('../../', import.meta.url).pathname;
const json = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));
let pass = 0;
let fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
};
const clone = (o) => JSON.parse(JSON.stringify(o));

/* ------------------------------------------------------------- schemas -- */
for (const f of ['workflow.schema.json', 'provenance.schema.json', 'data-requirement.schema.json']) {
  const s = loadSchema(f);
  eq(`${f}: declares JSON Schema 2020-12 and an id`, [s.$schema, Boolean(s.$id)], ['https://json-schema.org/draft/2020-12/schema', true]);
}
eq('the workflow and evidence schemas pin contract version 1', [loadSchema('workflow.schema.json').properties.contractVersion.const, loadSchema('provenance.schema.json').properties.contractVersion.const], ['1', '1']);

/* -------------------------------------------------------------- evidence -- */
const good = json('fixtures/finance-os/precedent-ev.evidence.json');
eq('the precedent fixture passes, all three lineage layers', validateEvidence(good), []);
{
  const bad = clone(good); bad.figures.find((f) => f.key === 'ev-ltm-ebitda').value = 0;
  eq('a missing multiple written as zero is caught', validateEvidence(bad).some((p) => /not missing/.test(p)), true);
}
{
  const bad = clone(good); delete bad.figures[0].period;
  eq('a figure without a period fails the schema', validateEvidence(bad).some((p) => /missing period/.test(p)), true);
}
{
  const bad = clone(good); bad.figures[0].source = { kind: 'none', title: 'No source', retrievedAt: '2026-10-07T09:00:00Z' };
  eq('an unsourced figure marked verified is caught', validateEvidence(bad).some((p) => /unsourced figure cannot be verified/.test(p)), true);
  bad.figures[0].verification = 'unverified';
  eq('a derivation still marked verified over that unverified input is caught', validateEvidence(bad).some((p) => /equity-value: verified, but input diluted-shares is unverified/.test(p)), true);
}
{
  const bad = clone(good); bad.decisions.find((d) => d.basis === 'model').verification = 'verified';
  eq('a model decision marked verified is caught', validateEvidence(bad).some((p) => /model decision/.test(p)), true);
}
{
  const bad = clone(good); bad.decisions[0].evidence = ['ghost'];
  eq('a decision resting on a figure that is not there is caught', validateEvidence(bad).some((p) => /ghost/.test(p)), true);
}
{
  const bad = clone(good); bad.decisions[1].actorEmail = 'someone@example.com';
  eq('a decision cannot carry a person\'s identity', validateEvidence(bad).some((p) => /unexpected field actorEmail/.test(p)), true);
}
{
  const bad = clone(good); bad.figures[1].source.location.excerpt = 'x'.repeat(201);
  eq('an excerpt is short, never a passage', validateEvidence(bad).some((p) => /longer than 200/.test(p)), true);
}

/* ------------------------------------------------------ provider profile -- */
const provider = json('fixtures/finance-os/test-fixture.provider.json');
eq('the provider fixture passes', validate(provider, 'data-requirement.schema.json', 'ProviderProfile'), []);
{
  const bad = clone(provider); bad.rights.export = 'probably';
  eq('a right is yes, no or unknown, nothing else', validate(bad, 'data-requirement.schema.json', 'ProviderProfile').length > 0, true);
}
eq('a requirement without a use fails', validate({ capability: 'kpis', required: true, provenance: 'any' }, 'data-requirement.schema.json', 'DataRequirement').some((p) => /missing use/.test(p)), true);
eq('an unknown capability fails', validate({ capability: 'vendor.feed', required: true, provenance: 'any', use: 'display' }, 'data-requirement.schema.json', 'DataRequirement').length > 0, true);

/* ------------------------------------------------- published workflows -- */
const dir = join(ROOT, 'workflows');
const workflowFiles = [];
if (existsSync(dir)) {
  const walk = (d) => readdirSync(d).forEach((n) => { const p = join(d, n); statSync(p).isDirectory() ? walk(p) : n === 'workflow.json' && workflowFiles.push(p); });
  walk(dir);
}
eq('the twelve open workflows are published', workflowFiles.length, 12);
for (const f of workflowFiles) {
  const w = JSON.parse(readFileSync(f, 'utf8'));
  eq(`${w.id}: validates against the workflow schema and the commons rules`, validateWorkflowDoc(w), []);
  eq(`${w.id}: sits where its ownership says`, f.slice(ROOT.length).replace(/\/workflow\.json$/, ''), w.ownership.repoPath);
  eq(`${w.id}: its SKILL.md is beside it`, existsSync(join(f, '..', 'SKILL.md')), true);
}
if (workflowFiles.length) {
  const index = json('workflows/index.json');
  eq('the index lists exactly the published workflows', index.workflows.map((w) => w.id).sort(), workflowFiles.map((f) => JSON.parse(readFileSync(f, 'utf8')).id).sort());
  const readmes = readdirSync(dir).filter((n) => statSync(join(dir, n)).isDirectory()).map((n) => readFileSync(join(dir, n, 'README.md'), 'utf8'));
  eq('no generated link points at an undefined folder', readmes.some((r) => r.includes('undefined')) || readFileSync(join(dir, 'README.md'), 'utf8').includes('undefined'), false);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
