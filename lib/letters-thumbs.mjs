// Letters: source previews (thumbnails), the rules as pure functions.
//
// WHAT A PREVIEW IS
// A small, pre-sized WebP of the page where a letter begins, published beside
// the data under data/letters/thumbs/ and read by the site over DATA_BASE_URL.
// Three files per record: a 16:10 crop of the top of the page for a card at
// 400 px and at 640 px (the retina card), and the whole page at 480 px for the
// letter's own page. Nothing else about the source is kept: the document is
// downloaded once into a directory made for the run, rendered, and deleted
// before the next one is fetched. No PDF, no HTML and no extracted text of
// anyone's ever reaches git, a cache or a proxy.
//
// WHO MAY HAVE ONE
// The owner's rights policy (8 October 2026), enforced here and nowhere else:
//
//   sec-public                  a document filed with the SEC. A preview of the
//                               letter's own page is allowed, credited "as filed
//                               with the SEC", linked to the filing, with a
//                               per-record takedown switch.
//   first-party-link-only       a publisher's own site with no stated licence.
//   first-party-restrictive     a publisher whose terms or legend forbid
//                               reproduction (Greenhaven Road's PDF calls itself
//                               confidential; Fairfax's, Giverny's and Exor's
//                               site notices bar copying).
//
// Only sec-public may be rendered. The other two get the identity cover the
// site typesets from the record's facts, and nothing is generated, fetched or
// cached for them: this module refuses before a request is made, so a
// restrictive source is never downloaded at all.
//
// THE MODE IS PER RECORD
// `thumbnailMode` is source-preview, identity-cover or disabled, and
// `takedown: true` withdraws a preview whatever the mode says. Withdrawing one
// is an edit to data/letters.thumbnail-sources.json and a run: the files go,
// the manifest entry goes, and the site's image falls back to the cover. No
// code changes.
//
// PHOTOGRAPHS ARE NOT REPRODUCED BLINDLY
// Annual reports put a portrait or a stock photograph on the page where the
// letter starts (JPMorgan's 2022 letter opens above a near full-page portrait
// of its chief executive). A photograph is the work most likely to belong to
// somebody other than the filer, and the least useful thing to show a reader
// looking for the letter. So every rendered page is read at low resolution as
// a grid of blocks, each classed as blank, flat colour, text or graphics, or
// continuous tone (a photograph). A page that is mostly photograph is skipped
// for the next page of the letter; a card crop slides down past a photograph
// banner to the first window that is text. Where no page qualifies the record
// falls back to the identity cover, and the manifest says why.
//
// The heuristic is deliberately simple and conservative, and is held by
// scripts/__tests__/letters-thumbnails.test.mjs on synthetic pages: drawn text,
// noise and gradients, never a real filing.

import { createHash } from 'node:crypto';

export const RIGHTS = ['sec-public', 'first-party-link-only', 'first-party-restrictive'];
export const MODES = ['source-preview', 'identity-cover', 'disabled'];
export const FORMATS = ['pdf', 'html', 'text'];
export const ROUTES = ['direct', 'pdf-page', 'text-fragment', 'anchor'];

/** The three files, their pixel width and their byte budget. */
export const SIZES = {
  card: { w: 400, aspect: 16 / 10, budget: 40 * 1024 },
  card2x: { w: 640, aspect: 16 / 10, budget: 40 * 1024 },
  detail: { w: 480, aspect: null, budget: 60 * 1024 },
};
/** Quality starts here and steps down until a file is inside its budget. */
export const QUALITY_STEPS = [70, 62, 54, 46];

/** Where the files live, relative to the published data directory (DATA_BASE_URL). */
export const THUMBS_DIR = 'letters/thumbs';

/** Bumped whenever a change here would change the pixels: forces a re-render. */
export const RENDER_VERSION = 2;

export const USER_AGENT = 'L3VLUP Research (contact: suro@l3vlup.com)';

const SEC_HOST = /^https:\/\/(?:[a-z0-9-]+\.)*sec\.gov\//i;

/* ------------------------------------------------------------ registry -- */

