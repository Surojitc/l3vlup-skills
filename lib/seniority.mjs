/**
 * Experienced and lateral seats: which titles are one, and at what level.
 *
 * WHY THIS EXISTS
 * ---------------
 * The collector reads Greenhouse, Ashby and Lever boards in full every day,
 * and on the finance boards among them about 750 postings a day were thrown
 * away because they are not early career: associates at William Blair and
 * Lincoln, traders at IMC and Squarepoint, quantitative researchers at
 * Point72 and Jump. The L3VLUP Weekly has an "Experienced and lateral" stage
 * and the site maps `programmeType: 'Lateral / Experienced'` to it, so those
 * roles have somewhere to go. See docs/experienced-roles-plan-2026-10.md.
 *
 * The danger is volume. A finance firm's board is mostly not finance seats:
 * the same Point72 board carries the payroll associate, the AV support
 * specialist and the psychologist beside the portfolio managers, and a bank's
 * board is mostly branches. A screen that let "Associate" through on its own
 * would put JPMorgan's hundred-odd "Associate Banker, 30 Hours" branch postings
 * on the tracker beside its equity research associates. So this is built the
 * way the early-career rules are, precision first:
 *
 *   1. Exclusions run first and are never overridden: retail and branch
 *      banking, wealth advisers, operations, administration, HR and
 *      recruiting, legal and compliance, IT support and infrastructure,
 *      facilities, sales and marketing, internal finance, and anything too
 *      senior for the site (managing director, head of, partner, C-suite).
 *   2. Early-career titles are refused here too. They belong to the existing
 *      path, and a title that reached this function having failed it (a
 *      "2027 Full-Time Analyst", a "Junior Quant Researcher") is a campus or
 *      near-campus seat, and labelling it experienced would mislead.
 *   3. A relevant FUNCTION is required: banking and advisory, private markets,
 *      public-markets investing and research, trading and quant, corporate
 *      development. Software and data engineering count only at a trading or
 *      quant firm (`firmType: 'trading'`), where the engineers sit beside the
 *      desk; at a bank they are the bank's IT estate, which the early-career
 *      tracker does not list either.
 *   4. A LEVEL must be readable from the title. A finance word with no seat
 *      ("Mortgage Valuation Specialist") is not enough.
 *
 * The answer is a seat or null. Null is the safe answer: a role this does not
 * recognise is simply not published, which is what happened to all of them
 * before this existed.
 *
 * Pure, no imports, tested in scripts/__tests__/seniority.test.mjs.
 */

/** Buckets, in the order a per-firm ceiling keeps them (most specific first). */
export const SENIORITY_BUCKETS = [
  'mba-associate',
  'associate',
  'experienced-analyst',
  'vp',
  'investment-professional',
  'technologist',
];

/* ------------------------------- exclusions ------------------------------- */

/**
 * Retail and branch banking, and wealth advice sold to individuals. "Associate
 * Banker" is the JPMorgan branch seat that would otherwise be read as an
 * associate; "Client Associate" is a wealth-management sales assistant.
 */
const RETAIL =
  /\b(associate banker|relationship banker|private client (banker|advisor|adviser|associate|investment associate)|personal banker|universal banker|teller|branch|banking center|financial (advisor|adviser|consultant|planner)|wealth (advisor|adviser|planner|management advisor)|investment (advisor|adviser) representative|home lending|mortgage (advisor|adviser|loan officer|consultant)|loan officer|client associate|customer (service|care|support|success|experience)|call cent(er|re)|contact cent(er|re)|collections?|overdraft|card (services|acquisition)|small business (bank|card)|consumer (bank|lending))/i;

/**
 * Work that is not an investing, banking, trading or quant seat at any firm.
 * Matched on the title. "Trading" in "Trading Operations Analyst" or "Trade
 * Support" does not rescue the row: an operations seat on a trading floor is
 * still an operations seat.
 */
