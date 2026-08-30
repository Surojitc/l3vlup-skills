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
import { detailUrl, parseWorkdayDetail } from '../lib/workday-detail.mjs';
import {
  ledgerDeadline,
  loadLedger,
  needsCheck,
  orderForEnrichment,
  pruneLedger,
  recordHit,
  recordMiss,
  serialiseLedger,
} from '../lib/deadline-ledger.mjs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY = join(ROOT, 'lib/sources/ats-registry.json');
const OUT = join(ROOT, 'data/opportunities.auto.json');
const UA = 'Mozilla/5.0 (compatible; L3vlupTracker/1.0; +https://l3vlup.com)';
const LEDGER = join(ROOT, 'data/deadlines.learned.json');
const TIMEOUT_MS = 12000;

/**
 * No per-firm cap.
 *
 * There used to be one, at 25. It was not a filter — it was `.slice(0, 25)` over
 * whatever order the board happened to answer in, so which roles reached the
 * site was decided by fetch order. When Workday pagination landed, Citi's
 * candidate pool went from 10 to 62 and the slice took a different 25; the five
 * roles that carried deadlines fell outside it and the tracker lost every dated
 * Citi role overnight. Those postings were still live and still carried
 * `validThrough` — they had simply stopped being collated.
 *
 * A cap that discards by arrival order discards the most valuable rows as
 * readily as the least. The ceiling below is a runaway guard, not a filter: it
 * is far above any real board's early-career count, and hitting it is logged as
 * a problem to look at rather than absorbed silently.
 */
const PER_FIRM_CEILING = 1000;

/* ----------------------------- classification ---------------------------- */
// Word-boundaried so "Internal"/"International" do NOT match "intern".
const EARLY_CAREER =
  /\b(intern|interns|internship|internships|new[\s-]?grad|newgrad|undergraduate|graduate|graduates|university\s+(grad|graduate|hire)|campus|apprentice|apprenticeship|early[\s-]?career|(?:industrial|summer|year[\s-]?long|12[\s-]?month)\s+placements?|placements?\s+(?:year|scheme|programme?|student)|co-?op|student|students|rotational|residency|apm|rpm|step|summer\s+analyst|summer\s+associate|analyst\s+programme?|off[\s-]?cycle|spring\s+(week|insight))\b/i;
const SENIOR = /\b(senior|staff|principal|director|distinguished|vp|head\s+of|lead)\b/i;

export function isEarlyCareer(title) {
  if (SENIOR.test(title)) return false;
  return EARLY_CAREER.test(title);
}

