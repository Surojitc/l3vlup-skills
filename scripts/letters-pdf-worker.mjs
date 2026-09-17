#!/usr/bin/env node
// The child process that reads a PDF, and the only place pdfjs runs.
//
// It is a separate process on purpose: a malformed document can exhaust
// memory or spin, and the parent needs to be able to kill it. Everything
// that could make a PDF do more than hold text is off — script execution,
// eval, XFA forms, system fonts, image decoding and every external fetch —
// so the file is data and nothing else. No OCR: a document without a text
// layer fails closed, and the parent records it as ineligible rather than
// guessing at pictures.
//
//   node scripts/letters-pdf-worker.mjs <path>   → JSON on stdout

import { readFile } from 'node:fs/promises';

const path = process.argv[2];
if (!path) { process.stderr.write('usage: letters-pdf-worker.mjs <path>\n'); process.exit(2); }

const { getDocument, version } = await import('pdfjs-dist/legacy/build/pdf.mjs');

const bytes = new Uint8Array(await readFile(path));
const task = getDocument({
  data: bytes,
  isEvalSupported: false,        // no eval of PDF-supplied function code
  enableScripting: false,        // no document-level JavaScript actions
  enableXfa: false,              // no XFA form engine
  disableFontFace: true,         // no font installation
  useSystemFonts: false,         // no reading fonts off this machine
  disableAutoFetch: true,        // no speculative loading
  disableStream: true,
  disableRange: true,            // the bytes in hand are all there is
  isOffscreenCanvasSupported: false,
  maxImageSize: 1,               // decode no images
  stopAtErrors: false,
  verbosity: 0,
});
const doc = await task.promise;

const pages = [];
let emptyPages = 0;
for (let n = 1; n <= doc.numPages; n += 1) {
  const page = await doc.getPage(n);
  const content = await page.getTextContent();
  let text = '';
  for (const item of content.items) {
    if (typeof item.str !== 'string') continue;
    text += item.str;
    if (item.hasEOL) text += '\n';
    else if (!item.str.endsWith(' ')) text += ' ';
  }
  const trimmed = text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!trimmed) emptyPages += 1;
  pages.push({ page: n, text: trimmed, chars: trimmed.length, items: content.items.length });
  page.cleanup();
}
await task.destroy();

const characters = pages.reduce((n, p) => n + p.chars, 0);
const status = characters === 0 ? 'no_text_layer' : 'ok';
process.stdout.write(JSON.stringify({
  parser: 'pdfjs-dist',
  parserVersion: version,
  units: 'pages',
  status,
  pages,
  stats: { pages: doc.numPages, emptyPages, characters },
}));