/** Every problem with one registry entry; empty means it may be acted on. */
export function entryProblems(slug, e) {
  const out = [];
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) out.push('slug is not kebab-case');
  if (!e || typeof e !== 'object') return [...out, 'entry is not an object'];
  if (!/^https:\/\//.test(e.sourceUrl ?? '')) out.push('sourceUrl is not https');
  if (!FORMATS.includes(e.format)) out.push(`format is not one of ${FORMATS.join(', ')}`);
  if (!RIGHTS.includes(e.rights)) out.push(`rights is not one of ${RIGHTS.join(', ')}`);
  if (!MODES.includes(e.thumbnailMode)) out.push(`thumbnailMode is not one of ${MODES.join(', ')}`);
  if (typeof e.takedown !== 'boolean') out.push('takedown is not true or false');
  if (e.rights === 'sec-public' && !SEC_HOST.test(e.sourceUrl ?? '')) out.push('sec-public is only for a source on sec.gov');
  // A restrictive or link-only source may never be set to render, even by mistake.
  if (e.rights !== 'sec-public' && e.thumbnailMode === 'source-preview') out.push(`${e.rights} may not be a source-preview`);
  const r = e.letterRoute;
  if (!r || !ROUTES.includes(r.method)) out.push('letterRoute.method is not direct, pdf-page, text-fragment or anchor');
  else {
    if (r.method === 'pdf-page' && !(Number.isInteger(r.page) && r.page >= 1)) out.push('a pdf-page route needs a page');
    if (r.method === 'text-fragment' && !(typeof r.phrase === 'string' && r.phrase.trim())) out.push('a text-fragment route needs a phrase');
    if (r.method === 'anchor' && !(typeof r.anchor === 'string' && r.anchor.trim())) out.push('an anchor route needs an anchor');
  }
  if (e.format === 'pdf') {
    if (!(Number.isInteger(e.renderPage) && e.renderPage >= 1)) out.push('a PDF needs renderPage');
    if (e.lastPage !== undefined && !(Number.isInteger(e.lastPage) && e.lastPage >= e.renderPage)) out.push('lastPage is before renderPage');
  }
  if (e.crop !== undefined) out.push(...cropProblems(e.crop, e.format));
  if (e.guardOverride !== undefined) {
    if (e.guardOverride !== 'graphics-not-photographs') out.push('guardOverride may only be graphics-not-photographs');
    if (!(typeof e.guardNote === 'string' && e.guardNote.trim())) out.push('a guardOverride needs a guardNote saying who looked and what they saw');
    if (!DATE.test(e.guardReviewBy ?? '')) out.push('a guardOverride needs a guardReviewBy date (YYYY-MM-DD) when it is looked at again');
  }
  if (!DATE.test(e.verifiedOn ?? '')) out.push('verifiedOn is not YYYY-MM-DD');
  if (!(typeof e.provenance === 'string' && e.provenance.trim())) out.push('provenance missing');
  return out;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const isFraction = (x) => typeof x === 'number' && x >= 0 && x <= 1;

/* ----------------------------------------------------------- crop hints -- */

// A crop hint is a person's decision about one record, made on the contact
// sheet, so it lives in the registry beside the record and never in code.
//
//   top, left, right   where the card window starts and how wide it is, in
//                      fractions of the page (or of the region, below).
//   half               'left' or 'right': the page is a two-page spread (an
//                      annual report laid out landscape) and the preview is
//                      the one page of it, so the type is read at twice the
//                      size. Shorthand for a region of that half.
//   region             { left, top, right, bottom }, fractions of the page: the
//                      part of the page the previews are taken from. The detail
//                      image is the region and the card is a 16:10 window inside
//                      it. The photo guard judges the region alone, at the page's
//                      own scale, with its thresholds unchanged, so a region can
//                      leave a portrait out but can never let one in.
//   above              HTML only: the share of a viewport shown above the
//                      letter's route, so a heading over the salutation is not
//                      clipped. Never past the top of the document.
//
// A region, a half or an above changes what a reader sees of the source, so
// each needs a reason (what the crop shows and why it is fair to the source)
// and a reviewBy date. A region is drawn for one page's layout, so it holds the
// preview to renderPage: the guard does not carry it to the next page, where
// the same box could land on anything; a refused region is the identity cover.

/** Every problem with a crop hint. */
export function cropProblems(c, format) {
  const out = [];
  if (!c || typeof c !== 'object') return ['crop is not an object'];
  for (const k of ['top', 'left', 'right']) {
    if (c[k] !== undefined && !isFraction(c[k])) out.push(`crop.${k} is not a fraction`);
  }
  if ((c.left ?? 0) >= (c.right ?? 1)) out.push('crop.left is not left of crop.right');
  if (c.half !== undefined && !['left', 'right'].includes(c.half)) out.push("crop.half is not 'left' or 'right'");
  if (c.half !== undefined && c.region !== undefined) out.push('crop has both a half and a region; give one');
  if (c.region !== undefined) {
    const r = c.region;
    if (!r || typeof r !== 'object') out.push('crop.region is not an object');
    else {
      for (const k of ['left', 'top', 'right', 'bottom']) if (!isFraction(r[k])) out.push(`crop.region.${k} is not a fraction`);
      if (!(r.left < r.right)) out.push('crop.region.left is not left of crop.region.right');
      if (!(r.top < r.bottom)) out.push('crop.region.top is not above crop.region.bottom');
      if (r.right - r.left < 0.15 || r.bottom - r.top < 0.15) out.push('crop.region is under 15% of the page in one direction: that is a detail, not the letter');
    }
  }
  if (c.above !== undefined && !(typeof c.above === 'number' && c.above >= 0 && c.above <= 0.5)) out.push('crop.above is not a fraction of a viewport between 0 and 0.5');
  if ((c.half !== undefined || c.region !== undefined) && format !== 'pdf') out.push('crop.half and crop.region are for a PDF page');
  if (c.above !== undefined && format !== 'html') out.push('crop.above is for an HTML filing');
  if (c.half !== undefined || c.region !== undefined || c.above !== undefined) {
    if (!(typeof c.reason === 'string' && c.reason.trim())) out.push('a region, half or above crop needs a reason saying what it shows and why');
    if (!DATE.test(c.reviewBy ?? '')) out.push('a region, half or above crop needs a reviewBy date (YYYY-MM-DD)');
  }
  return out;
}

/** The part of the page a record's previews come from, in fractions; the whole page when none is set. */
export function cropRegion(c) {
  if (c?.region) return { left: c.region.left, top: c.region.top, right: c.region.right, bottom: c.region.bottom };
  if (c?.half === 'left') return { left: 0, top: 0, right: 0.5, bottom: 1 };
  if (c?.half === 'right') return { left: 0.5, top: 0, right: 1, bottom: 1 };
  return { left: 0, top: 0, right: 1, bottom: 1 };
}

/** Whether a crop narrows the page at all. */
export const hasRegion = (c) => Boolean(c?.region || c?.half);

/** The pixel box of a region on an image W by H. */
export function regionBox(W, H, region) {
  const x = Math.round(region.left * W);
  const y = Math.round(region.top * H);
  return { x, y, w: Math.round(region.right * W) - x, h: Math.round(region.bottom * H) - y };
}

/** A grey image cut to a region, for the photo guard to judge alone. */
export function cropImage(image, region) {
  const b = regionBox(image.w, image.h, region);
  const data = new Uint8Array(b.w * b.h);
  for (let y = 0; y < b.h; y += 1) data.set(image.data.subarray((b.y + y) * image.w + b.x, (b.y + y) * image.w + b.x + b.w), y * b.w);
  return { w: b.w, h: b.h, data };
}

/**
 * The geometry a crop renders with, and nothing else: the reason and the
 * review date are for people, and rewording one must not force a render.
 */
export function cropGeometry(c) {
  if (c === undefined || c === null) return null;
  const out = {};
  for (const k of ['top', 'left', 'right', 'half', 'region', 'above']) if (c[k] !== undefined) out[k] = c[k];
  return out;
}

/**
 * Whether a record may be rendered, and if not, why. The order matters: the
 * takedown switch and the rights are read before anything else, so a
 * withdrawn or restrictive record is refused without a single request.
 */
export function renderDecision(e) {
  if (!e) return { render: false, reason: 'not in the registry' };
  if (e.takedown === true) return { render: false, reason: 'takedown' };
  if (e.rights !== 'sec-public') return { render: false, reason: `rights: ${e.rights ?? 'unknown'} (identity cover only)` };
  if (!SEC_HOST.test(e.sourceUrl ?? '')) return { render: false, reason: 'source is not on sec.gov' };
  if (e.thumbnailMode !== 'source-preview') return { render: false, reason: `mode: ${e.thumbnailMode}` };
  if (e.format === 'text') return { render: false, reason: 'plain-text filing (identity cover reads better)' };
  if (e.format === 'html') return { render: true, html: true, slots: ['detail'] };
  return { render: true, html: false, slots: ['card', 'card2x', 'detail'] };
}

/* -------------------------------------------------------------- images -- */

/** A binary PGM (P5, 8-bit) as { w, h, data }. pdftoppm -gray writes these. */
export function parsePgm(buf) {
  let i = 0;
  const token = () => {
    for (;;) {
      while (i < buf.length && /\s/.test(String.fromCharCode(buf[i]))) i += 1;
      if (buf[i] === 0x23) {
        while (i < buf.length && buf[i] !== 0x0a) i += 1;
        continue;
      }
      break;
    }
    const s = i;
    while (i < buf.length && !/\s/.test(String.fromCharCode(buf[i]))) i += 1;
    return buf.subarray(s, i).toString('latin1');
  };
  if (token() !== 'P5') throw new Error('not a binary PGM');
  const w = Number(token());
  const h = Number(token());
  const max = Number(token());
  if (!(w > 0 && h > 0 && max === 255)) throw new Error('unsupported PGM');
  i += 1; // the single whitespace byte before the raster
  const data = buf.subarray(i, i + w * h);
  if (data.length !== w * h) throw new Error('truncated PGM');
  return { w, h, data };
}

/** The analysis block, in pixels of the low-resolution grey render. */
export const BLOCK = 12;

/**
 * Class one block: 'blank' (bare paper), 'text' (paper with ink on it: type,
 * rules, a line chart), 'flat' (a solid fill that is not paper) or 'photo'
 * (anything else that is not paper: continuous tone that varies). A block is
 * only a candidate here; whether it is part of a photograph is decided by the
 * region it belongs to (photoMask).
 */
export function classifyBlock(px) {
  const n = px.length;
  let light = 0;
  let sum = 0;
  let sq = 0;
  for (const v of px) {
    if (v >= 230) light += 1;
    sum += v;
    sq += v * v;
  }
  const mean = sum / n;
  const sd = Math.sqrt(Math.max(0, sq / n - mean * mean));
  if (light / n >= 0.98) return 'blank';
  if (light / n >= 0.45) return 'text';
  if (sd < 6) return 'flat';
  return 'photo';
}

/** The page as a grid of block classes, row by row. */
export function blockGrid({ w, h, data }, block = BLOCK) {
  const cols = Math.floor(w / block);
  const rows = Math.floor(h / block);
  const grid = [];
  const px = new Uint8Array(block * block);
  for (let r = 0; r < rows; r += 1) {
    const row = [];
    for (let c = 0; c < cols; c += 1) {
      let k = 0;
      for (let y = 0; y < block; y += 1) {
        const off = (r * block + y) * w + c * block;
        for (let x = 0; x < block; x += 1) px[k++] = data[off + x];
      }
      row.push(classifyBlock(px));
    }
    grid.push(row);
  }
  return grid;
}

/** A region this small is a heading or a logo, never a photograph. */
export const MIN_REGION_BLOCKS = 5;
/** A region is photographic when at least this share of it is textured tone. */
export const REGION_TONE_SHARE = 0.25;

/**
 * Which blocks belong to a photograph. Blocks that are not paper are joined
 * into regions (4-connected); a region is a photograph when it is at least
 * MIN_REGION_BLOCKS on each side and a quarter of it is textured tone. A
 * solid banner is not one (it is all flat), a bold heading is not one (it is
 * too thin), and a portrait on a dark backdrop is one as a whole, backdrop
 * included.
 */
export function photoMask(grid) {
  const rows = grid.length;
  const cols = rows ? grid[0].length : 0;
  const mask = grid.map((row) => row.map(() => false));
  const seen = grid.map((row) => row.map(() => false));
  const tone = (cls) => cls === 'photo' || cls === 'flat';
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      if (seen[r][c] || !tone(grid[r][c])) continue;
      const cells = [];
      const stack = [[r, c]];
      seen[r][c] = true;
      let r0 = r;
      let r1 = r;
      let c0 = c;
      let c1 = c;
      let textured = 0;
      while (stack.length) {
        const [y, x] = stack.pop();
        cells.push([y, x]);
        if (grid[y][x] === 'photo') textured += 1;
        r0 = Math.min(r0, y);
        r1 = Math.max(r1, y);
        c0 = Math.min(c0, x);
        c1 = Math.max(c1, x);
        for (const [dy, dx] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const ny = y + dy;
          const nx = x + dx;
          if (ny >= 0 && ny < rows && nx >= 0 && nx < cols && !seen[ny][nx] && tone(grid[ny][nx])) {
            seen[ny][nx] = true;
            stack.push([ny, nx]);
          }
        }
      }
      const big = r1 - r0 + 1 >= MIN_REGION_BLOCKS && c1 - c0 + 1 >= MIN_REGION_BLOCKS;
      if (big && textured / cells.length >= REGION_TONE_SHARE) for (const [y, x] of cells) mask[y][x] = true;
    }
  }
  return mask;
}