// Every role that clears the early-career filter gets a vertical. The order of
// these rules is the whole design: each is reachable only because the ones
// above it are narrower, so the specific reading of an overloaded word wins.
// "Quantitative Risk Management" is Quant, plain "Credit Risk" is Risk;
// "Technology Investment Banking" is banking, plain "Technology Analyst" is
// engineering.
export function inferVertical(title) {
  const t = String(title || '').toLowerCase();

  if (/\b(quant|quantitative)\b/.test(t)) return 'Quant';
  if (
    /machine learning|deep learning|\bml\b|\bai\b|data scien(ce|tist)|data engineer|research (engineer|scientist)|applied scientist|research residency|\bdata analytics\b|applied research|\bnlp\b|\bllm\b|computer vision/.test(t)
  )
    return 'Data & ML';

  if (/equity research|research analyst/.test(t)) return 'Equity Research';
  if (/private equity|\bbuyout\b/.test(t)) return 'Private Equity';
  if (/venture capital|\bvc\b\s|growth equity/.test(t)) return 'Venture Capital';
  if (/private credit|direct lending|leveraged finance|credit investment/.test(t)) return 'Private Credit';
  if (/hedge fund|long[\s\/-]?short|multi[\s-]?strategy|portfolio management/.test(t)) return 'Hedge Fund';
  // Both of these sit above the generic 'banking' rule, which would otherwise
  // swallow them. "Private Banking" is wealth management, not a deal team —
  // caught by a test the moment the generic rule was added. And Citi files
  // corporate lending as "Banking - Corporate Banking", which is not the same
  // job as advising on deals.
  if (/wealth management|private bank|private wealth|\bpwm\b/.test(t)) return 'Wealth Management';
  if (/corporate banking|commercial banking|transaction banking|\btrade finance\b/.test(t))
    return 'Corporate Banking';
  if (
    /investment bank|\bibd\b|\bm&a\b|mergers|corporate advisory|capital markets|restructuring|corporate finance|valuation|debt advisory|capital solutions|\bbanking\b/.test(t)
  )
    return 'Investment Banking';

  if (
    /sales (and|&) trading|\bs&t\b|global markets|\bmarkets\b|trading|\btrader\b|securities|structuring|fixed income|equities desk/.test(t)
  )
    return 'Sales & Trading';
  if (/asset management|investment management|fund management|\bmulti[\s-]?asset\b/.test(t)) return 'Asset Management';
  if (/corporate development/.test(t)) return 'Corporate Development';

  if (/product manager|product management|\bapm\b|\brpm\b|associate product/.test(t)) return 'Product Management';
  if (
    /software engineer|\bswe\b|developer|frontend|front-end|backend|back-end|full[ -]?stack|infrastructure engineer|systems engineer|\btechnology\b|\bengineering\b|engineer|\basic\b|silicon|\bvlsi\b|firmware|circuit design|physical design|hardware|verification|system design|solution architect/.test(t)
  )
    return 'Software Engineering';

  if (/\brisk\b|credit analysis|\bcredit analyst\b/.test(t)) return 'Risk';
  if (/compliance|\blegal\b|financial crime|\bkyc\b|anti[\s-]?money/.test(t)) return 'Compliance & Legal';
  if (/\baudit\b|\btax\b|accounting|\bfinance\b|treasury|controller/.test(t)) return 'Finance & Accounting';
  if (/operations|\bops\b|middle office|back office|business management/.test(t)) return 'Operations';

  if (
    /fintech sales|account executive|account development|sales development|\bsdr\b|\bbdr\b|business development|\bsales\b/.test(t)
  )
    return 'FinTech Sales';

  // Kept, not dropped. Returning null here used to discard the role outright,
  // which is how every Markets, Wealth Management and Operations graduate
  // scheme a bank publishes went missing from the tracker. The role title,
  // department tag and application URL all survive, so anything landing here
  // can be reclassified later without re-collecting it.
  return 'Other';
}

