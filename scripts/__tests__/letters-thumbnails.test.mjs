// Offline checks on the Letters source previews (lib/letters-thumbs.mjs).
// No network and no real filing: the pages here are drawn in memory (lines of
// "type", noise for a photograph, a solid band for a banner).
//
//   node scripts/__tests__/letters-thumbnails.test.mjs
//
// What is held:
//   - rights gate the render: only sec-public on sec.gov, in source-preview
//     mode and not taken down, is ever rendered; a restrictive or link-only
//     source cannot even be configured to render;
//   - a takedown withdraws a preview: any file or manifest entry left for it
//     is a failure;
//   - the photo guard: a text page passes, a page dominated by a photograph is
//     refused for the detail image, a card slides below a photograph banner,
//     and neither a solid band nor a bold heading is mistaken for a photograph;
//   - the manifest's shape and the byte budgets (card 40 KB, detail 60 KB),
//     WebP only, no stray file;
//   - the committed registry and manifest: every entry well formed, the
//     twelve seeds present, Greenhaven Road identity cover with no files.

import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SIZES,
  THUMBS_DIR,
  blockGrid,
  candidatePages,
  cardBox,
  choosePages,
  entryProblems,
  isWebp,
  judgePage,
  manifestProblems,
  parsePgm,
  photoMask,
  photoShare,
  renderDecision,
  renderKey,
  thumbPath,
} from '../../lib/letters-thumbs.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

/* --------------------------------------------------------- synthetic pages -- */

const W = 600;
const H = 780;

/** A page of "type": lines of short dark dashes on white paper. */
function page({ photo = null, band = null, heading = null } = {}) {
  const data = new Uint8Array(W * H).fill(255);
  for (let y = 40; y < H - 40; y += 14) {
    for (let x = 50; x < W - 50; x += 1) {
      if ((x >> 2) % 3 !== 0) {
        data[y * W + x] = 20;
        data[(y + 1) * W + x] = 20;
        data[(y + 2) * W + x] = 120;
      }
    }
  }
  let seed = 7;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  if (photo) {
    // Continuous tone: a gradient with noise, the way a portrait reads.
    for (let y = photo.y0; y < photo.y1; y += 1) {
      for (let x = photo.x0; x < photo.x1; x += 1) data[y * W + x] = Math.max(0, Math.min(255, 70 + ((x + y) % 120) + Math.round(rand() * 50 - 25)));
    }
  }
  if (band) {
    for (let y = band.y0; y < band.y1; y += 1) for (let x = 0; x < W; x += 1) data[y * W + x] = 40;
  }
  if (heading) {
    // A bold display line: thick strokes, three blocks tall at most.
    for (let y = heading.y0; y < heading.y0 + 30; y += 1) {
      for (let x = 50; x < W - 50; x += 1) if ((x >> 3) % 2 === 0) data[y * W + x] = 10;
    }
  }
  return { w: W, h: H, data };
}

const pgm = (im) => Buffer.concat([Buffer.from(`P5\n# synthetic\n${im.w} ${im.h}\n255\n`), Buffer.from(im.data)]);

/* -------------------------------------------------------------- the rights -- */

const SEC = {
  sourceUrl: 'https://www.sec.gov/Archives/edgar/data/1/000000000026000001/letter.pdf',
  format: 'pdf',
  letterRoute: { method: 'pdf-page', page: 2 },
  renderPage: 2,
  rights: 'sec-public',
  thumbnailMode: 'source-preview',
  takedown: false,
  verifiedOn: '2026-10-08',
  provenance: 'EDGAR accession 0000000000-26-000001 (CIK 1), fixture',
};
const RESTRICTIVE = { ...SEC, sourceUrl: 'https://example.org/2026/q2-letter.pdf', rights: 'first-party-restrictive', thumbnailMode: 'identity-cover', provenance: 'fixture' };

test('a sec-public PDF in source-preview mode renders all three sizes', () => {
  assert.deepEqual(entryProblems('fixture-sec', SEC), []);
  const d = renderDecision(SEC);
  assert.equal(d.render, true);
  assert.deepEqual(d.slots, ['card', 'card2x', 'detail']);
});

