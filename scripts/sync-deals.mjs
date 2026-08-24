#!/usr/bin/env node
// The Pulse — deal-tape sync. Pulls M&A and deal announcements from primary
// press-release wires (PRNewswire, GlobeNewswire — the sources news desks
// themselves watch), extracts deal values where stated, and commits a compact
// digest for /pulse. No paywalled scraping; every item links its source.

import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const UA = { 'User-Agent': 'L3VLUP-pulse/1.0 (educational digest; contact: suro@l3vlup.com)' };

const FEEDS = [
  {
    source: 'PR Newswire',
    url: 'https://www.prnewswire.com/rss/financial-services-latest-news/acquisitions-mergers-and-takeovers-list.rss',
  },
  {
    source: 'GlobeNewswire',
    url: 'https://www.globenewswire.com/RssFeed/subjectcode/12-Mergers%20And%20Acquisitions/feedTitle/GlobeNewswire%20-%20Mergers%20and%20Acquisitions',
  },
];

const decode = (s) =>
  s
    .replace(/<!\[CDATA\[(.*?)\]\]>/gs, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&') // wires double-encode: "&amp;amp;" → "&amp;" → "&"
    .trim();

function parseRss(xml, source) {
  const items = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const block = m[1];
    const pick = (tag) => {
      const mm = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`).exec(block);
      return mm ? decode(mm[1]) : null;
    };
    const title = pick('title');
    const link = pick('link');
    const pubDate = pick('pubDate');
    const description = pick('description');
    if (!title || !link) continue;
    const date = pubDate ? new Date(pubDate) : null;
    // Deal value where the release states one ("$3.2 billion", "US$450 million", "£1.1bn", "$628M").
    const valMatch = /(?:US)?([$£€])\s?([\d.,]+)\s*(billion|bn|million|mn|m\b|b\b)/i.exec(`${title} ${description ?? ''}`);
    let dealValue = null;
    if (valMatch) {
      const cur = valMatch[1];
      const n = parseFloat(valMatch[2].replace(/,/g, ''));
      const isB = /^b/i.test(valMatch[3]);
      if (Number.isFinite(n)) {
        const billions = isB ? n : n / 1000;
        dealValue = billions >= 1
          ? `${cur}${Number.isInteger(billions) ? billions : billions.toFixed(1)}B`
          : `${cur}${Math.round(isB ? n * 1000 : n)}M`;
      }
    }
    items.push({
      title,
      link,
      source,
      date: date && !Number.isNaN(date.getTime()) ? date.toISOString() : null,
      dealValue,
    });
  }
  return items;
}

let all = [];
for (const feed of FEEDS) {
  process.stdout.write(`Fetching ${feed.source}… `);
  try {
    const res = await fetch(feed.url, { headers: UA });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const items = parseRss(await res.text(), feed.source);
    if (items.length === 0) throw new Error('0 items parsed');
    console.log(`${items.length} items`);
    all.push(...items);
  } catch (err) {
    console.log(`FAILED: ${err.message}`);
  }
  await new Promise((r) => setTimeout(r, 1000));
}

// Merge with existing so the tape accumulates a rolling window across runs.
try {
  const prev = JSON.parse(readFileSync(join(ROOT, 'data', 'deals.auto.json'), 'utf8'));
  all.push(...(prev.items ?? []));
} catch { /* first run */ }

// Keep actual deals only: the wires mix in dividend declarations and
// class-action-lawyer spam. Applied post-merge so old noise gets purged too.
const EXCLUDE = /class action|law firm|hareholder alert|investor alert|investor rights|investigation of/i;
const DEAL = /acquisi|acquire|merger|merge[sd]?\b|takeover|take[- ]?over|buy-?out|take[- ]private|divestiture|divests?\b|sale of|to buy|purchase of|stake in|business combination|tender offer|going private|drop down/i;

// Dedupe by link, newest first, keep a week's worth (max 80).
const seen = new Set();
const items = all
  .filter((i) => !EXCLUDE.test(i.title) && DEAL.test(i.title))
  .filter((i) => (seen.has(i.link) ? false : (seen.add(i.link), true)))
  .sort((a, b) => (b.date ?? '') > (a.date ?? '') ? 1 : -1)
  .sort((a, b) => ((a.date ?? '') < (b.date ?? '') ? 1 : -1))
  .slice(0, 80);

if (items.length === 0) {
  console.error('No items — leaving existing data untouched.');
  process.exit(1);
}

mkdirSync(join(ROOT, 'data'), { recursive: true });
writeFileSync(
  join(ROOT, 'data', 'deals.auto.json'),
  JSON.stringify({ generatedAt: new Date().toISOString(), items })
);
console.log(`Wrote ${items.length} deal items → data/deals.auto.json`);
