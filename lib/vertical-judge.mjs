// What to ask about a role the rules could not place, and when to believe it.
//
// Pure. Nothing here calls anything, so the whole policy — the options, the
// wording of each, the cutoff and the direction the errors are allowed to run
// — can be read and tested in one file without a key.
//
// THE PROBLEM THIS ADDRESSES
// --------------------------
// `inferVertical` in `scripts/sync-ats.mjs` is an ordered cascade of regular
// expressions over the job title. It is fast, free and auditable, and for the
// titles a bank publishes it is right. For everything else it returns `Other`,
// which on the September board is 363 rows of 1,386: a quarter of the tracker
// arrives with no vertical at all, and the filters that are the point of the
// tracker cannot see any of it.
//
// Some of that quarter is correct. "Employee and Workplace Experience Intern"
// belongs in no finance or technology vertical and should stay where it is.
// Some of it is the gap the classifier names in its own comment: a bare
// "Investment Analyst" is genuinely ambiguous across funds, corporates and
// asset managers, and no regular expression over a title can settle it.
//
// WHY THIS IS TWO QUESTIONS AND NOT ONE
// -------------------------------------
// A Choice always picks something. Handed 22 verticals and a facilities role,
// it returns the least bad of 22 wrong answers, and the distribution may even
// be concentrated, because one of them really is closest. So the Choice
// settles *which* vertical, and a separate yes/no settles *whether* the role
// belongs to any of them. Both are asked in the same request, over the same
// state, and code reads them together. Neither can answer the other's
// question.
//
// WHICH WAY THE ERRORS RUN
// ------------------------
// `sync-ats.mjs` says it plainly: guessing a vertical is worse than leaving
// the row visible in the Other report. So this judge:
//
//   - only ever looks at rows already classified `Other`;
//   - never overrides a rule that fired;
//   - can only ever move a row out of `Other`, never between two verticals;
//   - declines unless the role reads as in scope AND the choice is
//     concentrated, and a declined row stays exactly where it was.
//
// A row this judge declines is no worse off than it is today. That is the
// property that makes the whole thing safe to run at all, and it is what the
// suite checks first.

/**
 * Bumped whenever an option's wording, the instruction or the cutoff changes.
 * An answer is only comparable with another asked the same way.
 */
export const JUDGE_VERSION = '2026-09-21.1';

/**
 * The cutoff, and the reason it is high.
 *
 * TypeSafe's own worked example on SEC filings reports that a 0.9 cutoff over
 * 75 industry groups splits the set roughly in half, with the confident half
 * right about 90% of the time and the rest about 40%. Those are their numbers
 * on their data, not a promise about this one. They are a reason to start high
 * and measure, which is what `scripts/vertical-eval.mjs` is for: it reports
 * agreement at several cutoffs so this number can be set from evidence rather
 * than from a cookbook.
 */
export const CONFIDENT = 0.9;

/** Below this the role reads as belonging to no covered vertical at all. */
export const IN_SCOPE = 0.7;

/**
 * The verticals, each with the line that tells them apart.
 *
 * Written from the rules in `inferVertical` so the two cannot drift into
 * disagreeing about what a word means, and checked against `data/taxonomy.json`
 * by the suite: a vertical the collector declares and this file does not
 * describe would be one the judge could never assign, silently.
 *
 * `Other` is deliberately absent. It is not an option the model picks; it is
 * what a row keeps when the answer is not good enough, which is a decision
 * this file makes in code.
 */
export const VERTICAL_CRITERIA = Object.freeze({
  'Investment Banking':
    'Advising companies on mergers, acquisitions, disposals and raising capital, and executing those transactions. Includes coverage, M&A and the financing product groups.',
  'Private Equity':
    'Buying whole companies with a fund, owning them and selling them later. Includes buyout and growth buyout investing.',
  'Hedge Fund':
    'Investing a fund in public securities with a view that can be long or short, including multi-strategy and long/short equity seats.',
  'Equity Research':
    'Forming and publishing a view on what listed securities are worth, whether for clients of a bank or for a fund internally.',
  'Corporate Development':
    'Doing mergers, acquisitions and strategic investments from inside an operating company rather than for a client.',
  Quant:
    'Building the mathematical or statistical models that price instruments, find signals or manage risk. Quantitative research, quantitative trading and quantitative development.',
  'FinTech Sales':
    'Selling financial software, market data or trading infrastructure to institutions.',
  'Sales & Trading':
    'Making markets in securities, executing client flow and taking positions on a trading floor. Includes global markets and the individual asset-class desks.',
  'Corporate Banking':
    'Lending to and banking companies as clients: relationship management, transaction banking, cash management and corporate lending.',
  'Asset Management':
    'Managing pooled investments for clients under a long-only or institutional mandate, including fund management and investment operations at an asset manager.',
  'Wealth Management':
    'Advising individuals and families on their money. Includes private banking and financial planning.',
  'Private Credit':
    'Lending privately rather than through public markets: direct lending, leveraged finance and credit investing.',
  'Venture Capital':
    'Investing a fund in early-stage private companies.',
  Risk: 'Measuring and controlling the risk a financial firm carries: credit, market, operational, model or liquidity risk.',
  'Compliance & Legal':
    'Keeping a firm inside its rules and its law: compliance, financial crime, regulatory affairs, legal counsel.',
  'Finance & Accounting':
    'The firm reporting on itself: financial control, reporting, audit, tax, treasury, FP&A.',
  Operations:
    'Running the processes behind a transaction after it is agreed: settlement, clearing, client onboarding, middle and back office.',
  'Software Engineering':
    'Writing, testing and running software or the infrastructure it runs on. Includes security engineering, platform and site reliability work.',
  'Product Management':
    'Deciding what a software product should do and for whom. Includes product design and user research where the seat sits inside a product organisation.',
  'Data & ML':
    'Working with data as the product: data engineering, analytics engineering, data science and applied machine learning on a company’s own data.',
  'AI Research':
    'Advancing what models can do, as research: training, evaluating and publishing on models themselves.',
  'AI Engineering':
    'Building applications and systems on top of existing models, rather than researching the models.',
});

