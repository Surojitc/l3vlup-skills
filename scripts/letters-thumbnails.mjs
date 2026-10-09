#!/usr/bin/env node
// Letters: render the source previews (thumbnails) the site shows for public
// SEC filings, and nothing for anyone else.
//
//   node scripts/letters-thumbnails.mjs                 every eligible record
//   node scripts/letters-thumbnails.mjs --only a,b      just these slugs
//   node scripts/letters-thumbnails.mjs --dry-run       say what would happen
//   node scripts/letters-thumbnails.mjs --force         re-render even if current
//                                                       (with --only, just those)
//   node scripts/letters-thumbnails.mjs --html          also render SEC HTML letters
//                                                       (detail size only; needs
//                                                       playwright-core and Chromium)
//
// Reads data/letters.thumbnail-sources.json (the registry: source, route,
// rights, mode, takedown) and writes data/letters/thumbs/*.webp and
// data/letters.thumbnails.json (the manifest). The rules are in
// lib/letters-thumbs.mjs; this file is the plumbing.
//
// ONE DOCUMENT AT A TIME, AND THEN IT IS GONE
// Each record gets a directory of its own, made for this run. The source is
// downloaded into it once (sec.gov only, with the declared research user
// agent, at most one request a second, refusing a 403 or a 429 outright),
// its letter page is rendered, the WebP files are written into the repo, and
// the directory is removed before the next record starts, whatever happened.
// No source PDF or HTML is ever written anywhere else, cached or proxied.
//
// WHAT RENDERS WHAT
//   pages      pdftoppm (poppler). Nothing else is used for a PDF: pdf.js in
//              node renders without fonts it cannot find, and a browser's PDF
//              viewer does not run headless.
//   HTML       Chromium through playwright-core, only with --html and only
//              where it is already installed. The page is opened at a 640 px
//              viewport at the letter's route; requests are held to sec.gov
//              and throttled. Detail size only: on a card, an EDGAR HTML page
//              is grey text like every other, and the identity cover says more.
//   WebP       sharp if it resolves, else cwebp, else Python Pillow. Quality
//              starts at 70 and steps down until a file is inside its budget.
//
// IDEMPOTENT
// A record whose manifest entry carries the same render key (source, route,
// page hints, renderer version) and whose files still hash to the manifest is
// skipped without a request. So is a record the photo guard refused under the
// same key. --force renders again.
//
// Scheduling is deliberately not here: no workflow runs this yet.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FetchRefusal, fetchDocument } from '../lib/letters-fetch.mjs';
import { createWorkspace, onExitCleanup } from '../lib/letters-workspace.mjs';
import {
  QUALITY_STEPS,
  RENDER_VERSION,
  SIZES,
  THUMBS_DIR,
  USER_AGENT,
  candidatePages,
  cardBox,
  choosePages,
  cropImage,
  cropRegion,
  entryProblems,
  hasRegion,
  isWebp,
  judgePage,
  parsePgm,
  regionBox,
  renderDecision,
  renderKey,
  sha256,
  thumbPath,
} from '../lib/letters-thumbs.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'data');
const REGISTRY = join(DATA, 'letters.thumbnail-sources.json');
const MANIFEST = join(DATA, 'letters.thumbnails.json');
const UA = process.env.SEC_USER_AGENT || USER_AGENT;
/** The largest annual report in the catalogue is about 24 MB. */
const SOURCE_CAP = 40 * 1024 * 1024;
const GAP_MS = 1100;
const ANALYSIS_W = 600;
const RENDER_W = 1280;
const HTML_VIEWPORT = { width: 640, height: 828 };

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
};
const DRY = flag('--dry-run');
const FORCE = flag('--force');
const HTML = flag('--html');
const ONLY = opt('--only') ? new Set(opt('--only').split(',').map((s) => s.trim())) : null;
const today = () => new Date().toISOString().slice(0, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------ encoders -- */

async function pickEncoder() {
  try {
    const sharp = (await import('sharp')).default;
    return {
      name: 'sharp',
      async encode(png, box, w, h, q, out) {
        await sharp(png).extract({ left: box.x, top: box.y, width: box.w, height: box.h }).resize(w, h, { kernel: 'lanczos3' }).webp({ quality: q, effort: 6 }).toFile(out);
      },
      async gray(png, out, width) {
        const { data, info } = await sharp(png).resize(width).grayscale().raw().toBuffer({ resolveWithObject: true });
        writeFileSync(out, Buffer.concat([Buffer.from(`P5\n${info.width} ${info.height}\n255\n`), data]));
      },
      async size(png) {
        const m = await sharp(png).metadata();
        return { W: m.width, H: m.height };
      },
    };
  } catch {
    // not installed: fall through
  }
  const pillow = spawnSync('python3', ['-I', '-c', 'import PIL, PIL.features; assert PIL.features.check("webp"); print(PIL.__version__)'], { encoding: 'utf8' });
  const cwebp = spawnSync('cwebp', ['-version'], { encoding: 'utf8' });
  // cwebp encodes, but it cannot read a page back for the photo guard, so it
  // is used only where Pillow is not there to do both.
  if (pillow.status !== 0 && cwebp.status === 0) {
    return {
      name: `cwebp ${cwebp.stdout.trim()}`,
      async encode(png, box, w, h, q, out) {
        run('cwebp', ['-quiet', '-q', String(q), '-m', '6', '-crop', String(box.x), String(box.y), String(box.w), String(box.h), '-resize', String(w), String(h), png, '-o', out]);
      },
      gray: null,
      size: null,
    };
  }
  if (pillow.status !== 0) throw new Error('no WebP encoder: install sharp, cwebp or Python Pillow with WebP support');
  const py = (code, args) => run('python3', ['-I', '-c', code, ...args]);
  return {
    name: `Pillow ${pillow.stdout.trim()}`,
    async encode(png, box, w, h, q, out) {
      py(
        'import sys\nfrom PIL import Image\np,x,y,bw,bh,w,h,q,o=sys.argv[1:]\nim=Image.open(p).convert("RGB").crop((int(x),int(y),int(x)+int(bw),int(y)+int(bh))).resize((int(w),int(h)),Image.LANCZOS)\nim.save(o,"WEBP",quality=int(q),method=6)',
        [png, box.x, box.y, box.w, box.h, w, h, q, out].map(String),
      );
    },
    async gray(png, out, width) {
      py('import sys\nfrom PIL import Image\np,o,w=sys.argv[1:]\nim=Image.open(p).convert("L")\nw=int(w)\nim.resize((w,round(im.height*w/im.width)),Image.LANCZOS).save(o,"PPM")', [png, out, String(width)]);
    },
    async size(png) {
      const r = py('import sys\nfrom PIL import Image\nim=Image.open(sys.argv[1])\nprint(im.width,im.height)', [png]);
      const [W, H] = r.stdout.trim().split(' ').map(Number);
      return { W, H };
    },
  };
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`${cmd} failed: ${(r.stderr || r.error?.message || '').trim().slice(0, 400)}`);
  return r;
}

