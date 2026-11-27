#!/usr/bin/env node
/**
 * ATS collation cron — the comprehensive-freshness engine.
 *
 * Reads lib/sources/ats-registry.json, pulls each firm's public ATS board
 * (Greenhouse / Ashby / Lever — no login/key/browser), filters to early-career
 * roles in our covered verticals, normalizes into the Opportunity shape, and
 * writes data/opportunities.auto.json.
 *
 * Boards read in full at a finance or trading firm also yield experienced and
 * lateral rows (lib/seniority.mjs, toExperiencedOpportunity below), from the
 * postings the early-career filter refused and never instead of one.
 *
 * The app reads that pre-generated file (fast, no request-time fan-out), so this
 * scales to hundreds of firms. Runs daily in CI (.github/workflows/tracker-sync.yml);
 * the commit triggers a redeploy that ships the fresh data.
 *
 * Run locally: npm run sync:ats
 */

import { readFile, writeFile, mkdir, rename, readdir, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import {
  extractDeadline,
  applyManualDeadlines,
  extractJsonLdDeadline,
} from '../lib/deadline-extract.mjs';
import { detailUrl, parseWorkdayDetail } from '../lib/workday-detail.mjs';
import { isTalnetGate, parseTalnetBoard, parseTalnetDeadline, talnetBoardUrl } from '../lib/talnet.mjs';
import { brandForTitle } from '../lib/title-brands.mjs';
import { parseRolandBergerJobs, ROLAND_BERGER_JOBS_URL } from '../lib/rolandberger.mjs';
import { descriptionFiles, permissionFor } from '../lib/description-permissions.mjs';
import { avatureSearchUrl, parseAvatureSearch, isAvatureEmptyShell, AVATURE_PAGE } from '../lib/avature.mjs';
import { successFactorsSearchUrl, parseSuccessFactorsSearch, isSuccessFactorsEmptyShell, SUCCESSFACTORS_PAGE } from '../lib/successfactors.mjs';
import { eightfoldToJob, eightfoldUrl, paginateEightfold } from '../lib/eightfold.mjs';
import { parseJaneStreetFeed } from '../lib/janestreet.mjs';
import { RETENTION_DAYS, retainRoles } from '../lib/role-retention.mjs';
import { normaliseRoleText } from '../lib/text-normalise.mjs';
import { serialiseRegistry, updateRegistry } from '../lib/slug-registry.mjs';
import { isNonRoleTitle, screenRoles } from '../lib/role-screen.mjs';
import { collapseRepeats, duplicateGroups } from '../lib/role-duplicates.mjs';
import {
  SENIORITY_BUCKETS,
  classifySeniority,
  experiencedProgrammeType,
  experiencedVertical,
  firmTypeForTier,
  juniorSeatAtTradingFirm,
  namesNonTargetFunction,
} from '../lib/seniority.mjs';
import { COMPLETE_TIMEOUT_MS, walkCompleteBoard, withRetry } from '../lib/complete-board.mjs';
import {
  boardRecord,
  buildCheckFile,
  checkFilePath,
  checkVerdict,
  publishedView,
  everyRequestFailed,
  firmsToCarry,
  methodFingerprint,
  resolveMethod,
  newRequestStats,
  worstStatus,
} from '../lib/board-checks.mjs';
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
import { paginateSmartRecruiters, smartRecruitersToJob, smartRecruitersUrl } from '../lib/smartrecruiters.mjs';
import { recruiteeToJobs, recruiteeUrl } from '../lib/recruitee.mjs';
import { pinpointToJobs, pinpointUrl } from '../lib/pinpoint.mjs';
import { workableToJobs, workableUrl } from '../lib/workable.mjs';
import { employerListings } from '../lib/employer-listings.mjs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY = join(ROOT, 'lib/sources/ats-registry.json');
const OUT = join(ROOT, 'data/opportunities.auto.json');
const DESCRIPTIONS_DIR = join(ROOT, 'data/job-descriptions');
const DESCRIPTION_PERMISSIONS = JSON.parse(readFileSync(join(ROOT, 'lib/sources/description-permissions.json'), 'utf8')).permissions ?? [];
const capturedDescriptions = [];
const UA = 'Mozilla/5.0 (compatible; L3vlupTracker/1.0; +https://l3vlup.com)';
// tal.net's front end is rendered for browsers and returns an interstitial to
// anything it does not recognise. Used only for that family.
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const LEDGER = join(ROOT, 'data/deadlines.learned.json');
const SLUGS = join(ROOT, 'data/tracker-slugs.json');
const ARCHIVE = join(ROOT, 'data/tracker-archive.json');
const EMPLOYER_LISTINGS = join(ROOT, 'data/opportunities.employer.json');
const TAXONOMY = join(ROOT, 'data/taxonomy.json');
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

/**
 * Experienced and lateral rows, per firm.
 *
 * This one is a cap, and deliberately lower than the early-career ceiling,
 * because the population it reads is different. A finance firm's board is
 * mostly experienced postings, and the first phase of this work
 * (docs/experienced-roles-plan-2026-10.md) is to show the seats a candidate
 * on this site would move into, not to mirror a fund's whole hiring. Sixty is
 * above every banking and private-markets count the sweep found on the boards
 * read today (Lincoln and William Blair carry about twenty-five each), so in
 * practice it bites only on the trading firms whose engineering is as large
 * as their desk. What it keeps is decided by seat, not by arrival order (see
 * capExperienced), so the cap drops engineers before it drops a single
 * associate.
 */
export const EXPERIENCED_PER_FIRM_CEILING = 60;

/**
 * The exception: a universal bank, read in full.
 *
 * On 12 October 2026 JPMorgan's board gave 304 experienced rows after
 * repeats, and the 60-row cap above kept 60 associates and nothing else:
 * every experienced analyst (26 in investment banking alone) and every VP was
 * dropped, because associates come first in SENIORITY_BUCKETS and there were
 * more than sixty of them. That ordering is right at a trading firm, where the
 * overflow is engineering; at a bank it turns the board into one level.
 *
 * So a bank gets a larger allowance, and it is spent across the seats rather
 * than down them: one row from each seniority-and-area pair in turn (see
 * capExperienced), so analysts, associates and VPs in each area survive where
 * the bank has them, and no single area or level can fill the allowance by
 * sorting first. It stays a cap: one bank's whole hiring would otherwise be
 * most of the experienced board.
 */
export const LARGE_BANK_TIERS = new Set(['Bulge Bracket']);
export const LARGE_BANK_EXPERIENCED_CEILING = 150;

/** How many experienced rows a firm may publish, and how they are chosen. */
export function experiencedAllowance(firm) {
  return LARGE_BANK_TIERS.has(firm?.tier)
    ? { ceiling: LARGE_BANK_EXPERIENCED_CEILING, stratified: true }
    : { ceiling: EXPERIENCED_PER_FIRM_CEILING, stratified: false };
}
/* ----------------------------- classification ---------------------------- */
// Word-boundaried so "Internal"/"International" do NOT match "intern".
const EARLY_CAREER =
  /\b(intern|interns|internship|internships|new[\s-]?grad|newgrad|undergraduate|graduate|graduates|university\s+(grad|graduate|hire)|campus|apprentice|apprenticeship|early[\s-]?careers?|entry[\s-]?level|(?:industrial|summer|year[\s-]?long|12[\s-]?month)\s+placements?|placements?\s+(?:year|scheme|program(?:me)?|student)|co-?op|student|students|rotational|residency|apm|rpm|step|summer\s+analyst|summer\s+associate|analyst\s+program(?:me)?|off[\s-]?cycle|spring\s+(weeks?|insights?))\b/i;
const SENIOR = /\b(senior|staff|principal|director|distinguished|vp|head\s+of|lead)\b/i;

/**
 * 'manager' is a seniority signal, and it is the one that needed an exception.
 *
 * Two experienced hires reached the consulting inventory through this gap: an
 * FTI "Workday Student Financials - Consulting Manager" and an Accenture
 * "Associate Engagement Manager". Neither is an early-career seat. The first is
 * the more instructive: it matched EARLY_CAREER on the word "Student", which is
 * not a level here at all but part of the product name *Workday Student
 * Financials*.
 *
 * Adding 'manager' to SENIOR outright would throw away real graduate seats,
 * because "Associate Product Manager" is a graduate title at every technology
 * company that runs an APM scheme. So the exception is not a list of job titles
 * but a question about evidence: does the title ALSO carry an unambiguous
 * early-career token?
 *
 * "Student" and "graduate" alone are not enough, because both appear in product
 * names and in phrases like "graduate of". "Intern", "campus", "early career"
 * and "summer analyst" are, because nothing else in a job title uses those
 * words.
 *
 * WHAT THE ADVERSARIAL PASS CHANGED. Run across the 1,318 live rows, 18 carry
 * the word manager and the old filter accepted all 18. Almost every one is a
 * real graduate seat: five Associate Product Manager rows at Visa, Databricks
 * and Roblox, three "Area Manager - New Grad" at Flexport, two Account Manager
 * internships. A bare substring exclusion would have thrown away all of them,
 * which is why the exception is the rule rather than a footnote to it.
 *
 * Two tokens moved as a result. "early career" was added, because Notion's
 * "Experience Program Manager - EMEA & APAC, Early Career" says so in the
 * title and was being dropped. Bare "APM" and "RPM" were removed, because
 * Datadog's "Manager I, Engineering - APM Serverless" is Application
 * Performance Monitoring rather than a graduate scheme, and it is a genuine
 * manager the old filter wrongly accepted. "Associate Product Manager" stays
 * spelled out, which keeps every real APM row.
 *
 * Net effect on live data: 1 row of 1,318 changes, and it changes from wrong
 * to right. A positional rule was tried as the alternative, marking manager
 * senior only as the head noun of a title segment. It agreed with this one on
 * all 26 observed cases and was worse on the Datadog row, so it was not kept.
 */
const MANAGER = /\bmanagers?\b/i;
const STRONG_EARLY_CAREER =
  /\b(intern|interns|internship|internships|campus|apprentice|apprenticeship|new[\s-]?grad|newgrad|co-?op|early[\s-]?careers?|entry[\s-]?level|associate\s+product\s+manager|summer\s+(analyst|associate)|graduate\s+(program(?:me)?|scheme|analyst|trainee)|(?:industrial|summer|year[\s-]?long|12[\s-]?month)\s+placements?)\b/i;

/**
 * Early-career titles the tokens above missed (A0, 12 October 2026).
 *
 * Read across the sixteen boards whose experienced postings are collected,
 * the early-career rule was refusing real campus seats for three reasons.
 *
 * SPELLING. `programme?` matches "programm" or "programme" and never the US
 * "program", so "2027 Commercial Real Estate Full-Time Analyst Program" and
 * every JPMorgan analyst programme like it were dropped; "Spring Insights" and
 * "Early Careers" failed on the plural. Those tokens now take both spellings.
 *
 * STATED LEVELS. "Entry-Level" says what it is, as "intern" does.
 *
 * NARROW SHAPES, each needing two signals rather than one, so no single
 * common word is promoted on its own:
 *   - "Junior" in front of a quant or trading seat ("Junior Quant
 *     Researcher", "Junior Execution Trader"). Junior alone is not enough:
 *     "Junior Executive Assistant" and "Junior Desktop Support Analyst" are
 *     not the seats this tracker is for.
 *   - A class year beside a campus word: "2026 Grad", "2027 Trading Analyst",
 *     "Software Engineering - Summer 2027", "2027 Software Engineer Program".
 *     A year alone is not enough: "Connect with us at ICLR 2026!", "Fall 2026
 *     Event" and "2027 Full-Time Associate (Experience Required)" all carry
 *     one.
 *
 * Every one of them yields to the seniority words above, and to a title that
 * says it is for experienced people ("Investment Analyst Program for
 * Experienced Professionals"), which the spelling fix would otherwise have
 * started admitting. Fixtures, positive and negative, are in
 * scripts/__tests__/early-career-recovery.test.mjs.
 */
/**
 * Insight programmes that do not say "spring" (B2, 17 November 2026).
 *
 * EARLY_CAREER knew "spring insight" and nothing else of the kind, so GSA
 * Capital's "General Trading & Technology Insight Programme - 2027" and AQR's
 * "MBA Discovery - Early Engagement Program" were refused before
 * inferProgrammeAndLevel, which already types them as Insight Program, could
 * see them (docs/tracker-expansion-2026-10.md, proposal 1). The proposal said
 * "insight"; a bare "insight" would also admit "Customer Insights Analyst" and
 * "Market Insights Associate", so the word must be followed, within three
 * words, by the kind of thing a programme is. "Discovery" likewise needs a day,
 * week or programme, and "taster" a day or week.
 */
const INSIGHT_PROGRAMME =
  /\b(?:insights?|discovery)\b(?:\s+[\w&+/-]+){0,3}?\s+(?:days?|weeks?|series|program(?:me)?s?)\b|\btaster\s+(?:days?|weeks?)\b/i;
const FOR_EXPERIENCED = /\b(experienced\s+(?:professionals?|hires?)|experience\s+required|lateral)\b/i;
const JUNIOR_FRONT_OFFICE = /\bjunior\s+(?:[a-z&+/-]+\s+){0,2}?(?:quant\w*|traders?|trading)\b/i;
const CLASS_YEAR = /\b20[2-3]\d\b/;
const CLASS_YEAR_CAMPUS =
  /\b(grads?|analysts?|summer|(?:engineer(?:ing)?|trainee(?:ship)?|development)\s+program(?:me)?)\b/i;

export function isEarlyCareer(title) {
  return earlyCareerAdmission(title) !== null;
}

/**
 * Why a title is early career: 'campus' for a campus word or shape, or
 * 'stated-level' when the only evidence is a stated level ("Entry-Level",
 * "Early Careers") that says nothing about the work. Null when it is not.
 *
 * The distinction matters downstream (toOpportunity): a stated level on its
 * own admits "Collections, Fraud & Accounts Entry-Level Specialist" and
 * "Early Careers Manufacturing Technician" as readily as an entry-level
 * engineer, so those rows must also name work this tracker is for.
 */
const STATED_LEVEL_ONLY = /\b(entry[\s-]?level|early[\s-]?careers)\b/gi;
export function earlyCareerAdmission(title) {
  if (SENIOR.test(title)) return null;
  if (FOR_EXPERIENCED.test(title)) return null;
  if (MANAGER.test(title) && !STRONG_EARLY_CAREER.test(title)) return null;
  const campus = (t) =>
    EARLY_CAREER.test(t) || INSIGHT_PROGRAMME.test(t) || JUNIOR_FRONT_OFFICE.test(t) ||
    (CLASS_YEAR.test(t) && CLASS_YEAR_CAMPUS.test(t));
  if (!campus(title)) return null;
  return campus(title.replace(STATED_LEVEL_ONLY, ' ')) ? 'campus' : 'stated-level';
}

/* ------------------------- consulting classification ---------------------- */

/**
 * Consulting needed more than a title, and this is the only rule in the file
 * that reads the employer.
 *
 * WHY. A step 3 sweep of the five collected consulting boards returned 128
 * early-career rows, of which 47 were consulting. Accenture alone contributed
 * 103 and kept 25: its board carries a global delivery organisation, so Java
 * developers in Lodz, Korean-speaking customer service in Bangkok and a student
 * receptionist in Budapest all sit beside the consulting practice. A title-only
 * rule cannot tell those apart, because "Analyst" at Accenture means whichever
 * of the two the reader already had in mind.
 *
 * So the employer decides how much a weak title is worth. At a consulting firm,
 * "Business Analyst" is the consulting entry seat and counts. At a bank it is
 * not, and does not.
 *
 * WHAT IT DELIBERATELY WILL NOT DO. It never rescues a role from the exclusions
 * below, and it never fires on an employer it does not recognise unless the
 * title says "consulting" or "consultant" outright. An ambiguous row is left to
 * fall through to 'Other', which is visible in the sweep report, rather than
 * being promoted to make a count look better.
 */

/**
 * Employers whose primary business is consulting.
 *
 * Matched on a normalised substring, so "Accenture Song" and "Accenture" are
 * the same firm. Kept here rather than read from the registry because a role
 * can arrive from a curated row or a non-ATS source that never touches it, and
 * a classifier that behaved differently depending on where a row came from
 * would be impossible to reason about.
 */
const CONSULTING_FIRMS = [
  'mckinsey', 'boston consulting', 'bain & company', 'bain and company',
  'accenture', 'deloitte', 'pwc', 'pricewaterhousecoopers', 'kpmg', 'ernst & young',
  'strategy&', 'monitor deloitte', 'ey-parthenon', 'parthenon',
  'oliver wyman', 'kearney', 'roland berger', 'l.e.k', 'lek consulting',
  'occ strategy', 'oc&c', 'arthur d. little', 'simon-kucher', 'zs associates',
  'alixpartners', 'alvarez & marsal', 'huron', 'guidehouse', 'teneo',
  'analysis group', 'cornerstone research', 'charles river associates',
  'brattle', 'frontier economics', 'compass lexecon', 'keystone strategy',
  'trinity life sciences', 'putnam associates', 'health advances', 'clearview healthcare',
  'bridgespan', 'dalberg', 'pa consulting', 'newton europe', 'capgemini invent',
  'west monroe', 'slalom', 'thoughtworks', 'publicis sapient', 'infosys consulting',
  'fti consulting', 'berkeley research group', 'exponent',
  // Added with the boards that brought them (docs in l3vlup:
  // docs/tracker-coverage-consulting-vc-2026-11.md). NERA is named in full
  // because a bare "nera" is a substring of "general".
  'nera economic consulting', 'brattle group', 'pa consulting',
];

/**
 * Strategy and economic consultancies that sell nothing but consulting.
 *
 * At these firms a title that names only a programme ("NERA Summer Internship
 * 2027 - London", "Intern | Competition Practice | Paris") can only be a
 * consulting seat, because there is no delivery centre or back office large
 * enough to post a campus programme of its own. Accenture and the Big Four are
 * deliberately absent: their bare "Spring Internship" could be anything, and
 * the step 3 sweep showed most of it was not consulting.
 */
const STRATEGY_BOUTIQUES = [
  'mckinsey', 'boston consulting', 'bain & company', 'bain and company', 'oliver wyman', 'kearney',
  'roland berger', 'l.e.k', 'lek consulting', 'oc&c', 'occ strategy', 'simon-kucher', 'arthur d. little',
  'nera economic consulting', 'brattle group', 'compass lexecon', 'cornerstone research', 'analysis group',
  'charles river associates', 'keystone strategy', 'frontier economics',
];
const isStrategyBoutique = (firm) => {
  const f = String(firm || '').toLowerCase();
  return f ? STRATEGY_BOUTIQUES.some((c) => f.includes(c)) : false;
};
const PROGRAMME_ONLY = /\b(intern|internship|summer|graduate|analyst|consultant|praktikum|praktikant)\b/i;

const isConsultingFirm = (firm) => {
  const f = String(firm || '').toLowerCase();
  return f ? CONSULTING_FIRMS.some((c) => f.includes(c)) : false;
};

/**
 * Work that is not consulting even when the employer is a consulting firm.
 *
 * Checked first and never overridden. These are the four families the step 3
 * review found inside Accenture's board, in the order of how many rows each
 * accounted for.
 */
const NOT_CONSULTING_WORK =
  /\b(algorithmic trading|execution consult\w*|electronic trading|sales consultant|developer|engineer|engineering|administrator|devops|cloudops|mlops|sre\b|test automation|tester|qa\b|abap|salesforce|java|angular|python|node\.?js|\.net|linux|windows|backend|back-end|frontend|front-end|full[\s-]?stack|firmware|receptionist|workplace support|business support|facilities|procure[\s-]to[\s-]pay|processor|payroll|customer service|customer support|service desk|help ?desk|trust (and|&) safety|insurance operations|claims|collections|content moderation|graphic design|industrial design|ux\b|ui\b|marketing|seo\b|copywrit|part[\s-]?time for students|executive assistant|case team assistant|team assistant|office assistant|administrative assistant|internal services|internal strategy)\b/i;

/**
 * A Big Four firm's audit, tax and accounting service lines. Not consulting,
 * but read only before the employer-gated rules below: a title that says
 * "consulting" outright keeps its reading ("Accounting/Business/Finance
 * Consulting Analyst" at Charles River Associates is a consulting seat), while
 * an "Audit Associate" at PwC can no longer become one on the word associate.
 */
const BIG_FOUR = /\b(deloitte|pwc|pricewaterhousecoopers|kpmg|ernst & young|\bey\b)/i;
const SERVICE_LINE = /\b(audit|assurance|tax|accounting|bookkeeping)\b|steuer|wirtschaftspr[uü]f|fiscal|fiscalit/i;

/**
 * Finance work that keeps its existing vertical even at a consulting firm.
 *
 * FTI Consulting is the case this exists for. Its Corporate Finance segment
 * runs restructuring and transaction work that belongs beside a bank's, not
 * beside a strategy practice, and a candidate searching for restructuring
 * should find it under investment banking where the rest of it is. Its Forensic
 * and Economic segments are consulting and are not caught here.
 */
const FINANCE_OVERRIDE =
  /\b(restructuring|turnaround|corporate finance|debt advisory|capital markets|\bm&a\b|mergers|valuation|transaction services|due diligence advisory)\b/i;

/** A title that says consulting outright, wherever it is posted. */
const EXPLICIT_CONSULTING =
  /\b(consultant|consulting|management consult|strategy (and|&) consulting|economic consulting|litigation consulting|advisory (analyst|associate|consultant)|case team)\b/i;

/**
 * Titles that mean consulting AT a consulting firm and something else anywhere
 * else. "Strategy Analyst" at a bank is an internal planning seat; at Bain it
 * is the job. The employer gate is what separates them.
 */
const CONSULTING_AT_CONSULTING_FIRM =
  /\b(business analyst|strategy|transformation|commercial strategy|insights|advisory|\bvap\b|value,? access|market access|operations improvement|performance improvement|public sector|life sciences|economic analysis|associate consultant|econom(?:ist|ics)|research analyst|research associate|summer associate|summer consultant|generalist|associate)\b/i;
// The last six are the entry seats of the economic and strategy boutiques the
// November boards brought in, all read off live titles on 25 November 2026:
// Brattle and Cornerstone hire "Research Analysts", BRG and NERA hire into
// "Competition Economics" and as "Summer Economists", L.E.K. names its seat
// "Associate" ("Munich Office - Associate (Entry level position)"), and Huron
// and Keystone run MBA "Summer Associate" programmes. A bare "associate" is
// safe only because the exclusions above run first: audit, tax and accounting
// associates at a Big Four firm, and every technology and support seat, are
// refused before this list is read.

/**
 * Financial-crime work, which is a bank's own compliance function and a
 * consultancy's practice area, and has to be told apart by employer.
 *
 * CIBC posts "Consultant AML- (Winter 2027 Co-Op)". The word consultant there
 * is an internal grade, not a line of business, and the co-op sits in the
 * bank's anti-money-laundering team. Guidehouse and FTI genuinely sell
 * financial-crime compliance consulting, so this cannot be an outright
 * exclusion: it withdraws only the employer-independent token, leaving the
 * employer gate to answer for the firms that do sell it.
 */
const FINANCIAL_CRIME =
  /\b(a\.?m\.?l\.?|k\.?y\.?c\.?|anti[\s-]?money[\s-]?laundering|know your customer|financial crime|sanctions screening|suspicious activity)\b/i;

/**
 * 'Consulting', or null to let the ordinary chain decide.
 *
 * Order is the design, as everywhere else in this file. Exclusions first so
 * they cannot be overridden, finance second so FTI's restructuring keeps its
 * home, explicit titles third because they need no employer, and the employer
 * gate last because it is the only rule that can be wrong about a firm.
 *
 * Financial crime sits between the third and the fourth rather than with the
 * exclusions, because it is the one subject where the same words describe a
 * bank's own compliance seat and a consultancy's practice. Withdrawing the
 * employer-independent token and keeping the employer gate is what lets
 * Guidehouse sell it and CIBC not.
 */
export function consultingVerdict(title, ctx = {}) {
  const t = `${String(title || '')} ${String(ctx.department || '')}`.toLowerCase();
  if (!t.trim()) return null;

  if (NOT_CONSULTING_WORK.test(t)) return null;
  if (FINANCE_OVERRIDE.test(t)) return null;
  // At a Big Four firm "Tax Consultant" and "Audit Consultant" are grades in a
  // service line, not management consulting: the explicit word does not win
  // there, as it does at Charles River Associates (Deloitte US, 27 November).
  if (SERVICE_LINE.test(t) && BIG_FOUR.test(String(ctx.firm || ''))) return null;
  if (EXPLICIT_CONSULTING.test(t) && !FINANCIAL_CRIME.test(t)) return 'Consulting';
  // The weak readings below never apply to an audit, tax or accounting seat.
  const serviceLine = SERVICE_LINE.test(t);
  if (isConsultingFirm(ctx.firm) && (EXPLICIT_CONSULTING.test(t) || (!serviceLine && CONSULTING_AT_CONSULTING_FIRM.test(t)))) return 'Consulting';
  if (isStrategyBoutique(ctx.firm) && !serviceLine && PROGRAMME_ONLY.test(t)) return 'Consulting';
  return null;
}

// Every role that clears the early-career filter gets a vertical. The order of
// these rules is the whole design: each is reachable only because the ones
// above it are narrower, so the specific reading of an overloaded word wins.
// "Quantitative Risk Management" is Quant, plain "Credit Risk" is Risk;
// "Technology Investment Banking" is banking, plain "Technology Analyst" is
// engineering.
/**
 * The signals that make a role an AI role rather than a data or software one.
 * Defined once because two rules below read it and a drift between them would
 * put research and engineering roles in different buckets on the same evidence.
 */
const AI_TOKEN =
  /machine learning|deep learning|reinforcement learning|\bml\b|\bai\b|\bai\/ml\b|\bllm\b|\bnlp\b|gen(erative )?ai|computer vision|applied research/;

/**
 * Hedge Fund is a seat at a fund, or a fund-facing investing seat, and not
 * every title that carries the words.
 *
 * The live board put four kinds of row in the vertical that are not that: a
 * bank's "Hedge Fund Services - Financial Reporting" (the administrator's
 * back office), "Credit Risk Hedge Funds" (a risk seat whose clients are
 * funds), "Portfolio Management & Governance, Corporate Technology" (a
 * technology programme) and a lender's "Underwriting & Portfolio Management"
 * (a credit book). Two rules, both small on purpose.
 *
 * 1. A deny list of service-provider phrasing. These phrases describe the
 *    work of serving or controlling a fund, never of investing for one, so
 *    they win over the hedge fund tokens. "Operations" is the one word that
 *    is a service-provider seat at a bank and an ordinary seat at a fund
 *    ("Operations Analyst" at Point72 is a hedge fund role), so it is denied
 *    unless the employer is a named fund.
 * 2. "Portfolio management" on its own is a fund seat only away from a bank,
 *    lender or insurer. There it means the credit or loan book, and the rest
 *    of the chain reads the title (Risk, Wealth Management, or Other, which
 *    the sweep report shows) instead of guessing it into a fund. The explicit
 *    tokens (hedge fund, long/short, multi-strategy) are not affected by it.
 *
 * Both lists are matched on the employer's name like CONSULTING_FIRMS, and for
 * the same reason: a row can arrive from a source that never touches the
 * registry. A firm in neither list behaves exactly as before.
 */
const SERVICE_PROVIDER_TITLE =
  /fund services|fund administration|financial reporting|credit risk|\brisk\b.{0,40}hedge funds?|hedge funds?.{0,40}\brisk\b|\bgovernance\b|corporate technology/;
const HEDGE_FUND_TOKEN = /hedge fund|long[\s\/-]?short|multi[\s-]?strategy/;

const HEDGE_FUND_FIRMS = [
  'point72', 'millennium', 'citadel', 'bridgewater', 'schonfeld', 'exodus', 'verition',
  'marshall wace', 'man group', 'aqr', 'd. e. shaw', 'de shaw', 'two sigma', 'balyasny',
  'elliott', 'brevan howard', 'third point', 'pershing square', 'squarepoint', 'qube research',
  'viking global', 'tudor', 'walleye', 'sculptor', 'davidson kempner', 'coatue', 'lone pine',
  'tiger global', 'citadel', 'balyasny', 'eisler', 'hudson bay', 'capula', 'exoduspoint',
];

// Banks, lenders and insurers: the employers where "portfolio management" is a
// book of loans or policies. Names are matched whole, so "ing" is ING and not
// Wellington.
const BANK_LENDER_INSURER_FIRMS = [
  'jpmorgan', 'j.p. morgan', 'jp morgan', 'citi', 'citigroup', 'bank of america', 'wells fargo',
  'goldman sachs', 'morgan stanley', 'barclays', 'hsbc', 'ubs', 'deutsche bank', 'societe generale',
  'bnp paribas', 'rbc', 'td bank', 'bmo', 'cibc', 'scotiabank', 'ing', 'santander', 'lloyds',
  'natwest', 'mufg', 'mizuho', 'nomura', 'bny', 'state street', 'northern trust', 'u.s. bank',
  'pnc', 'truist', 'capital one', 'citizens', 'american express', 'synchrony', 'sofi', 'lendable',
  'zopa', 'oaknorth', 'nubank', 'affirm', 'aig', 'the hartford', 'nationwide', 'prudential',
  'aviva', 'manulife', 'sun life', 'allstate', 'chubb', 'travelers', 'cna financial', 'unum',
  'transamerica', 'corebridge', 'jackson financial', 'pacific life', 'guardian life',
  'globe life', 'assurant', 'usaa', 'nn group', 'northwestern mutual',
];

const escapeRe = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const firmMatcher = (names) => {
  const re = new RegExp(`(?:^|[^a-z0-9])(?:${names.map(escapeRe).join('|')})(?![a-z0-9])`);
  return (firm) => {
    const f = String(firm || '').toLowerCase();
    return f ? re.test(f) : false;
  };
};
const isHedgeFundFirm = firmMatcher(HEDGE_FUND_FIRMS);
const isBankLenderInsurer = firmMatcher(BANK_LENDER_INSURER_FIRMS);

/**
 * The investing seat at a fund, named the way funds name it rather than with
 * the words "hedge fund" or "private equity".
 *
 * WHY. Hedge funds, private equity and venture are the three thinnest verticals
 * on the tracker (3, 6 and 5 rows on the September copy), and a large part of
 * the reason is not missing boards but titles: Point72 posts "Sector Analyst,
 * Proprietary Research" and "Point72 Academy Investment Analyst", Blackstone
 * posts "Blackstone Credit & Insurance Summer Analyst", Viking posts "Public
 * Equity Investment Intern". None carries a token the title rules read, so all
 * of them fell to Other. Read beside the employer they are unambiguous.
 *
 * Employer-gated, like Consulting, because the same words at a bank or an
 * insurer describe a different job: "Investment Analyst" at an insurer is a
 * treasury seat. A firm qualifies by the registry tier it was added under, or
 * by name for rows that arrive without one.
 */
const FUND_SEAT =
  /sector (analyst|specialist)|fundamental (research|researcher|analyst|equit)|investment (analyst|associate|intern|internship|team|professional|program|programme)|investing|\binvestor\b|academy|public equit|long[\s-]?only|equity analyst|macro (analyst|research)|\beconomist\b|portfolio (analyst|manager)|deal team/;
// Asset classes that name an investing seat only at a private fund. At a hedge
// fund "infrastructure" is a technology team (Squarepoint's "Trading
// Infrastructure Specialist") and "credit" is as likely a risk seat.
const PRIVATE_FUND_SEAT = /secondar(y|ies)|strategic partners|private markets|infrastructure|\bcredit\b/;
const NOT_FUND_SEAT =
  // Impact and ESG research ("Y Analytics, Responsible Investing, Summer
  // Research Assistant" at TPG) is not a deal seat; it stays in Other rather
  // than being read as private equity on the word "investing".
  /research assistant|\bimpact\b|responsible invest|\besg\b|sustainab|\brisk\b|compliance|operations|investment services|fund (accounting|administration|services)|valuation control|treasury|tax|legal|technology|engineer|developer|data (scien|engineer)|marketing|communications|recruit|talent|human resources|\bhr\b|executive assistant|administrative|investor relations|client (service|relations)/;

const HEDGE_FUND_TIERS = new Set(['Multi-Manager', 'Single-Manager']);
const PRIVATE_FUND_TIERS = new Set(['Megafund', 'Mid-Market']);

/**
 * Venture firms, for the same reason. A venture fund's entry seats are "Investment
 * Analyst", "Platform Associate" and "Scout", and only the employer says they are
 * venture. 'accel' and 'index ventures' are matched whole, so Accelerate and an
 * index provider are not caught.
 */
const VENTURE_FIRMS = [
  'andreessen horowitz', 'a16z', 'sequoia capital', 'index ventures', 'accel', 'balderton',
  'atomico', 'general catalyst', 'bessemer venture partners', 'lightspeed venture partners',
  'insight partners', 'kleiner perkins', 'greylock', 'founders fund', 'khosla ventures',
  'northzone', 'creandum', 'localglobe', 'seedcamp', 'octopus ventures', 'notion capital',
  'eqt ventures', 'felix capital', 'hv capital', 'point nine', 'lakestar', 'speedinvest',
];
const isVentureFirm = firmMatcher(VENTURE_FIRMS);
const VENTURE_SEAT =
  /invest(ing|ment|or)|platform|portfolio|deal ?flow|sourcing|\bassociate\b|\banalyst\b|scout|fellow/;

/**
 * 'Hedge Fund', 'Private Equity', 'Private Credit', 'Venture Capital', or null.
 * Asked after the title rules, so a title that names its vertical keeps it.
 */
export function fundSeatVerdict(title, ctx = {}) {
  const t = String(title || '').toLowerCase();
  if (!t.trim()) return null;
  const tier = ctx.tier || '';
  if ((isVentureFirm(ctx.firm) || tier === 'Growth Equity') && VENTURE_SEAT.test(t) && !NOT_FUND_SEAT.test(t)) {
    return 'Venture Capital';
  }
  if (NOT_FUND_SEAT.test(t)) return null;
  if (PRIVATE_FUND_TIERS.has(tier) && (FUND_SEAT.test(t) || PRIVATE_FUND_SEAT.test(t))) {
    return /\bcredit\b/.test(t) ? 'Private Credit' : 'Private Equity';
  }
  if (FUND_SEAT.test(t) && (HEDGE_FUND_TIERS.has(tier) || isHedgeFundFirm(ctx.firm))) return 'Hedge Fund';
  return null;
}

/**
 * Research & Ratings: the analytical seats at a ratings agency, a credit
 * research house, a market data provider or an index and analytics firm (Fitch,
 * S&P Global, Morningstar, PitchBook, FactSet, Bloomberg). Read only beside the
 * employer's tier, because "Associate Analyst" or "Research Analyst" means a
 * ratings or data research seat there and something else at a bank.
 *
 * BOUNDARIES. Quant, AI, data science and software keep their readings, which
 * are asked before this rule. Sales, client service, account management and
 * consulting are not research seats. Portfolio management at the same firm
 * (Morningstar Investment Management) is asset management. A title that says
 * equity research keeps Equity Research. Everything here was a judgement on the
 * 27 November feed and its fixtures are in classify-vertical.test.mjs.
 *
 * The vertical is pending in data/taxonomy.json: the site withholds every row
 * carrying it until its launch gates are met (L3vlup docs/research-ratings-2026-11.md).
 */
const RESEARCH_RATINGS_TIER = 'Research & Ratings';
const RESEARCH_RATINGS_SEAT =
  /\bratings?\b|credit (?:analyst|research|analysis)|\banalyst\b|\bresearch\b|\bindex(?:es)?\b|\besg\b|sustainab|fund (?:research|analyst)|data (?:research|content|quality|collection)|\bmethodolog|surveillance|\bvaluations?\b|evaluated pricing|fixed income pricing|data analyst/;
const NOT_RESEARCH_RATINGS_SEAT =
  /\bsales\b|business development|account (?:manager|executive|management)|client (?:service|success|support|solutions)|customer|consult(?:ant|ing)|recruit|talent|\bhr\b|human resources|marketing|communications|\blegal\b|paralegal|compliance|finance (?:analyst|associate)|\bfp&a\b|accounting|payroll|procurement|facilities|executive assistant|\boperations analyst\b|portfolio (?:management|manager)|equity research|product (?:manager|management|owner)|engineer|developer|software|scien|machine learning|\bai\b|\bml\b|operations|\bcx\b|commercial/;

export function researchRatingsVerdict(title, ctx = {}) {
  if (ctx.tier !== RESEARCH_RATINGS_TIER) return null;
  const t = String(title || '').toLowerCase();
  if (!t.trim() || NOT_RESEARCH_RATINGS_SEAT.test(t)) return null;
  return RESEARCH_RATINGS_SEAT.test(t) ? 'Research & Ratings' : null;
}

export function isHedgeFundSeat(t, firm, tier) {
  const title = String(t || '').toLowerCase();
  if (SERVICE_PROVIDER_TITLE.test(title)) return false;
  if (/\boperations\b/.test(title) && !isHedgeFundFirm(firm)) return false;
  if (HEDGE_FUND_TOKEN.test(title)) return true;
  // At an asset manager or a pension fund (PIMCO, PSP Investments) portfolio
  // management is the firm's own long-only or real-asset book, which the asset
  // management rule below reads, not a hedge fund seat.
  return /portfolio management/.test(title) && !isBankLenderInsurer(firm) && tier !== 'Asset Manager' && tier !== RESEARCH_RATINGS_TIER;
}

export function inferVertical(title, ctx = {}) {
  const t = String(title || '').toLowerCase();

  // Consulting is asked first because it is the only rule that reads the
  // employer, and because the generic technology rule below would otherwise
  // swallow "Technology Consulting Analyst" on the word technology alone.
  // It answers null for anything it is not sure about, so the chain is intact.
  const consulting = consultingVerdict(title, ctx);
  if (consulting) return consulting;

  if (/\b(quant|quantitative)\b/.test(t)) return 'Quant';

  // Before the AI and data rules: at a ratings, data or index firm a "Data
  // Analyst" is a data content seat, not data science (researchRatingsVerdict).
  const researchRatings = researchRatingsVerdict(title, ctx);
  if (researchRatings) return researchRatings;

  // AI was one bucket called 'Data & ML' carrying three different careers. On a
  // 993-row sweep it held 78 roles: 35 research, 29 applied AI engineering and
  // 14 genuine data roles, filtered together and all routed to the same
  // preparation. Someone looking for research work read past dozens of data
  // engineering rows to find it, and the tracker offered no way to say so.
  //
  // Research first, because a research engineer is a more specific reading than
  // an AI engineer, and the rule is deliberately narrow: it needs an
  // AI-industry job title ("research engineer", "applied scientist") or an
  // AI token sitting beside the word research. A bare "Research Analyst" must
  // keep falling through to Equity Research below, which is what it means in
  // finance and what a wider rule would have quietly broken.
  if (
    /applied scientist|research (engineer|scientist)|research residency|research associate, (ai|ml)/.test(t) ||
    (AI_TOKEN.test(t) && /\bresearch(er)?\b/.test(t))
  )
    return 'AI Research';

  // Data before applied AI, so a title that calls itself data work stays data
  // work. "Data Scientist, Machine Learning" is a data scientist; "Machine
  // Learning Engineer" is not.
  if (/data scien(ce|tist)|data engineer|\bdata analytics\b|\bdata analyst\b/.test(t)) return 'Data & ML';

  if (AI_TOKEN.test(t)) return 'AI Engineering';

  // "Investment Research" is the sell-side equity research division, not a
  // hedge fund seat: Goldman's equity research arm is literally called Global
  // Investment Research, and asset managers use the same name for the same
  // function. Without this an "Investment Research Intern" fell through every
  // rule and landed in Other.
  //
  // Buy-side research is not swallowed by this: a fund seat that names the fund
  // ("Hedge Fund Investment Analyst") is caught by the hedge fund rule above.
  // A bare "Investment Analyst" still lands in Other, which is a real remaining
  // gap and deliberately left alone here — the title is genuinely ambiguous
  // across funds, corporates and asset managers, and guessing it into one of
  // them would be worse than leaving it visible in the Other report.
  if (/equity research|research analyst|investment research/.test(t)) return 'Equity Research';
  if (/private equity|\bbuyout\b/.test(t)) return 'Private Equity';
  if (/venture capital|\bvc\b\s|growth equity|venture (investing|investment|associate|analyst|fellow|scout|partner)|ventures? (fellowship|scout)/.test(t)) return 'Venture Capital';
  // A credit risk seat or a trading desk that names private credit is risk or
  // markets, not a lending seat: Santander's "Credit Risk - Leveraged Finance
  // Summer Intern" and Nomura's "Global Markets ... Private Credit Trading"
  // were both filed as private credit on the 27 November feed.
  if (/private credit|direct lending|leveraged finance|credit investment/.test(t) && !/\brisk\b|trading|\btrader\b|global markets/.test(t)) return 'Private Credit';
  if (isHedgeFundSeat(t, ctx.firm, ctx.tier)) return 'Hedge Fund';
  if ((ctx.tier === 'Asset Manager' || ctx.tier === RESEARCH_RATINGS_TIER) && /portfolio (?:management|manager|analyst)/.test(t)) return 'Asset Management';
  // The fund's own investing seat, read beside the employer (fundSeatVerdict).
  const fundSeat = fundSeatVerdict(title, ctx);
  if (fundSeat) return fundSeat;
  // Both of these sit above the generic 'banking' rule, which would otherwise
  // swallow them. "Private Banking" is wealth management, not a deal team —
  // caught by a test the moment the generic rule was added. And Citi files
  // corporate lending as "Banking - Corporate Banking", which is not the same
  // job as advising on deals.
  if (/wealth management|private bank|private wealth|\bpwm\b|private client/.test(t)) return 'Wealth Management';

  // The employer's division name is not a signal about the job. J.P. Morgan
  // files every early-career role under "Commercial & Investment Bank", so
  // "CIB - Global Payments" and "CIB - Sales" both carried the words
  // "investment bank" and both landed in Investment Banking, where they made
  // up a third of the bank's rows on the hub. The prefix is removed and the
  // rules below read what is left; a title that was only the prefix keeps its
  // banking reading through the generic rule at the end of this block.
  const core = t.replace(/\b(?:commercial|corporate|global)\s*(?:&|and)\s*investment\s*bank(?:ing)?\b/g, ' ');
  const insideBankingDivision = core !== t;

  // A bank's other businesses, each with the word "banking" in its name and
  // none of them a deal team. Retail, branch and consumer banking have no
  // vertical of their own, so they fall to Other, where the sweep reports
  // them, rather than to a seat a candidate would prepare for wrongly.
  if (/\bretail\b.*\bbanking\b|consumer (?:banking|lending)|branch banking|customer banking|personal banking|daily banking|everyday banking|\be[- ]?banking\b|private individuals/.test(core))
    return 'Other';
  // Payments and treasury services are corporate banking products, sold to
  // the same clients by the same division at most banks.
  // A payments risk or fraud seat at a fintech is a risk seat, and keeps
  // falling through to the risk rule below.
  if (/\bpayments?\b|treasury services|cash management|\bmerchant\b/.test(core) && !/\brisk\b|\bfraud\b|\bcompliance\b/.test(core))
    return 'Corporate Banking';
  // Custody and fund services are an operations business, not a market seat.
  if (/securities services|\bcustody\b|fund services|fund administration/.test(core)) return 'Operations';
  if (/corporate ba?n?king|commercial banking|business banking|wholesale banking|transaction banking|\btrade finance\b|sector lending/.test(core))
    return 'Corporate Banking';
  // Real estate investing is principal investing, whatever the row says about
  // capital markets; property valuation is a surveyor's job, not a banker's.
  // Inside an asset manager's own programme ("Investment Management
  // Off-Cycle Internship - Real Estate Investing") it stays asset management,
  // which the rule further down already answers. "Asset management" alone is
  // not the guard: a real estate fund lists it as one of its activities.
  if (
    /real estate (?:partners|debt|acquisitions|investing|investment|fund|equity|strategies)|private investments?|principal invest/.test(core) &&
    !/investment management|fund management/.test(core)
  )
    return 'Private Equity';
  if (/property valu|real estate valu|\bvaluer\b/.test(core)) return 'Other';
  // Business transformation is consulting, even when the firm calls the
  // segment corporate finance (FTI files it under its Corporate Finance
  // segment, which is why consultingVerdict's finance override let it pass).
  // Only at a consulting firm: a bank's own "Business Transformation Analyst"
  // is an internal change seat and stays Other, as before.
  if (/business transformation/.test(core)) return isConsultingFirm(ctx.firm) ? 'Consulting' : 'Other';
  // With the division prefix gone, a markets or sales seat inside the
  // investment bank reads as what it is.
  if (insideBankingDivision && /\bmarkets\b|\bsales\b|\btrading\b|\brisk\b/.test(core)) {
    return /\brisk\b/.test(core) ? 'Risk' : 'Sales & Trading';
  }
  // "Sales & Trading" and a bank's Global Markets division are markets seats
  // even when the title also names Capital Markets (27 November feed: "2028
  // Capital Markets, Global Markets Sales & Trading Summer Analyst" was filed
  // as banking). Origination inside Global Markets is a deal seat and is left
  // to the banking rule.
  if (/sales\s*(?:&|and)\s*trading|\bs&t\b/.test(core) || (/global markets/.test(core) && !/origination|\becm\b|\bdcm\b|syndicate/.test(core)))
    return 'Sales & Trading';
  if (
    /investment bank|\bibd\b|\bm&a\b|mergers|corporate advisory|capital markets|restructuring|corporate finance|valuation|debt advisory|capital solutions|\bbanking\b/.test(core) ||
    (insideBankingDivision && !/\b(?:technology|engineer|software|operations|compliance|audit|finance|legal|hr)\b/.test(core))
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
  // Word-bounded, as EARLY_CAREER is: a bare substring read "Internal Audit
  // Analyst Program" and "International Private Bank" as internships.
  if (/\bintern(?:s|ships?)?\b|co-op|coop|\bstudent\b/.test(t)) return { programmeType: 'Summer Internship', level: 'Internship' };
  // A summer analyst or summer associate is an internship, MBA summer
  // associates included, whether or not the title also says "intern"; so is a
  // seat named for a summer with its class year ("Data Science - Summer
  // 2027"). Without this, Citi's "Summer Analyst, London, 2027" and every MBA
  // Summer Associate Program were filed as graduate programmes. A full-time
  // post-MBA associate is not here: it is an experienced hire.
  if (/\bsummer\s+(analyst|associate)s?\b/.test(t) || (/\bsummer\b/.test(t) && /\b20[2-3]\d\b/.test(t))) {
    return { programmeType: 'Summer Internship', level: 'Internship' };
  }
  if (/residency/.test(t)) return { programmeType: 'Graduate Programme', level: 'Experienced' };
  return { programmeType: 'Graduate Programme', level: 'Graduate' };
}

/**
 * Locations that reached none of the patterns below and fell through to the
 * default. Reported at the end of a run: the fallback is a guess, and a guess
 * nobody counts is a guess nobody fixes.
 */
export const unmatchedLocations = new Map();

// Order matters, and two things decide it.
//
// Unambiguous country and city names run first, so "Munich, DE" is Europe
// before anything looks at DE as a US state code. Then the comma-anchored US
// state codes, so "Birmingham, AL" and "Manchester, NH" are US before the bare
// UK city names below can claim them — those names exist in both countries and
// a state code is the stronger signal. The bare UK names run after, so a
// "Birmingham" with nothing else attached still resolves to the larger city.
//
// The word boundaries are not decoration. Without them `india` matches
// Indianapolis, `wales` matches New South Wales, and `oman` matches Romania.
// All three shipped in the first version of this and are covered by tests.
const REGION_PATTERNS = [
  ['Remote', /\bremote\b|work from home|virtual/],
  [
    'Europe',
    /\beurope\b|\bemea\b|dublin|ireland|amsterdam|netherlands|rotterdam|paris|france|berlin|münchen|munich|frankfurt|hamburg|germany|madrid|barcelona|spain|zurich|geneva|basel|switzerland|stockholm|sweden|milan|rome|italy|lisbon|porto|portugal|warsaw|krakow|kraków|wroclaw|wrocław|gdansk|gdańsk|poznan|poznań|lodz|łódź|katowice|poland|copenhagen|denmark|aarhus|helsinki|finland|oslo|norway|vienna|austria|brussels|bruxelles|belgium|prague|czech|budapest|hungary|bucharest|romania|sofia|bulgaria|athens|greece|luxembourg|malta|zagreb|croatia|vilnius|lithuania|riga|latvia|tallinn|estonia|bratislava|slovakia|ljubljana|slovenia|reykjavik|iceland|kyiv|kiev|ukraine|belgrade|serbia|\bpisa\b|turin|torino|florence|firenze|bologna|naples|\bnapoli\b|genoa|genova|lyon|marseille|toulouse|lille|nantes|bordeaux|cologne|köln|stuttgart|düsseldorf|dusseldorf|leipzig|dresden|hanover|hannover|nuremberg|nürnberg|valencia|seville|sevilla|bilbao|malaga|málaga|antwerp|ghent|gothenburg|göteborg|malmö|malmo|tampere|espoo|cork|galway|limerick|utrecht|eindhoven|the hague|den haag|lausanne|lugano|graz|salzburg|brno|cluj|timisoara|timișoara|thessaloniki/,
  ],
  [
    'Asia',
    /\basia\b|\bapac\b|singapore|hong kong|tokyo|osaka|japan|bangalore|bengaluru|mumbai|hyderabad|pune|chennai|gurgaon|gurugram|noida|\bdelhi\b|\bindia\b|shanghai|beijing|shenzhen|\bchina\b|taiwan|taipei|hsinchu|seoul|korea|sydney|melbourne|brisbane|perth|australia|auckland|new zealand|kuala lumpur|malaysia|jakarta|indonesia|bangkok|thailand|manila|philippines|hanoi|ho chi minh|vietnam|putrajaya|cyberjaya|penang|cebu|chengdu|guangzhou|hangzhou|suzhou|dalian|kolkata|ahmedabad|coimbatore|jaipur|chandigarh|nagoya|fukuoka|yokohama|busan|canberra|adelaide|christchurch/,
  ],
  [
    'Middle East',
    /dubai|abu dhabi|riyadh|qatar|doha|\buae\b|saudi|bahrain|kuwait|\boman\b|tel aviv|israel|amman|jordan/,
  ],
  [
    'UK',
    /london|united kingdom|\buk\b|\bu\.k\b|england|scotland|(?<!new south )\bwales\b|northern ireland|edinburgh|glasgow|cardiff|belfast|canary wharf|milton keynes|knutsford|northampton|radbroke|bournemouth|leicester|coventry|swindon|guildford|basingstoke|southampton|aberdeen|dundee|swansea|peterborough|watford|st albans|wolverhampton|warrington|salford/,
  ],
  // Canada and Latin America before the US state codes, which would otherwise
  // read a province code ("Toronto, ON") as nothing or a state. A province
  // code alone is never enough: a Canadian city or the country must be named.
  [
    'Canada',
    /\bcanada\b|,\s*can$|toronto|mississauga|markham|brampton|oakville|kitchener|montr[eé]al|qu[eé]bec|vancouver|burnaby|calgary|edmonton|ottawa|winnipeg|halifax,? ns|saskatoon|ontario,? canada|british columbia|\balberta\b|nova scotia|manitoba|saskatchewan/,
  ],
  [
    'Latin America',
    /(?<!new )\bm[eé]xico\b|mexico city|monterrey|guadalajara|\bbrazil\b|\bbrasil\b|s[aã]o paulo|rio de janeiro|belo horizonte|curitiba|argentina|buenos aires|\bchile\b|santiago,? (chile|cl)|colombia|bogot[aá]|medell[ií]n|\bperu\b|lima,? (peru|pe)|costa rica|panam[aá]|uruguay|montevideo|guatemala|dominican republic|ecuador|\blatam\b|latin america/,
  ],
  // A two-letter code after a comma is a strong US signal and beats the bare
  // city names below. A bare code would read "in" out of "Bengaluru, India"
  // and "ma" out of "MA - Casablanca, Morocco", which is why it needs the comma.
  [
    'US',
    /,\s*(?:al|ak|az|ar|ca|co|ct|dc|de|fl|ga|hi|ia|id|il|in|ks|ky|la|ma|md|me|mi|mn|mo|ms|mt|nc|nd|ne|nh|nj|nm|nv|ny|oh|ok|or|pa|ri|sc|sd|tn|tx|ut|va|vt|wa|wi|wv|wy)\b/,
  ],
  // UK cities that also name a US city. Reached only when no state code said
  // otherwise, in which case the larger city is the better guess.
  [
    'UK',
    /birmingham|manchester|bristol|leeds|sheffield|liverpool|nottingham|newcastle|oxford|cambridge|reading/,
  ],
  [
    'US',
    /united states|\busa\b|\bu\.s\b|\bus\b|\bamerica\b|new mexico|new york|\bnyc\b|chicago|boston|san francisco|bay area|seattle|austin|dallas|houston|atlanta|denver|miami|philadelphia|phoenix|charlotte|jersey city|washington|los angeles|san diego|san jose|portland|minneapolis|detroit|salt lake|columbus|nashville|raleigh|pittsburgh|tampa|orlando|st\. louis|kansas city|cincinnati|cleveland|milwaukee|sacramento|las vegas|hartford|wilmington|richmond|baltimore|california|texas|florida|virginia|illinois|arizona|georgia|colorado|oregon|utah|massachusetts|new jersey|pennsylvania|north carolina|ohio|michigan|minnesota|tennessee|missouri|wisconsin|indiana|maryland|connecticut|delaware/,
  ],
];
/**
 * The region of an ISO 3166 country, where the mapping is unambiguous, else null.
 *
 * Workday's detail endpoint states the country as a code beside a descriptor
 * that is often a bare city ("Milan"). The code is the better evidence.
 * Canada and Latin America are regions of their own since 27 November 2026:
 * until then they fell through to the US, which put 103 Canadian and 51 Latin
 * American rows on the US board and hubs.
 */
const COUNTRY_REGION = {
  US: 'US', GB: 'UK', CA: 'Canada',
  MX: 'Latin America', BR: 'Latin America', AR: 'Latin America', CL: 'Latin America', CO: 'Latin America', PE: 'Latin America',
  CR: 'Latin America', PA: 'Latin America', UY: 'Latin America', GT: 'Latin America', DO: 'Latin America', EC: 'Latin America',
  AE: 'Middle East', SA: 'Middle East', QA: 'Middle East', BH: 'Middle East', KW: 'Middle East', OM: 'Middle East', IL: 'Middle East',
  SG: 'Asia', HK: 'Asia', CN: 'Asia', JP: 'Asia', KR: 'Asia', IN: 'Asia', AU: 'Asia', NZ: 'Asia', TW: 'Asia', MY: 'Asia', ID: 'Asia', PH: 'Asia', TH: 'Asia', VN: 'Asia',
};
const EUROPE = 'AT BE BG CH CY CZ DE DK EE ES FI FR GR HR HU IE IS IT LI LT LU LV MC MT NL NO PL PT RO RS SE SI SK UA'.split(' ');
export function regionForCountry(code) {
  if (!code) return null;
  if (EUROPE.includes(code)) return 'Europe';
  return COUNTRY_REGION[code] ?? null;
}

const COUNTRY_NAME = new Intl.DisplayNames(['en'], { type: 'region' });
/** "Milan" and "IT" as "Milan, Italy", so the country travels with the text. */
export function withCountry(location, code) {
  if (!code) return location;
  const name = COUNTRY_NAME.of(code);
  if (!name || location.toLowerCase().includes(name.toLowerCase())) return location;
  return `${location}, ${name}`;
}

export function inferRegion(location) {
  const l = (location || '').toLowerCase();
  for (const [region, pattern] of REGION_PATTERNS) {
    if (pattern.test(l)) return region;
  }
  // The taxonomy has no "unknown", and a row has to go somewhere for the page
  // to render. It goes to US because that is where most of the board is, and
  // the location is recorded so the guess is visible rather than silent.
  //
  // It was not visible before: 293 of 577 US rows carried a location saying
  // nothing US-like. Bristol, Denmark, Taiwan, Finland and Hungary were all
  // being published as US, which put UK roles on the US hub and vice versa.
  const key = (location || '').trim() || '(blank)';
  unmatchedLocations.set(key, (unmatchedLocations.get(key) ?? 0) + 1);
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
  // These two do have tracks of their own, written for these loops rather than
  // borrowed from a neighbouring one.
  'AI Engineering': 'ai-engineer-interview-prep',
  'AI Research': 'ml-research-interview-prep',
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

/**
 * The per-firm part of a role id.
 *
 * Greenhouse and Ashby have a token, Workday a tenant. The families added since
 * — tal.net, Eightfold, Oracle, Jane Street — have neither, and the id template
 * used to interpolate `undefined` for all of them: Morgan Stanley roles were
 * `talnet-undefined-21876` and BlackRock's `talnet-undefined-12220`, sharing one
 * namespace. Two tal.net tenants issuing the same opportunity number would then
 * collide, and the loser would be silently overwritten in both the tracker and
 * the deadline ledger.
 *
 * `token || tenant` stays first so every id already in the ledger and the
 * history file keeps its value; only the families that were producing
 * `undefined` change.
 */
export function firmKey(firm) {
  const raw = firm.token || firm.tenant || firm.host || firm.domain || firm.firm || 'unknown';
  return String(raw).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/**
 * A title that names an event or a club rather than a job.
 *
 * Roland Berger's "Boost Your Consulting Skills: Graduate Consulting Club" was
 * admitted on "Graduate" and published as a consulting graduate role. Google
 * does not allow events as job postings, and a candidate who applies to it has
 * applied to a club. Narrow on purpose: on the 25 November feed it matches that
 * one row and nothing else; insight days and spring weeks are programmes with
 * an application and stay.
 */
const NOT_A_POSTING = /\b(club|webinar|workshop|masterclass|open day|info(?:rmation)? session|networking event|boost your)\b/i;
export function isNotAPosting(title) {
  return NOT_A_POSTING.test(String(title || ''));
}

/**
 * A title whose every cycle year is already past: a posting the employer left up.
 *
 * "Accenture Summer Internship Program - Consulting (Aug to Dec2024)", Bain
 * Capital's "Credit Summer Associate 2024" and Citi's "2025 Markets Internship"
 * were all live rows on 25 November 2026. A year counts as past when it is
 * before the cycle a reader is applying for minus one, and the cycle rolls in
 * July as the site's does (lib/hub-live-meta.ts): in November 2026 the cycle is
 * 2027 and 2025 is past; in January 2027 a "Class of 2026" role is not. A title
 * with no year, or any current or future year, is untouched.
 */
export function namesOnlyPastCycle(title, now = new Date()) {
  const years = [...String(title || '').matchAll(/(?:^|\D)(20[1-3]\d)(?!\d)/g)].map((m) => Number(m[1]));
  if (!years.length) return false;
  const cycle = now.getUTCFullYear() + (now.getUTCMonth() + 1 >= 7 ? 1 : 0);
  return years.every((y) => y < cycle - 1);
}

export function toOpportunity(job, board) {
  // `earlyCareerConfirmed` is set by fetchers whose source states the level in a
  // dedicated field rather than in the title. Jane Street is the case that
  // forced it: `availability` says "Summer Internship" while the title says
  // "Software Engineer", so a title-only test threw away the entire board and
  // reported the firm as having nothing open.
  if (!job.title) return null;
  if (isNotAPosting(job.title) || namesOnlyPastCycle(job.title)) return null;
  // A board shared by several businesses names the owner in the title (see
  // lib/title-brands.mjs). The id still comes from the board, so it is stable
  // whichever brand a row is published under.
  const firm = { ...board, ...brandForTitle(job.title, board) };
  const admission = job.earlyCareerConfirmed ? 'campus' : earlyCareerAdmission(job.title);
  // A "Junior …" seat at a trading or quant firm is early career when the
  // rest of the title is a seat the experienced classifier would take there
  // (see isJuniorSeatAtTradingFirm); never at a bank, never on "junior" alone.
  const juniorSeat = !admission && !SENIOR.test(job.title) ? juniorSeatAtTradingFirm(job.title, firm.tier) : null;
  if (!admission && !juniorSeat) return null;
  // No null check: inferVertical always classifies, falling back to 'Other'.
  const inferred = inferVertical(job.title, {
    firm: firm.firm,
    tier: firm.tier,
    department: job.department,
    location: job.location,
  });
  // A junior seat whose title names no area is placed the way an experienced
  // one is: "Junior Commodities Fundamental Analyst" at a multi-manager is a
  // hedge fund seat, not Other.
  const vertical = juniorSeat ? (experiencedVertical(inferred, juniorSeat, firm.tier) ?? inferred) : inferred;
  // A stated level alone says nothing about the work: such a row must name a
  // seat this tracker covers, so "Entry-Level Specialist" in collections or a
  // manufacturing technician is not published (A0 decisions, 13 October).
  if (admission === 'stated-level' && (vertical === 'Other' || namesNonTargetFunction(job.title))) return null;
  const { programmeType, level } = inferProgrammeAndLevel(job.title);
  const tags = ['Auto-sourced'];
  if (job.department) tags.push(job.department);
  const extracted = job.deadline ? {} : extractDeadline(job.description || '');
  if (extracted.rolling) tags.push('Rolling');
  const atsDate = toIsoDate(job.deadline, { allowFuture: true });
  return {
    // `idAts` keeps a row's id when a board changes route: Roland Berger moved
    // from SmartRecruiters' API to its own careers page and its rows kept the
    // ids, and the tracker URLs pinned to them, that the API gave them.
    id: `${board.idAts ?? board.ats}-${firmKey(board)}-${job.id}`,
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

/* ------------------------- experienced and lateral ------------------------- */

/**
 * The programme types an experienced row carries. The site maps both to the
 * Weekly's "Experienced and lateral" stage. Every count in this file that
 * means "early career" (the collapse guard, the empty-board report, the
 * board-check records the Hiring Pulse reads, the history snapshot) leaves
 * these rows out, so they can neither hide a campus regression nor fake one.
 */
const EXPERIENCED_PROGRAMMES = new Set(['Lateral / Experienced', 'MBA Hire']);
export const isExperiencedRow = (o) => EXPERIENCED_PROGRAMMES.has(o?.programmeType);

/**
 * Boards whose experienced postings are read: those already read in full
 * (Greenhouse, Ashby and Lever return the whole board on one request, and
 * `collect: "complete"` boards are walked to their own total), at a firm the
 * registry tier calls a bank, adviser, sponsor, asset manager or trading
 * firm. A keyword-searched Workday or Oracle board is not here: its queries
 * ask only for early-career terms, so what it returns says nothing about the
 * experienced roles on it. Adding experienced queries is phase 2.
 */
// Recruitee, Pinpoint and Workable also serve the whole board on one request (November 2026).
const FULL_READ_ATS = new Set(['greenhouse', 'ashby', 'lever', 'recruitee', 'pinpoint', 'workable']);
export function readsExperienced(firm) {
  if (!firm || firm.parked) return false;
  if (!FULL_READ_ATS.has(firm.ats) && firm.collect !== 'complete') return false;
  return firmTypeForTier(firm.tier) !== null;
}

/**
 * A posting the early-career path refused, as an experienced row, or null.
 *
 * Never called on a posting the early-career path accepts, so nothing it does
 * can change an early-career row. The row is built by toOpportunity itself,
 * so it has every field the others have, its id in the same namespace (and so
 * a slug pinned to the source job id by the same rule), and the employer's own
 * application URL from the ATS. Only the four fields that describe the seat
 * are replaced.
 */
export function toExperiencedOpportunity(job, board) {
  if (!job?.title || job.earlyCareerConfirmed || isEarlyCareer(job.title)) return null;
  if (!readsExperienced(board)) return null;
  const firm = { ...board, ...brandForTitle(job.title, board) };
  const seat = classifySeniority(job.title, {
    department: job.department,
    firmType: firmTypeForTier(firm.tier),
  });
  if (!seat) return null;
  const vertical = experiencedVertical(
    inferVertical(job.title, { firm: firm.firm, tier: firm.tier, department: job.department, location: job.location }),
    seat,
    firm.tier
  );
  if (!vertical) return null;
  const row = toOpportunity({ ...job, earlyCareerConfirmed: true }, board);
  if (!row) return null;
  row.vertical = vertical;
  row.programmeType = experiencedProgrammeType(seat);
  row.level = 'Experienced';
  row.recommendedPrepSlug = prepSlugFor(vertical);
  // Internal, stripped in the fetch loop once the cap has read it.
  row._seniority = seat.seniority;
  return row;
}

/**
 * One firm's experienced rows: repeats collapsed, then capped by seat.
 *
 * Kept in SENIORITY_BUCKETS order (MBA associates, associates, experienced
 * analysts, VPs, named investing seats, then engineers), and by id within a
 * bucket, so the same board gives the same rows whatever order it answered
 * in. The cap that discarded by arrival order is the mistake described at
 * PER_FIRM_CEILING, and is not repeated here.
 */
export function capExperienced(rows, ceiling = EXPERIENCED_PER_FIRM_CEILING, { stratified = false } = {}) {
  const { kept, dropped } = collapseRepeats(rows);
  const rank = (o) => {
    const i = SENIORITY_BUCKETS.indexOf(o._seniority);
    return i < 0 ? SENIORITY_BUCKETS.length : i;
  };
  const ordered = [...kept].sort((a, b) => rank(a) - rank(b) || String(a.id).localeCompare(String(b.id)));
  const chosen = stratified ? roundRobinBySeat(ordered, ceiling) : ordered.slice(0, ceiling);
  // Copies without the internal field, so the caller's rows are left as given.
  const kept_ = chosen.map(({ _seniority, ...o }) => o);
  return { rows: kept_, repeats: dropped.length, overCeiling: Math.max(0, ordered.length - ceiling) };
}

/**
 * Up to `ceiling` rows, one from each seniority-and-area pair in turn.
 *
 * `ordered` is already in SENIORITY_BUCKETS order and by id within a bucket,
 * and the pairs are visited in that order (then by area name), so the result
 * depends only on which rows the board holds, never on the order it answered
 * in. Returned in the same order as `ordered`.
 */
function roundRobinBySeat(ordered, ceiling) {
  if (ordered.length <= ceiling) return ordered;
  const groups = new Map();
  for (const o of ordered) {
    const key = `${o._seniority}\u0000${o.vertical}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(o);
  }
  const bucketOf = (k) => {
    const i = SENIORITY_BUCKETS.indexOf(k.split('\u0000')[0]);
    return i < 0 ? SENIORITY_BUCKETS.length : i;
  };
  const queues = [...groups.entries()]
    .sort(([a], [b]) => bucketOf(a) - bucketOf(b) || a.localeCompare(b))
    .map(([, rows]) => rows);
  const picked = new Set();
  for (let round = 0; picked.size < ceiling; round += 1) {
    let any = false;
    for (const q of queues) {
      if (round < q.length && picked.size < ceiling) {
        picked.add(q[round]);
        any = true;
      }
    }
    if (!any) break;
  }
  return ordered.filter((o) => picked.has(o));
}

/* ------------------------------- fetchers -------------------------------- */
async function getJson(url, init, timeoutMs = TIMEOUT_MS) {
  const res = await fetch(url, {
    ...init,
    headers: { 'User-Agent': UA, Accept: 'application/json', ...(init?.headers || {}) },
    signal: AbortSignal.timeout(timeoutMs),
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
// The short seasonal terms run first. On 16 November 2026, the height of the
// spring-week season, the whole feed held two Spring Week rows and no insight
// programme at all: "2027 Spring Insight Programme" contains none of the five
// terms that follow, so a Workday or Oracle board never returned it to be
// judged. Each of these returns a page or two at most, so running them first
// costs a few requests a board and cannot be crowded out by the shared
// per-firm budget below; everything they find still has to pass
// isEarlyCareer and the vertical rules, as every other posting does.
export const SEASONAL_QUERIES = ['spring', 'insight', 'placement', 'off cycle'];
export const WORKDAY_QUERIES = [...SEASONAL_QUERIES, 'intern', 'graduate', 'new grad', 'summer analyst', 'apprentice'];
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
    // Optional request accounting (lib/board-checks.mjs). A page that throws
    // still ends its query quietly, but it is now counted, so a board whose
    // every request failed can no longer pass for a board with nothing open.
    stats,
    // One retry per page before the page counts as failed (lib/complete-board.mjs).
    retry,
  } = opts;
  const seen = new Map();

  for (const q of queries) {
    let offset = 0;
    let finished = false;
    // What THIS query has returned. The replay check below must ask whether a
    // page is new to the query, not to the firm: a later query whose first
    // page holds only postings an earlier query already collected is not a
    // board ignoring the offset, and used to end after one page while being
    // recorded as finished (JPMorgan "graduate", Barclays "new grad").
    const mine = new Set();
    for (let page = 0; page < maxPages; page++) {
      if (seen.size >= maxPostings) {
        // Our budget ended the walk, not the board. The count is a floor.
        if (stats) stats.capped = true;
        finished = true;
        break;
      }
      if (stats) stats.attempts++;
      const acc = {};
      const res = await withRetry(() => fetchPage(q, offset, PAGE), acc, retry);
      if (stats) stats.retries = (stats.retries ?? 0) + (acc.retries ?? 0);
      if (!res.ok) {
        if (stats) stats.failures++;
        finished = true; // counted as a failure, not as a budget
        break; // this query failed; move to the next one
      }
      const data = res.value;

      const postings = data?.jobPostings ?? [];
      if (postings.length === 0) { finished = true; break; }

      let added = 0;
      for (const jp of postings) {
        const path = jp.externalPath;
        if (!path || mine.has(path)) continue;
        mine.add(path);
        added++;
        if (!seen.has(path)) seen.set(path, jp);
      }
      // A page that adds nothing new to this query means the board is ignoring
      // our offset and replaying page one. Without this the loop never ends.
      if (added === 0) { finished = true; break; }

      offset += PAGE;
      // `total` is the count for this search term. Trust it when present, but
      // the two checks above are what actually terminate the loop, because not
      // every deployment returns it.
      if (typeof data.total === 'number' && offset >= data.total) { finished = true; break; }
      if (postings.length < PAGE) { finished = true; break; }
    }
    // Every page came back full and the page budget ran out first: there was
    // more on the board than we read.
    if (!finished && stats) stats.capped = true;
  }
  return seen;
}

/**
 * The total a Workday page states, read the way the tenant means it: a later
 * page that returns postings under a total of 0 restates the first page's
 * total (see the complete read in fetchWorkday). Anything else is taken as
 * given, so a board that really moved still reads as having moved.
 */
export function workdayPageTotal(offset, total, rowCount, firstPageTotal) {
  return offset > 0 && total === 0 && rowCount > 0 && typeof firstPageTotal === 'number' ? firstPageTotal : total;
}

async function fetchWorkday(f, stats = newRequestStats()) {
  // Two shapes live in the registry. Hand-added rows carry `host`; rows written
  // by scripts/discover-ats.mjs carry `tenant` + `shard` and no host at all.
  // Reading f.host alone built 'https://undefined/wday/cxs/...', which threw,
  // was swallowed by the catch below, and returned an empty list — so every
  // bank discovery added counted as a healthy board contributing nothing.
  const host = f.host || (f.tenant && f.shard ? `${f.tenant}.${f.shard}.myworkdayjobs.com` : null);
  if (!host) throw new Error(`no Workday host for ${f.firm}`);

  // A complete read waits longer for each page (COMPLETE_TIMEOUT_MS); a keyword
  // walk keeps the ordinary timeout.
  const timeout = f.collect === 'complete' ? COMPLETE_TIMEOUT_MS : TIMEOUT_MS;
  const search = (searchText, offset, limit) =>
    getJson(`https://${host}/wday/cxs/${f.tenant}/${f.site}/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Registry `appliedFacets`: a board shared by several businesses can be
      // narrowed to one of them by Workday's own facet, as the site's filter
      // would. Marsh McLennan's board is read through its Consulting job family
      // only (Oliver Wyman, NERA and Mercer), not its insurance broking.
      body: JSON.stringify({ appliedFacets: f.appliedFacets ?? {}, limit, offset, searchText }),
    }, timeout);
  // Registry `collect: "complete"`: the whole board, empty search, walked to
  // the board's own total and classified locally (lib/complete-board.mjs).
  // Workday serves at most 20 a page.
  //
  // Some tenants state the board's total on the first page only and answer
  // `total: 0` on every later page while still returning postings (Ares, Blue
  // Owl and Oaktree, read 20 November 2026; Barclays states it on every page).
  // Read literally, 0 ends the walk at offset 40 as "reached the total", so a
  // 230-posting board was read as 40. A later page that returns postings under
  // a total of 0 is therefore read as restating the first page's total; a
  // genuinely emptied board returns no postings and still ends the walk.
  let statedTotal;
  const seen = f.collect === 'complete'
    ? (await walkCompleteBoard(
        async (offset, limit) => {
          const d = await search('', offset, limit);
          const rows = d?.jobPostings ?? [];
          if (offset === 0) statedTotal = d?.total;
          const total = workdayPageTotal(offset, d?.total, rows.length, statedTotal);
          return { total, rows };
        },
        { pageSize: WORKDAY_PAGE, idOf: (jp) => jp?.externalPath, stats }
      )).postings
    : await paginateWorkday(search, { stats });
  if (everyRequestFailed(stats)) throw new Error(`every Workday request failed (${stats.failures})`);

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
export const ORACLE_QUERIES = [...SEASONAL_QUERIES, 'intern', 'graduate', 'summer analyst', 'apprentice', 'student'];
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
    stats, // see paginateWorkday
    retry, // see paginateWorkday
  } = opts;
  const seen = new Map();

  for (const q of queries) {
    let offset = 0;
    let finished = false;
    const mine = new Set(); // per query; see paginateWorkday
    for (let page = 0; page < maxPages; page++) {
      if (seen.size >= maxPostings) {
        // Our budget ended the walk, not the board. The count is a floor.
        if (stats) stats.capped = true;
        finished = true;
        break;
      }
      if (stats) stats.attempts++;
      const acc = {};
      const res = await withRetry(() => fetchPage(q, offset, PAGE), acc, retry);
      if (stats) stats.retries = (stats.retries ?? 0) + (acc.retries ?? 0);
      if (!res.ok) {
        if (stats) stats.failures++;
        finished = true; // counted as a failure, not as a budget
        break; // this query failed; move to the next one
      }
      const data = res.value;

      const bundle = data?.items?.[0];
      const reqs = bundle?.requisitionList ?? [];
      if (reqs.length === 0) { finished = true; break; }

      let added = 0;
      for (const r of reqs) {
        const id = r?.Id;
        if (id == null || mine.has(String(id))) continue;
        mine.add(String(id));
        added++;
        if (!seen.has(String(id))) seen.set(String(id), r);
      }
      if (added === 0) { finished = true; break; }

      offset += PAGE;
      if (typeof bundle.TotalJobsCount === 'number' && offset >= bundle.TotalJobsCount) { finished = true; break; }
      if (reqs.length < PAGE) { finished = true; break; }
    }
    if (!finished && stats) stats.capped = true; // see paginateWorkday
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

// A complete-board read asks for 200 a page: JPMorgan's 7,500 postings are 38
// requests rather than 300, and a shorter walk gives the board less time to
// move under it. The walker advances by what each page returned, so a server
// that serves fewer than it was asked for costs requests, never postings.
const ORACLE_COMPLETE_PAGE = 200;

async function fetchOracle(f, stats = newRequestStats()) {
  const timeout = f.collect === 'complete' ? COMPLETE_TIMEOUT_MS : TIMEOUT_MS;
  const search = (q, offset, limit) => {
    const keyword = q ? `,keyword=${q}` : '';
    const finder = `findReqs;siteNumber=${f.site},limit=${limit},offset=${offset},sortBy=POSTING_DATES_DESC${keyword}`;
    const url =
      `https://${f.host}/hcmRestApi/resources/latest/recruitingCEJobRequisitions` +
      `?onlyData=true&expand=requisitionList.secondaryLocations&finder=${encodeURIComponent(finder)}`;
    return getJson(url, undefined, timeout);
  };
  // See fetchWorkday for `collect: "complete"`.
  const seen = f.collect === 'complete'
    ? (await walkCompleteBoard(
        async (offset, limit) => {
          const b = (await search('', offset, limit))?.items?.[0];
          return { total: b?.TotalJobsCount, rows: b?.requisitionList ?? [] };
        },
        { pageSize: ORACLE_COMPLETE_PAGE, idOf: (r) => (r?.Id == null ? null : String(r.Id)), stats }
      )).postings
    : await paginateOracle(search, { stats });
  if (everyRequestFailed(stats)) throw new Error(`every Oracle request failed (${stats.failures})`);
  return [...seen.values()].map((r) => oracleToJob(r, f));
}

/* --------------------------------- tal.net -------------------------------- */
// Morgan Stanley, Nomura and BlackRock run campus hiring here, and nothing else
// in this collector reaches them. See lib/talnet.mjs for why this is the one
// HTML parser in the file.
//
// Boards are small — tens of roles, not thousands — so the detail page is
// fetched for every row rather than deferred to the enrichment budget. That is
// deliberate: tal.net states an explicit `Deadline:`, which is a stated
// apply-by date rather than an SEO artifact, and it is worth taking at
// collation time so it lands as an ATS field with the provenance to match.
const TALNET_POOL = 6;

async function fetchTalnet(f) {
  const url = talnetBoardUrl(f.host, f.brand, f.appcentre);
  if (!url) return [];
  const res = await fetch(url, { headers: { 'User-Agent': BROWSER_UA }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${res.status}`);
  const body = await res.text();
  // A gated tenant answers 200 with a ~4.8KB interstitial. Parsed naively that
  // is zero rows, which is indistinguishable from a firm with nothing open —
  // and it is not hypothetical: Nomura served 113KB in the morning and the gate
  // by the afternoon, and the board silently reported 0 roles. Throwing puts it
  // in the failed-boards list, where a disappearing firm belongs.
  if (isTalnetGate(body)) throw new Error('bot-check interstitial');
  const rows = parseTalnetBoard(body);

  const jobs = rows.map((r) => ({
    id: r.id,
    title: r.title,
    location: r.location,
    url: r.url,
    description: '',
  }));

  // Detail pages, for the deadline and the body text the board omits.
  for (let i = 0; i < jobs.length; i += TALNET_POOL) {
    await Promise.allSettled(
      jobs.slice(i, i + TALNET_POOL).map(async (j) => {
        const d = await fetch(j.url, { headers: { 'User-Agent': BROWSER_UA }, signal: AbortSignal.timeout(TIMEOUT_MS) });
        if (!d.ok) return;
        const html = await d.text();
        const deadline = parseTalnetDeadline(html);
        if (deadline) j.deadline = deadline;
        j.description = html;
      })
    );
  }
  return jobs;
}

/* -------------------------------- Eightfold ------------------------------- */
// Millennium's campus board. See lib/eightfold.mjs for the `num` cap that makes
// pagination mandatory rather than optional.
async function fetchEightfold(f, stats = newRequestStats()) {
  const seen = await paginateEightfold(async (start, num) => {
    stats.attempts++;
    try {
      return await getJson(eightfoldUrl(f.host, f.domain, start, num));
    } catch (e) {
      stats.failures++;
      throw e; // paginateEightfold ends the walk, as before
    }
  }, { stats });
  if (everyRequestFailed(stats)) throw new Error(`every Eightfold request failed (${stats.failures})`);
  return [...seen.values()].map((p) => eightfoldToJob(p, f));
}

/* ----------------------------- SmartRecruiters ---------------------------- */
// The public Posting API; one request per hundred postings and no detail
// pages. See lib/smartrecruiters.mjs for what it reads and what it refuses.
async function fetchSmartRecruiters(f, stats = newRequestStats()) {
  const seen = await paginateSmartRecruiters(async (offset, limit) => {
    try {
      return await getJson(smartRecruitersUrl(f.token, offset, limit));
    } catch (e) {
      stats.failures++;
      throw e;
    }
  }, { stats });
  return [...seen.values()].map((p) => smartRecruitersToJob(p, f)).filter(Boolean);
}

/* ------------------------------ Roland Berger ------------------------------ */
// The employer's own careers page, which replaced SmartRecruiters' Posting API
// for this firm (that host's robots.txt disallows all but LinkedInBot). One
// request, server-rendered; see lib/rolandberger.mjs.
async function fetchRolandBerger(f) {
  const res = await fetch(f.url || ROLAND_BERGER_JOBS_URL, {
    headers: { 'User-Agent': BROWSER_UA },
    redirect: 'follow',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${res.status}`);
  const jobs = parseRolandBergerJobs(await res.text());
  // The page always lists well over a hundred roles. None parsed means the
  // markup changed, which must read as a failed board and not as a firm with
  // nothing open.
  if (!jobs.length) throw new Error('no jobs parsed: the page has changed shape');
  return jobs;
}

/* ------------------------------- Recruitee -------------------------------- */
// The careers-site API: the whole board on one request. See lib/recruitee.mjs
// for the notices it refuses and why the registry stores the redirected name.
async function fetchRecruitee(f) {
  // From 10 February 2027 Recruitee answers 401 without the employer's
  // careers-site token (lib/sources/source-terms.json). The token is the
  // employer's to issue and is read from the environment, never the registry:
  // RECRUITEE_TOKEN_<TOKEN>, upper-cased, non-alphanumerics as underscores.
  const token = process.env[recruiteeTokenEnv(f.token)];
  try {
    return recruiteeToJobs(await getJson(recruiteeUrl(f.token), token ? { headers: { 'X-Careers-Sites-Token': token } } : undefined));
  } catch (e) {
    if (String(e.message) === '401') throw new Error(`401: needs a careers-site token in ${recruiteeTokenEnv(f.token)}`);
    throw e;
  }
}

export const recruiteeTokenEnv = (company) => `RECRUITEE_TOKEN_${String(company || '').toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;

/* -------------------------------- Pinpoint -------------------------------- */
// The postings feed: the whole board on one request. lib/pinpoint.mjs throws
// on the sample board an unused account serves, so that reads as a failure.
async function fetchPinpoint(f) {
  return pinpointToJobs(await getJson(pinpointUrl(f.token)));
}

/* -------------------------------- Workable -------------------------------- */
// The careers widget: the whole board on one request. lib/workable.mjs throws
// on any answer that is not the widget's shape, so a rate limit or a changed
// schema reads as a failed board, never as roles.
async function fetchWorkable(f) {
  return workableToJobs(await getJson(workableUrl(f.token)));
}

/* ------------------------------- Jane Street ------------------------------ */
// No ATS at all: a public JSON file behind a client-rendered page. The level
// lives in `availability` rather than the title, so the filtering happens in
// lib/janestreet.mjs before our own early-career rules ever see it.
// Registry rows of the two HTML-search families name the search terms that
// select campus roles (`queries`, default the cycle years), and a page budget
// per firm keeps a large tenant to a bounded number of polite requests.
const HTML_SEARCH_MAX_PAGES = 40;

/**
 * The paged HTML search both Avature and SuccessFactors serve: for each query,
 * pages of `pageSize` until the stated total, an empty page, a page that adds
 * nothing new (a site that ignores the offset), or the firm's page budget.
 * One request at a time, half a second apart.
 */
async function walkHtmlSearch(f, stats, { url, parse, pageSize, emptyShell }) {
  const year = new Date().getUTCFullYear();
  const queries = f.queries ?? [String(year + 1), String(year + 2)];
  const budget = f.maxPages ?? HTML_SEARCH_MAX_PAGES;
  const seen = new Map();
  let pages = 0;
  for (const q of queries) {
    for (let offset = 0; pages < budget; offset += pageSize) {
      pages++;
      stats.attempts++;
      let page;
      try {
        const res = await fetch(url(f, q, offset), {
          headers: { 'User-Agent': UA, Accept: 'text/html' },
          redirect: 'follow',
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(`${res.status}`);
        const html = await res.text();
        // A first page that is the bare shell means the template changed: a
        // failed board, never a firm with nothing open.
        if (offset === 0 && seen.size === 0 && emptyShell?.(html)) throw new Error('not a results page: the template has changed shape');
        page = parse(html, f.host);
      } catch (e) {
        stats.failures++;
        if (offset === 0) throw e;
        break;
      }
      const before = seen.size;
      for (const j of page.jobs) if (!seen.has(j.id)) seen.set(j.id, j);
      if (!page.jobs.length || seen.size === before || (page.total && offset + pageSize >= page.total)) break;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  if (pages >= budget) stats.capped = true;
  return [...seen.values()].map((j) => (f.defaultLocation && /^multiple locations$/i.test(j.location) ? { ...j, location: f.defaultLocation } : j));
}

/* -------------------------------- Avature -------------------------------- */
// Server-rendered search pages, ten a page (lib/avature.mjs).
async function fetchAvature(f, stats = newRequestStats()) {
  return walkHtmlSearch(f, stats, { url: avatureSearchUrl, parse: parseAvatureSearch, pageSize: AVATURE_PAGE, emptyShell: isAvatureEmptyShell });
}

/* ----------------------------- SuccessFactors ----------------------------- */
// Server-rendered search pages, 25 a page (lib/successfactors.mjs).
async function fetchSuccessFactors(f, stats = newRequestStats()) {
  return walkHtmlSearch(f, stats, { url: successFactorsSearchUrl, parse: parseSuccessFactorsSearch, pageSize: SUCCESSFACTORS_PAGE, emptyShell: isSuccessFactorsEmptyShell });
}

async function fetchJaneStreet() {
  const feed = await getJson('https://www.janestreet.com/jobs/main.json');
  return parseJaneStreetFeed(feed);
}

/* --------------------------------- iCIMS --------------------------------- */
// Deliberately absent. Probed 2026-08-31: Stifel returns 110 postings of which
// exactly one is early-career, Affinius 12 and Oak Hill 2 with none, and SIG's
// sig.icims.com is an employee login (orgname=sig-employee), not a public
// board. iCIMS has no JSON API, so this would be a second HTML parser bought
// for roughly one role. Recorded here so the next person can see it was
// measured rather than missed.

export const FETCHERS = { greenhouse: fetchGreenhouse, ashby: fetchAshby, lever: fetchLever, workday: fetchWorkday, oracle: fetchOracle, talnet: fetchTalnet, eightfold: fetchEightfold, janestreet: fetchJaneStreet, smartrecruiters: fetchSmartRecruiters, rolandberger: fetchRolandBerger, avature: fetchAvature, successfactors: fetchSuccessFactors, recruitee: fetchRecruitee, pinpoint: fetchPinpoint, workable: fetchWorkable };

/**
 * Write a file the way a consumer may read it at any moment.
 *
 * The site fetches these over HTTP the instant the push lands, and the IndexNow
 * detector deliberately reads them uncached. A half-written JSON file is a
 * parse error on a public page, so the bytes land under a temporary name and
 * are moved into place, which is atomic within a filesystem. The commit that
 * follows is the real transaction: the feed, the registry and the archive are
 * staged and pushed together, so a run that dies between them publishes none of
 * them rather than a feed whose slugs have no registry behind them.
 */
/**
 * The permitted descriptions, beside the feed (the contract in L3VLUP
 * lib/job-descriptions.ts): an index carrying the active permissions, and one
 * shard per FNV-1a byte. Stale shards are removed, so a permission that lapses
 * or is withdrawn takes its text off the site on the next run. Only rows still
 * in the feed are written.
 */
async function writeDescriptions(published) {
  const live = new Set(published.map((o) => o.id));
  const files = descriptionFiles(capturedDescriptions.filter((c) => live.has(c.id)), DESCRIPTION_PERMISSIONS, new Date());
  await mkdir(DESCRIPTIONS_DIR, { recursive: true });
  const keep = new Set(Object.keys(files));
  for (const name of await readdir(DESCRIPTIONS_DIR).catch(() => [])) {
    if (name.endsWith('.json') && !keep.has(name)) await rm(join(DESCRIPTIONS_DIR, name));
  }
  for (const [name, body] of Object.entries(files)) await writeAtomic(join(DESCRIPTIONS_DIR, name), JSON.stringify(body) + '\n');
  const n = Object.values(files).reduce((sum, f) => sum + (f.shards ? 0 : Object.keys(f).length), 0);
  console.log(`descriptions: ${n} published under ${files['index.json'].permissions.length} employer permission(s) → ${DESCRIPTIONS_DIR}`);
}

async function writeAtomic(path, contents) {
  const temp = `${path}.tmp`;
  await writeFile(temp, contents);
  await rename(temp, path);
}

/** Days a departed role's page is kept before the registry forgets the URL. */
const ARCHIVE_DAYS = 365;

/** Copy each row's first-collected day from the archive onto the row, in place. */
export function stampFirstSeen(rows, archived) {
  for (const o of rows) {
    const day = o.slug ? archived?.[o.slug]?.firstSeen : undefined;
    if (typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day)) o.firstSeen = day;
  }
  return rows;
}

/**
 * The record of every tracker URL this collector has published, departed roles
 * included.
 *
 * It used to be rebuilt in the website's repository, by a second job reading
 * this same feed, and that job is `workflow_dispatch` only: the archive sat
 * seventeen days stale while the board moved daily underneath it. Two
 * independent things fetching one feed and each keeping half the state is how
 * they disagree. This is the only place that sees a role leave, so this is
 * where the leaving is recorded.
 *
 * Entries carry the durable id and the canonical slug, so a consumer can join
 * them to the registry without re-deriving anything.
 */
export function updateArchive(previous, records, slugs, day) {
  const roles = { ...previous };
  const KEEP = ['id', 'firm', 'role', 'vertical', 'programmeType', 'tier', 'division', 'location', 'region', 'level', 'applicationUrl', 'recommendedPrepSlug'];

  for (const record of records) {
    const slug = slugs.get(String(record.id));
    if (!slug) continue;
    const entry = {};
    for (const key of KEEP) {
      if (record[key] !== undefined && record[key] !== null && record[key] !== '') entry[key] = record[key];
    }
    const prev = roles[slug];
    roles[slug] = {
      ...entry,
      slug,
      firstSeen: prev?.firstSeen && prev.firstSeen < day ? prev.firstSeen : day,
      lastSeen: day,
    };
  }

  // A record that was never a role is not an archived role. Left here, an
  // information session screened out of the feed would render as a listing
  // that had closed, indexable for another ninety days and in the sitemap.
  // Removing the entry makes the site answer 404 for it, which is the truth;
  // the slug itself stays reserved in the registry, so nothing can reuse it.
  // Matched on the title the archive holds, so entries written before the
  // screen existed are caught as well as today's.
  let screened = 0;
  for (const [slug, entry] of Object.entries(roles)) {
    if (isNonRoleTitle(entry?.role)) {
      delete roles[slug];
      screened += 1;
    }
  }

  // A URL nobody has seen in a year is not a listing anyone is still
  // following. Dropping it keeps the file, and the pages built from it,
  // proportional to what is actually tracked.
  const cutoff = new Date(Date.parse(`${day}T00:00:00Z`) - ARCHIVE_DAYS * 86400000)
    .toISOString()
    .slice(0, 10);
  let pruned = 0;
  for (const [slug, entry] of Object.entries(roles)) {
    if ((entry.lastSeen ?? '') < cutoff) {
      delete roles[slug];
      pruned += 1;
    }
  }

  const ordered = Object.fromEntries(Object.entries(roles).sort(([a], [b]) => a.localeCompare(b)));
  return { roles: ordered, pruned, screened };
}

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
  // Experienced rows do not count: a campus board gone quiet is still named
  // here even if the same board yields laterals.
  const emptyFirms = [];
  let experiencedCollected = 0;
  // Firms whose board did not answer at all.
  const failedFirms = [];
  // What each check established, for data/board-checks/ (lib/board-checks.mjs).
  const checks = {};
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
    const batchStats = batch.map(() => newRequestStats());
    const results = await Promise.allSettled(
      batch.map(async (f, k) => {
        const raw = await FETCHERS[f.ats](f, batchStats[k]);
        const pairs = raw.map((j) => [j, toOpportunity(j, f)]);
        const opps = pairs.map(([, o]) => o).filter(Boolean);
        // The employer's own description, kept only where the employer has
        // given written permission to republish it (lib/sources/description-
        // permissions.json). The readers already fetch the text; nothing extra
        // is requested, and nothing is kept for anyone else.
        if (permissionFor(DESCRIPTION_PERMISSIONS, f.firm, f.ats)) {
          for (const [j, o] of pairs) if (o && j.description) capturedDescriptions.push({ id: o.id, employer: o.firm, system: f.ats, sourceUrl: j.url || o.applicationUrl, html: j.description });
        }
        // Experienced rows, only from postings the line above refused, and
        // kept apart from `opps` all the way through: the ceiling, the board
        // check and the empty-board report below read early-career rows only.
        const allowance = experiencedAllowance(f);
        const xp = readsExperienced(f)
          ? capExperienced(raw.map((j) => toExperiencedOpportunity(j, f)).filter(Boolean), allowance.ceiling, allowance)
          : { rows: [], repeats: 0, overCeiling: 0 };
        if (xp.overCeiling) {
          console.log(
            `  ${f.firm}: ${xp.overCeiling} experienced role(s) above the ${allowance.ceiling} cap left out, ${allowance.stratified ? 'spread across seats and areas' : 'engineers first'}`,
          );
        }
        // Ceiling, not cap: see PER_FIRM_CEILING. Reaching it means a board is
        // answering with something we did not expect, which is worth saying out
        // loud rather than trimming away.
        if (opps.length > PER_FIRM_CEILING) {
          console.warn(`  !! ${f.firm}: ${opps.length} early-career roles, above the ${PER_FIRM_CEILING} ceiling — truncating; check the board and the filters`);
          return { firm: f.firm, opps: opps.slice(0, PER_FIRM_CEILING), xp: xp.rows, truncated: true };
        }
        return { firm: f.firm, opps, xp: xp.rows };
      })
    );
    for (const [k, r] of results.entries()) {
      const firm = batch[k];
      // A truncated board's count is a floor, like a partly answered one.
      const { status, why } = checkVerdict({
        settled: r.status,
        stats: batchStats[k],
        ceiling: r.status === 'fulfilled' && Boolean(r.value.truncated),
      });
      const roles = r.status === 'fulfilled' ? r.value.opps : [];
      const reason = r.status === 'rejected' ? String(r.reason?.message ?? r.reason) : undefined;
      const walk = batchStats[k].walk;
      // A complete read that was not called ok says how its last pass ended,
      // and why, so a production log shows a timeout from a refusal.
      if (walk && status !== 'ok') {
        const last = walk.passes[walk.passes.length - 1];
        console.log(
          `  ${firm.firm}: complete read ${walk.verdict}; pass ${walk.passes.length} ended ${last.terminal} after ` +
            `${last.pages} page(s) of ${last.pageSize}, ${last.raw} postings${last.error ? `: ${last.error}` : ''}`
        );
      }
      const prev = checks[firm.firm];
      checks[firm.firm] = prev
        ? { firm, status: worstStatus(prev.status, status), why: prev.why ?? why, roles: prev.roles.concat(roles), reason: prev.reason ?? reason, walk: prev.walk ?? walk }
        : { firm, status, why, roles, reason, walk };
      if (r.status === 'fulfilled') {
        ok++;
        all.push(...r.value.opps, ...r.value.xp);
        experiencedCollected += r.value.xp.length;
        const xpNote = r.value.xp.length ? ` (+${r.value.xp.length} experienced)` : '';
        if (r.value.opps.length) console.log(`  ${r.value.firm}: ${r.value.opps.length}${xpNote}`);
        else if (xpNote) console.log(`  ${r.value.firm}: 0${xpNote}`);
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
        failedFirms.push({ firm: firm?.firm ?? 'unknown', reason: String(r.reason?.message ?? r.reason).slice(0, 80) });
      }
    }
  }
  // Read once and keep the rows: the collapse guard needs the count, and the
  // per-firm delta report at the end needs to know which roles were dated.
  let previousRoles = [];
  let previousGeneratedAt;
  try {
    const prev = JSON.parse(await readFile(OUT, 'utf8'));
    previousRoles = prev.opportunities ?? [];
    previousGeneratedAt = typeof prev.generatedAt === 'string' ? prev.generatedAt.slice(0, 10) : undefined;
  } catch {
    /* first run — nothing to protect */
  }
  // Early career only, on both sides. Experienced rows arrived in October
  // 2026 and are capped per firm; counted here they would let a campus
  // collapse pass behind a run of laterals, or read their own first day as a
  // rise.
  const previousCount = previousRoles.filter((o) => !isExperiencedRow(o)).length;

  if (failedFirms.length) {
    console.log(`\n${failedFirms.length} board(s) failed to answer:`);
    for (const f of failedFirms) console.log(`  ${f.firm}: ${f.reason}`);
  }

  // Everything collated above was seen on a board just now.
  const runDay = stamp.slice(0, 10);
  for (const o of all) o.lastConfirmedAt = runDay;

  // ---------------------------------------------------------------------
  // Carry forward the roles of boards that failed, and of complete reads that
  // stopped part way.
  //
  // Only those. A board that answered and returned nothing has told us
  // something true, and its roles are dropped as before. See
  // lib/role-retention.mjs for why this exists at all — tal.net serves to
  // residential addresses and refuses datacentre ones, so three firms have
  // never survived a CI run despite collating perfectly by hand — and for why
  // a complete read that stopped part way carries only what it never reached.
  // A role collected this run is never carried as well.
  // ---------------------------------------------------------------------
  const carryFor = firmsToCarry(Object.values(checks));
  const retained = retainRoles(previousRoles, carryFor, runDay, {
    fallbackConfirmedAt: previousGeneratedAt,
    collected: new Set(all.map((o) => String(o.id))),
  });
  if (retained.length) {
    all.push(...retained);
    const byFirm = {};
    for (const r of retained) byFirm[r.firm] = (byFirm[r.firm] ?? 0) + 1;
    const how = (f) => (checks[f]?.status === 'partial' ? ' (read stopped part way)' : '');
    console.log(
      `\ncarried forward ${retained.length} role(s) from boards not read in full, marked Unconfirmed ` +
        `(dropped after ${RETENTION_DAYS} days): ` +
        Object.entries(byFirm).map(([f, n]) => `${f} ${n}${how(f)}`).join(', ')
    );
  }

  // ---------------------------------------------------------------------
  // Roles an employer listed with us directly (lib/employer-listings.mjs):
  // on no public board, approved in writing, labelled and dated to expire.
  // After collection and retention, so a board carrying the same link wins;
  // before screening and slugs, so a listing is screened and given a
  // permanent URL like any other row. A bad file costs the listings, never
  // the collection.
  // ---------------------------------------------------------------------
  try {
    const file = JSON.parse(await readFile(EMPLOYER_LISTINGS, 'utf8'));
    const taxonomy = JSON.parse(await readFile(TAXONOMY, 'utf8'));
    const { rows, skipped } = employerListings(file.listings, taxonomy, runDay, all);
    for (const r of rows) r.lastConfirmedAt = runDay;
    all.push(...rows);
    if (rows.length || skipped.length) {
      console.log(`\nemployer listings: ${rows.length} published, ${skipped.length} left out`);
      for (const s of skipped) console.log(`  ${s.label}: ${s.reason}`);
    }
  } catch (e) {
    if (e?.code !== 'ENOENT') console.log(`::warning::employer listings not read: ${String(e?.message ?? e).slice(0, 120)}`);
  }

  // ---------------------------------------------------------------------
  // Records that are not roles.
  //
  // After retention, so a row carried from a failed board is screened by the
  // same rule as one collected this morning; the first run after this landed
  // would otherwise have carried yesterday's information session forward for
  // a week. See lib/role-screen.mjs for what is dropped, what is only cleaned,
  // and why the rules are phrases rather than words.
  // ---------------------------------------------------------------------
  {
    const { kept, dropped, cleaned } = screenRoles(all);
    all.length = 0;
    all.push(...kept);
    if (dropped.length) {
      console.log(`\nscreened out ${dropped.length} record(s) that are not roles:`);
      for (const d of dropped) console.log(`  [${d.reason}] ${d.row.firm} — ${d.row.role.slice(0, 90)}`);
    }
    if (cleaned.length) {
      console.log(`\ncleaned ${cleaned.length} title(s) of a requisition label:`);
      for (const c of cleaned) console.log(`  ${c.row.firm} — ${c.from.slice(0, 60)} -> ${c.to.slice(0, 60)}`);
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
  const MIN_RETAINED_SHARE = 0.5;
  const earlyCount = all.filter((o) => !isExperiencedRow(o)).length;
  if (previousCount > 0 && earlyCount < previousCount * MIN_RETAINED_SHARE) {
    console.error(
      `\nABORT: collated ${earlyCount} early-career roles vs ${previousCount} previously ` +
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
  // Early-career rows are asked first, so experienced rows on a complete
  // Workday board spend only what the campus rows leave of the budget.
  // A row whose location the list endpoint withheld ("See listing", "3
  // Locations") is asked too, whatever its deadline, because its region is
  // otherwise a guess: inferRegion publishes an unreadable location as US, which
  // put 22 of Accenture's European and Canadian consulting rows on the US board.
  const locationUnknown = (o) => !o.location || o.location === 'See listing' || /^\d+\s+Locations?$/i.test(o.location);
  const wdEligible = all.filter(
    (o) => o._workdayDetail && ((!o.closingDate && needsCheck(ledger, o.id, today, 'workday-detail')) || locationUnknown(o))
  );
  const wdRows = [...wdEligible.filter((o) => !isExperiencedRow(o)), ...wdEligible.filter(isExperiencedRow)]
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
          if (parsed.location && locationUnknown(o)) {
            o.location = withCountry(parsed.location, parsed.countryCode);
            o.region = regionForCountry(parsed.countryCode) ?? inferRegion(o.location);
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
  // Experienced rows are not asked. A lateral posting almost never states a
  // closing date, and every page fetched for one is a page not fetched for a
  // campus programme that might.
  const candidates = all.filter(
    (o) => !isExperiencedRow(o) && !o.closingDate && o.applicationUrl && needsCheck(ledger, o.id, today, 'jsonld')
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

  // Same reasoning as the unclassified block above. A location the patterns do
  // not recognise is still published, as US, because the taxonomy has nowhere
  // else to put it — so the guess has to be counted or it stays invisible. It
  // did stay invisible: 293 of 577 US rows carried a location saying nothing
  // US-like, which put Bristol on the US hub and Taipei alongside it.
  if (unmatchedLocations.size) {
    const rows = [...unmatchedLocations.values()].reduce((a, b) => a + b, 0);
    console.log(`\nunplaced: ${rows} role(s) across ${unmatchedLocations.size} location strings defaulted to US`);
    for (const [loc, n] of [...unmatchedLocations.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
      console.log(`  ${String(n).padStart(3)}  ${loc}`);
    }
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
  for (const o of all) if (o.closingDate && !isExperiencedRow(o)) datedNow[o.firm] = (datedNow[o.firm] ?? 0) + 1;
  const datedBefore = {};
  for (const o of previousRoles) if (o.closingDate && !isExperiencedRow(o)) datedBefore[o.firm] = (datedBefore[o.firm] ?? 0) + 1;
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
  await writeAtomic(LEDGER, JSON.stringify(serialiseLedger(ledger, today), null, 2) + '\n');
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
  // `ids` is the record of what was on the tracker that day, experienced rows
  // included: the site reads a role's first sighting from it (the programme
  // page's tracking history, and the Sunday Weekly's "new this week", which
  // cannot call a row new without one). `count` and `byVertical` are the
  // early-career figures they always were, so the first day of experienced
  // rows does not read as a campus surge; `experienced` counts the rest.
  const early = all.filter((o) => !isExperiencedRow(o));
  const byVertical = {};
  for (const o of early) byVertical[o.vertical] = (byVertical[o.vertical] ?? 0) + 1;
  const snapshot = { date: day, count: early.length, byVertical, ids: all.map((o) => o.id) };
  const experiencedCount = all.length - early.length;
  if (experiencedCount) snapshot.experienced = experiencedCount;
  history = history.filter((h) => h.date !== day);
  history.push(snapshot);
  history = history.slice(-120);
  await writeAtomic(HISTORY, JSON.stringify({ snapshots: history }, null, 2) + '\n');

  // What each board check established today. Written beside the history, and
  // after the collapse guard, so an aborted run records nothing.
  const carriedByFirm = {};
  // Early career only, like the collected roles beside them (see isExperiencedRow).
  for (const r of retained) if (!isExperiencedRow(r)) (carriedByFirm[r.firm] ??= []).push(r);
  // What the feed finally publishes, after the non-role screen and title
  // cleaning above. The day's file describes exactly this (publishedView).
  const publishedById = new Map(all.map((o) => [String(o.id), o]));
  const boards = {};
  for (const c of Object.values(checks)) {
    const collected = publishedView(c.roles, publishedById);
    const carried = publishedView(carriedByFirm[c.firm.firm] ?? [], publishedById);
    boards[c.firm.firm] = boardRecord({
      firm: c.firm,
      status: c.status,
      why: c.why,
      roles: collected.rows,
      carried: carried.rows,
      reason: c.reason,
      screened: collected.screened + carried.screened,
      walk: c.walk,
    });
  }
  // The method is read off the code that ran, not a constant someone had to
  // remember to bump (lib/board-checks.mjs, METHOD_FILES).
  const fingerprint = methodFingerprint((f) => readFileSync(join(ROOT, f), 'utf8'));
  let methodRecord = null;
  try {
    methodRecord = JSON.parse(await readFile(join(ROOT, 'lib/collection-method.json'), 'utf8'));
  } catch {
    /* no record: every run is unacknowledged, which compares with nothing */
  }
  const method = resolveMethod(fingerprint, methodRecord);
  if (method.startsWith('unacknowledged:')) {
    console.log(
      `::warning::collection method fingerprint ${fingerprint} is not in lib/collection-method.json; ` +
        `today's board checks compare with no other day. Run node scripts/collection-method.mjs`
    );
  }
  const checkFile = buildCheckFile({
    date: day,
    checkedAt: stamp,
    boards,
    parked: parked.map((f) => f.firm),
    method,
    fingerprint,
  });
  const CHECKS = join(ROOT, checkFilePath(day));
  await mkdir(dirname(CHECKS), { recursive: true });
  await writeAtomic(CHECKS, JSON.stringify(checkFile, null, 1) + '\n');
  const { ok: okN, partial: partialN, failed: failedN } = checkFile.counts;
  const whys = {};
  for (const b of Object.values(boards)) if (b.why) whys[b.why] = (whys[b.why] ?? 0) + 1;
  const whyText = Object.keys(whys).length ? ` (${Object.entries(whys).map(([k, v]) => `${k} ${v}`).join(', ')})` : '';
  console.log(`board checks: ${okN} ok, ${partialN} partial${whyText}, ${failedN} failed, method ${method} -> ${CHECKS}`);

  // ---------------------------------------------------------------------
  // Canonical URLs.
  //
  // Last, because everything above can still abort the run, and the registry
  // must not record a slug for a board that turned out not to have collated.
  // The titles are normalised first: a zero-width space at the end of a Wells
  // Fargo title is what made two distinct roles look like one collision and
  // cost the second its URL. See lib/text-normalise.mjs.
  // ---------------------------------------------------------------------
  const normalised = all.map((o) => normaliseRoleText(o));
  for (let i = 0; i < all.length; i += 1) Object.assign(all[i], normalised[i]);

  let slugRoles = {};
  try {
    slugRoles = JSON.parse(await readFile(SLUGS, 'utf8')).roles ?? {};
  } catch {
    /* first run — the registry is created below */
  }
  const knownBefore = Object.keys(slugRoles).length;
  const { assigned, added } = updateRegistry(slugRoles, all, runDay);

  // The URL travels in the feed. A role collected this morning therefore has a
  // stable address this morning, with no commit to the website and no deploy.
  let unslugged = 0;
  for (const o of all) {
    const slug = assigned.get(String(o.id));
    if (slug) o.slug = slug;
    else unslugged += 1;
  }
  if (unslugged) {
    console.log(`::warning::${unslugged} role(s) produced no slug (blank firm or role after normalisation)`);
  }

  // Apparent duplicates, reported and never collapsed. Every row here already
  // holds a permanent URL, and removing one would turn a live page into an
  // archived one rather than remove a duplicate: see lib/role-duplicates.mjs.
  // One posting arriving twice is a collector bug and is raised as a warning;
  // the same programme posted per city is the normal case and is only counted.
  {
    const dupes = duplicateGroups(all);
    const rows = (groups) => groups.reduce((n, g) => n + g.rows.length, 0);
    console.log(
      `\napparent duplicates: ${dupes.samePosting.length} posting(s) collected twice, ` +
        `${dupes.sameTitleSameLocation.length} same-title-same-city group(s) (${rows(dupes.sameTitleSameLocation)} rows), ` +
        `${dupes.sameTitleManyLocations.length} programme(s) posted in several cities (${rows(dupes.sameTitleManyLocations)} rows)`
    );
    for (const g of dupes.samePosting) {
      console.log(`::warning::one posting collected as ${g.rows.length} rows (${g.key}): ${g.rows.map((r) => r.id).join(', ')}`);
    }
    for (const g of dupes.sameTitleSameLocation.slice(0, 10)) {
      console.log(`  ${g.rows[0].firm} — ${g.rows[0].role.slice(0, 60)} @ ${g.rows[0].location.slice(0, 30)}: ${g.rows.map((r) => r.slug ?? r.id).join(', ')}`);
    }
    if (dupes.sameTitleSameLocation.length > 10) console.log(`  …and ${dupes.sameTitleSameLocation.length - 10} more`);
  }

  // Departed roles. Their URLs stay published, and the record of them belongs
  // here rather than in a second job reading this same feed.
  let archiveRoles = {};
  try {
    archiveRoles = JSON.parse(await readFile(ARCHIVE, 'utf8')).roles ?? {};
  } catch {
    /* first run */
  }
  const archivedBefore = Object.keys(archiveRoles).length;
  const { roles: archived, pruned: archivePruned, screened: archiveScreened } = updateArchive(archiveRoles, all, assigned, runDay);

  // The day the role was first collected travels with it, so the site can say
  // "new this week" without a second read of the archive. The archive is the
  // only record of it (kept since 1 August 2026), and it keeps the earliest
  // day a slug was seen, so a role that drops off a board for a day and
  // returns is not new again. A row without a slug has no archive entry and
  // carries no date rather than a guessed one.
  stampFirstSeen(all, archived);

  await writeAtomic(
    SLUGS,
    JSON.stringify(serialiseRegistry(slugRoles, stamp), null, 2) + '\n'
  );
  await writeAtomic(
    ARCHIVE,
    JSON.stringify(
      { generatedAt: stamp, count: Object.keys(archived).length, roles: archived },
      null,
      2
    ) + '\n'
  );

  await writeAtomic(
    OUT,
    JSON.stringify({ generatedAt: stamp, count: all.length, opportunities: all }, null, 2) + '\n'
  );
  // A failure here must never cost the day's feed: the descriptions are an
  // addition beside it, and the site shows none it cannot read.
  try {
    await writeDescriptions(all);
  } catch (err) {
    console.warn(`  !! descriptions not written: ${err instanceof Error ? err.message : err}`);
  }
  const xpPublished = all.filter(isExperiencedRow).length;
  console.log(
    `\n${all.length - xpPublished} early-career roles and ${xpPublished} experienced ` +
      `(${experiencedCollected} collected today) from ${ok}/${firms.length} boards (${failed} failed) → ${OUT}`
  );
  console.log(
    `slug registry: ${Object.keys(slugRoles).length} records (${knownBefore} known, ${added} newly assigned) → ${SLUGS}`
  );
  console.log(
    `archive: ${Object.keys(archived).length} published URLs ` +
      `(${archivedBefore} before, ${archivePruned} pruned past ${ARCHIVE_DAYS} days, ` +
      `${archiveScreened} removed as not roles) → ${ARCHIVE}`
  );
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