/** Every vertical the judge may assign, in a stable order. */
export const JUDGED_VERTICALS = Object.freeze(Object.keys(VERTICAL_CRITERIA));

/**
 * The state one row is judged on.
 *
 * The title, the firm, what kind of firm it is and where it is, and nothing
 * else. Jev loses accuracy as the state fills with material the question does
 * not need, and a job posting's body is mostly benefits, equal-opportunity
 * boilerplate and a description of the company. The four fields here are what
 * a person reads to answer this question too.
 */
export function judgeState(row) {
  return {
    title: String(row.role ?? row.title ?? '').slice(0, 300),
    firm: String(row.firm ?? '').slice(0, 120),
    firmKind: String(row.tier ?? '').slice(0, 60) || null,
    location: String(row.location ?? '').slice(0, 120) || null,
  };
}

/**
 * The two questions, asked over one row's state.
 *
 * Both go in the same request. Jev reads the state once and answers every
 * question in the request against it in parallel, so a second question costs
 * its own wording and not a second copy of the row.
 */
export function judgeQuestions() {
  return {
    inScope: {
      type: 'noul',
      instructions:
        'Is the job named in `title` a role in finance, investing, or technology, rather than a role supporting the firm itself?',
      criteria: {
        true: 'The work is finance, investing, trading, risk, banking, software, data, or research into any of those.',
        false:
          'The work is human resources, recruiting, workplace or facilities, office management, marketing, communications, sales of a non-financial product, administration, or another function a company of any kind would have.',
      },
    },
    vertical: {
      type: 'choice',
      instructions:
        'Which of these areas does the job named in `title` at the firm named in `firm` belong to?',
      criteria: { ...VERTICAL_CRITERIA },
    },
  };
}

/**
 * What to do with one row's answers.
 *
 * Returns the vertical to write, which is `Other` unless everything agrees,
 * along with the reason and the raw numbers. The numbers are kept so a cutoff
 * can be moved later without asking anything again.
 */
export function decideVertical(
  { inScope, choice, probabilities, confidence },
  { confident = CONFIDENT, inScopeFloor = IN_SCOPE } = {},
) {
  const signals = { inScope, confidence, choice: choice ?? null, probabilities: probabilities ?? null };
  const stay = (reason) => ({ vertical: 'Other', changed: false, reason, ...signals, version: JUDGE_VERSION });

  if (inScope === null || inScope === undefined) return stay('no-scope-reading');
  if (choice === null || choice === undefined) return stay('no-choice');
  if (!Object.hasOwn(VERTICAL_CRITERIA, choice)) return stay('choice-outside-taxonomy');
  if (inScope < inScopeFloor) return stay('out-of-scope');
  if (!Number.isFinite(confidence) || confidence < confident) return stay('not-confident-enough');

  return { vertical: choice, changed: true, reason: 'assigned', ...signals, version: JUDGE_VERSION };
}

/**
 * The rows a judge is allowed to look at.
 *
 * Only `Other`, and only rows carrying a title. A row the rules placed is not
 * re-examined: this can add a vertical where there was none and can do nothing
 * else, which is the property that makes it safe to run against the live feed.
 */
export function judgeable(rows) {
  return (Array.isArray(rows) ? rows : []).filter(
    (r) => r && r.vertical === 'Other' && String(r.role ?? r.title ?? '').trim().length > 0,
  );
}

/**
 * Agreement between two labellings of the same rows, as counts.
 *
 * Used by the evaluation harness to check the judge against the rules on the
 * rows the rules *did* place, which is the only ground truth available without
 * somebody labelling a set by hand. Agreement there is not proof it is right
 * about the rows the rules could not place, and the harness says so; it is
 * evidence that it understands the taxonomy the same way.
 */
export function agreement(pairs) {
  const counts = { total: 0, agreed: 0, disagreed: 0, declined: 0, byVertical: {} };
  for (const { expected, got, changed } of pairs) {
    counts.total += 1;
    const bucket = (counts.byVertical[expected] ??= { total: 0, agreed: 0, disagreed: 0, declined: 0 });
    bucket.total += 1;
    if (!changed) {
      counts.declined += 1;
      bucket.declined += 1;
    } else if (got === expected) {
      counts.agreed += 1;
      bucket.agreed += 1;
    } else {
      counts.disagreed += 1;
      bucket.disagreed += 1;
    }
  }
  const decided = counts.agreed + counts.disagreed;
  counts.accuracyWhenDecided = decided ? counts.agreed / decided : null;
  counts.coverage = counts.total ? decided / counts.total : null;
  return counts;
}