test('a sec-public HTML filing renders the detail size only; plain text renders nothing', () => {
  assert.deepEqual(renderDecision({ ...SEC, format: 'html' }).slots, ['detail']);
  assert.equal(renderDecision({ ...SEC, format: 'text' }).render, false);
});

test('first-party sources never render, and cannot even be set to', () => {
  for (const rights of ['first-party-link-only', 'first-party-restrictive']) {
    const e = { ...RESTRICTIVE, rights };
    assert.equal(renderDecision(e).render, false);
    assert.match(renderDecision({ ...e, thumbnailMode: 'source-preview' }).reason, /identity cover only/);
    assert.ok(entryProblems('fixture', { ...e, thumbnailMode: 'source-preview' }).some((p) => /may not be a source-preview/.test(p)));
  }
});

test('sec-public is refused for a source off sec.gov, and an unknown right is refused', () => {
  assert.ok(entryProblems('fixture', { ...RESTRICTIVE, rights: 'sec-public' }).some((p) => /only for a source on sec.gov/.test(p)));
  assert.ok(entryProblems('fixture', { ...SEC, rights: 'fair-use' }).some((p) => /rights is not/.test(p)));
  assert.equal(renderDecision({ ...SEC, sourceUrl: 'https://example.org/x.pdf' }).render, false);
});

test('identity-cover and disabled modes never render, whatever the rights', () => {
  assert.equal(renderDecision({ ...SEC, thumbnailMode: 'identity-cover' }).render, false);
  assert.equal(renderDecision({ ...SEC, thumbnailMode: 'disabled' }).render, false);
});

test('a takedown is read before anything else', () => {
  const d = renderDecision({ ...SEC, takedown: true });
  assert.equal(d.render, false);
  assert.equal(d.reason, 'takedown');
  assert.ok(entryProblems('fixture', { ...SEC, takedown: 'yes' }).some((p) => /takedown/.test(p)));
});

test('a guard override needs the reviewed wording and a note', () => {
  assert.ok(entryProblems('fixture', { ...SEC, guardOverride: 'skip' }).some((p) => /guardOverride/.test(p)));
  assert.ok(entryProblems('fixture', { ...SEC, guardOverride: 'graphics-not-photographs' }).some((p) => /guardNote/.test(p)));
  assert.deepEqual(entryProblems('fixture', { ...SEC, guardOverride: 'graphics-not-photographs', guardNote: 'Looked on 8 Oct: a gradient band.' }), []);
});

test('the render key changes with the source, the route and the hints, and nothing else', () => {
  const k = renderKey(SEC);
  assert.equal(renderKey({ ...SEC, verifiedOn: '2027-01-01', provenance: 'other' }), k);
  assert.notEqual(renderKey({ ...SEC, sourceUrl: SEC.sourceUrl.replace('letter', 'letter2') }), k);
  assert.notEqual(renderKey({ ...SEC, renderPage: 3 }), k);
  assert.notEqual(renderKey({ ...SEC, crop: { top: 0.1 } }), k);
});

/* --------------------------------------------------------- the photo guard -- */

test('parsePgm reads a binary PGM with a comment', () => {
  const im = page();
  const back = parsePgm(pgm(im));
  assert.equal(back.w, W);
  assert.equal(back.h, H);
  assert.equal(back.data[40 * W + 51], im.data[40 * W + 51]);
});

test('a page of text passes for both uses, its card at the top', () => {
  const v = judgePage(page());
  assert.equal(v.pagePhotoShare, 0);
  assert.equal(v.detail.ok, true);
  assert.equal(v.card.ok, true);
  assert.equal(v.card.top, 0);
});

test('a page dominated by a photograph is refused for the detail image', () => {
  const v = judgePage(page({ photo: { x0: 60, x1: 540, y0: 80, y1: 520 } }));
  assert.ok(v.pagePhotoShare > 0.3, `share ${v.pagePhotoShare}`);
  assert.equal(v.detail.ok, false);
  assert.match(v.detail.reason, /photograph/);
});

