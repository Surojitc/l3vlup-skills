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
    return data?.data?.html ?? '';
  }
  const res = await fetch(page.url, {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`fetch ${res.status}`);
  return res.text();
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
  const stamp = new Date().toISOString();

  for (const page of registry.pages ?? []) {
    let postings = [];
    let error = null;
    try {
      const html = await fetchHtml(page);
      postings = extractPostings(html, page.url);
    } catch (e) {
      error = e.message;
    }

    const titles = postings.map((p) => p.title).sort();
    const prev = snapshots[page.firm]?.titles ?? [];
    const prevSet = new Set(prev);
    const currSet = new Set(titles);

    const added = postings.filter((p) => !prevSet.has(p.title));
    const removed = prev.filter((t) => !currSet.has(t));

    if (error) {
      console.log(`✗ ${page.firm}: ${error}${page.rendered ? ' (needs FIRECRAWL_API_KEY?)' : ''}`);
      // Preserve previous snapshot on error so we don't false-flag next run.
      nextSnapshots[page.firm] = snapshots[page.firm] ?? { titles: [], updatedAt: stamp };
      continue;
    }

    nextSnapshots[page.firm] = { titles, updatedAt: stamp, count: titles.length };
    console.log(
      `✓ ${page.firm}: ${titles.length} early-career postings (+${added.length} new, -${removed.length} gone)`
    );

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
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
