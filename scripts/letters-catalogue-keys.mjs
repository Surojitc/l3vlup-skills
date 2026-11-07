#!/usr/bin/env node
// The site catalogue's keys, for the review queue's duplicate check.
//
// The letters catalogue lives in the site repository (data/letters.catalogue.json,
// with data/letters.held.json and data/letters.excluded.json beside it), which
// the weekly job here does not check out. This writes the part the queue needs
// and nothing more: each record's id, whether it is published, held or
// excluded, its accession and its canonical URLs. No title, note or quotation
// is copied. Run it after the site's catalogue changes and commit the result.
//
//   node scripts/letters-catalogue-keys.mjs --site ../L3vlup

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { catalogueKeys } from '../lib/letters-queue.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'data', 'letters.catalogue-keys.json');
const at = process.argv.indexOf('--site');
if (at < 0 || !process.argv[at + 1]) {
  console.error('usage: node scripts/letters-catalogue-keys.mjs --site <path to the site repository>');
  process.exit(1);
}
const DATA = join(resolve(process.argv[at + 1]), 'data');
const read = (name, field) => {
  const path = join(DATA, name);
  if (!existsSync(path)) return [];
  return JSON.parse(readFileSync(path, 'utf8'))[field] || [];
};

const catalogue = JSON.parse(readFileSync(join(DATA, 'letters.catalogue.json'), 'utf8'));
const held = read('letters.held.json', 'records');
const excluded = read('letters.excluded.json', 'entries');
const keys = [
  ...catalogueKeys(catalogue.records, 'published'),
  ...catalogueKeys(held, 'held'),
  ...catalogueKeys(excluded, 'excluded'),
];
const out = {
  _comment: 'Written by scripts/letters-catalogue-keys.mjs from the site repository. Ids, statuses, accessions and URLs only. Edit the site catalogue, not this file.',
  from: { catalogueGeneratedAt: catalogue.generatedAt || null, published: catalogue.records.length, held: held.length, excluded: excluded.length },
  keys,
};
writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`);
console.log(`wrote ${OUT}: ${keys.length} keys (${catalogue.records.length} published, ${held.length} held, ${excluded.length} excluded), ${keys.filter((k) => k.accession).length} with an accession`);