const NOT_A_SEAT =
  /\b(operations?|\bops\b|middle office|back office|mid office|trade support|trading support|settlements?|reconciliations?|onboarding|client (service|services|relations|reporting|onboarding|data|success)|investor relations|fund (accounting|accountant|administration|servicing|reporting)|asset servicing|custody|transfer agency|assistant(?! vice president)|coordinator|administrator|administrative|receptionist|secretary|office manager|concierge|hospitality|barista|meeting planning|planner|\bhr\b|human (resources|capital)|people (operations|partner|team)|recruit(er|ing|ment)?|talent|payroll|benefits|compensation|total rewards|learning (and|&) development|leadership development|counsel|attorney|lawyer|paralegal|legal|compliance|surveillance|\baml\b|\bkyc\b|financial crime|investigat(or|ions)|internal audit|auditor|audit|regulatory reporting|accountant|accounting|accounts payable|controller|product control|fp&a|\btax\b|treasury (accounting|operations)|procurement|sourcing|vendor|buyer|facilities|workplace|real estate (services|facilities)|help ?desk|service desk|desktop|end user|it support|it operations|technical support|support (engineer|analyst|specialist)|production support|application support|\bav\b|audio[\s-]?visual|network|storage|data (center|centre)|security|identity|\biam\b|privileged access|cloud|devops|devsecops|site reliab\w*|\bsre\b|reliab\w* engineer|technology services|threat|vulnerabilit\w*|observability|sdlc|techops|corvil|detection|sailpoint|enterprise (engineer|applications|systems)|modem|forward deployed|production engineer|infrastructure(?! invest)|platform (engineer|specialist)|linux|unix|windows|database (engineer|administrator)|\bdba\b|systems? (engineer|administrator|architect)|solutions? architect|architect|\bqa\b|quality assurance|tester|marketing|communications|social media|content|brand|public relations|\bpr\b|copywrit|graphic|designer|\bux\b|\bui\b|sales development|\bsdr\b|\bbdr\b|account (executive|manager|specialist)|business development|client portfolio manager|investment specialist|product specialist|relationship manager|institutional sales|regional sales|sales (director|manager|lead|associate|representative)|claims|underwrit|actuar|project manager|program(me)? manager|programme manager|product (manager|owner|management|delivery|lead|strategist)|delivery manager|scrum|agile|agility|change management|business (analyst|analysis|manager|management|partner|support)|chief of staff|psycholog|coach|instructor|trainer|teacher|nurse|driver|technician|engineering manager|people manager)\b/i;

/** Too senior for a site written for the first rungs. */
const TOO_SENIOR =
  /\b(managing director|\bmd\b|head(s)? of|director of|\bhead\b|partner|chief|\b(ceo|cfo|cto|coo)\b|\bcio\b(?! office)|(?<!vice[\s-])president|founder|general manager|country manager|senior managing)\b/i;

/**
 * Early-career and not-a-role titles. The first group belongs to the existing
 * path; the second is the noise the role screen drops later, refused here so
 * it never reaches the ceiling.
 */
const EARLY_OR_NOT_A_ROLE =
  /\b(intern|interns|internship|summer|graduate|graduates|grad|new[\s-]?grad|campus|student|apprentice|apprenticeship|trainee|placement|co-?op|junior|entry[\s-]?level|early[\s-]?careers?|first[\s-]?year|sophomore|freshman|fellow|fellowship|residency|rotational|class of|full[\s-]?time analyst|talent (community|pool|network)|expression of interest|interest form|networking|workshop|coffee chats?|sneak peek|academy|phd|postdoc|external contributors?|stagiaire|werkstudent|praktikant\w*|ausbildung|alternance|alternant)\b|\b20(2[6-9]|3\d)\b/i;

/**
 * A title that says it is for experienced hires outright. Point72 files its
 * experienced investment analyst programme under "Academy" with a cohort
 * year, both of which would otherwise read as early career.
 */
const EXPLICITLY_EXPERIENCED = /\bexperienced (professionals?|hires?)\b/i;

/** Job families that name a retail or advisory sales force (JPMorgan's "Associate Bankers"). */
const RETAIL_DEPARTMENT = /\b(bankers?|advisors?|advisers?|wealth advisory|client advisory|branch)\b/i;

/* -------------------------------- functions ------------------------------- */

/** Banking and advisory. "Valuations" is Lincoln's opinions practice. */
const BANKING =
  /\b(investment bank(ing|er)?|\bibd\b|m&a|mergers|\becm\b|\bdcm\b|equity capital markets|debt capital markets|capital markets|leveraged finance|acquisition finance|asset[\s-]backed finance|structured finance|restructuring|corporate finance|capital advisory|private capital (markets|advisory)|secondar(y|ies) advisory|financial sponsors?|sponsor coverage|coverage|transaction opinions|board advisory|portfolio valuations?|valuations? (and|&) opinions|fairness opinions?|debt advisory|special situations)\b/i;

/** Private markets. */
const PRIVATE_MARKETS =
  /\b(private equity|private credit|growth equity|venture|buyout|direct lending|credit opportunities|distressed|private investments?|principal investing|infrastructure invest\w*|real estate (acquisitions|investing|investments?|private equity|debt))\b/i;