/** The share of photograph blocks in rows [r0, r1) of a mask. */
export function photoShare(mask, r0 = 0, r1 = mask.length) {
  let photo = 0;
  let all = 0;
  for (let r = Math.max(0, r0); r < Math.min(mask.length, r1); r += 1) {
    for (const m of mask[r]) {
      all += 1;
      if (m) photo += 1;
    }
  }
  return all ? photo / all : 0;
}

/** The share of blocks carrying anything at all (not blank paper). */
export function inkShare(grid, r0 = 0, r1 = grid.length) {
  let ink = 0;
  let all = 0;
  for (let r = Math.max(0, r0); r < Math.min(grid.length, r1); r += 1) {
    for (const cls of grid[r]) {
      all += 1;
      if (cls !== 'blank') ink += 1;
    }
  }
  return all ? ink / all : 0;
}

/** A page is skipped when this much of it is photograph. */
export const PAGE_PHOTO_LIMIT = 0.04;
/** A card window is accepted when at most this much of it is photograph. */
export const WINDOW_PHOTO_LIMIT = 0.02;
/** A card window must carry something: a near-blank crop says nothing. */
export const WINDOW_MIN_INK = 0.12;

/**
 * Judge one page for both uses. The detail image is the whole page, so the
 * page may carry little photograph (`detail`). The card is a 16:10 window,
 * so it is the first window from the hinted top downwards that is text
 * rather than photograph (`card`); a page with a portrait at the foot can
 * still give a card from its top, and one with a photograph banner gives a
 * card from below it. `graphicsReviewed` is a person's word, recorded in the
 * registry, that the tone the guard sees on these pages is designed graphics
 * (a gradient letterhead, a coloured band) and not a photograph; it lifts the
 * page limit for the detail image and nothing else. Fractions are of the page height. Each says why when
 * it fails.
 */