function pngSize(file) {
  const b = readFileSync(file);
  return { W: b.readUInt32BE(16), H: b.readUInt32BE(20) };
}

/** Encode one slot inside its budget, stepping quality down. */
async function encodeSlot(enc, png, box, slot, out) {
  const { w } = SIZES[slot];
  const h = SIZES[slot].aspect ? Math.round(w / SIZES[slot].aspect) : Math.round((box.h * w) / box.w);
  for (const q of QUALITY_STEPS) {
    await enc.encode(png, box, w, h, q, out);
    const buf = readFileSync(out);
    if (!isWebp(buf)) throw new Error(`${out} is not a WebP`);
    if (buf.length <= SIZES[slot].budget) return { w, h, quality: q, buf };
  }
  rmSync(out, { force: true });
  return null;
}

/* ------------------------------------------------------------- sources -- */

// One queue for every request to sec.gov, the document and a page's own
// images alike, so concurrent requests from a browser wait their turn.
let lastSecRequest = 0;
let queue = Promise.resolve();
function politeGap() {
  queue = queue.then(async () => {
    const wait = lastSecRequest + GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastSecRequest = Date.now();
  });
  return queue;
}

async function download(entry) {
  await politeGap();
  return fetchDocument({ url: entry.sourceUrl, expectedFormat: 'pdf', cap: SOURCE_CAP, userAgent: UA });
}