/** Public-markets investing and research. */
const INVESTING =
  /\b(hedge fund|portfolio manag(er|ement)|portfolio analyst|equity research|credit research|research (analyst|associate)|investment (analyst|associate|professional|team)|sector analyst|fundamental (equit(y|ies)|research(er)?|analyst)|long[\s/-]?short|macro (analyst|research(er)?|strategist)|equity analyst|credit analyst|commodities (analyst|research)|stock selection|discretionary (macro|trader|investment)|global (equities|macro) investing|alpha (research(er)?|capture))\b/i;

/** Trading and quant. Quant developer counts here at any finance firm. */
const TRADING_QUANT =
  /\b(trader|traders|trading|sales (and|&) trading|sales[\s-]trader|\bs&t\b|quant|quants|quantitative|strategist|structur(er|ing)|market[\s-]making|delta one|execution (trader|strategist)|desk (quant|strategist)|microstructure|signals?|systematic)\b/i;

/** Corporate development and strategy, read only at a finance firm. */
const CORP_DEV = /\b(corporate development|corporate strategy|strategic finance)\b/i;

/**
 * Software and data engineering, counted only at a trading or quant firm.
 * Infrastructure, support and security titles were excluded above.
 */
const TECH =
  /\b(software (engineer|developer|development engineer)|developer|engineer|data scientist|data engineer|machine learning|\bml\b|deep learning|\bnlp\b|research (engineer|scientist)|researcher|fpga|low[\s-]latency|c\+\+|python|java|rust|kdb|full[\s-]?stack|front[\s-]?end|back[\s-]?end)\b/i;

/* --------------------------------- levels --------------------------------- */

const MBA = /\b(mba|post[\s-]?mba)\b/i;
const VP = /\b(vice president|\bvp\b|\bavp\b|\bsvp\b|\bed\b|executive director|director|principal)\b/i;
const ASSOCIATE = /\bassociate\b/i;
const EXPERIENCED_ANALYST =
  /\b(senior analyst|experienced analyst|analyst\s*(ii|iii|2|3)\b|investment banking senior analyst|senior (investment banking|m&a|research) analyst)\b|\banalyst\b/i;
/** A named investing, trading or research seat that carries its own level. */
const SEAT =
  /\b(portfolio manager|trader|traders|quant(itative)? (researcher|research|analyst|strategist|trader|developer|engineer)|quant|researcher|research analyst|investment analyst|investment professional|sector analyst|equity analyst|credit analyst|macro analyst|commodities analyst|fundamental (analyst|researcher)|strategist|structurer|analyst)\b/i;

const has = (re, s) => re.test(s);

/**
 * The seat a title describes, or null.
 *
 * @param {string} title
 * @param {{ department?: string, firmType?: 'trading' | 'finance' | null }} [ctx]
 *   `department` is read for exclusions only: JPMorgan files its branch seats
 *   under job families like "Associate Bankers", which is evidence against,
 *   never evidence for. `firmType` is 'trading' for trading and quant firms,
 *   'finance' for banks, advisers and asset managers, and anything else for a
 *   firm that is neither, at which no title qualifies.
 * @returns {{ seniority: string, function: string } | null}
 */
