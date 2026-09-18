// Offline checks on retrieval and deterministic parsing. No network: the
// fetcher takes an injected implementation, and the PDFs are built here,
// byte by byte, so no document is committed and no fixture is copyrighted.
//
//   node scripts/__tests__/letters-retrieval.test.mjs

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ARCHIVE_ENV, probeEncryption, resolveArchive } from '../../lib/letters-archive.mjs';
import { approvedDocument, createWorkspace, resolveWorkspace, withWorkspace } from '../../lib/letters-workspace.mjs';
import {
  buildOutput,
  EXTRACTION_CONFIG_VERSION,
  identityKey,
  preserveProcessedAt,
  renderMarkdown,
  SCHEMA_VERSION,
  serialiseOutput,
  sortRecords,
  toPublicRecord,
  unchanged,
  validatePublicRecord,
} from '../../lib/letters-output.mjs';
import { CAP_BYTES, FetchRefusal, contentTypeMatches, fetchDocument, isSecUrl } from '../../lib/letters-fetch.mjs';
import { extractSections } from '../../lib/letters-html.mjs';
import { WORKER, parsePdf } from '../../lib/letters-pdf.mjs';
import { assess } from '../../lib/letters-quality.mjs';
import { alreadyRetrieved, emptyManifest, validateRow, writeManifestAtomic } from '../../lib/letters-manifest.mjs';
import { ledgerSummary } from '../../lib/letters-ledger.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

const tmp = mkdtempSync(join(tmpdir(), 'letters-retrieval-'));
const stubStat = { isDirectory: () => true };
const okProbe = () => ({ encrypted: true, evidence: 'test probe' });

// ── A PDF built here, so nothing copyrighted is ever a fixture ──────────────

