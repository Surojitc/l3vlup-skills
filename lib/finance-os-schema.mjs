// A dependency-free validator for the Finance OS public schemas.
//
// The schemas in schemas/finance-os/ are standard JSON Schema (2020-12) and
// any conforming validator can check against them. This module exists so
// the repository can check its own fixtures and generated workflows without
// adding a dependency: it implements exactly the subset those schemas use
// (type, enum, const, required, properties, additionalProperties: false,
// items, minItems, minLength, maxLength, minimum, pattern, oneOf, and $ref
// within a file or to a sibling file) and fails loudly on any keyword it
// does not know, so a schema can never quietly outgrow it.
//
// It also checks the rules a schema cannot express: a missing value is null
// and marked missing, every lineage reference resolves within the document,
// and a model's decision is never verified without review.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCHEMA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'schemas', 'finance-os');
const cache = new Map();

export function loadSchema(file) {
  if (!cache.has(file)) cache.set(file, JSON.parse(readFileSync(join(SCHEMA_DIR, file), 'utf8')));
  return cache.get(file);
}

const KNOWN = new Set([
  '$schema', '$id', '$defs', 'title', 'description', 'type', 'enum', 'const', 'required', 'properties',
  'additionalProperties', 'items', 'minItems', 'minLength', 'maxLength', 'minimum', 'pattern', 'oneOf', '$ref',
]);

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (Number.isInteger(v)) return 'integer';
  return typeof v;
}

function matchesType(v, t) {
  const actual = typeOf(v);
  if (t === 'number') return actual === 'number' || actual === 'integer';
  return actual === t;
}

function resolveRef(ref, file) {
  const [target, pointer = ''] = ref.split('#');
  const nextFile = target || file;
  let node = loadSchema(nextFile);
  for (const part of pointer.split('/').filter(Boolean)) {
    node = node?.[part];
    if (node === undefined) throw new Error(`unresolvable $ref ${ref} from ${file}`);
  }
  return { node, file: nextFile };
}

function check(value, schema, file, path, out) {
  for (const k of Object.keys(schema)) if (!KNOWN.has(k)) throw new Error(`schema keyword ${k} at ${file} is not supported by this validator`);
  if (schema.$ref) {
    const { node, file: f } = resolveRef(schema.$ref, file);
    check(value, node, f, path, out);
  }
  if (schema.oneOf) {
    const passing = schema.oneOf.filter((s) => {
      const sub = [];
      check(value, s, file, path, sub);
      return sub.length === 0;
    });
    if (passing.length !== 1) out.push(`${path}: matches ${passing.length} of oneOf, needs exactly 1`);
    return;
  }
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => matchesType(value, t))) {
      out.push(`${path}: expected ${types.join(' or ')}, got ${typeOf(value)}`);
      return;
    }
  }
  if (schema.const !== undefined && value !== schema.const) out.push(`${path}: must be ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value)) out.push(`${path}: ${JSON.stringify(value)} is not one of ${schema.enum.join(', ')}`);
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) out.push(`${path}: shorter than ${schema.minLength}`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) out.push(`${path}: longer than ${schema.maxLength}`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) out.push(`${path}: does not match ${schema.pattern}`);
  }
  if (typeof value === 'number' && schema.minimum !== undefined && value < schema.minimum) out.push(`${path}: below ${schema.minimum}`);
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) out.push(`${path}: fewer than ${schema.minItems} items`);
    if (schema.items) value.forEach((item, i) => check(item, schema.items, file, `${path}[${i}]`, out));
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const r of schema.required ?? []) if (!(r in value)) out.push(`${path}: missing ${r}`);
    for (const [k, v] of Object.entries(value)) {
      if (schema.properties?.[k]) check(v, schema.properties[k], file, `${path}.${k}`, out);
      else if (schema.additionalProperties === false) out.push(`${path}: unexpected field ${k}`);
    }
  }
}

/** Problems with `value` against a schema file (optionally a $defs entry), as a list. */
export function validate(value, file, def) {
  const out = [];
  const schema = def ? loadSchema(file).$defs[def] : loadSchema(file);
  if (!schema) throw new Error(`no schema ${file}${def ? `#/$defs/${def}` : ''}`);
  check(value, schema, file, def ?? '$', out);
  return out;
}

/** Schema problems plus the lineage rules a schema cannot express. */
export function validateEvidence(doc) {
  const out = validate(doc, 'provenance.schema.json');
  if (out.length) return out;
  const keys = new Map(doc.figures.map((f) => [f.key, f]));
  if (keys.size !== doc.figures.length) out.push('figure keys are not unique');
  for (const f of doc.figures) {
    if (f.value === null && f.verification !== 'missing') out.push(`${f.key}: a null value must be marked missing`);
    if (f.value !== null && f.verification === 'missing') out.push(`${f.key}: a figure with a value is not missing`);
    if (f.source.kind === 'none' && f.verification === 'verified') out.push(`${f.key}: an unsourced figure cannot be verified`);
    for (const k of f.lineage?.inputs ?? []) {
      if (!keys.has(k)) out.push(`${f.key}: lineage input ${k} is not a figure here`);
      else if (f.verification === 'verified' && keys.get(k).verification !== 'verified') out.push(`${f.key}: verified, but input ${k} is ${keys.get(k).verification}`);
    }
  }
  const ids = new Set();
  for (const d of doc.decisions) {
    if (ids.has(d.id)) out.push(`decision ${d.id} appears twice`);
    ids.add(d.id);
    for (const k of [...(d.target.figureKeys ?? []), ...d.evidence]) if (!keys.has(k)) out.push(`decision ${d.id}: ${k} is not a figure here`);
    for (const a of d.affects) if (!a.startsWith('section:') && !keys.has(a)) out.push(`decision ${d.id}: affects ${a}, neither a figure nor a section`);
    if (!d.target.entity && !(d.target.figureKeys ?? []).length) out.push(`decision ${d.id}: names no target`);
    if (d.basis === 'model' && d.verification === 'verified') out.push(`decision ${d.id}: a model decision is never verified without review`);
    if (d.basis === 'rule' && !d.ruleId) out.push(`decision ${d.id}: a rule decision names its rule`);
    if (d.basis === 'human' && !d.actorRole) out.push(`decision ${d.id}: a human decision records a role`);
  }
  return out;
}

/** Schema problems plus the ownership rules for a workflow published here. */
export function validateWorkflowDoc(w) {
  const out = validate(w, 'workflow.schema.json');
  if (out.length) return out;
  const o = w.ownership;
  if (o.publicationRing === 'twc' || o.specOwner === 'twc' || o.runtimeOwner === 'twc') out.push(`${w.id}: nothing private is published in the commons`);
  if (o.specOwner === 'open' && !o.repoPath) out.push(`${w.id}: an open specification names its home here`);
  if (o.referenceImplementation && o.referenceImplementation.repo !== 'l3vlup-skills') out.push(`${w.id}: a reference implementation lives in this repository`);
  const caps = w.data.map((d) => d.capability);
  if (new Set(caps).size !== caps.length) out.push(`${w.id}: a data capability is declared twice`);
  return out;
}