export function inferProgrammeAndLevel(title) {
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

// Vertical -> the career track page a candidate should read next.
//
// This was three tech branches and nothing else, so every finance role the
// tracker collected pointed nowhere: 24 investment banking rows, 12 sales &
// trading, and an equity research row, all with a written prep page sitting
// unlinked. The pages already existed; only this map was missing.
const PREP_SLUG = {
  'Investment Banking': 'investment-banking-interview-prep',
  'Private Equity': 'private-equity-interview-prep',
  'Hedge Fund': 'hedge-fund-interview-prep',
  'Equity Research': 'equity-research-interview-prep',
  'Sales & Trading': 'sales-and-trading-interview-prep',
  'Venture Capital': 'venture-capital-interview-prep',
  'Corporate Development': 'corporate-development-ma-interview-prep',
  'Operations': 'bizops-strategy-operations-interview-prep',
  'Product Management': 'product-management-interview-prep',
  'Software Engineering': 'software-engineering-interview-prep',
  // Data & ML has no track of its own yet and borrows the engineering one. It
  // is a proxy, not a path: the loops differ substantially, and docs/content-gaps.md
  // carries this as the second-largest content gap on the site.
  'Data & ML': 'software-engineering-interview-prep',
};

function prepSlugFor(vertical) {
  return PREP_SLUG[vertical];
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

/**
 * Normalise whatever an ATS gave us to a plain YYYY-MM-DD, or nothing.
 *
 * `allowFuture` separates the two uses. A POSTING date in the future is bad
 * data and would make JobPosting markup invalid, so it is dropped. A DEADLINE
 * in the future is the entire point of a deadline.
 */
function toIsoDate(value, { allowFuture = false } = {}) {
  if (!value) return undefined;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return undefined;
  if (!allowFuture && d.getTime() > Date.now()) return undefined;
  return d.toISOString().slice(0, 10);
}

export function toOpportunity(job, firm) {
  if (!job.title || !isEarlyCareer(job.title)) return null;
  // No null check: inferVertical always classifies, falling back to 'Other'.
  const vertical = inferVertical(job.title);
  const { programmeType, level } = inferProgrammeAndLevel(job.title);
  const tags = ['Auto-sourced'];
  if (job.department) tags.push(job.department);
  const extracted = job.deadline ? {} : extractDeadline(job.description || '');
  if (extracted.rolling) tags.push('Rolling');
  const atsDate = toIsoDate(job.deadline, { allowFuture: true });
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
    // Normalised to a plain date. Greenhouse returns application_deadline as a
    // full timestamp on some boards, and two Robinhood rows shipped as
    // '2026-09-26T19:28:09-04:00' — which renders as a wall of text next to the
    // plain dates beside it and is not a date the reader can act on differently
    // for knowing the hour.
    closingDate: atsDate || extracted.closingDate || undefined,
    // Where the date came from, so a run-over-run swap between sources is
    // visible instead of hiding behind a flat total. See the provenance
    // summary at the end of main().
    deadlineSource: atsDate ? 'ats-field' : extracted.closingDate ? 'prose' : undefined,
    // Real posting date from the ATS. Drives JobPosting datePosted, which
    // Google requires — without it the markup is invalid and the row is
    // ineligible for job rich results.
    openingDate: toIsoDate(job.postedAt),
    status: 'Open',
    applicationUrl: job.url,
    recommendedPrepSlug: prepSlugFor(vertical),
    tags,
    // Internal, stripped before write. Addresses the Workday detail endpoint.
    _workdayDetail: job.workdayDetail,
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
const WORKDAY_QUERIES = ['intern', 'graduate', 'new grad', 'summer analyst', 'apprentice'];
const WORKDAY_PAGE = 20;
const WORKDAY_MAX_PAGES_PER_QUERY = 15; // 300 postings per query, before dedupe
const WORKDAY_MAX_POSTINGS_PER_FIRM = 600; // whole-firm budget across all queries

/**
 * Page through a Workday board until it runs out, deduping on externalPath.
 *
 * Offsets used to be the fixed pair [0, 20], which sampled 40 postings from
 * boards holding hundreds — Barclays reports 965 — so which roles reached the
 * tracker was decided by Workday's result order rather than by relevance. Every
 * Barclays hit in the run that exposed this was Singapore or Hong Kong for
 * exactly that reason.
 *
 * `fetchPage(query, offset)` is injected so the termination rules can be tested
 * without a live board. They matter more than they look: a deployment that
 * ignores `offset` replays page one forever, and this runs in CI against real
 * boards.
 *
 * @returns {Map<string, object>} postings keyed by Workday's stable externalPath
 */
export async function paginateWorkday(fetchPage, opts = {}) {
  const {
    queries = WORKDAY_QUERIES,
    page: PAGE = WORKDAY_PAGE,
    maxPages = WORKDAY_MAX_PAGES_PER_QUERY,
    maxPostings = WORKDAY_MAX_POSTINGS_PER_FIRM,
  } = opts;
  const seen = new Map();

  for (const q of queries) {
    let offset = 0;
    for (let page = 0; page < maxPages; page++) {
      if (seen.size >= maxPostings) break;
      let data;
      try {
        data = await fetchPage(q, offset, PAGE);
      } catch {
        break; // this query failed; move to the next one
      }

      const postings = data?.jobPostings ?? [];
      if (postings.length === 0) break;

      let added = 0;
      for (const jp of postings) {
        const path = jp.externalPath;
        if (!path || seen.has(path)) continue;
        added++;
        seen.set(path, jp);
      }
      // A page that adds nothing new means the board is ignoring our offset and
      // replaying page one. Without this the loop never terminates.
      if (added === 0) break;

      offset += PAGE;
      // `total` is the count for this search term. Trust it when present, but
      // the two checks above are what actually terminate the loop, because not
      // every deployment returns it.
      if (typeof data.total === 'number' && offset >= data.total) break;
      if (postings.length < PAGE) break;
    }
  }
  return seen;
}

async function fetchWorkday(f) {
  // Two shapes live in the registry. Hand-added rows carry `host`; rows written
  // by scripts/discover-ats.mjs carry `tenant` + `shard` and no host at all.
  // Reading f.host alone built 'https://undefined/wday/cxs/...', which threw,
  // was swallowed by the catch below, and returned an empty list — so every
  // bank discovery added counted as a healthy board contributing nothing.
  const host = f.host || (f.tenant && f.shard ? `${f.tenant}.${f.shard}.myworkdayjobs.com` : null);
  if (!host) throw new Error(`no Workday host for ${f.firm}`);

  const seen = await paginateWorkday((searchText, offset, limit) =>
    getJson(`https://${host}/wday/cxs/${f.tenant}/${f.site}/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ limit, offset, searchText }),
    })
  );

  return [...seen.values()].map((jp) => ({
    id: jp.externalPath.split('_').pop() || jp.externalPath,
    title: jp.title ?? '',
    location: jp.locationsText ?? '',
    url: `https://${host}/${f.site}${jp.externalPath}`,
    // Workday gives relative text ("Posted 3 Days Ago"), not a date. The detail
    // pass below replaces this with the exact startDate where it can.
    postedAt: relativePostedToIso(jp.postedOn),
    // Kept so the detail endpoint can be addressed without rebuilding the host.
    workdayDetail: { host, tenant: f.tenant, site: f.site, externalPath: jp.externalPath },
  }));
}

/* ------------------------------ Oracle Cloud ----------------------------- */
// Oracle Recruiting Cloud, which is where JPMorgan sits — and a good part of the
// rest of the banking sector that is not on Workday. The candidate-facing site
// is a single-page app, but it is driven by a public REST endpoint that returns
// everything we need in JSON, including an exact PostedDate and a real
// PostingEndDate field.
//
// Two landmines, both hit while building this:
//
//   1. `expand=requisitionList...` is not optional. Without it the call still
//      returns 200 with a full facet payload and simply omits requisitionList —
//      so a board with thousands of roles reads as a firm with none. That is the
//      exact silent-empty failure the collapse guard and emptyFirms reporting
//      exist for, and it would have been invisible here.
//   2. `/hcmUI/CandidateExperience/...` is the SPA, not the API. Fetching it
//      returns HTML and no data. The API lives under `/hcmRestApi/`.
const ORACLE_QUERIES = ['intern', 'graduate', 'summer analyst', 'apprentice', 'student'];
const ORACLE_PAGE = 25;
const ORACLE_MAX_PAGES_PER_QUERY = 8;
const ORACLE_MAX_POSTINGS_PER_FIRM = 600;

/**
 * Page through an Oracle Recruiting Cloud site, deduping on requisition Id.
 *
 * Same termination contract as paginateWorkday, and for the same reasons: a
 * deployment that ignores `offset` replays page one forever, so "a page that
 * added nothing new" has to be a stop condition rather than trusting a count.
 *
 * `fetchPage(query, offset, limit)` is injected so those rules can be tested
 * without a live board.
 *
 * @returns {Map<string, object>} requisitions keyed by Oracle's stable Id
 */
export async function paginateOracle(fetchPage, opts = {}) {
  const {
    queries = ORACLE_QUERIES,
    page: PAGE = ORACLE_PAGE,
    maxPages = ORACLE_MAX_PAGES_PER_QUERY,
    maxPostings = ORACLE_MAX_POSTINGS_PER_FIRM,
  } = opts;
  const seen = new Map();

  for (const q of queries) {
    let offset = 0;
    for (let page = 0; page < maxPages; page++) {
      if (seen.size >= maxPostings) break;
      let data;
      try {
        data = await fetchPage(q, offset, PAGE);
      } catch {
        break; // this query failed; move to the next one
      }

      const bundle = data?.items?.[0];
      const reqs = bundle?.requisitionList ?? [];
      if (reqs.length === 0) break;

      let added = 0;
      for (const r of reqs) {
        const id = r?.Id;
        if (id == null || seen.has(String(id))) continue;
        added++;
        seen.set(String(id), r);
      }
      if (added === 0) break;

      offset += PAGE;
      if (typeof bundle.TotalJobsCount === 'number' && offset >= bundle.TotalJobsCount) break;
      if (reqs.length < PAGE) break;
    }
  }
  return seen;
}

/** Normalise one Oracle requisition into the shape toOpportunity() expects. */
export function oracleToJob(r, { host, site }) {
  return {
    id: String(r.Id),
    title: r.Title ?? '',
    location: r.PrimaryLocation ?? '',
    url: `https://${host}/hcmUI/CandidateExperience/en/sites/${site}/job/${r.Id}`,
    department: r.JobFamily || undefined,
    // An exact ISO date, unlike Workday's "Posted 3 Days Ago" prose.
    postedAt: r.PostedDate || undefined,
    // The apply-by date when the requisition carries one. JPMorgan currently
    // leaves it null throughout, but it is a first-class field on the record
    // rather than something to be read out of a page, so it costs nothing to
    // take and starts working the day they populate it.
    deadline: r.PostingEndDate || undefined,
    description: [r.ShortDescriptionStr, r.ExternalQualificationsStr, r.ExternalResponsibilitiesStr]
      .filter(Boolean)
      .join(' '),
  };
}

async function fetchOracle(f) {
  const seen = await paginateOracle((q, offset, limit) => {
    const finder = `findReqs;siteNumber=${f.site},limit=${limit},offset=${offset},sortBy=POSTING_DATES_DESC,keyword=${q}`;
    const url =
      `https://${f.host}/hcmRestApi/resources/latest/recruitingCEJobRequisitions` +
      `?onlyData=true&expand=requisitionList.secondaryLocations&finder=${encodeURIComponent(finder)}`;
    return getJson(url);
  });
  return [...seen.values()].map((r) => oracleToJob(r, f));
}

const FETCHERS = { greenhouse: fetchGreenhouse, ashby: fetchAshby, lever: fetchLever, workday: fetchWorkday, oracle: fetchOracle };

async function main() {
  const registry = JSON.parse(await readFile(REGISTRY, 'utf8'));
  // A parked firm resolved to a real board that provably holds no early-career
  // roles — an experienced-hire site, usually. Polling it costs five paginated
  // queries and returns nothing, and its silence is indistinguishable from a
  // firm that has not opened applications yet. Skipped and named, with the
  // evidence kept in the registry so it is not rediscovered and re-added.
  const parked = (registry.firms || []).filter((f) => f.parked);
  const firms = (registry.firms || []).filter((f) => !f.parked);
  if (parked.length) {
    console.log(`parked (not polled): ${parked.map((f) => f.firm).join(', ')}`);
  }
  const stamp = new Date().toISOString();
  const all = [];
  let ok = 0;
  let failed = 0;

  // Small concurrency pool so we don't hammer or hang.
  const POOL = 8;
  // Firms whose board answered but produced no early-career role. See below.
  const emptyFirms = [];
  // Firms whose board did not answer at all.
  const failedFirms = [];
  // ---------------------------------------------------------------------
  // Enrichment budgets.
  //
  // Raised with the collated set. Removing the per-firm cap roughly trebles the
  // number of roles, and a budget that stayed at 400 would simply have moved
  // the truncation from the collation into the enrichment — the same silent
  // loss one step later. These are sized for a cold start, where the ledger is
  // empty and every role needs asking.
  //
  // In steady state almost none of this is spent: the ledger answers for roles
  // already dated, and holds a widening backoff for roles whose pages have said
  // nothing. A normal day checks the new postings and little else.
  //
  // The wall-clock stop is the real guard. A cap on requests bounds a healthy
  // run; it does not bound one where every request is timing out, which is
  // exactly when a scheduled job needs to give up and publish what it has.
  // ---------------------------------------------------------------------
  const LD_PASS_CAP = 1200;
  const WD_DETAIL_CAP = 800;
  const ENRICH_POOL = 12;
  const ENRICH_BUDGET_MS = 12 * 60 * 1000;
  const enrichStartedAt = Date.now();
  const outOfTime = () => Date.now() - enrichStartedAt > ENRICH_BUDGET_MS;
  for (let i = 0; i < firms.length; i += POOL) {
    const batch = firms.slice(i, i + POOL);
    const results = await Promise.allSettled(
      batch.map(async (f) => {
        const raw = await FETCHERS[f.ats](f);
        const opps = raw.map((j) => toOpportunity(j, f)).filter(Boolean);
        // Ceiling, not cap: see PER_FIRM_CEILING. Reaching it means a board is
        // answering with something we did not expect, which is worth saying out
        // loud rather than trimming away.
        if (opps.length > PER_FIRM_CEILING) {
          console.warn(`  !! ${f.firm}: ${opps.length} early-career roles, above the ${PER_FIRM_CEILING} ceiling — truncating; check the board and the filters`);
          return { firm: f.firm, opps: opps.slice(0, PER_FIRM_CEILING) };
        }
        return { firm: f.firm, opps };
      })
    );
    for (const r of results) {
      if (r.status === 'fulfilled') {
        ok++;
        all.push(...r.value.opps);
        if (r.value.opps.length) console.log(`  ${r.value.firm}: ${r.value.opps.length}`);
        // A firm that answers healthily and yields nothing was invisible here,
        // and that is the shape of the worst bug this collector has: a board
        // that is real, responds, and holds the wrong population. Bank of
        // America resolved to its 'lateral-us' Workday site — 2,086 live
        // postings, no campus roles — and would have sat in the registry
        // contributing zero, indistinguishable from a bank that has not opened
        // applications yet. Named rather than skipped.
        else emptyFirms.push(r.value.firm);
      } else {
        failed++;
        // Named, not just counted. A board that starts failing every run looks
        // identical to a firm with nothing open unless something says which one
        // it was — the same reason emptyFirms is reported below.
        failedFirms.push({ firm: batch[results.indexOf(r)]?.firm ?? 'unknown', reason: String(r.reason?.message ?? r.reason).slice(0, 80) });
      }
    }
  }
  if (failedFirms.length) {
    console.log(`\n${failedFirms.length} board(s) failed to answer:`);
    for (const f of failedFirms) console.log(`  ${f.firm}: ${f.reason}`);
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
  // Read once and keep the rows: the collapse guard needs the count, and the
  // per-firm delta report at the end needs to know which roles were dated.
  let previousRoles = [];
  try {
    previousRoles = JSON.parse(await readFile(OUT, 'utf8')).opportunities ?? [];
  } catch {
    /* first run — nothing to protect */
  }
  const previousCount = previousRoles.length;
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
  // What we already know.
  //
  // Loaded before any enrichment so the passes below can skip roles whose
  // deadline is already established, and so a role that briefly falls out of a
  // board does not lose its date. See lib/deadline-ledger.mjs for why this is
  // not simply a cache.
  // ---------------------------------------------------------------------
  const today = stamp.slice(0, 10);
  let ledger;
  try {
    ledger = loadLedger(JSON.parse(await readFile(LEDGER, 'utf8')));
  } catch {
    ledger = loadLedger(null);
  }
  let fromLedger = 0;
  for (const o of all) {
    if (o.closingDate) {
      recordHit(ledger, o.id, o.closingDate, o.deadlineSource ?? 'ats-field', today);
      continue;
    }
    const known = ledgerDeadline(ledger, o.id, today);
    if (known) {
      o.closingDate = known.closingDate;
      o.deadlineSource = 'ledger';
      fromLedger++;
    }
  }
  if (fromLedger) console.log(`\ncarried ${fromLedger} deadlines forward from the ledger`);

  // ---------------------------------------------------------------------
  // Workday detail pass.
  //
  // The list endpoint returns a locationsText that is often "3 Locations" and a
  // postedOn of "Posted Yesterday". The per-job detail endpoint returns
  // startDate and endDate as exact ISO dates and a structured location with an
  // ISO country code. endDate is the apply-by date — Workday shows it to
  // candidates as "time left to apply" — which makes it the largest available
  // source of deadlines for banks, who are almost all on Workday and almost all
  // currently undated.
  //
  // Runs before the JSON-LD pass so the cheaper and more reliable source wins,
  // and only for Workday rows, so the JSON-LD budget is left for the rest.
  // ---------------------------------------------------------------------
  // Only rows we still cannot date, and only those the ledger says are worth
  // asking about again. A board that has answered "no deadline" four runs
  // running is not asked a fifth time today.
  const wdRows = all
    .filter((o) => o._workdayDetail && !o.closingDate && needsCheck(ledger, o.id, today, 'workday-detail'))
    .slice(0, WD_DETAIL_CAP);
  let fromWorkday = 0;
  let wdLocations = 0;
  if (wdRows.length) {
    console.log(`\nreading ${wdRows.length} Workday postings for exact dates and locations…`);
    for (let i = 0; i < wdRows.length; i += ENRICH_POOL) {
      if (outOfTime()) {
        console.warn(`  !! enrichment budget spent after ${i}/${wdRows.length} Workday rows; the rest carry over to the next run`);
        break;
      }
      await Promise.allSettled(
        wdRows.slice(i, i + ENRICH_POOL).map(async (o) => {
          const d = o._workdayDetail;
          const url = detailUrl(d.host, d.tenant, d.site, d.externalPath);
          if (!url) return;
          const res = await fetch(url, {
            headers: { 'User-Agent': UA, Accept: 'application/json' },
            signal: AbortSignal.timeout(TIMEOUT_MS),
          });
          if (!res.ok) return;
          const parsed = parseWorkdayDetail(await res.json());
          if (parsed.closingDate && !o.closingDate) {
            o.closingDate = parsed.closingDate;
            o.deadlineSource = 'workday-detail';
            recordHit(ledger, o.id, parsed.closingDate, 'workday-detail', today);
            fromWorkday++;
          } else if (!o.closingDate) {
            recordMiss(ledger, o.id, today, 'workday-detail');
          }
          // An exact date always beats one derived from "Posted 3 Days Ago".
          if (parsed.openingDate) o.openingDate = parsed.openingDate;
          // "3 Locations" is not a location.
          if (parsed.location && (!o.location || /^\d+\s+Locations?$/i.test(o.location))) {
            o.location = parsed.location;
            o.region = inferRegion(parsed.location);
            wdLocations++;
          }
        })
      );
    }
    console.log(`  ${fromWorkday} deadlines, ${wdLocations} locations resolved from Workday detail`);
  }
  for (const o of all) delete o._workdayDetail;

  // ---------------------------------------------------------------------
  // JSON-LD pass, prioritised rather than truncated.
  //
  // The budget exists because this costs one GET per role and the collated set
  // no longer has a per-firm cap holding it down. What changed is *which* roles
  // the budget buys: the queue is ordered so a Bulge Bracket investment banking
  // role is asked before a graduate software engineering one, and roles the
  // ledger has already answered for are not asked at all.
  //
  // The previous version sliced an unordered list at 400. That is the same
  // mistake the per-firm cap made one layer up — a ceiling that discards by
  // arrival order — and it would have started biting silently the moment the
  // cap came off and the undated pool grew.
  // ---------------------------------------------------------------------
  const candidates = all.filter(
    (o) => !o.closingDate && o.applicationUrl && needsCheck(ledger, o.id, today, 'jsonld')
  );
  const undated = orderForEnrichment(candidates).slice(0, LD_PASS_CAP);
  const skippedForBudget = candidates.length - undated.length;
  let fromMarkup = 0;
  if (undated.length) {
    console.log(
      `\nchecking ${undated.length} posting pages for JobPosting validThrough` +
        `${skippedForBudget > 0 ? ` (${skippedForBudget} more queued for a later run)` : ''}…`
    );
    for (let i = 0; i < undated.length; i += ENRICH_POOL) {
      if (outOfTime()) {
        console.warn(`  !! enrichment budget spent after ${i}/${undated.length} posting pages; the rest carry over to the next run`);
        break;
      }
      const batch = undated.slice(i, i + ENRICH_POOL);
      await Promise.allSettled(
        batch.map(async (o) => {
          let date;
          try {
            const res = await fetch(o.applicationUrl, {
              headers: { 'User-Agent': UA },
              signal: AbortSignal.timeout(TIMEOUT_MS),
            });
            if (!res.ok) return; // a failed fetch is not evidence of no deadline
            const html = await res.text();
            const found = extractJsonLdDeadline(html);
            // Prose is the fallback when a page carries no markup.
            date = found.closingDate || extractDeadline(html).closingDate;
          } catch {
            return; // ditto: do not record a miss for a network failure
          }
          if (date) {
            o.closingDate = date;
            o.deadlineSource = 'jsonld';
            recordHit(ledger, o.id, date, 'jsonld', today);
            fromMarkup++;
          } else {
            // The page answered and carried no date. That is a real answer, and
            // recording it is what stops us asking again tomorrow. Scoped to
            // this source: the Workday detail endpoint may still know better.
            recordMiss(ledger, o.id, today, 'jsonld');
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
  const beforeManual = new Map(all.map((o) => [o.id, o.closingDate]));
  const overridden = applyManualDeadlines(all, manual, today);
  for (const o of all) {
    if (o.closingDate && o.closingDate !== beforeManual.get(o.id)) {
      o.deadlineSource = 'manual';
      recordHit(ledger, o.id, o.closingDate, 'manual', today);
    }
  }

  // Roles that reached the tracker without a recognised vertical. This number is
  // the price of no longer discarding them, and it is reported so it can be
  // driven down: a title that keeps landing here is a rule inferVertical is
  // missing, not a role worth losing. Sample titles included so the next rule
  // can be written without re-running the collection.
  const other = all.filter((o) => o.vertical === 'Other');
  if (other.length) {
    const share = ((other.length / all.length) * 100).toFixed(1);
    console.log(`\nunclassified: ${other.length}/${all.length} roles (${share}%) fell back to 'Other'`);
    for (const o of other.slice(0, 12)) console.log(`  ${o.firm} — ${o.role.slice(0, 70)}`);
    if (other.length > 12) console.log(`  …and ${other.length - 12} more`);
  }

  const withDates = all.filter((o) => o.closingDate).length;
  const rolling = all.filter((o) => o.tags?.includes('Rolling')).length;
  const bySource = {};
  for (const o of all) if (o.closingDate) bySource[o.deadlineSource ?? 'unknown'] = (bySource[o.deadlineSource ?? 'unknown'] ?? 0) + 1;
  console.log(
    `\ndeadlines: ${withDates}/${all.length} dated ` +
      `(${fromWorkday} new from Workday detail, ${fromMarkup} new from JobPosting markup, ` +
      `${fromLedger} carried forward, ${overridden} from data/deadlines.manual.json), ` +
      `${rolling} marked rolling`
  );
  console.log(`  by source: ${Object.entries(bySource).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(' ') || 'none'}`);

  // ---------------------------------------------------------------------
  // Run-over-run delta, per firm.
  //
  // This exists because the failure it catches is invisible in a total. When
  // Citi's five deadlines were lost, Barclays gained ten in the same run and
  // the site-wide figure moved from 22 to 22 — a swap that read as "nothing
  // happened" for two days. A firm losing dated roles is now named.
  // ---------------------------------------------------------------------
  const datedNow = {};
  for (const o of all) if (o.closingDate) datedNow[o.firm] = (datedNow[o.firm] ?? 0) + 1;
  const datedBefore = {};
  for (const o of previousRoles) if (o.closingDate) datedBefore[o.firm] = (datedBefore[o.firm] ?? 0) + 1;
  const moved = [...new Set([...Object.keys(datedNow), ...Object.keys(datedBefore)])]
    .map((f) => ({ firm: f, delta: (datedNow[f] ?? 0) - (datedBefore[f] ?? 0), now: datedNow[f] ?? 0, was: datedBefore[f] ?? 0 }))
    .filter((x) => x.delta !== 0)
    .sort((a, b) => a.delta - b.delta);
  if (previousRoles.length && moved.length) {
    console.log('\ndated-role changes since the last run:');
    for (const m of moved) console.log(`  ${m.delta > 0 ? '+' : ''}${m.delta}  ${m.firm} (${m.was} -> ${m.now})`);
    const lost = moved.filter((m) => m.delta < 0);
    if (lost.length) {
      console.log(
        `::warning::${lost.length} firm(s) lost dated roles: ${lost.map((m) => `${m.firm} ${m.was}->${m.now}`).join(', ')}`
      );
    }
  }

  // Forget expired dates and roles long gone, then persist.
  pruneLedger(ledger, new Set(all.map((o) => o.id)), today);
  await writeFile(LEDGER, JSON.stringify(serialiseLedger(ledger, today), null, 2) + '\n');
  console.log(
    `\nledger: ${Object.keys(ledger.entries).length} remembered deadlines, ` +
      `${Object.keys(ledger.misses).length} roles known to carry none -> ${LEDGER}`
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
  if (emptyFirms.length) {
    // Not an error: plenty of firms genuinely have nothing open off-season. It
    // is a list to read, because a firm that is empty every single run is
    // usually pointed at the wrong board rather than out of season.
    console.log(`\n${emptyFirms.length} board(s) answered with no early-career role: ${emptyFirms.join(', ')}`);
  }
}

// Only sync when executed directly. The classifiers above are exported so the
// tests can import them, and importing this file must not kick off a live
// collection against every board in the registry.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