test('a photograph banner at the top moves the card below it', () => {
  const v = judgePage(page({ photo: { x0: 0, x1: 600, y0: 0, y1: 200 } }));
  assert.equal(v.card.ok, true);
  assert.ok(v.card.moved);
  assert.ok(v.card.top * H >= 190, `card top ${v.card.top}`);
});

test('a solid band and a bold heading are not photographs', () => {
  const band = page({ band: { y0: 0, y1: 120 } });
  assert.equal(photoShare(photoMask(blockGrid(band))), 0);
  const heading = page({ heading: { y0: 60 } });
  assert.equal(photoShare(photoMask(blockGrid(heading))), 0);
  assert.equal(judgePage(heading).detail.ok, true);
});

test('a reviewed graphics override lifts the page limit for the detail image only', () => {
  const im = page({ photo: { x0: 60, x1: 540, y0: 80, y1: 520 } });
  const v = judgePage(im, { graphicsReviewed: true });
  assert.equal(v.detail.ok, true);
  assert.equal(judgePage(im).detail.ok, false);
});

test('choosePages takes the next page of the letter, and says why when none will do', () => {
  const bad = judgePage(page({ photo: { x0: 0, x1: 600, y0: 0, y1: 780 } }));
  const good = judgePage(page());
  const c = choosePages([{ page: 4, verdict: bad }, { page: 5, verdict: good }]);
  assert.equal(c.detail.page, 5);
  assert.equal(c.card.page, 5);
  assert.match(c.detail.skipped[0].reason, /photograph/);
  const none = choosePages([{ page: 4, verdict: bad }]);
  assert.equal(none.detail, null);
  assert.equal(none.card, null);
  assert.match(none.detailRefused, /p4: page is \d+% photograph/);
});

test('candidate pages stop at the letter\'s last page', () => {
  assert.deepEqual(candidatePages({ renderPage: 5 }), [5, 6, 7]);
  assert.deepEqual(candidatePages({ renderPage: 5, lastPage: 5 }), [5]);
});

test('the card box is a 16:10 window inside the page', () => {
  const b = cardBox(1280, 1656, { top: 0.9 });
  assert.equal(b.w, 1280);
  assert.equal(b.h, 800);
  assert.ok(b.y + b.h <= 1656);
  assert.deepEqual(cardBox(1280, 1656, { left: 0.5, right: 1 }), { x: 640, y: 0, w: 640, h: 400 });
});

/* ------------------------------------------------------------ the manifest -- */

const webp = (n) => {
  const b = Buffer.alloc(n);
  b.write('RIFF', 0, 'latin1');
  b.writeUInt32LE(n - 8, 4);
  b.write('WEBP', 8, 'latin1');
  return b;
};
const { createHash } = await import('node:crypto');
const hash = (b) => createHash('sha256').update(b).digest('hex');

function tree(files) {
  return {
    exists: (src) => files.has(src),
    read: (src) => files.get(src),
    list: () => [...files.keys()],
  };
}

function entry(slug, files, sizes = { card: 12000, card2x: 28000, detail: 34000 }) {
  const m = { sourceUrl: SEC.sourceUrl };
  for (const [slot, n] of Object.entries(sizes)) {
    const buf = webp(n);
    files.set(thumbPath(slug, slot), buf);
    m[slot] = { src: thumbPath(slug, slot), w: SIZES[slot].w, h: slot === 'detail' ? 621 : SIZES[slot].w * 10 / 16, bytes: n, sha256: hash(buf) };
  }
  return m;
}

test('a well-formed manifest passes', () => {
  const files = new Map();
  const manifest = { records: { a: entry('a', files) } };
  assert.deepEqual(manifestProblems(manifest, { a: SEC }, tree(files)), []);
  assert.ok(isWebp(webp(20)));
  assert.ok(!isWebp(Buffer.from('%PDF-1.7 not an image')));
});

test('budgets: a card over 40 KB or a detail over 60 KB fails', () => {
  const files = new Map();
  const manifest = { records: { a: entry('a', files, { card: 41 * 1024, detail: 61 * 1024 }) } };
  const p = manifestProblems(manifest, { a: SEC }, tree(files));
  assert.ok(p.some((x) => /card is \d+ bytes, over/.test(x)));
  assert.ok(p.some((x) => /detail is \d+ bytes, over/.test(x)));
});