function buildPdf({ withFont = true, withJavaScript = false, external = false, text = 'Fixture text alpha beta gamma' } = {}) {
  const objs = [];
  objs[1] = withJavaScript
    ? '<</Type/Catalog/Pages 2 0 R/OpenAction<</S/JavaScript/JS(app.alert\\(1\\))>>>>'
    : '<</Type/Catalog/Pages 2 0 R>>';
  objs[2] = '<</Type/Pages/Kids[3 0 R]/Count 1>>';
  const resources = withFont ? '<</Font<</F1 5 0 R>>>>' : '<</XObject<</Im1 5 0 R>>>>';
  objs[3] = `<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Resources${resources}/Contents 4 0 R>>`;
  const stream = withFont ? `BT /F1 12 Tf 72 700 Td (${text}) Tj ET` : 'q 100 0 0 100 72 600 cm /Im1 Do Q';
  objs[4] = `<</Length ${stream.length}>>\nstream\n${stream}\nendstream`;
  const fileSpec = external ? '/F(https://example.invalid/pixel.raw)' : '';
  objs[5] = withFont
    ? '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>'
    : `<</Type/XObject/Subtype/Image/Width 1/Height 1/ColorSpace/DeviceGray/BitsPerComponent 8${fileSpec}/Length 1>>\nstream\nZ\nendstream`;

  let out = '%PDF-1.4\n';
  const offsets = [];
  for (let i = 1; i < objs.length; i += 1) {
    offsets[i] = out.length;
    out += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objs.length; i += 1) out += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<</Size ${objs.length}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const res = ({ status = 200, headers = {}, body = Buffer.from('x') } = {}) => ({
  status,
  ok: status >= 200 && status < 300,
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  body: {
    getReader() {
      let sent = false;
      return { read: async () => (sent ? { done: true } : ((sent = true), { value: new Uint8Array(body), done: false })), cancel: async () => {} };
    },
  },
});

await test('the archive refuses an unset root, a repository path, scratch space and an unproven volume', () => {
  const base = { repoRoot: REPO, exists: () => true, stat: () => stubStat, probe: okProbe };
  assert.match(resolveArchive({ ...base, env: {} }).refusal, /LETTERS_ARCHIVE_ROOT is not set/);
  assert.match(resolveArchive({ ...base, env: { [ARCHIVE_ENV]: 'relative/path' } }).refusal, /not an absolute path/);
  assert.match(resolveArchive({ ...base, env: { [ARCHIVE_ENV]: join(REPO, 'data') } }).refusal, /inside .*never sit where they could be staged/);
  assert.match(resolveArchive({ ...base, env: { [ARCHIVE_ENV]: '/tmp/letters' } }).refusal, /temporary; the archive is permanent storage/);
  assert.match(resolveArchive({ ...base, env: { [ARCHIVE_ENV]: `${tmpdir()}/x` } }).refusal, /temporary/);
  assert.match(resolveArchive({ ...base, env: { [ARCHIVE_ENV]: '/mnt/letters' }, exists: () => false }).refusal, /does not exist/);
  const unproven = resolveArchive({ ...base, env: { [ARCHIVE_ENV]: '/mnt/letters' }, probe: () => ({ encrypted: null, evidence: 'no probe' }) });
  assert.match(unproven.refusal, /Confirmed encryption is required/);
  assert.equal(unproven.ok, false);
  assert.equal(resolveArchive({ ...base, env: { [ARCHIVE_ENV]: '/mnt/letters' }, probe: () => ({ encrypted: false, evidence: 'plain disk' }) }).ok, false);
  const good = resolveArchive({ ...base, env: { [ARCHIVE_ENV]: '/mnt/letters' } });
  assert.equal(good.ok, true);
  assert.equal(good.root, '/mnt/letters');
  assert.equal(good.checks.filter((c) => c.ok).length, 6, 'all six checks recorded as passed');
});

await test('the encryption probe reports a plain device as not encrypted and a dm-crypt one as encrypted', () => {
  const linux = (type) => probeEncryption('/x', { platform: 'linux', run: (cmd) => (cmd === 'findmnt' ? '/dev/mapper/x\n' : `${type}\n`) });
  assert.equal(linux('crypt').encrypted, true);
  assert.equal(linux('disk').encrypted, false);
  assert.equal(probeEncryption('/x', { platform: 'linux', run: () => { throw new Error('boom'); } }).encrypted, null);
  // macOS is left unimplemented on purpose until the private archive is
  // commissioned: an untested probe that returned true would be worse than none.
  assert.equal(probeEncryption('/x', { platform: 'darwin' }).encrypted, null);
  assert.equal(probeEncryption('/x', { platform: 'sunos' }).encrypted, null);
});

await test('a redirect off sec.gov is refused, and one within it is followed', async () => {
  assert.equal(isSecUrl('https://www.sec.gov/a'), true);
  assert.equal(isSecUrl('https://www.sec.gov.evil.com/a'), false);
  assert.equal(isSecUrl('http://www.sec.gov/a'), false);
  const offsite = async () => res({ status: 302, headers: { location: 'https://evil.example/a.pdf' } });
  await assert.rejects(
    fetchDocument({ url: 'https://www.sec.gov/a.pdf', expectedFormat: 'pdf', userAgent: 'x', fetchImpl: offsite }),
    (e) => e instanceof FetchRefusal && e.code === 'offsite_redirect'
  );
  let hop = 0;
  const inside = async () => (hop++ === 0
    ? res({ status: 301, headers: { location: 'https://www.sec.gov/final.pdf' } })
    : res({ status: 200, headers: { 'content-type': 'application/pdf', 'content-length': '1' }, body: Buffer.from('p') }));
  const out = await fetchDocument({ url: 'https://www.sec.gov/a.pdf', expectedFormat: 'pdf', userAgent: 'x', fetchImpl: inside });
  assert.equal(out.finalUrl, 'https://www.sec.gov/final.pdf');
  assert.equal(out.redirects.length, 1);
});

await test('a body over the cap is abandoned mid-stream, and an oversized Content-Length never starts', async () => {
  const declared = async () => res({ status: 200, headers: { 'content-type': 'application/pdf', 'content-length': String(CAP_BYTES + 1) } });
  await assert.rejects(fetchDocument({ url: 'https://www.sec.gov/a.pdf', expectedFormat: 'pdf', userAgent: 'x', fetchImpl: declared }), (e) => e.code === 'declared_too_large');
  const lying = async () => res({ status: 200, headers: { 'content-type': 'application/pdf', 'content-length': '10' }, body: Buffer.alloc(200) });
  await assert.rejects(
    fetchDocument({ url: 'https://www.sec.gov/a.pdf', expectedFormat: 'pdf', userAgent: 'x', fetchImpl: lying, cap: 100 }),
    (e) => e.code === 'body_too_large'
  );
});

await test('a Content-Length mismatch warns, unless the body was compressed on the wire', async () => {
  const impl = async () => res({ status: 200, headers: { 'content-type': 'application/pdf', 'content-length': '99' }, body: Buffer.from('four') });
  const out = await fetchDocument({ url: 'https://www.sec.gov/a.pdf', expectedFormat: 'pdf', expectedBytes: 5, userAgent: 'x', fetchImpl: impl });
  assert.equal(out.bytes, 4);
  assert.match(out.warnings[0], /Content-Length said 99 but 4 bytes arrived/);
  assert.match(out.warnings[1], /selection recorded 5 bytes but 4 arrived/);
  assert.equal(out.sha256, createHash('sha256').update('four').digest('hex'), 'the hash is of what arrived');

  // The SEC gzips these: Content-Length is the compressed size and comparing
  // it with the decoded body would warn on every well-behaved response.
  const gzipped = async () => res({ status: 200, headers: { 'content-type': 'application/pdf', 'content-length': '99', 'content-encoding': 'gzip' }, body: Buffer.from('four') });
  const enc = await fetchDocument({ url: 'https://www.sec.gov/a.pdf', expectedFormat: 'pdf', expectedBytes: 4, userAgent: 'x', fetchImpl: gzipped });
  assert.deepEqual(enc.warnings, [], 'no spurious warning when the transfer was encoded');
  assert.equal(enc.contentEncoding, 'gzip');
  // A chunked response declares nothing, and silence is not a mismatch.
  const chunked = async () => res({ status: 200, headers: { 'content-type': 'application/pdf', 'content-length': '0' }, body: Buffer.from('four') });
  assert.deepEqual((await fetchDocument({ url: 'https://www.sec.gov/a.pdf', expectedFormat: 'pdf', expectedBytes: 4, userAgent: 'x', fetchImpl: chunked })).warnings, []);
});

await test('a wrong content type, a 403 and a 429 each stop without a retry', async () => {
  const wrong = async () => res({ status: 200, headers: { 'content-type': 'text/html' } });
  await assert.rejects(fetchDocument({ url: 'https://www.sec.gov/a.pdf', expectedFormat: 'pdf', userAgent: 'x', fetchImpl: wrong }), (e) => e.code === 'wrong_type');
  assert.equal(contentTypeMatches('html', 'text/html; charset=utf-8'), true);
  assert.equal(contentTypeMatches('pdf', 'text/html'), false);
  for (const [status, code] of [[403, 'forbidden'], [429, 'rate_limited']]) {
    let calls = 0;
    const impl = async () => { calls += 1; return res({ status }); };
    await assert.rejects(
      fetchDocument({ url: 'https://www.sec.gov/a.pdf', expectedFormat: 'pdf', userAgent: 'x', fetchImpl: impl }),
      (e) => e.code === code && e.stopRun === true
    );
    assert.equal(calls, 1, 'one attempt, no retry');
  }
});

await test('a document already in the manifest with a good extraction is not fetched again', () => {
  const m = emptyManifest();
  const hash = 'a'.repeat(64);
  assert.equal(alreadyRetrieved(m, hash), false);
  m.documents[hash] = { sha256: hash, extractionStatus: 'ok' };
  assert.equal(alreadyRetrieved(m, hash), true);
  m.documents[hash].extractionStatus = 'no_text_layer';
  assert.equal(alreadyRetrieved(m, hash), false, 'a failed extraction is retried, a good one is not');
});

await test('the manifest is written atomically and rejects a row that carries text', () => {
  const path = join(tmp, 'manifest.json');
  const m = emptyManifest();
  m.documents.x = { sha256: 'b'.repeat(64) };
  assert.throws(() => writeManifestAtomic(path, m, { write: () => {}, rename: () => { throw new Error('interrupted'); } }), /interrupted/);
  assert.equal(existsSync(path), false, 'an interrupted write leaves nothing at the real path');
  writeManifestAtomic(path, m);
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).version, 1);
  const problems = validateRow({ sha256: 'zz', documentId: 'other', actualBytes: CAP_BYTES + 1, manager: 'x'.repeat(600) });
  assert.ok(problems.some((p) => /not a 64-character hex/.test(p)));
  assert.ok(problems.some((p) => /documentId must be the sha256/.test(p)));
  assert.ok(problems.some((p) => /over the 15 MiB cap/.test(p)));
  assert.ok(problems.some((p) => /metadata, not text/.test(p)));
});

