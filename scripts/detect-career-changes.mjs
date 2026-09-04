#!/usr/bin/env node
/**
 * Career-page change detector — the Trackr-style freshness engine for firms that
 * are NOT on a public ATS JSON board (custom / SPA career portals).
 *
 * For each page in lib/sources/career-pages.json it:
 *   1. fetches the page (plain fetch; rendered via Firecrawl when FIRECRAWL_API_KEY
 *      is set and the entry has "rendered": true — SPA pages need JS execution),
 *   2. extracts candidate early-career postings (title + link),
 *   3. diffs the set of titles against the last snapshot,
 *   4. writes new/removed postings to a human review queue.
 *
 * State (committed so the next run can diff across CI runs):
 *   data/career-snapshots.json      last-seen posting set per firm
 *   data/career-review-queue.json   detected changes awaiting curation into the Sheet
 *
 * Run: npm run sync:careers
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY = join(ROOT, 'lib/sources/career-pages.json');
const SNAP = join(ROOT, 'data/career-snapshots.json');
const QUEUE = join(ROOT, 'data/career-review-queue.json');
const UA = 'Mozilla/5.0 (compatible; L3vlupTracker/1.0; +https://l3vlup.com)';

// Word-boundaried so "Internal"/"International" do NOT match "intern".
const EARLY_CAREER =
  /\b(intern|interns|internship|internships|new[\s-]?grad|graduate|graduates|university|campus|apprentice|apprenticeship|early[\s-]?career|placement|spring\s+(week|insight)|off[\s-]?cycle|analyst\s+programme|student|students|rotational|residency|apm|rpm)\b/i;

async function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return fallback;
  }
}

/**
 * The page's HTML, plus what the fetch noticed on the way.
 *
 * The `note` matters as much as the HTML. A firm whose careers page has MOVED
 * must not look like a firm with nothing open, and the difference is a status
 * code that is easy to lose: on a rendered fetch, Firecrawl answers 200 for
 * its own API call and reports the page's status inside the payload. Read only
 * the outer status and a 404 error page arrives as ordinary HTML, matches no
 * job titles, and is written down as a confident zero. That is how Morgan
 * Stanley sat at nought while its board was live. The URL had gone, and
 * nothing was looking at the field that said so.
 *
 * Deliberately a note rather than a throw. Corporate careers sites answer 403
 * and 404 to anything they do not recognise while still serving the page a
 * renderer can read, and Rothschild does exactly that today: 404 to a plain
 * GET, three postings through Firecrawl. Treating the status as fatal would
 * have broken a firm that works in order to diagnose one that does not. So the
 * caller only reaches for the note when the extraction came back empty, which
 * makes this strictly a better explanation of a zero and never a cause of one.
 */
async function fetchHtml(page) {
  const key = process.env.FIRECRAWL_API_KEY;
  if (page.rendered && key) {
    // Firecrawl renders JS-heavy SPA career pages.
    const res = await fetch('https://api.firecrawl.dev/v1/scrape', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ url: page.url, formats: ['html'] }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) throw new Error(`firecrawl ${res.status}`);
    const data = await res.json();
    if (data?.success === false) throw new Error(`firecrawl: ${data?.error ?? 'scrape failed'}`);
    const meta = data?.data?.metadata ?? {};
    return {
      html: data?.data?.html ?? '',
      note: landingNote(meta.statusCode, meta.url ?? meta.sourceURL, page.url),
    };
  }
  const res = await fetch(page.url, {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(20000),
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`fetch ${res.status}`);
  return { html: await res.text(), note: landingNote(res.status, res.url, page.url) };
}

/** Why an empty result might be the URL's fault rather than the firm's. */
function landingNote(status, landed, wanted) {
  if (typeof status === 'number' && status >= 400) return `the page returned ${status}`;
  if (landed && !samePath(landed, wanted)) return `the page redirected to ${landed}`;
  return null;
}

/**
 * Did we land on the page we asked for?
 *
 * Host and path only. Query strings and fragments get rewritten by consent
 * banners and analytics on almost every corporate site, and a trailing slash
 * is not a move.
 */
function samePath(a, b) {
  try {
    const x = new URL(a);
    const y = new URL(b);
    const norm = (u) => u.pathname.replace(/\/+$/, '').toLowerCase();
    return x.host.toLowerCase() === y.host.toLowerCase() && norm(x) === norm(y);
  } catch {
    return true; // Unparseable: not evidence of a move.
  }
}