/** pdftoppm one page: grey PGM for the guard, or PNG for the crops. */
function renderPdfPage(pdf, page, outBase, { gray, width = RENDER_W }) {
  const args = ['-f', String(page), '-l', String(page), '-singlefile', '-scale-to-x', String(gray ? ANALYSIS_W : width), '-scale-to-y', '-1'];
  if (gray) args.push('-gray');
  else args.push('-png');
  run('pdftoppm', [...args, pdf, outBase]);
  return `${outBase}.${gray ? 'pgm' : 'png'}`;
}

function pdfPageCount(pdf) {
  const r = spawnSync('pdfinfo', [pdf], { encoding: 'utf8' });
  const m = /Pages:\s+(\d+)/.exec(r.stdout || '');
  return m ? Number(m[1]) : null;
}

async function renderPdfRecord(slug, entry, enc, dir) {
  const got = await download(entry);
  const pdf = join(dir, 'source.pdf');
  writeFileSync(pdf, got.body);
  const pages = pdfPageCount(pdf);
  const crop = entry.crop ?? {};
  // A region (or a half of a spread) is judged alone, at the page's own
  // analysis scale, and cut from a render wide enough that the region itself
  // is RENDER_W across: the type is enlarged from the source, never upscaled.
  const region = cropRegion(crop);
  const regioned = hasRegion(crop);
  const hints = { top: crop.top, left: crop.left, right: crop.right };
  const pngWidth = regioned ? Math.min(4096, Math.round(RENDER_W / (region.right - region.left))) : RENDER_W;
  const judged = [];
  for (const page of candidatePages(entry)) {
    if (pages && page > pages) break;
    const pgm = renderPdfPage(pdf, page, join(dir, `g${page}`), { gray: true });
    const grey = parsePgm(readFileSync(pgm));
    judged.push({ page, verdict: judgePage(regioned ? cropImage(grey, region) : grey, { ...hints, graphicsReviewed: entry.guardOverride === 'graphics-not-photographs' }) });
  }
  const choice = choosePages(judged);
  const out = { source: { sha256: got.sha256, bytes: got.bytes, pages }, files: {}, notes: [] };
  if (regioned) out.notes.push(`region: ${crop.half ? `${crop.half} half of the spread` : `${region.left}-${region.right} across, ${region.top}-${region.bottom} down`}; review by ${crop.reviewBy}`);
  const pngs = new Map();
  const pagePng = (page) => {
    if (!pngs.has(page)) pngs.set(page, renderPdfPage(pdf, page, join(dir, `p${page}`), { gray: false, width: pngWidth }));
    return pngs.get(page);
  };
  const regionOf = (png) => {
    const { W, H } = pngSize(png);
    return regionBox(W, H, region);
  };
  if (choice.card) {
    const png = pagePng(choice.card.page);
    const rb = regionOf(png);
    const inner = cardBox(rb.w, rb.h, { ...hints, top: choice.card.top });
    const box = { ...inner, x: rb.x + inner.x, y: rb.y + inner.y };
    for (const slot of ['card', 'card2x']) {
      const file = join(DATA, thumbPath(slug, slot));
      const r = await encodeSlot(enc, png, box, slot, file);
      if (r) out.files[slot] = { ...r, page: choice.card.page, top: choice.card.top };
      else out.notes.push(`${slot}: over budget at every quality`);
    }
    for (const s of choice.card.skipped) out.notes.push(`card: p${s.page} skipped (${s.reason})`);
  } else out.notes.push(`card: identity cover (${choice.cardRefused})`);
  if (choice.detail) {
    const png = pagePng(choice.detail.page);
    const file = join(DATA, thumbPath(slug, 'detail'));
    const r = await encodeSlot(enc, png, regionOf(png), 'detail', file);
    if (r) out.files.detail = { ...r, page: choice.detail.page };
    else out.notes.push('detail: over budget at every quality');
    for (const s of choice.detail.skipped) out.notes.push(`detail: p${s.page} skipped (${s.reason})`);
  } else out.notes.push(`detail: identity cover (${choice.detailRefused})`);
  return out;
}