await test('a PDF with a text layer parses to pages, and an image-only one fails closed', async () => {
  const good = join(tmp, 'text.pdf');
  writeFileSync(good, buildPdf({ withFont: true }));
  const out = await parsePdf(good);
  assert.equal(out.status, 'ok');
  assert.equal(out.units, 'pages');
  assert.equal(out.pages.length, 1);
  assert.match(out.pages[0].text, /Fixture text alpha/);
  assert.equal(out.parser, 'pdfjs-dist');
  assert.equal(out.parserVersion, '6.3.289', 'the pinned version is what ran');

  const imageOnly = join(tmp, 'image.pdf');
  writeFileSync(imageOnly, buildPdf({ withFont: false }));
  const bad = await parsePdf(imageOnly);
  assert.equal(bad.status, 'no_text_layer');
  assert.equal(bad.stats.characters, 0);
  assert.match(bad.warnings[0], /image-only document/);
});

await test('the PDF worker is hardened, and a document carrying JavaScript or an external resource yields only text', async () => {
  const src = readFileSync(WORKER, 'utf8');
  for (const flag of ['isEvalSupported: false', 'enableScripting: false', 'enableXfa: false', 'disableFontFace: true', 'useSystemFonts: false', 'disableAutoFetch: true', 'disableRange: true', 'maxImageSize: 1']) {
    assert.ok(src.includes(flag), `the worker sets ${flag}`);
  }
  const js = join(tmp, 'js.pdf');
  writeFileSync(js, buildPdf({ withFont: true, withJavaScript: true, text: 'Benign body text' }));
  const out = await parsePdf(js);
  assert.equal(out.status, 'ok');
  assert.match(out.pages[0].text, /Benign body text/);
  assert.ok(!/app\.alert/.test(out.pages[0].text), 'the action is not treated as content');

  const ext = join(tmp, 'external.pdf');
  writeFileSync(ext, buildPdf({ withFont: false, external: true }));
  const extOut = await parsePdf(ext);
  assert.equal(extOut.status, 'no_text_layer', 'no text, and the external file specification is not resolved');
});

