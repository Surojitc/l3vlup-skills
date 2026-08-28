#!/usr/bin/env node
/**
 * ATS collation cron — the comprehensive-freshness engine.
 *
 * Reads lib/sources/ats-registry.json, pulls each firm's public ATS board
 * (Greenhouse / Ashby / Lever — no login/key/browser), filters to early-career
 * roles in our covered verticals, normalizes into the Opportunity shape, and
 * writes data/opportunities.auto.json.
 *
 * The app reads that pre-generated file (fast, no request-time fan-out), so this
 * scales to hundreds of firms. Runs daily in CI (.github/workflows/tracker-sync.yml);
 * the commit triggers a redeploy that ships the fresh data.
 *
 * Run locally: npm run sync:ats
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import {
  extractDeadline,
  applyManualDeadlines,
  extractJsonLdDeadline,
} from '../lib/deadline-extract.mjs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY = join(ROOT, 'lib/sources/ats-registry.json');
const OUT = join(ROOT, 'data/opportunities.auto.json');
const UA = 'Mozilla/5.0 (compatible; L3vlupTracker/1.0; +https://l3vlup.com)';
const PER_FIRM_CAP = 25; // avoid one big board flooding the tracker
const TIMEOUT_MS = 12000;

/* ----------------------------- classification ---------------------------- */
// Word-boundaried so "Internal"/"International" do NOT match "intern".
const EARLY_CAREER =
  /\b(intern|interns|internship|internships|new[\s-]?grad|newgrad|undergraduate|graduate|graduates|university\s+(grad|graduate|hire)|campus|apprentice|apprenticeship|early[\s-]?career|placement|co-?op|student|students|rotational|residency|apm|rpm|step|summer\s+analyst|analyst\s+programme?|off[\s-]?cycle|spring\s+(week|insight))\b/i;
const SENIOR = /\b(senior|staff|principal|director|distinguished|vp|head\s+of|lead)\b/i;

function isEarlyCareer(title) {
  if (SENIOR.test(title)) return false;
  return EARLY_CAREER.test(title);
}

function inferVertical(title) {
  const t = title.toLowerCase();
  if (/\b(quant|quantitative)\b/.test(t)) return 'Quant';
  if (
    /machine learning|deep learning|\bml\b|\bai\b|data scientist|data engineer|research (engineer|scientist)|applied scientist|research residency/.test(t)
  )
    return 'Data & ML';
  // Finance verticals — classify only clear signals so bank/ops roles aren't mislabeled.
  if (/equity research|research analyst/.test(t)) return 'Equity Research';
  if (/private equity/.test(t)) return 'Private Equity';
  if (/investment bank|\bibd\b|\bm&a\b|mergers|corporate advisory/.test(t)) return 'Investment Banking';
  if (/product manager|product management|\bapm\b|\brpm\b|associate product/.test(t)) return 'Product Management';
  if (/software engineer|\bswe\b|developer|frontend|front-end|backend|back-end|full[ -]?stack|infrastructure engineer|systems engineer|engineer/.test(t))
    return 'Software Engineering';
  return null;
}

function inferProgrammeAndLevel(title) {
  const t = title.toLowerCase();
  // Checked before the generic intern match, because most of these titles also
  // contain "intern" or "program" and would otherwise be filed as internships.
  if (
    /\b(sophomore|freshman|first[- ]year)\b/.test(t) ||
    /\b(insight|early insights?|discovery|explore|exploration|immersion|launchpad|springboard)\b.*\b(program|programme|day|series|summit|experience)\b/.test(t) ||
    /\b(program|programme|summit)\b.*\b(insight|discovery|immersion)\b/.test(t)
  ) {
    return { programmeType: 'Insight Program', level: 'Internship' };
  }
  if (/spring\s*(week|insight)/.test(t)) return { programmeType: 'Spring Week', level: 'Internship' };
  if (/intern|co-op|coop|\bstudent\b/.test(t)) return { programmeType: 'Summer Internship', level: 'Internship' };
  if (/residency/.test(t)) return { programmeType: 'Graduate Programme', level: 'Experienced' };
  return { programmeType: 'Graduate Programme', level: 'Graduate' };
}