/* ---------------------------------------------------------------- HTML -- */

let browser = null;
async function htmlBrowser() {
  if (browser) return browser;
  const req = createRequire(pathToFileURL(join(process.cwd(), 'noop.js')));
  let pw;
  try {
    pw = req(process.env.PLAYWRIGHT_CORE_PATH || 'playwright-core');
  } catch {
    return null;
  }
  browser = await pw.chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined });
  return browser;
}

async function renderHtmlRecord(slug, entry, enc, dir) {
  const b = await htmlBrowser();
  if (!b) return { unavailable: 'HTML renderer unavailable (playwright-core not installed)' };
  if (!enc.gray) return { unavailable: 'HTML renderer needs Pillow or sharp for the photo guard' };
  // A fresh context per record: nothing is cached between records or kept after.
  const ctx = await b.newContext({ userAgent: UA, viewport: HTML_VIEWPORT, deviceScaleFactor: 1, javaScriptEnabled: true });
  let requests = 0;
  let main = null;
  try {
    await ctx.route('**/*', async (route) => {
      const u = new URL(route.request().url());
      if (u.protocol !== 'https:' || !/(^|\.)sec\.gov$/i.test(u.hostname)) return route.abort();
      requests += 1;
      await politeGap();
      return route.continue();
    });
    const page = await ctx.newPage();
    const res = await page.goto(entry.sourceUrl, { waitUntil: 'load', timeout: 90_000 });
    if (!res || res.status() === 403 || res.status() === 429) throw new FetchRefusal('forbidden', `HTTP ${res?.status()} for ${entry.sourceUrl}; stopping`);
    main = await res.body();
    // A filing laid out wider than the viewport (page images, a fixed-width
    // table) is shown whole: the viewport widens to it, keeping the portrait.
    const wide = await page.evaluate(() => document.documentElement.scrollWidth);
    const vw = Math.min(Math.max(HTML_VIEWPORT.width, wide), 1100);
    const vh = Math.round((vw * HTML_VIEWPORT.height) / HTML_VIEWPORT.width);
    if (vw !== HTML_VIEWPORT.width) await page.setViewportSize({ width: vw, height: vh });
    await sleep(300);
    const r = entry.letterRoute;
    const y = await page.evaluate((route) => {
      const top = (el) => (el ? el.getBoundingClientRect().top + window.scrollY : 0);
      if (route.method === 'anchor') return top(document.getElementById(route.anchor) || document.getElementsByName(route.anchor)[0]);
      if (route.method === 'text-fragment') {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        const want = route.phrase.replace(/\s+/g, ' ').trim().toLowerCase();
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          if (n.textContent.replace(/\s+/g, ' ').toLowerCase().includes(want)) return top(n.parentElement);
        }
        return 0;
      }
      return 0;
    }, r);
    const crop = entry.crop ?? {};
    const scrollable = await page.evaluate(() => document.documentElement.scrollHeight);
    const judged = [];
    const shots = new Map();
    // The letter's viewport, then a quarter of a viewport at a time below it,
    // so a photograph banner is cleared without skipping the letter's opening.
    for (let k = 0; k < 8; k += 1) {
      // crop.above, a reviewed per-record hint, shows more of the page above
      // the route (a heading over the salutation); 56 px is the default lead.
      const at = Math.max(0, Math.round(y - 56 - (crop.above ?? 0) * vh + (k / 4) * vh + (crop.top ?? 0) * vh));
      if (at > scrollable) break;
      await page.evaluate((v) => window.scrollTo(0, v), at);
      await sleep(300);
      const png = join(dir, `v${k}.png`);
      await page.screenshot({ path: png });
      const pgm = join(dir, `v${k}.pgm`);
      await enc.gray(png, pgm, ANALYSIS_W);
      shots.set(k + 1, png);
      const verdict = judgePage(parsePgm(readFileSync(pgm)), {});
      judged.push({ page: k + 1, verdict });
      if (verdict.detail.ok) break;
    }
    const choice = choosePages(judged);
    const out = { source: { sha256: sha256(main), bytes: main.length, pages: null }, files: {}, notes: [`html: ${requests} sec.gov requests`] };
    if (choice.detail) {
      const png = shots.get(choice.detail.page);
      const file = join(DATA, thumbPath(slug, 'detail'));
      const r2 = await encodeSlot(enc, png, { x: 0, y: 0, w: vw, h: vh }, 'detail', file);
      if (r2) out.files.detail = { ...r2, page: null, viewport: choice.detail.page };
      if (choice.detail.page > 1) out.notes.push(`detail: scrolled ${(choice.detail.page - 1) / 4} viewport(s) past photographs`);
    } else out.notes.push(`detail: identity cover (${choice.detailRefused})`);
    out.notes.push('card: identity cover (an HTML filing renders as grey text on a card)');
    return out;
  } finally {
    await ctx.close();
  }
}

