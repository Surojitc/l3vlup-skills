// Running the PDF worker, and surviving a document that will not be read.
//
// The parent's whole job is limits: a wall clock, a heap ceiling, and a kill
// if either is passed. A document that times out, crashes the child or comes
// back without a text layer is a failure recorded in the manifest, never a
// partial result quietly treated as text.

import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export const PARSER = 'pdfjs-dist';

/**
 * The version the worker will report, known without spawning it.
 *
 * Read from the exact pin in package.json rather than from node_modules, so
 * a checkout that has not installed anything still knows what a record made
 * by this repository should say. The pin is exact on purpose: a caret here
 * would mean a record could not be compared to the one before it.
 */
export const PARSER_VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).dependencies['pdfjs-dist'];

export const WORKER = join(ROOT, 'scripts', 'letters-pdf-worker.mjs');
export const TIMEOUT_MS = 120_000;
export const HEAP_MB = 1024;
export const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

export function parsePdf(path, { timeoutMs = TIMEOUT_MS, heapMb = HEAP_MB, worker = WORKER, run = execFile } = {}) {
  return new Promise((resolve) => {
    const child = run(
      process.execPath,
      [`--max-old-space-size=${heapMb}`, worker, path],
      { timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES, killSignal: 'SIGKILL' },
      (err, stdout, stderr) => {
        if (err && (err.killed || err.signal === 'SIGKILL')) {
          resolve({ status: 'failed', failure: 'timeout', detail: `the parser was killed after ${timeoutMs} ms`, parser: PARSER, units: 'pages', pages: [], stats: { pages: 0, emptyPages: 0, characters: 0 }, warnings: ['the document did not parse inside its time limit'] });
          return;
        }
        if (err) {
          resolve({ status: 'failed', failure: 'crashed', detail: String(stderr || err.message).slice(0, 300), parser: PARSER, units: 'pages', pages: [], stats: { pages: 0, emptyPages: 0, characters: 0 }, warnings: ['the parser exited with an error'] });
          return;
        }
        try {
          const out = JSON.parse(stdout);
          out.warnings = out.status === 'no_text_layer' ? ['no text layer: an image-only document, which Phase 0 does not read'] : [];
          resolve(out);
        } catch (parseErr) {
          resolve({ status: 'failed', failure: 'bad_output', detail: parseErr.message, parser: PARSER, units: 'pages', pages: [], stats: { pages: 0, emptyPages: 0, characters: 0 }, warnings: ['the parser returned something that was not JSON'] });
        }
      }
    );
    child.stdin?.end();
  });
}
