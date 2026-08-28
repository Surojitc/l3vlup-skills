#!/usr/bin/env node
/**
 * Report what the unresolved firms actually serve, so adapters get written
 * against observed shapes rather than guesses.
 *
 * This repo has a habit of probing first — the ERP and econ collectors were both
 * written against a CI probe's output. Same reason here: an ATS family has one
 * documented API and several undocumented deployments of it, and a parser
 * written from memory fails silently rather than loudly.
 *
 * Reads data/ats-discovery.json, so run discovery first.
 *
 * Scaffolding, not a fixture. Delete it once the adapters exist.
 *
 * Run: node scripts/probe-ats-families.mjs
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { candidateUrls, detectUnsupportedFamily } from '../lib/ats-discover.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPORT = join(ROOT, 'data/ats-discovery.json');
const UA = 'Mozilla/5.0 (compatible; L3vlupTracker/1.0; +https://www.l3vlup.com)';
const T = 25_000;

const get = (url, init) =>
  fetch(url, {
    ...init,
    headers: { 'User-Agent': UA, ...(init?.headers || {}) },
    redirect: 'follow',
    signal: AbortSignal.timeout(T),
  });

const head = (s, n = 300) => String(s).replace(/\s+/g, ' ').slice(0, n);

/**
 * Oracle Cloud Recruiting exposes a public REST collection. The site number
 * varies per deployment, so try the common ones and report which answered.
 */
async function probeOracle(host) {
  const base = `https://${host}/hcmRestApi/resources/latest/recruitingCEJobRequisitions`;
  for (const site of ['CX_1', 'CX_2', 'CX_45001', 'CX_3']) {
    const url =
      `${base}?onlyData=true&expand=requisitionList.secondaryLocations` +
      `&finder=findReqs;siteNumber=${site},limit=5,sortBy=POSTING_DATES_DESC`;
    try {
      const res = await get(url, { headers: { Accept: 'application/json' } });
      const body = await res.text();
      if (!res.ok) {
        console.log(`      ${site.padEnd(9)} HTTP ${res.status}  ${head(body, 120)}`);
        continue;
      }
      let d;
      try {
        d = JSON.parse(body);
      } catch {
        console.log(`      ${site.padEnd(9)} HTTP 200 but not JSON  ${head(body, 120)}`);
        continue;
      }
      const items = d.items?.[0]?.requisitionList ?? d.items ?? [];
      console.log(`      ${site.padEnd(9)} HTTP 200  ${items.length} requisitions`);
      if (items.length) {
        console.log(`        keys: ${Object.keys(items[0]).join(', ')}`);
        console.log(`        sample: ${head(JSON.stringify(items[0]), 400)}`);
        return { site, ok: true };
      }
    } catch (e) {
      console.log(`      ${site.padEnd(9)} ${head(e.message || e, 90)}`);
    }
  }
  return { ok: false };
}

/**
 * For firms whose careers page had no board on it: the board is usually one hop
 * further in, behind a "search jobs" link. Report those links and whether any
 * known ATS hostname appears anywhere in the HTML, which would mean the
 * extractor missed it rather than the page not having one. Different bugs.
 */
async function probeSecondHop(url) {
  let res, html;
  try {
    res = await get(url);
    html = await res.text();
  } catch (e) {
    console.log(`      fetch failed: ${head(e.message || e, 90)}`);
    return;
  }
  if (!res.ok) {
    console.log(`      HTTP ${res.status}`);
    return;
  }

  const ATS_NAME =
    /(myworkdayjobs|greenhouse\.io|lever\.co|ashbyhq|oraclecloud|icims|taleo|successfactors|eightfold|phenompeople|avature|brassring)/gi;
  const anywhere = [...new Set(html.match(ATS_NAME) || [])];
  console.log(`      ATS names in HTML: ${anywhere.length ? anywhere.join(', ') : 'none'}`);

  const hrefs = [...html.matchAll(/href=["']([^"']+)["'][^>]*>([^<]{0,80})/gi)]
    .map((m) => ({ href: m[1], text: m[2].replace(/\s+/g, ' ').trim() }))
    .filter((l) =>
      /job|career|vacan|opportunit|search|apply|student|graduate|early/i.test(l.href + ' ' + l.text)
    );

  const seen = new Set();
  const next = [];
  for (const l of hrefs) {
    let abs;
    try {
      abs = new URL(l.href, res.url).toString();
    } catch {
      continue;
    }
    if (seen.has(abs) || abs === res.url) continue;
    seen.add(abs);
    next.push({ abs, text: l.text });
    if (next.length >= 6) break;
  }
  for (const n of next) console.log(`      → ${n.text ? `"${n.text}" ` : ''}${n.abs.slice(0, 110)}`);

  for (const n of next.slice(0, 3)) {
    try {
      const r2 = await get(n.abs);
      if (!r2.ok) continue;
      const h2 = await r2.text();
      const found = candidateUrls(h2, r2.url).filter(
        (c) => /myworkdayjobs|greenhouse\.io|lever\.co|ashbyhq/i.test(c) || detectUnsupportedFamily(c)
      );
      if (found.length) {
        console.log(`      HOP HIT via ${n.abs.slice(0, 80)}`);
        for (const f of [...new Set(found)].slice(0, 4)) console.log(`        ${f.slice(0, 120)}`);
        return;
      }
    } catch {
      /* try the next one */
    }
  }
}

async function main() {
  const report = JSON.parse(await readFile(REPORT, 'utf8')).results ?? [];

  const oracle = report.filter((r) => r.status === 'unsupported-ats' && r.family === 'oracle-cloud');
  console.log(`\n=== Oracle Cloud (${oracle.length} firms) ===`);
  for (const r of oracle) {
    const host = (() => {
      try {
        return new URL(r.atsUrl || r.via).host;
      } catch {
        return null;
      }
    })();
    console.log(`  ${r.firm}  host=${host ?? 'unknown'}`);
    if (!host || !host.includes('oraclecloud')) {
      console.log('      no oracle host recorded — rerun discovery first');
      continue;
    }
    await probeOracle(host);
  }

  const none = report.filter((r) => r.status === 'no-board-found');
  console.log(`\n=== No board found (${none.length} firms) ===`);
  for (const r of none) {
    console.log(`  ${r.firm}`);
    if (r.via) await probeSecondHop(r.via);
  }

  const blocked = report.filter((r) => r.status === 'unreachable');
  console.log(`\n=== Unreachable (${blocked.length} firms) ===`);
  for (const r of blocked) console.log(`  ${String(r.firm).padEnd(24)} ${head(r.note, 150)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