/** Extract candidate early-career postings as {title, url} from raw HTML. */
function extractPostings(html, baseUrl) {
  const out = new Map();
  const anchor = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = anchor.exec(html)) !== null) {
    const href = m[1];
    const title = m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (title.length < 6 || title.length > 140) continue;
    if (!EARLY_CAREER.test(title)) continue;
    let url = href;
    try {
      url = new URL(href, baseUrl).toString();
    } catch {
      /* keep raw href */
    }
    if (!out.has(title)) out.set(title, url);
  }
  return [...out.entries()].map(([title, url]) => ({ title, url }));
}

async function main() {
  const registry = await readJson(REGISTRY, { pages: [] });
  const snapshots = await readJson(SNAP, {});
  const nextSnapshots = {};
  const changes = [];
  const suspect = [];
  const stamp = new Date().toISOString();

  for (const page of registry.pages ?? []) {
    let postings = [];
    let error = null;
    let note = null;
    try {
      const got = await fetchHtml(page);
      note = got.note;
      postings = extractPostings(got.html, page.url);
    } catch (e) {
      error = e.message;
    }

    const titles = postings.map((p) => p.title).sort();
    const prev = snapshots[page.firm]?.titles ?? [];
    const prevSet = new Set(prev);
    const currSet = new Set(titles);

    const added = postings.filter((p) => !prevSet.has(p.title));
    const removed = prev.filter((t) => !currSet.has(t));

    const before = snapshots[page.firm];

    if (error) {
      console.log(`✗ ${page.firm}: ${error}${page.rendered && !process.env.FIRECRAWL_API_KEY ? ' (needs FIRECRAWL_API_KEY?)' : ''}`);
      // Preserve previous snapshot on error so we don't false-flag next run.
      nextSnapshots[page.firm] = { ...(before ?? { titles: [] }), updatedAt: stamp, error };
      suspect.push({ firm: page.firm, url: page.url, reason: error });
      continue;
    }

    // A page that fetches cleanly and yields nothing is the ambiguous case: a
    // firm between recruiting cycles looks identical to a page that has been
    // restructured out from under the extractor. It is only worth acting on
    // when the same page used to return roles, so that is the line drawn here.
    // The previous titles are kept rather than replaced with an empty set,
    // because overwriting is what makes the break invisible on the run after
    // this one.
    if (titles.length === 0 && prev.length > 0) {
      console.log(
        `⚠ ${page.firm}: 0 postings, was ${prev.length}${note ? ` (${note})` : ''}. ` +
        'Keeping the last set; check the page.'
      );
      nextSnapshots[page.firm] = { ...before, updatedAt: stamp, emptySince: before?.emptySince ?? stamp };
      suspect.push({
        firm: page.firm,
        url: page.url,
        reason: `dropped from ${prev.length} posting${prev.length === 1 ? '' : 's'} to 0${note ? `, and ${note}` : ''}`,
      });
      continue;
    }

    nextSnapshots[page.firm] = { titles, updatedAt: stamp, count: titles.length };
    console.log(
      `✓ ${page.firm}: ${titles.length} early-career postings (+${added.length} new, -${removed.length} gone)`
    );

    // A registry entry that has never once produced a posting is not a firm
    // with nothing open, it is an entry that has never worked.
    if (titles.length === 0 && prev.length === 0) {
      suspect.push({
        firm: page.firm,
        url: page.url,
        reason: note ? `no postings, and ${note}` : 'no postings on this run or the last',
      });
    }

    for (const p of added) {
      changes.push({
        firm: page.firm,
        role: p.title,
        applicationUrl: p.url,
        region: page.region,
        tier: page.tier,
        change: 'new',
        detectedAt: stamp,
      });
    }
  }

  await mkdir(dirname(SNAP), { recursive: true });
  await writeFile(SNAP, JSON.stringify(nextSnapshots, null, 2) + '\n');

  const existingQueue = await readJson(QUEUE, { generatedAt: null, items: [] });
  // Keep queue items that haven't been curated away; prepend the newest.
  const merged = [...changes, ...(existingQueue.items ?? [])].slice(0, 500);
  await writeFile(QUEUE, JSON.stringify({ generatedAt: stamp, items: merged }, null, 2) + '\n');

  console.log(`\n${changes.length} new posting(s) queued for review → ${QUEUE}`);

  // Printed last so it is the thing left on screen at the end of the step. A
  // firm listed here is producing no signal, and a source producing no signal
  // is the one failure this collector cannot report as a number.
  if (suspect.length) {
    console.log(`\n${suspect.length} page(s) need a look:`);
    for (const s of suspect) console.log(`  ⚠ ${s.firm}: ${s.reason}\n    ${s.url}`);
    console.log(
      '\nIf the firm is on a reachable board in lib/sources/ats-registry.json it is already\n' +
        'collated there and the entry can go; otherwise the URL needs repointing.'
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
