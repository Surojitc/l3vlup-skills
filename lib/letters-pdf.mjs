// Running the PDF worker, and surviving a document that will not be read.
//
// The parent's whole job is limits: a wall clock, a heap ceiling, and a kill
// if either is passed. A document that times out, crashes the child or comes
// back without a text layer is a failure recorded in the manifest, never a
// partial result quietly treated as text.

import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const WORKER = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'letters-pdf-worker.mjs');
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
          resolve({ status: 'failed', failure: 'timeout', detail: `the parser was killed after ${timeoutMs} ms`, parser: 'pdfjs-dist', units: 'pages', pages: [], stats: { pages: 0, emptyPages: 0, characters: 0 }, warnings: ['the document did not parse inside its time limit'] });
          return;
        }
        if (err) {
          resolve({ status: 'failed', failure: 'crashed', detail: String(stderr || err.message).slice(0, 300), parser: 'pdfjs-dist', units: 'pages', pages: [], stats: { pages: 0, emptyPages: 0, characters: 0 }, warnings: ['the parser exited with an error'] });
          return;
        }
        try {
          const out = JSON.parse(stdout);
          out.warnings = out.status === 'no_text_layer' ? ['no text layer: an image-only document, which Phase 0 does not read'] : [];
          resolve(out);
        } catch (parseErr) {
          resolve({ status: 'failed', failure: 'bad_output', detail: parseErr.message, parser: 'pdfjs-dist', units: 'pages', pages: [], stats: { pages: 0, emptyPages: 0, characters: 0 }, warnings: ['the parser returned something that was not JSON'] });
        }
      }
    );
    child.stdin?.end();
  });
}