export function judgePage(image, { top = 0, left = 0, right = 1, aspect = SIZES.card.aspect, graphicsReviewed = false } = {}) {
  const grid = blockGrid(image);
  const mask = photoMask(grid);
  const rows = grid.length;
  const share = photoShare(mask);
  const detail =
    share > PAGE_PHOTO_LIMIT && !graphicsReviewed
      ? { ok: false, reason: `page is ${Math.round(share * 100)}% photograph` }
      : inkShare(grid) < WINDOW_MIN_INK
        ? { ok: false, reason: 'page is nearly blank' }
        : { ok: true };
  const cropW = (right - left) * image.w;
  const winRows = Math.max(1, Math.round(cropW / aspect / BLOCK));
  const start = Math.round(top * rows);
  let card = { ok: false, reason: 'no text window clear of photographs' };
  for (let r = start; r + winRows <= rows; r += 1) {
    const ps = photoShare(mask, r, r + winRows);
    if (ps <= WINDOW_PHOTO_LIMIT && inkShare(grid, r, r + winRows) >= WINDOW_MIN_INK) {
      card = { ok: true, top: round((r * BLOCK) / image.h), photoShare: round(ps), moved: r !== start };
      break;
    }
  }
  return { pagePhotoShare: round(share), detail, card };
}