test('a missing file, a non-WebP file, a wrong hash and a stray file each fail', () => {
  const files = new Map();
  const manifest = { records: { a: entry('a', files) } };
  files.delete(thumbPath('a', 'card2x'));
  files.set(thumbPath('a', 'detail'), Buffer.from('%PDF-1.7'));
  files.set(`${THUMBS_DIR}/nobody-card.webp`, webp(100));
  files.set(`${THUMBS_DIR}/a-page.pdf`, Buffer.from('%PDF-1.7'));
  const p = manifestProblems(manifest, { a: SEC }, tree(files)).join('\n');
  assert.match(p, /card2x file .* is missing/);
  assert.match(p, /detail is not a WebP/);
  assert.match(p, /detail hash does not match/);
  assert.match(p, /nobody-card.webp: belongs to no registry record/);
  assert.match(p, /a-page.pdf: only WebP files/);
});

test('a takedown or a restrictive record with a file or an entry fails', () => {
  const files = new Map();
  const manifest = { records: { a: entry('a', files), b: entry('b', files) } };
  const p = manifestProblems(manifest, { a: { ...SEC, takedown: true }, b: RESTRICTIVE }, tree(files)).join('\n');
  assert.match(p, /a: has a manifest entry but may not have a preview \(takedown\)/);
  assert.match(p, /a-card.webp: a may not have a preview \(takedown\)/);
  assert.match(p, /b: has a manifest entry but may not have a preview \(rights: first-party-restrictive/);
});

/* --------------------------------------------------- the committed files -- */

const registry = JSON.parse(readFileSync(join(ROOT, 'data', 'letters.thumbnail-sources.json'), 'utf8')).records;
const manifest = JSON.parse(readFileSync(join(ROOT, 'data', 'letters.thumbnails.json'), 'utf8'));

const SEEDS = [
  'fairfax-1985-letter-prem-watsa',
  'ruane-sequoia-fy2001-letter',
  'third-point-star-gas-2005-02',
  'hussman-2008-10-four-magic-words',
  'muddy-waters-sino-forest-2011-06',
  'brookfield-2020-03-update-for-shareholders',
  'giverny-capital-2025-annual-letter',
  'exor-2025-letter-to-shareholders',
  'greenhaven-road-q2-2026-letter',
  'impactive-wex-2026-04',
  'hayden-capital-q2-2026-letter',
  'source-capital-h1-2026-letter',
];

test('every registry entry is well formed', () => {
  for (const [slug, e] of Object.entries(registry)) assert.deepEqual(entryProblems(slug, e), [], slug);
});

test('the twelve seeds are in the registry', () => {
  for (const s of SEEDS) assert.ok(registry[s], s);
});

test('Greenhaven Road: restrictive, identity cover, no files and no manifest entry', () => {
  const g = registry['greenhaven-road-q2-2026-letter'];
  assert.equal(g.rights, 'first-party-restrictive');
  assert.equal(g.thumbnailMode, 'identity-cover');
  assert.equal(manifest.records['greenhaven-road-q2-2026-letter'], undefined);
  const dir = join(ROOT, 'data', THUMBS_DIR);
  const files = existsSync(dir) ? readdirSync(dir) : [];
  assert.ok(!files.some((f) => f.startsWith('greenhaven')));
});

test('only sec-public records have manifest entries, and the committed files match it', () => {
  for (const slug of Object.keys(manifest.records)) assert.equal(registry[slug]?.rights, 'sec-public', slug);
  const dir = join(ROOT, 'data', THUMBS_DIR);
  const io = {
    exists: (src) => existsSync(join(ROOT, 'data', src)),
    read: (src) => readFileSync(join(ROOT, 'data', src)),
    list: () => (existsSync(dir) ? readdirSync(dir).map((f) => `${THUMBS_DIR}/${f}`) : []),
  };
  assert.deepEqual(manifestProblems(manifest, registry, io), []);
});

console.log(`\n${passed} passed`);
