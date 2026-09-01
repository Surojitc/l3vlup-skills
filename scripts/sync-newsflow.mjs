#!/usr/bin/env node
// Newsflow sync — the cross-vertical tape behind the site's news map.
//
// Where sync-deals.mjs answers "what got bought today", this answers the wider
// question a candidate walks into any interview with: what is happening this
// week in the seat I am applying to. Five verticals, each from public wires and
// publisher RSS, each item linking its source. No paywalled scraping.
//
// Feeds are best-effort BY DESIGN: each one is fetched in its own try/catch,
// a failing feed logs FAILED and costs only its own vertical, and a vertical
// with no items simply does not render on the site. The M&A wires are proven
// in production (sync-deals.mjs); the others follow each publisher's standard
// RSS shape but could not be probed from the dev sandbox (egress-blocked), so
// the first workflow_dispatch run of collect.yml is the verification: check the
// step log for FAILED lines and swap any dead URL there.

import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const UA = { 'User-Agent': 'L3VLUP-newsflow/1.0 (educational digest; contact: suro@l3vlup.com)' };

// The wires mix in dividend declarations and class-action-lawyer spam.
const EXCLUDE = /class action|law firm|hareholder alert|investor alert|investor rights|investigation of|dividend declar/i;

const DEAL = /acquisi|acquire|merger|merge[sd]?\b|takeover|take[- ]?over|buy-?out|take[- ]private|divestiture|divests?\b|sale of|to buy|purchase of|stake in|business combination|tender offer|going private|drop down/i;
const RAISE = /raises?\b|financing|funding|priced|pricing of|offering|private placement|series [a-f]\b|ipo\b|initial public offering|credit facility|notes due|debt facility|capital raise|closes? .*round|oversubscribed/i;
const PE = /private equity|buyout|buy-out|fund close|closes .*fund|final close|portfolio company|take[- ]private|growth equity|co-invest|continuation (fund|vehicle)|secondaries|gp stake/i;
const HF = /hedge fund|long[- \/]short|macro fund|multi[- ]strategy|activist|short seller|quant fund|launch(es)? .*fund|aum\b|returns?\b|drawdown|13f/i;

const VERTICALS = [
  {
    key: 'ma',
    label: 'M&A',
    include: DEAL,
    feeds: [
      // Both proven daily in sync-deals.mjs.
      { source: 'PR Newswire', url: 'https://www.prnewswire.com/rss/financial-services-latest-news/acquisitions-mergers-and-takeovers-list.rss' },
      { source: 'GlobeNewswire', url: 'https://www.globenewswire.com/RssFeed/subjectcode/12-Mergers%20And%20Acquisitions/feedTitle/GlobeNewswire%20-%20Mergers%20and%20Acquisitions' },
    ],
  },
  {
    key: 'capital-raises',
    label: 'Capital raises',
    include: RAISE,
    feeds: [
      { source: 'PR Newswire', url: 'https://www.prnewswire.com/rss/financial-services-latest-news/financing-agreements-list.rss' },
      { source: 'GlobeNewswire', url: 'https://www.globenewswire.com/RssFeed/subjectcode/65-Initial%20Public%20Offerings/feedTitle/GlobeNewswire%20-%20Initial%20Public%20Offerings' },
    ],
  },
  {
    key: 'pe',
    label: 'Private Equity',
    include: PE,
    feeds: [
      { source: 'Private Equity Wire', url: 'https://www.privateequitywire.co.uk/feed/' },
      { source: 'PR Newswire', url: 'https://www.prnewswire.com/rss/financial-services-latest-news/acquisitions-mergers-and-takeovers-list.rss' },
    ],
  },
  {
    key: 'vc',
    label: 'Venture Capital',
    // Publisher category feeds are already on-topic; keep everything that is
    // not wire spam rather than second-guessing an editor.
    include: null,
    feeds: [
      { source: 'TechCrunch', url: 'https://techcrunch.com/category/venture/feed/' },
      { source: 'PR Newswire', url: 'https://www.prnewswire.com/rss/financial-services-latest-news/venture-capital-list.rss' },
    ],
  },
  {
    key: 'hf',
    label: 'Hedge Funds',
    include: null,
    feeds: [{ source: 'Hedgeweek', url: 'https://www.hedgeweek.com/feed/' }],
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
    .replace(/&amp;/g, '&') // wires double-encode
    .trim();

function parseRss(xml, source, vertical) {
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
    const valMatch = /(?:US)?([$£€])\s?([\d.,]+)\s*(billion|bn|million|mn|m\b|b\b)/i.exec(`${title} ${description ?? ''}`);
    let dealValue = null;
    let valueUsdB = null;
    if (valMatch) {
      const cur = valMatch[1];
      const n = parseFloat(valMatch[2].replace(/,/g, ''));
      const isB = /^b/i.test(valMatch[3]);
      if (Number.isFinite(n)) {
        const billions = isB ? n : n / 1000;
        valueUsdB = billions; // treemap weight; currency mix is fine at this precision
        dealValue = billions >= 1
          ? `${cur}${Number.isInteger(billions) ? billions : billions.toFixed(1)}B`
          : `${cur}${Math.round(isB ? n * 1000 : n)}M`;
      }
    }
    items.push({
      title,
      link,
      source,
      vertical,
      date: date && !Number.isNaN(date.getTime()) ? date.toISOString() : null,
      dealValue,
      valueUsdB,
    });
  }
  return items;
}

let all = [];
for (const v of VERTICALS) {
  for (const feed of v.feeds) {
    process.stdout.write(`[${v.key}] Fetching ${feed.source}… `);
    try {
      const res = await fetch(feed.url, { headers: UA });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const items = parseRss(await res.text(), feed.source, v.key);
      if (items.length === 0) throw new Error('0 items parsed');
      console.log(`${items.length} items`);
      all.push(...items.filter((i) => !v.include || v.include.test(i.title)));
    } catch (err) {
      console.log(`FAILED: ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

// Merge with the previous run so the map holds a rolling week even when a
// source has a quiet day.
try {
  const prev = JSON.parse(readFileSync(join(ROOT, 'data', 'newsflow.auto.json'), 'utf8'));
  all.push(...(prev.items ?? []));
} catch { /* first run */ }

const weekAgo = Date.now() - 8 * 86400000;
const seen = new Set();
const perVertical = {};
const items = all
  .filter((i) => !EXCLUDE.test(i.title))
  .filter((i) => !i.date || new Date(i.date).getTime() > weekAgo)
  .filter((i) => (seen.has(i.link) ? false : (seen.add(i.link), true)))
  .sort((a, b) => ((a.date ?? '') < (b.date ?? '') ? 1 : -1))
  .filter((i) => {
    perVertical[i.vertical] = (perVertical[i.vertical] ?? 0) + 1;
    return perVertical[i.vertical] <= 30;
  });

if (items.length === 0) {
  console.error('No items — leaving existing data untouched.');
  process.exit(1);
}

mkdirSync(join(ROOT, 'data'), { recursive: true });
writeFileSync(
  join(ROOT, 'data', 'newsflow.auto.json'),
  JSON.stringify({ generatedAt: new Date().toISOString(), items })
);
console.log(`Wrote ${items.length} items across ${Object.keys(perVertical).length} verticals → data/newsflow.auto.json`);