function inferRegion(location) {
  const l = (location || '').toLowerCase();
  if (/remote/.test(l)) return 'Remote';
  if (/london|united kingdom|\buk\b|england|scotland|edinburgh|manchester|glasgow/.test(l)) return 'UK';
  if (/dublin|ireland|amsterdam|netherlands|paris|france|berlin|münchen|munich|germany|madrid|barcelona|spain|zurich|switzerland|stockholm|sweden|milan|italy|lisbon|portugal|warsaw|poland/.test(l))
    return 'Europe';
  if (/singapore|hong kong|tokyo|japan|bangalore|bengaluru|india|shanghai|beijing|china|seoul|korea|sydney|australia/.test(l))
    return 'Asia';
  if (/dubai|abu dhabi|riyadh|qatar|doha|\buae\b|saudi|bahrain/.test(l)) return 'Middle East';
  return 'US';
}

function prepSlugFor(vertical) {
  if (vertical === 'Software Engineering' || vertical === 'Data & ML') return 'software-engineering-interview-prep';
  if (vertical === 'Product Management') return 'product-management-interview-prep';
  return undefined;
}

/**
 * Workday reports "Posted 3 Days Ago" / "Posted Today" / "Posted 30+ Days Ago"
 * rather than a date. Converts to an ISO date so the row can carry a real
 * datePosted. "30+" is deliberately dropped: it is a floor, not a date, and
 * guessing would put a wrong value into JobPosting markup.
 */
