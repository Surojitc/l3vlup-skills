#!/usr/bin/env node
// Letters: a contact sheet of the source previews, for a person to approve
// the crops before they are published.
//
//   node scripts/letters-thumbnails-review.mjs        writes .letters-review/thumbnails.html
//
// One row per registry record: the card at 400 and 640, the detail page, the
// page each came from, what the photo guard skipped and why, and for a record
// with no preview the reason (rights, mode, takedown, the guard). The images
// are referenced from data/letters/thumbs, never copied, and the sheet links
// each row to its source so a reviewer can check the crop against the page.
// The folder is git-ignored: the sheet is a working document, not a record.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SIZES } from '../lib/letters-thumbs.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, '.letters-review');
const OUT = join(OUT_DIR, 'thumbnails.html');
const registry = JSON.parse(readFileSync(join(ROOT, 'data', 'letters.thumbnail-sources.json'), 'utf8')).records;
const manifest = JSON.parse(readFileSync(join(ROOT, 'data', 'letters.thumbnails.json'), 'utf8'));

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const kb = (n) => `${(n / 1024).toFixed(1)} KB`;

function img(a, slot) {
  if (!a) return `<div class="none">no ${slot}</div>`;
  const src = relative(OUT_DIR, join(ROOT, 'data', a.src));
  const over = a.bytes > SIZES[slot].budget ? ' over' : '';
  return `<figure><img src="${esc(src)}" width="${a.w}" height="${a.h}" style="width:${Math.round(a.w / 2)}px" alt=""><figcaption class="${over}">${slot} ${a.w}x${a.h}, ${kb(a.bytes)}, q${a.quality}${a.page ? `, p${a.page}` : ''}${a.top ? `, top ${a.top}` : ''}</figcaption></figure>`;
}

const rows = Object.entries(registry).map(([slug, e]) => {
  const m = manifest.records[slug];
  const s = manifest.skipped?.[slug];
  const head = `<h2>${esc(slug)}</h2><p class="meta">${esc(e.rights)} · ${esc(e.thumbnailMode)}${e.takedown ? ' · <b>takedown</b>' : ''} · <a href="${esc(e.sourceUrl)}">source</a> · route ${esc(e.letterRoute.method)}${e.letterRoute.page ? ` p${e.letterRoute.page}` : ''}</p>`;
  if (!m) return `<section class="skip">${head}<p>No preview: ${esc(s?.reason ?? 'not rendered yet')}</p></section>`;
  const notes = (m.notes ?? []).map((n) => `<li>${esc(n)}</li>`).join('');
  return `<section>${head}<div class="imgs">${img(m.card, 'card')}${img(m.card2x, 'card2x')}${img(m.detail, 'detail')}</div>${notes ? `<ul>${notes}</ul>` : ''}<p class="meta">source ${kb(m.sourceBytes)}${m.sourcePages ? `, ${m.sourcePages} pages` : ''}, ${esc(m.renderer)}, ${esc(m.generatedOn)}</p></section>`;
});

const total = Object.values(manifest.records).reduce((n, m) => n + ['card', 'card2x', 'detail'].reduce((k, s) => k + (m[s]?.bytes ?? 0), 0), 0);
const html = `<!doctype html><meta charset="utf-8"><title>Letters previews: review</title>
<style>body{font:14px/1.4 system-ui,sans-serif;margin:24px;color:#0f172a;background:#fafbff}section{background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:12px 16px;margin:0 0 16px}
section.skip{opacity:.75}h2{font-size:15px;margin:0}.meta{color:#64748b;margin:4px 0}.imgs{display:flex;gap:16px;align-items:flex-start;flex-wrap:wrap}
figure{margin:8px 0}img{border:1px solid #cbd5e1;display:block;height:auto}figcaption{font-size:12px;color:#475569}.over{color:#b91c1c;font-weight:600}.none{color:#94a3b8;padding:8px}ul{margin:4px 0;color:#92400e}</style>
<h1>Letters source previews</h1>
<p>${Object.keys(manifest.records).length} records with previews, ${kb(total)} in all. Approve each crop, or set <code>takedown: true</code> or a <code>crop</code> hint in data/letters.thumbnail-sources.json and run the renderer again.</p>
${rows.join('\n')}`;

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT, html);
console.log(`wrote ${relative(ROOT, OUT)} (${Object.keys(registry).length} records)`);
if (!existsSync(join(ROOT, '.gitignore')) || !readFileSync(join(ROOT, '.gitignore'), 'utf8').includes('.letters-review')) {
  console.warn('note: .letters-review/ should be in .gitignore');
}
