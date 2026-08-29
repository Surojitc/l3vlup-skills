#!/usr/bin/env node
/**
 * Report every field each ATS actually returns, so enrichment is written
 * against observed payloads rather than a blog post.
 *
 * WHY
 * The tracker is short of deadlines (22 of 207 roles) and stores location as an
 * unparsed string. The instinct is to go and scrape more sites. The likelier
 * truth is that we are under-reading the APIs we already call: the Workday
 * LIST endpoint is all sync-ats.mjs touches, and the per-job DETAIL endpoint is
 * documented as returning startDate as an exact ISO date, an endDate, and a
 * structured jobRequisitionLocation with country and city — against the
 * relative "Posted 3 Days Ago" text we currently parse and the flat
 * locationsText we currently store.
 *
 * This prints the full key set and a redacted sample for each source. Delete it
 * once the enrichment exists; it is scaffolding, like probe-ats-families.mjs.
 *
 * Run: node scripts/probe-ats-fields.mjs
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const UA = 'Mozilla/5.0 (compatible; L3vlupTracker/1.0; +https://www.l3vlup.com)';
const T = 20_000;

const get = (url, init) =>
  fetch(url, { ...init, headers: { 'User-Agent': UA, Accept: 'application/json', ...(init?.headers || {}) }, signal: AbortSignal.timeout(T) });

const keys = (o, prefix = '') =>
  Object.entries(o || {}).flatMap(([k, v]) =>
    v && typeof v === 'object' && !Array.isArray(v) && prefix.split('.').length < 2
      ? [`${prefix}${k}`, ...keys(v, `${prefix}${k}.`)]
      : [`${prefix}${k}`]
  );

const show = (label, obj) => {
  console.log(`\n  --- ${label}`);
  console.log('  keys: ' + keys(obj).join(', '));
  console.log('  sample: ' + JSON.stringify(obj).slice(0, 700));
};

async function probeWorkday(f) {
  const host = f.host || `${f.tenant}.${f.shard}.myworkdayjobs.com`;
  console.log(`\n=== WORKDAY ${f.firm} (${host}/${f.site})`);
  let list;
  try {
    const res = await get(`https://${host}/wday/cxs/${f.tenant}/${f.site}/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appliedFacets: {}, limit: 5, offset: 0, searchText: 'intern' }),
    });
    if (!res.ok) return console.log(`  list HTTP ${res.status}`);
    list = await res.json();
  } catch (e) {
    return console.log('  list failed: ' + (e.message || e));
  }
  console.log('  top-level keys: ' + keys(list).join(', '));
  const first = (list.jobPostings || [])[0];
  if (!first) return console.log('  no postings for "intern"');
  show('LIST item (what sync-ats reads today)', first);

  // The detail endpoint. This is the part we do not call.
  try {
    const res = await get(`https://${host}/wday/cxs/${f.tenant}/${f.site}/job${first.externalPath}`);
    if (!res.ok) return console.log(`  detail HTTP ${res.status}`);
    const d = await res.json();
    console.log('\n  detail top-level keys: ' + keys(d).join(', '));
    const info = d.jobPostingInfo ?? d;
    show('DETAIL jobPostingInfo', { ...info, jobDescription: `<${String(info.jobDescription || '').length} chars of HTML>` });
    for (const field of ['startDate', 'endDate', 'jobRequisitionLocation', 'additionalLocations', 'timeType', 'jobReqId']) {
      console.log(`  ${field.padEnd(24)} ${JSON.stringify(info[field]) ?? 'absent'}`);
    }
  } catch (e) {
    console.log('  detail failed: ' + (e.message || e));
  }
}

async function probeGreenhouse(token) {
  console.log(`\n=== GREENHOUSE ${token}`);
  try {
    const res = await get(`https://boards-api.greenhouse.io/v1/boards/${token}/jobs?content=true`);
    if (!res.ok) return console.log(`  HTTP ${res.status}`);
    const d = await res.json();
    const j = (d.jobs || [])[0];
    if (!j) return console.log('  no jobs');
    show('job', { ...j, content: `<${String(j.content || '').length} chars>` });
    // The single-job endpoint carries questions and richer metadata.
    const one = await get(`https://boards-api.greenhouse.io/v1/boards/${token}/jobs/${j.id}?questions=true`);
    if (one.ok) {
      const o = await one.json();
      show('single job (questions=true)', { ...o, content: `<${String(o.content || '').length} chars>` });
    }
  } catch (e) {
    console.log('  failed: ' + (e.message || e));
  }
}

async function probeAshby(token) {
  console.log(`\n=== ASHBY ${token}`);
  try {
    const res = await get(`https://api.ashbyhq.com/posting-api/job-board/${token}?includeCompensation=true`);
    if (!res.ok) return console.log(`  HTTP ${res.status}`);
    const d = await res.json();
    const j = (d.jobs || [])[0];
    if (j) show('job (includeCompensation=true)', { ...j, descriptionHtml: '<html>', descriptionPlain: '<text>' });
  } catch (e) {
    console.log('  failed: ' + (e.message || e));
  }
}

async function main() {
  const reg = JSON.parse(await readFile(join(ROOT, 'lib/sources/ats-registry.json'), 'utf8')).firms;
  const wd = reg.filter((f) => f.ats === 'workday').slice(0, 3);
  for (const f of wd) await probeWorkday(f);
  await probeGreenhouse('stripe');
  await probeAshby('ramp');
  console.log('\ndone');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