/**
 * Choose a page for each use from the judged candidates, in page order.
 * `judged` is [{ page, verdict }]. A use with no acceptable page is null,
 * with the reasons it was refused, so the manifest can say why a record
 * shows the identity cover.
 */
export function choosePages(judged) {
  const pick = (use) => {
    const hit = judged.find((j) => j.verdict[use].ok);
    return hit
      ? { page: hit.page, ...(use === 'card' ? { top: hit.verdict.card.top } : {}), skipped: judged.filter((j) => j.page < hit.page).map((j) => ({ page: j.page, reason: j.verdict[use].reason })) }
      : null;
  };
  const card = pick('card');
  const detail = pick('detail');
  const why = (use) => judged.map((j) => `p${j.page}: ${j.verdict[use].reason}`).join('; ');
  return {
    card,
    detail,
    cardRefused: card ? null : why('card'),
    detailRefused: detail ? null : why('detail'),
  };
}

/** Pages to try, in order: the letter's page, then the next pages of the letter (only the first under a region). */
export function candidatePages(e, maxExtra = 2) {
  const first = e.renderPage;
  if (hasRegion(e.crop)) return [first];
  const last = Math.min(e.lastPage ?? first + maxExtra, first + maxExtra);
  const out = [];
  for (let p = first; p <= last; p += 1) out.push(p);
  return out;
}