function relativePostedToIso(text) {
  if (!text || typeof text !== 'string') return undefined;
  const t = text.toLowerCase();
  if (/30\+/.test(t)) return undefined;
  let daysAgo = null;
  if (/today|just posted/.test(t)) daysAgo = 0;
  else if (/yesterday/.test(t)) daysAgo = 1;
  else {
    const m = t.match(/(\d+)\s*\+?\s*day/);
    if (m) daysAgo = Number(m[1]);
    const w = t.match(/(\d+)\s*\+?\s*week/);
    if (w) daysAgo = Number(w[1]) * 7;
    const mo = t.match(/(\d+)\s*\+?\s*month/);
    if (mo) daysAgo = Number(mo[1]) * 30;
  }
  if (daysAgo === null || !Number.isFinite(daysAgo)) return undefined;
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

/** Normalise whatever an ATS gave us to a plain YYYY-MM-DD, or nothing. */
function toIsoDate(value) {
  if (!value) return undefined;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return undefined;
  // A posting date in the future is bad data, and would make JobPosting
  // markup invalid. Drop it rather than publish it.
  if (d.getTime() > Date.now()) return undefined;
  return d.toISOString().slice(0, 10);
}

function toOpportunity(job, firm) {
  if (!job.title || !isEarlyCareer(job.title)) return null;
  const vertical = inferVertical(job.title);
  if (!vertical) return null;
  const { programmeType, level } = inferProgrammeAndLevel(job.title);
  const tags = ['Auto-sourced'];
  if (job.department) tags.push(job.department);
  const extracted = job.deadline ? {} : extractDeadline(job.description || '');
  if (extracted.rolling) tags.push('Rolling');
  return {
    id: `${firm.ats}-${firm.token || firm.tenant}-${job.id}`,
    firm: firm.firm,
    role: job.title.trim(),
    vertical,
    programmeType,
    tier: firm.tier,
    location: (job.location || '').trim() || 'See listing',
    region: inferRegion(job.location),
    level,
    // A stated deadline, in order of trust: the ATS field if a board bothers
    // to populate it, otherwise one the posting states in prose. Never inferred.
    closingDate: job.deadline || extracted.closingDate || undefined,
    // Real posting date from the ATS. Drives JobPosting datePosted, which
    // Google requires — without it the markup is invalid and the row is
    // ineligible for job rich results.
    openingDate: toIsoDate(job.postedAt),
    status: 'Open',
    applicationUrl: job.url,
    recommendedPrepSlug: prepSlugFor(vertical),
    tags,
  };
}

/* ------------------------------- fetchers -------------------------------- */
async function getJson(url, init) {
  const res = await fetch(url, {
    ...init,
    headers: { 'User-Agent': UA, Accept: 'application/json', ...(init?.headers || {}) },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

async function fetchGreenhouse(f) {
  // content=true costs a larger payload and buys the posting body, which is
  // where deadlines are actually written — application_deadline is a real
  // Greenhouse field that almost no board populates.
  const d = await getJson(`https://boards-api.greenhouse.io/v1/boards/${f.token}/jobs?content=true`);
  return (d.jobs || []).map((j) => ({
    id: String(j.id),
    title: j.title || '',
    location: j.location?.name || '',
    url: j.absolute_url,
    deadline: j.application_deadline || undefined,
    postedAt: j.first_published || j.updated_at || undefined,
    description: j.content || '',
  }));
}

async function fetchAshby(f) {
  const d = await getJson(`https://api.ashbyhq.com/posting-api/job-board/${f.token}`);
  return (d.jobs || [])
    .filter((j) => j.isListed !== false)
    .map((j) => ({
      id: String(j.id),
      title: j.title || '',
      location: j.location || '',
      url: j.jobUrl || j.applyUrl,
      department: j.department || undefined,
      postedAt: j.publishedAt || j.updatedAt || undefined,
      description: j.descriptionPlain || j.descriptionHtml || '',
    }));
}

async function fetchLever(f) {
  const d = await getJson(`https://api.lever.co/v0/postings/${f.token}?mode=json`);
  return (Array.isArray(d) ? d : []).map((j) => ({
    id: String(j.id),
    title: j.text || '',
    location: j.categories?.location || '',
    url: j.hostedUrl,
    department: j.categories?.team || undefined,
    // Lever returns epoch milliseconds, not an ISO string.
    postedAt: j.createdAt ? new Date(j.createdAt).toISOString() : undefined,
    description: j.descriptionPlain || j.description || '',
  }));
}

// Workday search is fuzzy (matches "International" for "intern"), so we run a few
// targeted queries, union them, and lean on the strict early-career + vertical
// filters downstream to drop false positives. Covers banks + big enterprises.
async function fetchWorkday(f) {
  const QUERIES = ['intern', 'graduate', 'new grad', 'summer analyst', 'apprentice'];
  const seen = new Map();
  for (const q of QUERIES) {
    for (const offset of [0, 20]) {
      let data;
      try {
        data = await getJson(`https://${f.host}/wday/cxs/${f.tenant}/${f.site}/jobs`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ limit: 20, offset, searchText: q }),
        });
      } catch {
        break; // this query/page failed; move on
      }
      for (const jp of data.jobPostings ?? []) {
        const path = jp.externalPath;
        if (!path || seen.has(path)) continue;
        const idMatch = path.split('_').pop();
        seen.set(path, {
          id: idMatch || path,
          title: jp.title ?? '',
          location: jp.locationsText ?? '',
          url: `https://${f.host}/${f.site}${path}`,
          // Workday gives relative text ("Posted 3 Days Ago"), not a date.
          postedAt: relativePostedToIso(jp.postedOn),
        });
      }
    }
  }
  return [...seen.values()];
}

const FETCHERS = { greenhouse: fetchGreenhouse, ashby: fetchAshby, lever: fetchLever, workday: fetchWorkday };

async function main() {
  const registry = JSON.parse(await readFile(REGISTRY, 'utf8'));
  const firms = registry.firms || [];
  const stamp = new Date().toISOString();
  const all = [];
  let ok = 0;
  let failed = 0;

  // Small concurrency pool so we don't hammer or hang.
  const POOL = 8;
  // Ceiling on the JSON-LD pass so one bad run cannot crawl indefinitely.
  const LD_PASS_CAP = 400;
  for (let i = 0; i < firms.length; i += POOL) {
    const batch = firms.slice(i, i + POOL);
    const results = await Promise.allSettled(
      batch.map(async (f) => {
        const raw = await FETCHERS[f.ats](f);
        const opps = raw.map((j) => toOpportunity(j, f)).filter(Boolean).slice(0, PER_FIRM_CAP);
        return { firm: f.firm, opps };
      })
    );
    for (const r of results) {
      if (r.status === 'fulfilled') {
        ok++;
        all.push(...r.value.opps);
        if (r.value.opps.length) console.log(`  ${r.value.firm}: ${r.value.opps.length}`);
      } else {
        failed++;
      }
    }
  }

  // ---------------------------------------------------------------------
  // Refuse to publish a collapsed result.
  //
  // Every fetch is independently fallible — an ATS outage, rate limiting, a
  // network blip in CI — and `Promise.allSettled` swallows all of it. Without
  // this guard a bad run writes an empty tracker, commits it, and the live
  // site loses every role until someone notices. Discovered the hard way: a
  // local run with restricted egress failed 45 of 48 boards and produced 0.
  //
  // A real drop happens gradually; a collapse is infrastructure. Bail loudly
  // and leave yesterday's data in place, which is stale but correct.
  // ---------------------------------------------------------------------
  let previousCount = 0;
  try {
    previousCount = JSON.parse(await readFile(OUT, 'utf8')).opportunities?.length ?? 0;
  } catch {
    /* first run — nothing to protect */
  }
  const MIN_RETAINED_SHARE = 0.5;
  if (previousCount > 0 && all.length < previousCount * MIN_RETAINED_SHARE) {
    console.error(
      `\nABORT: collated ${all.length} roles vs ${previousCount} previously ` +
        `(${ok}/${firms.length} boards ok, ${failed} failed).\n` +
        `That is below ${MIN_RETAINED_SHARE * 100}% of the last good run, which means a ` +
        `source outage rather than roles genuinely closing. Existing data left untouched.`,
    );
    process.exit(1);
  }

  // ---------------------------------------------------------------------
  // Second pass: read JobPosting structured data off the posting page itself.
  //
  // `validThrough` is required for a posting to be eligible for Google's job
  // rich results, so employers chasing that traffic publish the deadline as
  // machine-readable JSON-LD even when their ATS exposes no such field. That
  // makes it far more reliable than reading prose, and it costs one HTTP GET
  // per undated role — only for roles the first pass could not date.
  // ---------------------------------------------------------------------
  const undated = all.filter((o) => !o.closingDate && o.applicationUrl).slice(0, LD_PASS_CAP);
  let fromMarkup = 0;
  if (undated.length) {
    console.log(`\nchecking ${undated.length} posting pages for JobPosting validThrough…`);
    for (let i = 0; i < undated.length; i += POOL) {
      const batch = undated.slice(i, i + POOL);
      await Promise.allSettled(
        batch.map(async (o) => {
          const res = await fetch(o.applicationUrl, {
            headers: { 'User-Agent': UA },
            signal: AbortSignal.timeout(TIMEOUT_MS),
          });
          if (!res.ok) return;
          const html = await res.text();
          const found = extractJsonLdDeadline(html);
          // Prose is the fallback when a page carries no markup.
          const date = found.closingDate || extractDeadline(html).closingDate;
          if (date) {
            o.closingDate = date;
            fromMarkup++;
          }
        })
      );
    }
  }

  // ---------------------------------------------------------------------
  // Hand-entered deadlines win over anything scraped. Most bank early-career
  // dates are announced on the firm's own careers page and never reach the
  // ATS record, so this is the only route for them.
  // ---------------------------------------------------------------------
  const MANUAL = join(ROOT, 'data/deadlines.manual.json');
  let manual = [];
  try {
    manual = JSON.parse(await readFile(MANUAL, 'utf8')).deadlines ?? [];
  } catch {
    /* optional file */
  }
  const overridden = applyManualDeadlines(all, manual, stamp.slice(0, 10));

  const withDates = all.filter((o) => o.closingDate).length;
  const rolling = all.filter((o) => o.tags?.includes('Rolling')).length;
  console.log(
    `\ndeadlines: ${withDates}/${all.length} dated ` +
      `(${fromMarkup} from JobPosting markup, ${overridden} from ` +
      `data/deadlines.manual.json), ${rolling} marked rolling`
  );

  await mkdir(dirname(OUT), { recursive: true });

  // Snapshot history for the weekly "what opened this week" insights: one
  // compact entry per sync day (ids + per-vertical counts), capped at 120 days.
  const HISTORY = join(ROOT, 'data/tracker-history.json');
  let history = [];
  try {
    history = JSON.parse(await readFile(HISTORY, 'utf8')).snapshots ?? [];
  } catch {
    /* first run */
  }
  const day = stamp.slice(0, 10);
  const byVertical = {};
  for (const o of all) byVertical[o.vertical] = (byVertical[o.vertical] ?? 0) + 1;
  const snapshot = { date: day, count: all.length, byVertical, ids: all.map((o) => o.id) };
  history = history.filter((h) => h.date !== day);
  history.push(snapshot);
  history = history.slice(-120);
  await writeFile(HISTORY, JSON.stringify({ snapshots: history }, null, 2) + '\n');

  await writeFile(OUT, JSON.stringify({ generatedAt: stamp, count: all.length, opportunities: all }, null, 2) + '\n');
  console.log(`\n${all.length} early-career roles from ${ok}/${firms.length} boards (${failed} failed) → ${OUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
