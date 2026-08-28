#!/usr/bin/env node
/**
 * Resolve the seed list of careers pages into ATS boards the tracker can poll.
 *
 * Reads lib/sources/careers-seed.json, fetches each firm's student/careers page,
 * finds the board behind it, then PROVES the board by asking it for postings.
 * Only boards that answer with real jobs are written out.
 *
 * That last step is the point. A guessed Workday tenant does not error — it
 * returns an empty board, which is indistinguishable from a firm having no
 * early-career roles until someone notices a bank has quietly vanished from the
 * tracker. Nothing is trusted here until it has produced a posting.
 *
 * Run: npm run discover:ats
 *      npm run discover:ats -- --limit=20        first N unresolved firms
 *      npm run discover:ats -- --vertical="Investment Bank"
 *      npm run discover:ats -- --write           merge findings into the registry
 */

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  detectBoard,
  boardApiUrl,
  detectUnsupportedFamily,
  firstBoard,
  candidateUrls,
} from '../lib/ats-discover.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SEED = join(ROOT, 'lib/sources/careers-seed.json');
const REGISTRY = join(ROOT, 'lib/sources/ats-registry.json');
const OUT = join(ROOT, 'data/ats-discovery.json');
const UA = 'Mozilla/5.0 (compatible; L3vlupTracker/1.0; +https://www.l3vlup.com)';
const TIMEOUT_MS = 20_000;
const POOL = 6;

const arg = (n) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split('=').slice(1).join('=');

async function get(url, init) {
  const res = await fetch(url, {
    ...init,
    headers: { 'User-Agent': UA, ...(init?.headers || {}) },
    redirect: 'follow',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  return res;
}

/** Ask a board for postings. Returns a count, or null when it is not a real board. */
async function countPostings(board) {
  const url = boardApiUrl(board);
  if (!url) return null;
  try {
    if (board.ats === 'workday') {
      const res = await get(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ appliedFacets: {}, limit: 20, offset: 0, searchText: '' }),
      });
      if (!res.ok) return null;
      const d = await res.json();
      return typeof d.total === 'number' ? d.total : (d.jobPostings || []).length;
    }
    const res = await get(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    const d = await res.json();
    if (Array.isArray(d)) return d.length;            // lever
    if (Array.isArray(d.jobs)) return d.jobs.length;  // greenhouse, ashby
    return null;
  } catch {
    return null;
  }
}

async function resolveFirm(firm) {
  const base = { firm: firm.firm, vertical: firm.vertical, region: firm.region };

  // A tenant already recorded in the seed still has to prove itself.
  if (firm.workday?.tenant) {
    const board = { ats: 'workday', ...firm.workday };
    const n = await countPostings(board);
    if (n !== null) return { ...base, status: 'validated', board, postings: n, via: 'seed' };
    return { ...base, status: 'seed-tenant-failed', board, note: 'tenant in the seed list returned nothing' };
  }

  const httpFailures = [];
  for (const url of [firm.studentsUrl, firm.careersUrl].filter(Boolean)) {
    let res;
    try {
      res = await get(url);
    } catch (e) {
      httpFailures.push(`${url} → ${String(e.message || e).slice(0, 60)}`);
      continue;
    }
    // A page we could not read is not evidence that a firm has no board. Keeping
    // the two apart matters: "no board found" invites someone to conclude the
    // firm has nothing, when the fetch simply failed.
    if (!res.ok) {
      httpFailures.push(`${url} → HTTP ${res.status}`);
      continue;
    }

    // A redirect may land straight on the board.
    const landed = detectBoard(res.url);
    const html = await res.text();
    const board = landed ?? firstBoard(html, res.url);

    if (board) {
      const n = await countPostings(board);
      if (n !== null) return { ...base, status: 'validated', board, postings: n, via: url };
      return { ...base, status: 'detected-not-validated', board, via: url,
               note: 'board pattern matched but returned no postings' };
    }

    // Keep the URL that matched, not just the family name. 'oracle-cloud' does
    // not say which Oracle deployment, and the tenant host is the only part an
    // adapter can be written against.
    const atsUrl = detectUnsupportedFamily(res.url)
      ? res.url
      : candidateUrls(html, res.url).find(detectUnsupportedFamily) ?? null;
    const family = atsUrl ? detectUnsupportedFamily(atsUrl) : null;
    if (family) return { ...base, status: 'unsupported-ats', family, atsUrl, via: url };
  }

  if (httpFailures.length) {
    return { ...base, status: 'unreachable', note: httpFailures.join('; ').slice(0, 200) };
  }
  return { ...base, status: 'no-board-found', via: firm.studentsUrl || firm.careersUrl };
}

async function main() {
  const seed = JSON.parse(await readFile(SEED, 'utf8')).firms ?? [];
  const registry = JSON.parse(await readFile(REGISTRY, 'utf8'));
  const known = new Set(
    (Array.isArray(registry) ? registry : registry.firms ?? []).map((f) => String(f.firm).toLowerCase())
  );

  let firms = seed.filter((f) => !known.has(String(f.firm).toLowerCase()));
  const vertical = arg('vertical');
  if (vertical) firms = firms.filter((f) => f.vertical === vertical);
  const limit = Number(arg('limit'));
  if (Number.isFinite(limit) && limit > 0) firms = firms.slice(0, limit);

  console.log(`resolving ${firms.length} firms not already in the registry…\n`);

  const results = [];
  for (let i = 0; i < firms.length; i += POOL) {
    const batch = await Promise.allSettled(firms.slice(i, i + POOL).map(resolveFirm));
    for (const r of batch) {
      if (r.status !== 'fulfilled') continue;
      results.push(r.value);
      const v = r.value;
      const detail =
        v.status === 'validated'
          ? `${v.board.ats}:${v.board.tenant ?? v.board.token} (${v.postings} postings)`
          : v.family ?? v.note ?? '';
      console.log(`  ${v.status.padEnd(24)} ${String(v.firm).slice(0, 30).padEnd(32)} ${detail}`);
    }
  }

  const byStatus = {};
  for (const r of results) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
  console.log('\nsummary:', JSON.stringify(byStatus));

  await writeFile(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2) + '\n');
  console.log(`wrote ${OUT}`);

  if (process.argv.includes('--write')) {
    const validated = results.filter((r) => r.status === 'validated' && r.postings > 0);
    const list = Array.isArray(registry) ? registry : (registry.firms ??= []);
    for (const v of validated) {
      list.push({
        firm: v.firm,
        ats: v.board.ats,
        ...(v.board.token ? { token: v.board.token } : {}),
        ...(v.board.tenant ? { tenant: v.board.tenant, shard: v.board.shard, site: v.board.site } : {}),
        tier: 'Tracked',
      });
    }
    await writeFile(REGISTRY, JSON.stringify(registry, null, 2) + '\n');
    console.log(`merged ${validated.length} validated boards into the registry`);
  } else {
    console.log('(dry run — pass --write to merge validated boards into the registry)');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