/** The pixel box of the card crop, on a page render of width W and height H. */
export function cardBox(W, H, { top = 0, left = 0, right = 1 } = {}, aspect = SIZES.card.aspect) {
  const x = Math.round(left * W);
  const w = Math.round((right - left) * W);
  const h = Math.round(w / aspect);
  const y = Math.min(Math.round(top * H), Math.max(0, H - h));
  return { x, y, w, h };
}

/* ------------------------------------------------------------ manifest -- */

export const isWebp = (buf) =>
  buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP';

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** The file name for a record's slot: letters/thumbs/<slug>-card.webp. */
export function thumbPath(slug, slot) {
  const suffix = { card: 'card', card2x: 'card-640', detail: 'detail' }[slot];
  return `${THUMBS_DIR}/${slug}-${suffix}.webp`;
}

/**
 * What decides whether a record's files are current: the source, the route,
 * the page hints and the renderer. A manifest entry with the same key and
 * files whose hashes match is skipped; anything else re-renders.
 */
export function renderKey(e) {
  const parts = {
    v: RENDER_VERSION,
    url: e.sourceUrl,
    format: e.format,
    route: e.letterRoute,
    page: e.renderPage ?? null,
    last: e.lastPage ?? null,
    crop: cropGeometry(e.crop),
    guard: e.guardOverride ?? null,
  };
  return sha256(Buffer.from(JSON.stringify(parts))).slice(0, 16);
}

/**
 * Every problem with the manifest against the registry and the files on disk.
 * `io` is injected so the tests can run it on an in-memory tree.
 */
export function manifestProblems(manifest, registry, io) {
  const out = [];
  const records = manifest?.records ?? {};
  for (const [slug, m] of Object.entries(records)) {
    const e = registry[slug];
    if (!e) {
      out.push(`${slug}: in the manifest but not in the registry`);
      continue;
    }
    const d = renderDecision(e);
    if (!d.render) out.push(`${slug}: has a manifest entry but may not have a preview (${d.reason})`);
    if (m.sourceUrl !== e.sourceUrl) out.push(`${slug}: manifest source ${m.sourceUrl} is not the registry's`);
    for (const slot of ['card', 'card2x', 'detail']) {
      const a = m[slot];
      if (!a) continue;
      if (a.src !== thumbPath(slug, slot)) out.push(`${slug}: ${slot} is not at ${thumbPath(slug, slot)}`);
      if (!(Number.isInteger(a.w) && Number.isInteger(a.h) && a.w > 0 && a.h > 0)) out.push(`${slug}: ${slot} has no pixel size`);
      if (!io.exists(a.src)) {
        out.push(`${slug}: ${slot} file ${a.src} is missing`);
        continue;
      }
      const buf = io.read(a.src);
      if (!isWebp(buf)) out.push(`${slug}: ${slot} is not a WebP`);
      if (buf.length !== a.bytes) out.push(`${slug}: ${slot} is ${buf.length} bytes, the manifest says ${a.bytes}`);
      if (sha256(buf) !== a.sha256) out.push(`${slug}: ${slot} hash does not match the manifest`);
      if (buf.length > SIZES[slot].budget) out.push(`${slug}: ${slot} is ${buf.length} bytes, over the ${SIZES[slot].budget} byte budget`);
      if (a.w !== SIZES[slot].w) out.push(`${slug}: ${slot} is ${a.w} px wide, not ${SIZES[slot].w}`);
    }
    if (!m.detail && !m.card) out.push(`${slug}: an entry with no files`);
  }
  // No file may exist for a record that may not have one, nor without an entry.
  for (const file of io.list()) {
    const name = file.replace(`${THUMBS_DIR}/`, '');
    const slug = name.replace(/-(?:card|card-640|detail)\.webp$/, '');
    if (!/\.webp$/.test(file)) {
      out.push(`${file}: only WebP files belong in ${THUMBS_DIR}`);
      continue;
    }
    const e = registry[slug];
    if (!e) out.push(`${file}: belongs to no registry record`);
    else if (!renderDecision(e).render) out.push(`${file}: ${slug} may not have a preview (${renderDecision(e).reason})`);
    else if (!records[slug]) out.push(`${file}: not in the manifest`);
  }
  return out;
}

const round = (x) => Math.round(x * 1000) / 1000;