/* ---------------------------------------------------------------- main -- */

function readJson(file, fallback) {
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : fallback;
}

function writeAtomic(file, text) {
  writeFileSync(`${file}.tmp`, text);
  renameSync(`${file}.tmp`, file);
}

/** The record's files on disk still hash to the manifest. */
function filesCurrent(slug, m) {
  for (const slot of ['card', 'card2x', 'detail']) {
    const a = m[slot];
    if (!a) continue;
    const p = join(DATA, a.src);
    if (!existsSync(p) || sha256(readFileSync(p)) !== a.sha256) return false;
  }
  return Boolean(m.card || m.detail);
}

function removeFiles(slug) {
  const removed = [];
  for (const slot of ['card', 'card2x', 'detail']) {
    const p = join(DATA, thumbPath(slug, slot));
    if (existsSync(p)) {
      rmSync(p);
      removed.push(thumbPath(slug, slot));
    }
  }
  return removed;
}

async function main() {
  const registry = readJson(REGISTRY, null);
  if (!registry) throw new Error(`${REGISTRY} is missing`);
  const records = registry.records;
  const problems = Object.entries(records).flatMap(([slug, e]) => entryProblems(slug, e).map((p) => `${slug}: ${p}`));
  if (problems.length) {
    console.error(problems.join('\n'));
    throw new Error('the registry has problems; nothing was fetched');
  }
  const prev = readJson(MANIFEST, { records: {}, skipped: {} });
  const next = { records: { ...prev.records }, skipped: { ...(prev.skipped ?? {}) } };
  const enc = DRY ? { name: 'dry-run' } : await pickEncoder();
  mkdirSync(join(DATA, THUMBS_DIR), { recursive: true });
  const tally = { rendered: [], current: [], skipped: [], withdrawn: [], failed: [] };
  let stopped = null;

  for (const [slug, e] of Object.entries(records)) {
    if (ONLY && !ONLY.has(slug)) continue;
    const d = renderDecision(e);
    const key = renderKey(e);
    if (!d.render || (d.html && !HTML && !next.records[slug])) {
      const reason = d.render ? 'SEC HTML: not rendered in this run (pass --html)' : d.reason;
      const removed = DRY ? [] : removeFiles(slug);
      if (next.records[slug] || removed.length) tally.withdrawn.push(`${slug} (${reason})`);
      delete next.records[slug];
      next.skipped[slug] = { reason, renderKey: key };
      tally.skipped.push(`${slug}: ${reason}`);
      continue;
    }
    if (d.html && !HTML) {
      tally.current.push(`${slug} (HTML, kept as published)`);
      continue;
    }
    const m = next.records[slug];
    if (!FORCE && m && m.renderKey === key && filesCurrent(slug, m)) {
      tally.current.push(slug);
      continue;
    }
    const s = next.skipped[slug];
    if (!FORCE && !m && s && s.renderKey === key && s.photoGuard) {
      tally.skipped.push(`${slug}: ${s.reason} (unchanged)`);
      continue;
    }
    if (DRY) {
      tally.rendered.push(`${slug} (would render)`);
      continue;
    }
    if (stopped) break;
    const ws = createWorkspace({ prefix: 'letters-thumbs-' });
    const handlers = onExitCleanup(ws);
    const t0 = Date.now();
    try {
      removeFiles(slug);
      const r = d.html ? await renderHtmlRecord(slug, e, enc, ws.path) : await renderPdfRecord(slug, e, enc, ws.path);
      if (r.unavailable) {
        tally.skipped.push(`${slug}: ${r.unavailable}`);
        next.skipped[slug] = { reason: r.unavailable, renderKey: key };
        delete next.records[slug];
        continue;
      }
      const files = {};
      for (const [slot, f] of Object.entries(r.files)) {
        files[slot] = {
          src: thumbPath(slug, slot),
          w: f.w,
          h: f.h,
          bytes: f.buf.length,
          sha256: sha256(f.buf),
          quality: f.quality,
          ...(f.page ? { page: f.page } : {}),
          ...(f.top !== undefined ? { top: f.top } : {}),
          ...(hasRegion(e.crop) && !d.html ? { region: cropRegion(e.crop) } : {}),
        };
      }
      if (!files.card && !files.detail) {
        removeFiles(slug);
        delete next.records[slug];
        next.skipped[slug] = { reason: `photo guard: ${r.notes.join('; ')}`, renderKey: key, photoGuard: true };
        tally.skipped.push(`${slug}: photo guard (${r.notes.join('; ')})`);
        continue;
      }
      next.records[slug] = {
        sourceUrl: e.sourceUrl,
        sourceSha256: r.source.sha256,
        sourceBytes: r.source.bytes,
        ...(r.source.pages ? { sourcePages: r.source.pages } : {}),
        renderKey: key,
        renderer: `${d.html ? 'chromium' : 'pdftoppm'} + ${enc.name}, v${RENDER_VERSION}`,
        generatedOn: today(),
        ...files,
        notes: r.notes,
      };
      delete next.skipped[slug];
      tally.rendered.push(`${slug} in ${Date.now() - t0} ms${r.notes.length ? ` (${r.notes.join('; ')})` : ''}`);
    } catch (err) {
      tally.failed.push(`${slug}: ${err.message}`);
      removeFiles(slug);
      delete next.records[slug];
      if (err instanceof FetchRefusal && err.stopRun) stopped = err.message;
    } finally {
      ws.cleanup();
      if (existsSync(ws.path)) throw new Error(`the scratch directory ${ws.path} survived cleanup`);
      for (const [signal, h] of handlers) process.off(signal, h);
    }
  }
  if (browser) await browser.close();

  // Registry entries that were removed leave no files behind.
  for (const slug of Object.keys(next.records)) if (!records[slug]) delete next.records[slug];
  for (const slug of Object.keys(next.skipped)) if (!records[slug]) delete next.skipped[slug];
  if (!DRY) {
    for (const f of readdirSync(join(DATA, THUMBS_DIR))) {
      const slug = f.replace(/-(?:card|card-640|detail)\.webp$/, '');
      if (!next.records[slug]) rmSync(join(DATA, THUMBS_DIR, f));
    }
  }

  const sorted = (o) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
  const manifest = {
    _comment: [
      'Source previews for the Letters archive, written by scripts/letters-thumbnails.mjs from',
      'data/letters.thumbnail-sources.json. Only records whose rights are sec-public have files.',
      'Each src is relative to the published data directory (DATA_BASE_URL). No source document is kept.',
      'Validate with: node scripts/letters-validate-thumbnails.mjs',
    ],
    version: 1,
    records: sorted(next.records),
    skipped: sorted(next.skipped),
  };
  const text = `${JSON.stringify(manifest, null, 2)}\n`;
  if (!DRY && text !== (existsSync(MANIFEST) ? readFileSync(MANIFEST, 'utf8') : '')) writeAtomic(MANIFEST, text);

  const bytes = Object.values(next.records).reduce((n, m) => n + ['card', 'card2x', 'detail'].reduce((k, s) => k + (m[s]?.bytes ?? 0), 0), 0);
  console.log(`encoder: ${enc.name}`);
  for (const [k, list] of Object.entries(tally)) {
    console.log(`\n${k}: ${list.length}`);
    for (const line of list) console.log(`  ${line}`);
  }
  console.log(`\npublished previews: ${Object.keys(next.records).length} records, ${bytes} bytes`);
  if (stopped) {
    console.error(`\nstopped: ${stopped}`);
    process.exit(2);
  }
  if (tally.failed.length) process.exit(1);
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