export function classifySeniority(title, ctx = {}) {
  const t = String(title ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  const firmType = ctx.firmType;
  if (firmType !== 'trading' && firmType !== 'finance') return null;
  const dept = String(ctx.department ?? '');

  // MBA associate titles carry a class year by design ("2027 Investment
  // Banking Full-Time MBA Associate"), so they are read before the
  // early-career refusal, and need a banking or investing function beside
  // them.
  const mba = has(MBA, t) && has(ASSOCIATE, t);

  if (has(RETAIL, t) || (dept && (has(RETAIL, dept) || has(RETAIL_DEPARTMENT, dept)))) return null;
  if (has(TOO_SENIOR, t)) return null;
  if (!mba && !has(EXPLICITLY_EXPERIENCED, t) && has(EARLY_OR_NOT_A_ROLE, t)) return null;

  // Exclusions on the title, with one carve-out: a quantitative risk or
  // modelling seat is a quant seat even where the department is risk.
  const quantRisk = /\bquant(itative)?\b.*\b(risk|model)/i.test(t) || /\b(risk|model)\w*\b.*\bquant(itative)?\b/i.test(t);
  if (has(NOT_A_SEAT, t) && !quantRisk) {
    // "Trading Engineer" and "Software Engineer, Trading Research" at a
    // trading firm are engineering seats that happen to mention trading; the
    // exclusion list never names software engineering, so only infrastructure
    // and support titles reach here and they stay excluded.
    return null;
  }
  if (dept && has(NOT_A_SEAT, dept) && !quantRisk && !/\b(trading|quant|research|investment|banking|markets)\b/i.test(dept)) return null;

  let fn = null;
  if (has(BANKING, t)) fn = 'banking';
  else if (has(PRIVATE_MARKETS, t)) fn = 'private-markets';
  else if (has(INVESTING, t)) fn = 'investing';
  else if (has(TRADING_QUANT, t)) fn = 'trading-quant';
  else if (has(CORP_DEV, t)) fn = 'corporate-development';
  else if (firmType === 'trading' && has(TECH, t)) fn = 'technology';
  if (!fn) return null;

  let seniority = null;
  if (mba) seniority = 'mba-associate';
  else if (has(VP, t)) seniority = 'vp';
  else if (has(ASSOCIATE, t)) seniority = 'associate';
  else if (fn === 'technology') seniority = 'technologist';
  else if ((fn === 'banking' || fn === 'private-markets' || fn === 'corporate-development') && has(EXPERIENCED_ANALYST, t)) seniority = 'experienced-analyst';
  else if (/\b(senior analyst|experienced analyst|analyst\s*(ii|iii|2|3))\b/i.test(t)) seniority = 'experienced-analyst';
  else if (has(SEAT, t)) seniority = 'investment-professional';
  // A trading firm's quant developer or engineer with no seat word of its own.
  else if (firmType === 'trading' && has(TECH, t)) seniority = 'technologist';
  if (!seniority) return null;

  // An MBA title with no banking or investing function ("MBA Associate,
  // Marketing") was refused above by the function test; one that names a
  // technology function only is not an MBA hire either.
  if (seniority === 'mba-associate' && fn === 'technology') return null;

  return { seniority, function: fn };
}

/** The programme type the feed carries for a seat. */
export function experiencedProgrammeType(seat) {
  return seat?.seniority === 'mba-associate' ? 'MBA Hire' : 'Lateral / Experienced';
}

/**
 * Tiers whose firms are hedge funds, for the one vertical fallback below.
 * Matches the registry's `tier` values.
 */
const FUND_TIERS = new Set(['Multi-Manager', 'Systematic']);

/**
 * The vertical an experienced row is published under, or null to drop it.
 *
 * inferVertical answers first and is trusted whenever it names a vertical.
 * When it falls back to 'Other', an experienced row is never published as
 * Other: the early-career path keeps such rows so the sweep can report them,
 * but a lateral row in Other is a page with no preparation path and no hub.
 *
 * Three readings are unambiguous enough to stand in for it, because the seat
 * function was matched on a phrase that names the business outright: a
 * banking phrase ("Capital Advisory", "Transaction Opinions") is investment
 * banking; a private-markets phrase is private equity; and an investing seat
 * ("Portfolio Manager", "Investment Analyst", "Sector Analyst") at a
 * multi-manager or systematic fund is a hedge fund seat. Anything else in
 * Other is dropped: "Business Strategist" or "Macro Analyst" at a market maker
 * could be several careers, and a guess would be worse than the absence.
 */
export function experiencedVertical(inferred, seat, tier) {
  if (inferred && inferred !== 'Other') return inferred;
  if (!seat) return null;
  if (seat.function === 'banking') return 'Investment Banking';
  if (seat.function === 'private-markets') return 'Private Equity';
  if (seat.function === 'investing' && FUND_TIERS.has(tier)) return 'Hedge Fund';
  return null;
}

/**
 * The firm type classifySeniority needs, from the registry's `tier`.
 *
 * 'trading' is where engineers sit beside the desk and count as seats;
 * 'finance' is every other bank, adviser, sponsor and asset manager; null is
 * a firm that is neither (technology, fintech, consulting), whose boards get
 * no experienced rows at all in this first phase.
 */
const TRADING_TIERS = new Set(['Trading Tech', 'Multi-Manager', 'Systematic', 'Prop Trading']);
const FINANCE_TIERS = new Set(['Bulge Bracket', 'Elite Boutique', 'Middle Market', 'Megafund', 'Asset Manager']);
export function firmTypeForTier(tier) {
  if (TRADING_TIERS.has(tier)) return 'trading';
  if (FINANCE_TIERS.has(tier)) return 'finance';
  return null;
}