await test('a PDF that will not finish is killed by the parent, not left running', async () => {
  const hang = join(tmp, 'hang-worker.mjs');
  // A timer keeps the event loop alive; an unsettled top-level await would
  // make Node exit by itself and test nothing.
  writeFileSync(hang, 'setInterval(() => {}, 1000);\n');
  const out = await parsePdf(join(tmp, 'text.pdf'), { worker: hang, timeoutMs: 700 });
  assert.equal(out.status, 'failed');
  assert.equal(out.failure, 'timeout');
  assert.match(out.warnings[0], /did not parse inside its time limit/);
});

await test('SEC HTML and inline XBRL lose their chrome and keep their prose, tables and order', () => {
  const html = `<html><head><title>t</title><style>a{}</style><meta charset="utf-8"></head><body>
    <ix:header><ix:hidden><p>hidden tagging</p></ix:hidden><ix:references><p>schema</p></ix:references></ix:header>
    <script>fetch('https://evil.example')</script><noscript>no</noscript>
    <nav><a href="https://evil.example">Home</a></nav>
    <h1>Letter to Shareholders</h1>
    <p>We believe the <ix:nonNumeric contextRef="c">company</ix:nonNumeric> is undervalued.</p>
    <table><tr><th>Year</th><th>Return</th></tr><tr><td>2025</td><td>12.4%</td></tr></table>
    <ul><li>First point</li><li>Second point</li></ul>
    <iframe src="https://evil.example"></iframe></body></html>`;
  const r = extractSections(html);
  const texts = r.sections.map((s) => s.text);
  assert.ok(!texts.some((t) => /hidden tagging|schema|evil\.example|fetch\(/.test(t)), 'no tagging, no script, no external URL');
  assert.equal(texts[0], 'Letter to Shareholders');
  assert.equal(texts[1], 'We believe the company is undervalued.');
  assert.equal(r.sections[0].tag, 'h1');
  assert.equal(r.sections[0].level, 1);
  assert.deepEqual(texts.slice(2, 4), ['Year\tReturn', '2025\t12.4%'], 'table rows keep the cell boundary');
  assert.deepEqual(texts.slice(4), ['First point', 'Second point'], 'list order preserved');
  assert.ok(r.stats.droppedElements >= 4);
  assert.equal(extractSections('<html><body><img src="x"></body></html>').warnings[0], 'no sections survived: the document may be a frameset, an image or entirely tagging');
});

await test('unit hashes are stable across runs and move only when the text moves', () => {
  const html = '<html><body><h1>One</h1><p>Two</p></body></html>';
  const hashes = (h) => extractSections(h).sections.map((s) => createHash('sha256').update(s.text).digest('hex'));
  assert.deepEqual(hashes(html), hashes(html), 'the same input gives the same hashes');
  assert.deepEqual(hashes(html), hashes('<html><body><h1>One</h1>\n\n  <p>Two</p>  </body></html>'), 'whitespace does not move a hash');
  assert.notDeepEqual(hashes(html), hashes('<html><body><h1>One</h1><p>Three</p></body></html>'));
});

await test('quality measures catch a blank extraction, a running header and a bad encoding', () => {
  const page = (text) => ({ index: 1, tag: 'page', text, chars: text.length });
  const blank = assess({ units: 'pages', items: [page(''), page(''), page('a')], rawCharacters: 10 });
  assert.ok(blank.emptyUnitRatio > 0.3);
  assert.ok(blank.warnings.some((w) => /empty: check for an image-only document/.test(w)));
  const header = assess({ units: 'pages', items: Array.from({ length: 5 }, () => page('Longleaf Partners Funds\nbody text here')), rawCharacters: 100 });
  assert.ok(header.repeatedEdgeRatio > 0.6);
  assert.ok(header.warnings.some((w) => /running header is being counted as content/.test(w)));
  const mojibake = assess({ units: 'pages', items: [page('a�'.repeat(50))], rawCharacters: 100 });
  assert.ok(mojibake.warnings.some((w) => /encoding may be wrong/.test(w)));
  const good = assess({ units: 'sections', items: [page(`We believe our position in the portfolio is sound. ${'Management and valuation and earnings for shareholders. '.repeat(60)}`)], rawCharacters: 5000 });
  assert.equal(good.managerDiscussionPresent, true);
  assert.deepEqual(good.warnings, []);
});

await test('the archive can never be staged: its paths are gitignored and it lives outside the repository', () => {
  const ignore = readFileSync(join(REPO, '.gitignore'), 'utf8');
  for (const pattern of ['letters-archive/', '.letters-archive/', 'letters-review-report.md']) {
    assert.ok(ignore.includes(pattern), `.gitignore covers ${pattern}`);
  }
  assert.ok(ignore.includes('node_modules/'), 'and the dependencies stay out too');
  const inside = resolveArchive({ env: { [ARCHIVE_ENV]: join(REPO, 'letters-archive') }, repoRoot: REPO, exists: () => true, stat: () => stubStat, probe: okProbe });
  assert.equal(inside.ok, false, 'the gate refuses an archive inside the repository');
});

// ── The two modes ───────────────────────────────────────────────────────────

await test('ephemeral-sec needs no archive, retains nothing, and refuses a document nobody approved', () => {
  const place = resolveWorkspace({ mode: 'ephemeral-sec', env: {}, repoRoot: REPO, base: tmp });
  assert.equal(place.ok, true, 'no LETTERS_ARCHIVE_ROOT, and it still runs');
  assert.equal(place.retainsBytes, false);
  assert.ok(place.workspace.path.startsWith(tmp), 'a directory of its own');
  place.workspace.cleanup();

  const selection = [{ documentUrl: 'https://www.sec.gov/Archives/edgar/data/769397/000092189525000816/ex1.pdf' }];
  assert.equal(approvedDocument(selection[0].documentUrl, selection).ok, true);
  assert.match(approvedDocument('https://www.sec.gov/Archives/edgar/data/1/000000000000000001/x.pdf', selection).reason, /not in the approved selection/);
  assert.match(approvedDocument('https://evil.example/x.pdf', selection).reason, /not an https www\.sec\.gov filing document/);
  assert.match(approvedDocument('http://www.sec.gov/Archives/edgar/data/1/000000000000000001/x.pdf', selection).reason, /not an https/);
});

await test('local-private still refuses without a verified encrypted archive, and an unknown mode refuses too', () => {
  const refused = resolveWorkspace({ mode: 'local-private', env: {}, repoRoot: REPO, base: tmp });
  assert.equal(refused.ok, false);
  assert.match(refused.refusal, /LETTERS_ARCHIVE_ROOT is not set/);
  assert.match(resolveWorkspace({ mode: 'nonsense' }).refusal, /unknown mode/);
  // macOS is deliberately not implemented yet, so it refuses rather than guessing.
  assert.equal(probeEncryption('/x', { platform: 'darwin' }).encrypted, null);
  assert.match(probeEncryption('/x', { platform: 'darwin' }).evidence, /not built yet/);
});

// ── Cleanup, after each way a run ends ──────────────────────────────────────

const scratch = (ws, name) => writeFileSync(join(ws.path, name), 'scratch bytes');

await test('the workspace is removed after success, a download failure, a size rejection, a parser exception, a timeout and an interrupted write', async () => {
  const endings = [
    ['success', async (ws) => { scratch(ws, 'doc.pdf'); return 'parsed'; }],
    ['download failure', async (ws) => { throw new FetchRefusal('http_error', 'HTTP 500'); }],
    ['size rejection', async (ws) => { scratch(ws, 'partial.pdf'); throw new FetchRefusal('body_too_large', 'over the cap'); }],
    ['parser exception', async (ws) => { scratch(ws, 'doc.pdf'); throw new Error('the parser threw'); }],
    ['parser timeout', async (ws) => { scratch(ws, 'doc.pdf'); return { status: 'failed', failure: 'timeout' }; }],
    ['interrupted write', async (ws) => { scratch(ws, 'doc.pdf'); scratch(ws, 'out.json.tmp'); throw new Error('interrupted'); }],
  ];
  for (const [label, fn] of endings) {
    const ws = createWorkspace({ base: tmp });
    const paths = [];
    const { error, cleanup } = await withWorkspace(ws, async (w) => { const r = await fn(w); paths.push(w.path); return r; });
    assert.equal(cleanup.clean, true, `${label}: the workspace is gone`);
    assert.equal(cleanup.remainingFiles, 0, `${label}: no file survived`);
    assert.equal(cleanup.workspaceExists, false, `${label}: the directory itself is gone`);
    assert.equal(existsSync(ws.path), false, `${label}: nothing at the path`);
    if (label !== 'success' && label !== 'parser timeout') assert.ok(error, `${label}: the error is returned, not swallowed`);
  }
});

await test('cleanup is idempotent, so a signal handler and a finally block can both run it', () => {
  const ws = createWorkspace({ base: tmp });
  scratch(ws, 'a.pdf');
  assert.equal(ws.cleanup().removed, true);
  assert.equal(ws.cleanup().alreadyGone, true, 'the second call does nothing and does not throw');
  assert.equal(existsSync(ws.path), false);
});

// ── What may be published ───────────────────────────────────────────────────

await test('the public record carries only allowed fields, and refuses text however it arrives', () => {
  const full = {
    schemaVersion: SCHEMA_VERSION, manager: 'starboard-value', documentId: 'c'.repeat(64), sha256: 'c'.repeat(64),
    subjectOrPeriod: 'CARMAX INC', filingDate: '2026-03-11', form: 'DFAN14A', accession: '0000921895-26-000666',
    filingIndexUrl: 'https://www.sec.gov/Archives/edgar/data/1170010/000092189526000666/0000921895-26-000666-index.htm',
    documentUrl: 'https://www.sec.gov/Archives/edgar/data/1170010/000092189526000666/ex1.pdf',
    sourceBytes: 145421, mimeType: 'application/pdf', parser: 'pdfjs-dist', parserVersion: '6.3.289',
    extractionStatus: 'ok', units: 'pages', unitCount: 3, characterCount: 9000, quality: { emptyUnitRatio: 0 },
    warnings: [], processedAt: '2026-09-17T00:00:00Z',
    // None of these may survive.
    text: 'Dear Members of the Board', pages: [{ text: 'page one' }], items: [1], summary: 'a summary', themes: ['x'], originalPath: '/tmp/x',
  };
  const record = toPublicRecord(full);
  for (const forbidden of ['text', 'pages', 'items', 'summary', 'themes', 'originalPath']) {
    assert.ok(!(forbidden in record), `${forbidden} is dropped`);
  }
  assert.deepEqual(validatePublicRecord(record), []);
  assert.deepEqual(validatePublicRecord({ ...record, text: 'x' }), ['text is not a public field', 'text would carry document content']);
  assert.ok(validatePublicRecord({ ...record, subjectOrPeriod: 'y'.repeat(401) })[0].includes('measurements, not text'));
  assert.ok(validatePublicRecord({ ...record, quality: { note: 'z'.repeat(401) } })[0].includes('quality.note'));
  assert.ok(validatePublicRecord({ ...record, documentUrl: 'https://example.com/x' }).some((p) => /authoritative sec\.gov/.test(p)));
  assert.ok(validatePublicRecord({ ...record, sourceBytes: CAP_BYTES + 1 }).some((p) => /over the 15 MiB cap/.test(p)));
});

await test('a record is unchanged only when the filing, bytes, parser, schema and configuration all match', () => {
  const base = {
    accession: 'a', sha256: 'd'.repeat(64), parser: 'p', parserVersion: '1', documentUrl: 'u',
    schemaVersion: SCHEMA_VERSION, extractionConfigVersion: EXTRACTION_CONFIG_VERSION, extractionStatus: 'ok',
  };
  const previous = { documents: [base] };
  assert.equal(unchanged(previous, { ...base }), true);
  assert.equal(unchanged(previous, { ...base, sha256: 'e'.repeat(64) }), false, 'the document changed');
  assert.equal(unchanged(previous, { ...base, parserVersion: '2' }), false, 'the parser changed');
  assert.equal(unchanged(previous, { ...base, accession: 'b' }), false, 'a different filing');
  assert.equal(unchanged(previous, { ...base, schemaVersion: SCHEMA_VERSION + 1 }), false, 'the published shape changed');
  assert.equal(unchanged(previous, { ...base, extractionConfigVersion: EXTRACTION_CONFIG_VERSION + 1 }), false, 'the parsing configuration changed');
  assert.equal(unchanged(previous, { ...base, extractionStatus: 'failed' }), false);
  assert.equal(identityKey(base), `a:${'d'.repeat(64)}:p@1:schema${SCHEMA_VERSION}:config${EXTRACTION_CONFIG_VERSION}:ok`);
});

// ── Idempotency: an unchanged rerun must rewrite the same bytes ─────────────
//
// The committed files are read as a record of the documents, so a diff has
// to mean a document moved. A run that writes a fresh timestamp, a request
// count or a tally of what it skipped makes every rerun look like news and
// makes the real news invisible. These two tests are the pair: nothing about
// a run may reach the file, and everything about a document must.

/** A record as the retrieval script would build one, at a given clock. */
function recordAt(now, overrides = {}) {
  return toPublicRecord({
    schemaVersion: SCHEMA_VERSION,
    manager: 'oakmark',
    documentId: 'b'.repeat(64),
    subjectOrPeriod: '2026-03-31',
    filingDate: '2026-06-04',
    form: 'N-CSRS',
    accession: '0001104659-26-000001',
    filingIndexUrl: 'https://www.sec.gov/Archives/edgar/data/872323/000110465926000001/0001104659-26-000001-index.htm',
    documentUrl: 'https://www.sec.gov/Archives/edgar/data/872323/000110465926000001/report.htm',
    sourceBytes: 4096,
    sha256: 'b'.repeat(64),
    mimeType: 'text/html',
    parser: 'parse5',
    parserVersion: '8.0.1',
    extractionConfigVersion: EXTRACTION_CONFIG_VERSION,
    extractionStatus: 'ok',
    units: 'sections',
    unitCount: 12,
    characterCount: 3400,
    quality: { emptyUnitRatio: 0, repeatedEdgeRatio: 0, replacementRate: 0, tableRows: 2, managerDiscussionPresent: true },
    warnings: [],
    processedAt: now,
    ...overrides,
  });
}

await test('two generations with different clocks write byte-identical JSON and Markdown', () => {
  const first = buildOutput([
    recordAt('2026-01-01T00:00:00.000Z'),
    recordAt('2026-01-01T00:00:01.000Z', { manager: 'sequoia', documentUrl: 'https://www.sec.gov/Archives/edgar/data/89043/000110465926000002/report.htm', accession: '0001104659-26-000002', sha256: 'c'.repeat(64), documentId: 'c'.repeat(64) }),
  ]);
  const firstJson = serialiseOutput(first);
  const firstMd = renderMarkdown(first);

  // The second run reads the same documents an hour later, in the opposite
  // order, and preserves each timestamp because nothing about them changed.
  const later = '2026-06-30T12:34:56.789Z';
  const second = buildOutput([
    preserveProcessedAt(first, recordAt(later, { manager: 'sequoia', documentUrl: 'https://www.sec.gov/Archives/edgar/data/89043/000110465926000002/report.htm', accession: '0001104659-26-000002', sha256: 'c'.repeat(64), documentId: 'c'.repeat(64) })),
    preserveProcessedAt(first, recordAt(later)),
  ]);

  assert.equal(serialiseOutput(second), firstJson, 'the JSON changed on an unchanged rerun');
  assert.equal(renderMarkdown(second), firstMd, 'the Markdown changed on an unchanged rerun');
  assert.ok(!/\d{4}-\d\d-\d\dT\d\d:\d\d/.test(firstMd), 'the Markdown carries a timestamp');
  assert.deepEqual(Object.keys(first), ['schemaVersion', 'extractionConfigVersion', 'note', 'documents'], 'run data reached the committed file');
  for (const key of ['generatedAt', 'counts', 'requests', 'runtimeMs', 'mode']) {
    assert.equal(first[key], undefined, `${key} must not be committed`);
  }
});

await test('a changed hash, parser version, schema version or configuration updates the record and its timestamp', () => {
  const before = buildOutput([recordAt('2026-01-01T00:00:00.000Z')]);
  const now = '2026-09-17T09:00:00.000Z';

  const same = preserveProcessedAt(before, recordAt(now));
  assert.equal(same.processedAt, '2026-01-01T00:00:00.000Z', 'an unchanged record kept its first timestamp');

  for (const [what, change] of [
    ['a re-filed document', { sha256: 'f'.repeat(64), documentId: 'f'.repeat(64) }],
    ['a newer parser', { parserVersion: '9.9.9' }],
    ['a wider schema', { schemaVersion: SCHEMA_VERSION + 1 }],
    ['a different parsing configuration', { extractionConfigVersion: EXTRACTION_CONFIG_VERSION + 1 }],
    ['a document that stopped parsing', { extractionStatus: 'failed' }],
  ]) {
    const after = preserveProcessedAt(before, recordAt(now, change));
    assert.equal(after.processedAt, now, `${what} should have earned a new timestamp`);
    assert.notEqual(serialiseOutput(buildOutput([after])), serialiseOutput(before), `${what} should have changed the committed file`);
  }
});

await test('the order of records does not depend on the order a run read them', () => {
  const rows = [
    { manager: 'starboard-value', filingDate: '2026-03-11', accession: 'a2', documentUrl: 'u2' },
    { manager: 'oakmark', filingDate: '2026-06-04', accession: 'a1', documentUrl: 'u1' },
    { manager: 'oakmark', filingDate: '2025-12-31', accession: 'a3', documentUrl: 'u3' },
  ];
  const order = (list) => sortRecords(list).map((r) => r.accession).join(',');
  assert.equal(order(rows), 'a3,a1,a2');
  assert.equal(order([...rows].reverse()), 'a3,a1,a2', 'the sort depends on the run order');
});

await test('the retrieval script can rebuild both files without a network call', () => {
  const source = readFileSync(join(REPO, 'scripts', 'retrieve-letters.mjs'), 'utf8');
  assert.match(source, /--render-only/, 'render-only is not documented in the usage block');
  assert.match(source, /function renderOnly\(\)/, 'there is no render-only path');
  const body = source.slice(source.indexOf('function renderOnly()'), source.indexOf('async function main()'));
  for (const forbidden of ['fetchDocument', 'appendLedger', 'appendRunLog', 'appendDurable', 'parsePdf', 'extractSections']) {
    assert.ok(!body.includes(forbidden), `render-only reaches for ${forbidden}`);
  }
});

await test('the committed ledger accounts for all four retrieval runs, the unintended one included', () => {
  const lines = readFileSync(join(REPO, 'data', 'letters.requests.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const gets = lines.filter((l) => l.script === 'retrieve-letters');
  assert.equal(gets.length, 36, 'the durable ledger should hold 36 observed document GETs');
  assert.ok(gets.every((l) => l.status === 200 && l.reconstructed === undefined), 'every retrieval line is observed, not reconstructed');

  const byRun = new Map();
  for (const l of gets) byRun.set(l.run, (byRun.get(l.run) || 0) + 1);
  assert.deepEqual([...byRun.entries()].sort(), [[1, 9], [2, 9], [3, 9], [4, 9]], 'four runs of nine documents');
  assert.deepEqual(gets.filter((l) => l.intended === false).map((l) => l.run), Array(9).fill(3), 'the third run is the accidental one');
  assert.match(lines[0].note, /run 3 accidental/, 'the ledger note does not say what the third run was');
  assert.match(lines[0].note, /production_verification/, 'the ledger note does not say what the fourth run was');

  const summary = ledgerSummary(join(REPO, 'data', 'letters.requests.jsonl'));
  assert.equal(summary.byScript['retrieve-letters'].observed, 36);
  assert.equal(summary.byScript['retrieve-letters'].reconstructed, 0);
});

rmSync(tmp, { recursive: true, force: true });
console.log(`${passed} passed`);
