#!/usr/bin/env node
// Letters: check the published source previews before they ship.
//
//   node scripts/letters-validate-thumbnails.mjs
//
// Fails (exit 1) when any of these is untrue:
//   - every registry entry is well formed, and none but a sec-public source is
//     set to render;
//   - every manifest entry has its files, each a WebP of the stated width,
//     bytes and hash, inside its budget (card 40 KB, detail 60 KB);
//   - no record that may not have a preview has a file or an entry: not a
//     first-party source, not a takedown, not an identity cover;
//   - no stray file sits in data/letters/thumbs;
//   - no PDF exists anywhere in the repository tree (outside .git and
//     node_modules): the sources are rendered and deleted, never kept.

import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { THUMBS_DIR, entryProblems, manifestProblems } from '../lib/letters-thumbs.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'data');
const registry = JSON.parse(readFileSync(join(DATA, 'letters.thumbnail-sources.json'), 'utf8')).records;
const manifest = JSON.parse(readFileSync(join(DATA, 'letters.thumbnails.json'), 'utf8'));

const problems = [];
for (const [slug, e] of Object.entries(registry)) for (const p of entryProblems(slug, e)) problems.push(`registry ${slug}: ${p}`);

const dir = join(DATA, THUMBS_DIR);
const io = {
  exists: (src) => existsSync(join(DATA, src)),
  read: (src) => readFileSync(join(DATA, src)),
  list: () => (existsSync(dir) ? readdirSync(dir).map((f) => `${THUMBS_DIR}/${f}`) : []),
};
problems.push(...manifestProblems(manifest, registry, io));

/** Every PDF under the repository, by extension and by magic bytes. */
function findPdfs(at, out = []) {
  for (const entry of readdirSync(at, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const p = join(at, entry.name);
    if (entry.isDirectory()) findPdfs(p, out);
    else if (entry.isFile()) {
      if (/\.pdf$/i.test(entry.name)) out.push(p);
      else {
        const head = Buffer.alloc(5);
        try {
          const fd = openSync(p, 'r');
          readSync(fd, head, 0, 5, 0);
          closeSync(fd);
        } catch {
          continue;
        }
        if (head.toString('latin1') === '%PDF-') out.push(p);
      }
    }
  }
  return out;
}
for (const p of findPdfs(ROOT)) problems.push(`a PDF is in the repository: ${relative(ROOT, p)}`);

const n = Object.keys(manifest.records).length;
const bytes = Object.values(manifest.records).reduce((t, m) => t + ['card', 'card2x', 'detail'].reduce((k, s) => k + (m[s]?.bytes ?? 0), 0), 0);
if (problems.length) {
  for (const p of problems) console.log(`FAIL ${p}`);
  console.log(`\n${problems.length} problem(s)`);
  process.exit(1);
}
console.log(`PASS ${Object.keys(registry).length} registry records, ${n} with previews, ${bytes} bytes, no PDF in the tree`);
