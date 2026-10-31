/**
 * What each collection run is allowed to publish, and what each file has to
 * look like before it may replace a good one.
 *
 * WHY THIS IS A SEPARATE FILE
 * ---------------------------
 * A ruleset closed direct pushes to `main` on 18 September. `build-samples`
 * was adapted to open a pull request instead; the other two publishers were
 * not, and the interesting part is how that looked from the outside. The
 * collection of open data went on reporting success every morning while its
 * push was refused, so the economic calendar, the deal tape and the news map
 * sat two days stale behind a green tick. A run that fails loudly is a
 * nuisance. A run that fails quietly is a lie about the data.
 *
 * So all three producers now travel the same road, and the gate that decides
 * what may travel it is one engine reading one table. This file is the table.
 *
 * WHY NOT ONE SET OF THRESHOLDS
 * -----------------------------
 * The tracker's numbers are the tracker's. An economic calendar is a rolling
 * two-week window that legitimately halves on a Friday and doubles on a
 * Monday; the board-book index only ever grows, because it is an index of
 * filings that happened; the CUSIP map is rebuilt monthly and is correct
 * while it is stale. Applying the tracker's "no more than 40% down" to any of
 * those would either block a normal day or wave through a broken one. Each
 * file therefore carries the checks that are true of it, and the reason is
 * written beside the number rather than left to be inferred.
 *
 * Pure data and pure functions, so the whole contract runs offline in
 * scripts/__tests__/publication-contracts.test.mjs.
 */

/**
 * The check vocabulary, which is deliberately small:
 *
 *   path         the file, exactly
 *   label        what it is, for the pull request body and the error
 *   rows         the key holding the array, when the file is a list
 *   keyed        the key holding an object whose entries are the rows, when
 *                the file is keyed by id rather than listed (counted only)
 *   min          the fewest rows worth publishing over yesterday's copy
 *   minRatio     how far the count may fall in one run, as a fraction
 *   maxRatio     and how far it may rise
 *   required     fields every row must carry, because the site indexes by them
 *   stamp        the field carrying the collector's own generation time
 *   maxAgeHours  how old that stamp may be before the file is a leftover
 *   groups       {by, floor, minRatio}: no category of this size may halve.
 *                With `freshBaselineOnly`, the comparison is only made when
 *                the last published copy is itself inside `maxAgeHours`; see
 *                the note on the news map below
 *   neverShrinks the file is an accumulating index; losing rows is a defect
 *   optional     the producing step does not run every cycle, so absence is
 *                normal and only a file that IS staged is checked
 *   shapeOnly    bookkeeping this repository writes and nothing renders: it
 *                must parse, and nothing more is claimed about it
 */

/** Tracker fields the site indexes a row by. A row missing one renders wrong. */
const TRACKER_FIELDS = ['id', 'firm', 'role', 'vertical', 'programmeType', 'location', 'region', 'level', 'status'];

export const CONTRACTS = {
  /**
   * build-samples.yml. Unchanged from the gate merged in #57: the numbers
   * here are the numbers that release was reviewed against.
   */
  tracker: {
    label: 'the daily tracker collection',
    branch: 'automation/daily-data-refresh',
    title: 'chore(data): daily collection',
    files: [
      {
        path: 'data/opportunities.auto.json', freshness: { cadence: 'daily', required: true, from: 'generatedAt' },
        label: 'the tracker feed',
        rows: 'opportunities',
        min: 200,
        minRatio: 0.6,
        maxRatio: 2.0,
        required: TRACKER_FIELDS,
        stamp: 'generatedAt',
        maxAgeHours: 24,
        groups: { by: 'vertical', floor: 20, minRatio: 0.5 },
      },
      { path: 'data/tracker-slugs.json', freshness: { cadence: 'daily', from: 'generatedAt' }, label: 'the slug registry', shapeOnly: true },
      { path: 'data/tracker-archive.json', freshness: { cadence: 'daily', from: 'generatedAt' }, label: 'the archive of published URLs', shapeOnly: true },
      { path: 'data/tracker-history.json', freshness: { cadence: 'manual' }, label: 'the board history', shapeOnly: true },
      // One file per run day, written once and never rewritten: what each
      // board check established (ok / partial / failed). See lib/board-checks.mjs.
      // `immutable`: once a date is on main it is the day's observation. A
      // same-day rerun still refreshes the feed, but may not replace the
      // observation, so the Hiring Pulse never gets to keep the most
      // favourable of several reads of one day (see immutableProblems).
      { pattern: /^data\/board-checks\/\d{4}-\d{2}-\d{2}\.json$/, label: 'the day\'s board checks', immutable: true },
      { path: 'data/deadlines.learned.json', freshness: { cadence: 'daily', from: 'updatedAt' }, label: 'the deadline ledger', shapeOnly: true },
      { path: 'data/econ.auto.json', freshness: { cadence: 'daily', required: true, from: 'generatedAt' }, label: 'the economic backdrop', shapeOnly: true },
      { path: 'data/erp.auto.json', freshness: { cadence: 'daily', required: true, from: 'generatedAt' }, label: 'equity and country risk premiums', shapeOnly: true },
      { pattern: /^samples\/[A-Za-z0-9._-]+\.xlsx$/, label: 'a sample workbook', binary: true },
    ],
  },

  /**
   * collect.yml. Three cadences in one workflow, which is why almost
   * everything here is optional: a Tuesday run writes the calendar, the deal
   * tape and the news map and touches nothing else, and a gate that demanded
   * a fresh macro chartbook every morning would refuse every Tuesday.
   */
  'open-data': {
    label: 'the open-data collection',
    branch: 'automation/open-data-refresh',
    title: 'chore(data): open data',
    files: [
      {
        path: 'data/calendar.auto.json', freshness: { cadence: 'daily', required: true, from: 'generatedAt' },
        label: 'the economic calendar',
        rows: 'events',
        min: 8,
        // A rolling two-week window of scheduled releases. It genuinely
        // thins towards a holiday and fills again after one, so the band is
        // wide on purpose; what it is really catching is a feed that came
        // back empty or a parser that started duplicating.
        minRatio: 0.35,
        maxRatio: 3.0,
        required: ['date', 'title', 'country', 'source', 'url'],
        stamp: 'generatedAt',
        maxAgeHours: 36,
        optional: true,
      },
      {
        path: 'data/deals.auto.json', freshness: { cadence: 'daily', required: true, from: 'generatedAt' },
        label: 'the deal tape',
        rows: 'items',
        min: 20,
        minRatio: 0.5,
        maxRatio: 2.5,
        // dealValue is absent on plenty of announcements and that is honest,
        // so it is not required. A row with no link is not a deal tape entry.
        required: ['date', 'title', 'link', 'source'],
        stamp: 'generatedAt',
        maxAgeHours: 36,
        optional: true,
      },
      {
        path: 'data/newsflow.auto.json', freshness: { cadence: 'daily', required: true, from: 'generatedAt' },
        label: 'the news map',
        rows: 'items',
        min: 40,
        minRatio: 0.5,
        maxRatio: 2.5,
        required: ['date', 'title', 'link', 'source', 'vertical'],
        stamp: 'generatedAt',
        maxAgeHours: 36,
        // The map is read by vertical, so one wire going dark and taking a
        // whole vertical with it is the failure worth catching.
        //
        // Only against a baseline that is itself fresh. The collector builds
        // its rolling week by merging each run with the last published copy.
        // After an outage that copy is older than the week, contributes
        // nothing, and today's map is one day of items judged against a week
        // of them. On 25 September, a week after the last publication, capital
        // raises read 26 -> 9 with every capital-raise feed answering, and the
        // refusal kept the week-old copy as the baseline for the next run too,
        // so the map could never publish again. A copy older than this file's
        // own `maxAgeHours` is one the contract would refuse as a leftover; it
        // is not evidence that a wire went dark. The comparison resumes the
        // day after the first publication, and every other check still runs.
        groups: { by: 'vertical', floor: 15, minRatio: 0.5, freshBaselineOnly: true },
        optional: true,
      },
      {
        path: 'data/macro.auto.json', freshness: { cadence: 'weekly', required: true, from: 'generatedAt' },
        label: 'the macro chartbook',
        rows: 'series',
        min: 8,
        // A curated list of series, not a feed. The count should be flat;
        // anything else means a series was silently dropped or duplicated.
        minRatio: 0.9,
        maxRatio: 1.1,
        required: ['id', 'name', 'points', 'unit', 'country', 'sourceName', 'url'],
        stamp: 'generatedAt',
        // Weekly, so a week and a day.
        maxAgeHours: 200,
        // A series with one point draws no line. This is the check that would
        // catch FRED answering with an empty observation set.
        eachRow: { key: 'points', minLength: 2 },
        optional: true,
      },
      {
        path: 'data/decks.auto.json', freshness: { cadence: 'weekly', required: true, from: 'generatedAt' },
        label: 'the board-book index',
        rows: 'transactions',
        min: 100,
        // An index of filings that have already happened. It only grows.
        neverShrinks: true,
        maxRatio: 1.5,
        required: ['id', 'announced'],
        stamp: 'generatedAt',
        maxAgeHours: 200,
        optional: true,
      },
      {
        path: 'data/cusip-tickers.auto.json', freshness: { cadence: 'monthly', from: 'generatedAt' },
        label: 'the CUSIP to ticker map',
        // Monthly, and a stale map is still a correct one, so freshness is
        // deliberately not checked here. What matters is that it never
        // shrinks: a mapping is only ever added.
        neverShrinks: true,
        optional: true,
      },
      {
        path: 'data/precedent-transactions.auto.json', freshness: { cadence: 'monthly', from: 'generatedAt' },
        label: 'the precedent transactions database',
        neverShrinks: true,
        optional: true,
      },
      { path: 'data/funds.auto.json', freshness: { cadence: 'monthly', from: 'generatedAt' }, label: '13F holdings', neverShrinks: true, optional: true },
      // The long 13F record (scripts/funds_history.py): one folder per manager,
      // an index the pages read and one file per year of full positions. A
      // history accumulates, so a run that lost quarters is refused; a run
      // that changed nothing writes nothing, so absence is normal.
      {
        pattern: /^data\/funds\/history\/[a-z0-9-]+\/index\.json$/,
        label: 'a manager\'s 13F history',
        rows: 'quarters',
        min: 1,
        required: ['quarter', 'periodOfReport', 'cik', 'accession', 'aumK', 'signature'],
        neverShrinks: true,
        optional: true,
      },
      {
        pattern: /^data\/funds\/history\/[a-z0-9-]+\/\d{4}\.json$/,
        label: 'a year of a manager\'s 13F positions',
        keyed: 'quarters',
        min: 1,
        neverShrinks: true,
        optional: true,
      },
      {
        // Who held each symbol, quarter by quarter: the stock pages' half of
        // the same record. One file per symbol two or more managers listed.
        pattern: /^data\/funds\/by-ticker\/[A-Z0-9][A-Z0-9.-]{0,9}\.json$/,
        label: 'a symbol\'s 13F ownership history',
        keyed: 'quarters',
        min: 1,
        neverShrinks: true,
        optional: true,
      },
      {
        // Which managers' books are most like each manager's, written from the
        // same record. A manager's peer list can shrink honestly (a peer that
        // has not filed the latest quarter is not compared), so no floor.
        pattern: /^data\/funds\/overlap\/[a-z0-9-]+\.json$/,
        label: 'a manager\'s overlap with other managers',
        rows: 'peers',
        min: 0,
        optional: true,
      },
      {
        path: 'data/funds/securities.json', freshness: { cadence: 'monthly', from: 'generatedAt' },
        label: 'the 13F security register',
        keyed: 'securities',
        min: 1,
        neverShrinks: true,
        stamp: 'generatedAt',
        optional: true,
      },
      // The quarterly EDGAR form index the precedent collector reads merger
      // proxies from, kept so a closed quarter is read once. Committed since
      // #29 and rewritten by every monthly run, but missing from this list,
      // so every monthly run refused to publish anything at all.
      { path: 'data/merger-index.auto.json', freshness: { cadence: 'monthly', from: 'generatedAt' }, label: 'the merger-proxy form index', shapeOnly: true, optional: true },
      { path: 'data/funds.universe.json', freshness: { cadence: 'manual' }, label: 'the 13F manager universe', shapeOnly: true, optional: true },
      {
        path: 'data/peers.auto.json', freshness: { cadence: 'monthly', from: 'generatedAt' },
        label: 'the industry peer lists',
        // Counted by industry. This used to say neverShrinks with nothing to
        // count but the file's five top-level keys, which could never fail.
        // An industry leaves the file only when a fresh crawl finds no filers
        // under it at all, which is rare and honest, so the floor is a ratio
        // rather than a ban: what it catches is a run that lost the crawl
        // record and wrote the handful of industries it managed to reach.
        keyed: 'industries',
        min: 400,
        minRatio: 0.95,
        stamp: 'generatedAt',
        optional: true,
      },
      {
        path: 'data/peers-crawl.auto.json', freshness: { cadence: 'monthly', from: 'generatedAt' },
        label: 'the industry peer crawl record',
        // What each industry's EDGAR crawl found, so a monthly run re-reads
        // only the industries most overdue and fits inside its step. An
        // industry's record is replaced, never removed: a failed crawl keeps
        // the last one. So the count only grows.
        keyed: 'industries',
        min: 400,
        neverShrinks: true,
        stamp: 'generatedAt',
        optional: true,
      },
      { path: 'data/career-snapshots.json', freshness: { cadence: 'daily', from: 'commit' }, label: 'the careers-page snapshots', shapeOnly: true, optional: true },
      { path: 'data/career-review-queue.json', freshness: { cadence: 'daily', from: 'generatedAt' }, label: 'the careers review queue', shapeOnly: true, optional: true },
    ],
  },

  /**
   * market-reference.yml. IEX reference prices: the latest dated price per
   * stock with its 52-week figures, and one price a week per stock for the
   * range chart. Never the daily database, which stays in the collector's
   * cache (docs/market-reference.md).
   */
  'market-reference': {
    label: 'the IEX reference prices',
    branch: 'automation/market-reference',
    title: 'chore(data): IEX reference prices',
    files: [
      {
        path: 'data/market-reference.auto.json',
        // Read every weekday morning, but IEX publishes only trading days, so
        // the file legitimately stands still from Saturday to Tuesday, and to
        // Wednesday after a Monday holiday: about a hundred hours.
        freshness: { cadence: 'daily', required: true, from: 'generatedAt', maxAgeHours: 130 },
        label: 'the IEX reference prices',
        keyed: 'symbols',
        // Several thousand listed stocks and funds trade on IEX every day. A
        // file with a few hundred is a reader or a capture gone wrong.
        min: 1000,
        // The count moves with listings and with names crossing the quality
        // gate, a few per cent a day. A third gone is not that.
        minRatio: 0.7,
        maxRatio: 1.5,
        stamp: 'generatedAt',
        maxAgeHours: 130,
        // A run that read no new day writes nothing.
        optional: true,
      },
      {
        // One shard per first letter of the symbol.
        pattern: /^data\/market-history\/[A-Z]\.auto\.json$/,
        label: 'a letter of the weekly IEX reference-price history',
        keyed: 'symbols',
        min: 1,
        stamp: 'generatedAt',
        maxAgeHours: 130,
        optional: true,
      },
    ],
  },

  /**
   * fx-rates.yml. One file, written once a week: the ECB euro reference
   * rates re-based to the US dollar, which the site converts pay and career
   * reference figures with (never a price, never a company model). The
   * script has already refused anything that is not fit (lib/fx-rates.mjs:
   * both currencies, positive finite rates, a real date no later than today
   * and no older than ten days, no rate more than 20% from the published
   * one); this gate holds the file to its shape again and to its stamp.
   */
  'fx-rates': {
    label: 'the ECB exchange rates',
    branch: 'automation/fx-rates',
    title: 'chore(data): ECB exchange rates',
    files: [
      {
        path: 'data/fx.auto.json',
        // Weekly, read from the rate's own date. The ECB publishes on working
        // days only and a Monday holiday leaves the previous Friday's rate in
        // place, so the file is legitimately up to ten days older than the
        // run that wrote it. 264 hours is eleven days: a week, plus the
        // script's own ten-day limit on a rate's age, minus a day of grace
        // that a holiday week does not need. Two missed Mondays go past it.
        freshness: { cadence: 'weekly', required: true, from: 'asOf', maxAgeHours: 264 },
        label: 'the exchange-rate table',
        // USD, EUR and GBP per US dollar.
        keyed: 'perUsd',
        min: 3,
        // The collector's own stamp: set by the run that wrote the file, so a
        // leftover from an earlier run cannot be republished as this one's.
        stamp: 'fetchedAt',
        maxAgeHours: 48,
      },
    ],
  },

  /**
   * discover-ats.yml. Manual, and it only ever adds: a firm resolves to a
   * board and moves into the registry, where the daily sync polls it. A run
   * that removed entries would silently stop the tracker collecting from
   * those firms, and nothing else in the repository would notice.
   */
  'ats-registry': {
    label: 'the discovered ATS boards',
    branch: 'automation/ats-registry',
    title: 'chore(tracker): boards resolved by discovery',
    files: [
      {
        path: 'lib/sources/ats-registry.json', freshness: { cadence: 'manual' },
        label: 'the board registry',
        neverShrinks: true,
        maxRatio: 1.5,
      },
      { path: 'data/ats-discovery.json', freshness: { cadence: 'manual' }, label: 'the discovery report', shapeOnly: true },
    ],
  },

  /**
   * this-week-draft.yml. One file, written every Thursday: the deterministic
   * shortlist, the one model call's result (or its failure, by name) and the
   * cartoon brief, for the editor to read on the site at /this-week/draft.
   * Shape only: a draft is text for a person, and a week with a failed model
   * stage still publishes, marked, so the editor sees the failure.
   */
  'this-week-draft': {
    label: 'the This Week draft',
    branch: 'automation/this-week-draft',
    title: 'chore(editorial): This Week draft',
    files: [
      { path: 'data/this-week.draft.json', freshness: { cadence: 'weekly', required: true, from: 'generatedAt' }, label: 'the weekly draft', shapeOnly: true },
    ],
  },
};

/**
 * How old a file of each cadence may be before its collector has stopped
 * working, in hours.
 *
 * A daily source gets 36 hours, which is the number that makes the difference
 * between one miss and a pattern. A collector that fails this morning and
 * succeeds tomorrow never trips it; one that fails twice running does. That
 * is the behaviour asked for and it is the reason the horizon is not 24.
 *
 * Weekly gets eight days and a bit, so a run that slips a day is not a
 * failure. Monthly gets forty-five, which covers a month plus the fortnight a
 * quarterly filing can take to arrive.
 *
 * Weekends and market holidays need no allowance here, and it is worth saying
 * why rather than leaving it to be rediscovered. These stamps are collection
 * times, not data times: `sync-calendar` rewrites `generatedAt` on a Sunday
 * exactly as it does on a Tuesday, whether or not any event moved. A source
 * that genuinely only publishes on weekdays still gets read daily, so its
 * file is still rewritten daily. The one place the distinction bites is
 * `from: 'commit'` below.
 */
export const HORIZON_HOURS = { daily: 36, weekly: 200, monthly: 1100 };

/**
 * What a file's freshness is read from.
 *
 *   'generatedAt', 'updatedAt'   the collector's own stamp, rewritten every
 *                                run. A reliable heartbeat: if the stamp is
 *                                old, the collector did not run or did not
 *                                finish.
 *   'commit'                     the file's last commit date, for the few
 *                                files that carry no stamp. This conflates
 *                                "the collector ran" with "the data changed",
 *                                so a quiet week looks identical to a broken
 *                                collector. Files read this way are therefore
 *                                never `required`: they can degrade a run,
 *                                never fail it.
 */

/** The five states a source can be in. */
export const FRESHNESS_STATES = ['fresh', 'degraded', 'stale', 'not-due', 'manual'];

/**
 * The state of one file, from the copy that is on disk.
 *
 * `committedAt` is the file's last commit time, supplied by the caller
 * because reading it means shelling out to git and this module stays pure.
 *
 * `expectedSince` is set when this run's collector for the file was due and
 * ran, and is the time the collection began. The horizon alone answers "has
 * this been collected lately", which for a monthly source means a collector
 * can fail on the first of the month and read as not-due for another six
 * weeks. That is how the peer lists timed out on a green step: ninety minutes,
 * no file, and a table that said all was well. When a collector was due and
 * the stamp on disk predates the run, the collector did not finish, and that
 * is said this morning rather than in November.
 */
export function fileFreshness(spec, value, committedAt, now = new Date(), expectedSince = null) {
  const f = spec.freshness ?? { cadence: 'manual' };
  const base = { path: spec.path, label: spec.label, cadence: f.cadence, required: Boolean(f.required) };

  if (f.cadence === 'manual') {
    return { ...base, state: 'manual', note: 'written by hand or on demand; no schedule to be late for' };
  }
  if (value === undefined) {
    // A required file that is not there at all is worse than a stale one.
    return f.required
      ? { ...base, state: 'stale', note: 'required, and not present in the repository' }
      : { ...base, state: 'degraded', note: 'not present in the repository' };
  }
  if (value === null) {
    return { ...base, state: f.required ? 'stale' : 'degraded', note: 'present but not readable JSON' };
  }

  const raw = f.from === 'commit' ? committedAt : value?.[f.from];
  const stamp = raw ? new Date(raw) : null;
  if (!stamp || Number.isNaN(stamp.getTime())) {
    return { ...base, state: f.required ? 'stale' : 'degraded', note: `no readable ${f.from}` };
  }

  const ageHours = (now.getTime() - stamp.getTime()) / 3_600_000;
  const horizon = f.maxAgeHours ?? HORIZON_HOURS[f.cadence];
  const at = { ...base, lastSuccess: stamp.toISOString(), ageHours: Math.round(ageHours) };

  // Degraded, never stale, while the file is inside its horizon: one missed
  // run is worth a warning, and the horizon is still what decides blocking.
  // Past the horizon the ordinary verdict below already says more.
  if (expectedSince && ageHours <= horizon && stamp.getTime() < new Date(expectedSince).getTime()) {
    return {
      ...at,
      state: 'degraded',
      horizon,
      note: `due this run and not written by it; the copy on disk is ${Math.round(ageHours)}h old`,
    };
  }

  if (ageHours <= horizon) {
    // Old and not overdue is worth saying out loud. A 13F file collected
    // three weeks ago is doing exactly what a monthly source does, and an
    // operator scanning the table should not have to work that out from the
    // cadence column. Anything a daily source would already have refreshed,
    // but a slower one would not, reads as not-due rather than fresh.
    const notDue = f.cadence !== 'daily' && ageHours > HORIZON_HOURS.daily;
    return { ...at, state: notDue ? 'not-due' : 'fresh', horizon };
  }
  return {
    ...at,
    state: f.required ? 'stale' : 'degraded',
    horizon,
    note: `${Math.round(ageHours)}h since the last successful collection, past its ${horizon}h horizon`,
  };
}

/**
 * Every file a producer owns, whether or not this run touched it.
 *
 * This is the half the publication gate cannot see. The gate checks what is
 * being published; a collector that fails every morning publishes nothing and
 * the gate has nothing to object to, while the committed file ages behind a
 * green tick. That is the same defect as a silently refused push, one step
 * earlier in the pipeline, and it is what this answers.
 */
export function freshnessReport(producer, { read, committedAt, expected = [], since = null }, now = new Date()) {
  const contract = CONTRACTS[producer];
  if (!contract) return { sources: [], blocking: true, degraded: false, problems: [`no publication contract named ${producer}`] };

  const sources = contract.files
    .filter((spec) => spec.path)
    .map((spec) =>
      fileFreshness(spec, read(spec.path), committedAt(spec.path), now, since && expected.includes(spec.path) ? since : null),
    );

  const stale = sources.filter((s) => s.state === 'stale');
  const degraded = sources.filter((s) => s.state === 'degraded');
  return {
    sources,
    blocking: stale.length > 0,
    degraded: degraded.length > 0,
    problems: stale.map((s) => `${s.label} is stale: ${s.note ?? ''}`.trim()),
  };
}

/** A label written for the middle of a sentence, used at the start of one. */
const sentence = (t) => t.charAt(0).toUpperCase() + t.slice(1);

/** The operator's table: every source, its state, and when it last worked. */
export function freshnessSummary(producer, report) {
  const icon = { fresh: '🟢', degraded: '🟡', stale: '🔴', manual: '⚪', 'not-due': '⚪' };
  const lines = [
    // The labels read as sentence fragments ("the open-data collection")
    // because that is how they read inside an error message. As a heading
    // they need the capital.
    `### ${sentence(CONTRACTS[producer]?.label ?? producer)}: source freshness`,
    '',
    report.blocking
      ? '**A required source is stale.** The healthy sources below are still published; the run is failed so this is not mistaken for a working morning.'
      : report.degraded
        ? '**An optional source is degraded.** Publication continues; nothing here blocks it.'
        : 'Every source is within its horizon.',
    '',
    '| | Source | Cadence | State | Last successful collection | Age |',
    '|---|---|---|---|---|---:|',
  ];
  for (const s of report.sources) {
    lines.push(
      `| ${icon[s.state] ?? ''} | ${s.label}${s.required ? ' *(required)*' : ''} | ${s.cadence} | ${s.state} | ${s.lastSuccess ?? '—'} | ${s.ageHours === undefined ? '—' : `${s.ageHours}h`} |`,
    );
  }
  if (report.problems.length) lines.push('', ...report.problems.map((p) => `- ${p}`));
  return lines.join('\n') + '\n';
}

// ── where a run publishes: the scheduled branch, or a review branch of its own ──
//
// THE INCIDENT THIS ANSWERS
// -------------------------
// On 20 October 2026 collect.yml was dispatched from a feature branch: a
// controlled run, number 81. Its publisher rebuilt the producer's one branch
// (`automation/open-data-refresh`) on main, committed the run's files, opened
// data pull request #192 and, correctly under G1, did not merge it. Two
// minutes later the scheduled run from main reached its own publisher, which
// rebuilt the same branch from main plus the day's files, force-pushed it and
// merged #192. Nothing unreviewed reached main, but the copy that was opened
// for review was silently replaced, and the pull request a person had been
// asked to read was merged with different contents. A later scheduled run
// updating a still-open review pull request would lose it the same way.
//
// The defect was that both kinds of run shared one branch. G1 decided who
// may merge; nothing decided who may write.
//
// THE RULE
// --------
// A run is *scheduled* only when it was collected by `refs/heads/main` and
// nobody marked it review-only. It publishes to the contract's branch, as it
// always has, and may merge.
//
// Every other run is a *review* run. It publishes to
// `<contract branch>-review-<run id>`: a branch named by this rule, from the
// contract and the run id GitHub assigned, and by nothing a caller or a
// collector supplied. It is never merged automatically, whatever `merge`
// says, and no scheduled run can address it, because a scheduled run's branch
// is the contract's and the contract's branches may not contain the review
// marker (pinned in the suite). Two review runs have two run ids and so two
// branches. A re-run of the same run is the same run, and updates its own.
export const SCHEDULED_REF = 'refs/heads/main';
export const REVIEW_MARKER = '-review-';

// GitHub run ids are decimal integers. Anything else is refused rather than
// cleaned, so a branch name can never carry a character the rule did not put
// there.
const RUN_ID = /^[1-9][0-9]{0,19}$/;
// For display only (the pull request body and the commit trailer). A ref
// outside this shape is described rather than quoted, so it cannot put markup
// into a body a person is asked to trust. It never decides the branch.
const DISPLAYABLE_REF = /^refs\/(heads|tags)\/[A-Za-z0-9._\/-]{1,200}$/;

/** The review branch for one run of one producer, or null if either is unusable. */
export function reviewBranch(producer, runId) {
  const contract = CONTRACTS[producer];
  if (!contract || !RUN_ID.test(String(runId ?? ''))) return null;
  return `${contract.branch}${REVIEW_MARKER}${runId}`;
}

/** Is this a branch the review rule could have produced, for any producer? */
export function isReviewBranch(branch) {
  return Object.values(CONTRACTS).some((c) => typeof branch === 'string' && branch.startsWith(`${c.branch}${REVIEW_MARKER}`));
}

/** A ref as it may be shown to a reader. */
export function displayRef(ref) {
  return DISPLAYABLE_REF.test(String(ref ?? '')) ? ref : 'an unrecognised ref';
}

/**
 * Where one run of one producer publishes, and whether it may merge.
 *
 * `ref` is `github.ref` and `runId` is `github.run_id`, both set by GitHub
 * for the run; `review` is the caller's boolean, which can only move a run
 * from the scheduled branch to a review branch, never the other way. An empty
 * or absent `review` is false; anything that is not a boolean's spelling is
 * refused, because a value nobody meant should not decide where data lands.
 *
 * Returns `{ problems }` when the run cannot be placed, and the run is then
 * published nowhere.
 *
 * `seed` is the branch a run's precedent collector was started from instead
 * of main's copy of its files (collect.yml's `seed_ref`, applied by
 * scripts/precedent-seed.mjs). A seeded run is a review run or it is no run:
 * the rule is here, beside the one that decides review, so the seed step and
 * this table cannot disagree about it. Only the producer that owns those
 * files can be seeded.
 */
export function publicationTarget(producer, { ref, runId, review, seed } = {}) {
  const contract = CONTRACTS[producer];
  if (!contract) return { problems: [`no publication contract named ${producer ?? '(none)'}`] };
  const problems = [];
  if (typeof ref !== 'string' || !ref || /[\r\n]/.test(ref)) problems.push('the run\'s ref (github.ref) is missing or not a single line');
  if (!RUN_ID.test(String(runId ?? ''))) problems.push(`the run id (github.run_id) is missing or not a run id: ${JSON.stringify(runId ?? null)}`);
  const flag = review === undefined || review === null ? '' : String(review);
  if (!['', 'true', 'false'].includes(flag)) problems.push(`review must be true or false, got ${JSON.stringify(flag)}`);
  for (const [key, value] of [['branch', contract.branch], ['title', contract.title], ['label', contract.label]]) {
    if (typeof value !== 'string' || /[\r\n]/.test(value)) problems.push(`${producer}'s ${key} is not a single-line string`);
  }
  if (contract.branch.includes(REVIEW_MARKER)) problems.push(`${producer}'s contract branch carries the review marker`);
  if (problems.length) return { problems };

  const isReview = ref !== SCHEDULED_REF || flag === 'true';
  const seeded = seed !== undefined && seed !== null && String(seed) !== '';
  if (seeded) {
    if (producer !== SEEDED_PRODUCER) return { problems: [`${producer} has no seed: only ${SEEDED_PRODUCER}'s precedent collector can start from one`] };
    if (/[\r\n]/.test(String(seed))) return { problems: ['the seed is not a single line'] };
    // A seeded run's guard compares it against the seed, not against main, so
    // its output is fit for a person to read and never for main unread.
    if (!isReview) return { problems: ['a run started from a seed is review-only, and this one is not: dispatch it with review_only, or from a branch other than main. Nothing has been collected or published'] };
  }
  return {
    problems: [],
    review: isReview,
    seeded,
    branch: isReview ? reviewBranch(producer, runId) : contract.branch,
    title: isReview ? `review: ${contract.title}` : contract.title,
    label: contract.label,
    // What the commit's trailers say about who made it, read back by the
    // scheduled path before it rewrites its own branch (see foreignCommits):
    // `Publication: <kind>`, `Collected-by: <collectedBy>`, `Publication-run: <runId>`.
    kind: isReview ? 'review' : 'scheduled',
    collectedBy: displayRef(ref),
    runId: String(runId),
  };
}

/**
 * Commits on the scheduled branch's open pull request that the scheduled
 * path did not make.
 *
 * The scheduled publisher force-pushes its branch, which is safe only while
 * the branch has one author. Before it does, it reads the commits on the open
 * pull request there and refuses to touch the branch if any of them lacks
 * the scheduled path's trailers. That is the case of the incident above when
 * the controlled run's caller predates this rule (its workflow file comes
 * from the branch it was dispatched on), and of a person pushing to the
 * branch by hand: either way someone else's work is on it, and the scheduled
 * run would otherwise replace it and merge the result.
 *
 * A guard against accidents, not against a hostile branch: a workflow file on
 * a branch can write any trailer it likes. The ruleset and the review of
 * that branch are what stand against malice.
 *
 * A commit from before these trailers existed is foreign too. The cost is
 * one refusal, the first time a pull request opened by the old code is still
 * open when the new code runs; the alternative is to merge a review copy.
 *
 * @param commits the `commits` array of `gh pr view --json commits`
 */
export function foreignCommits(commits) {
  if (!Array.isArray(commits) || commits.length === 0) return [{ oid: '(unreadable)', why: 'the pull request\'s commits could not be read' }];
  const out = [];
  for (const c of commits) {
    const body = typeof c?.messageBody === 'string' ? c.messageBody : '';
    const lines = body.split('\n').map((l) => l.trim());
    const ours = lines.includes('Publication: scheduled') && lines.includes(`Collected-by: ${SCHEDULED_REF}`);
    if (!ours) {
      const by = lines.find((l) => l.startsWith('Collected-by: '))?.slice('Collected-by: '.length);
      const path = lines.find((l) => l.startsWith('Publication: '))?.slice('Publication: '.length);
      out.push({
        oid: String(c?.oid ?? '').slice(0, 12) || '(no id)',
        why: path || by ? `made by a ${path ?? 'unmarked'} publication collected by ${displayRef(by)}` : 'carries no publication trailers (made by hand, or by a publisher that predates review branches)',
      });
    }
  }
  return out;
}

// ── where the precedent collector started: published main, or a seed ──────
//
// THE FINDING THIS ANSWERS
// ------------------------
// On 22 October 2026 controlled review runs of collect.yml were dispatched
// from branches carrying an earlier run's data/precedent-transactions.auto.json
// as their starting state. The collecting job checks out main, on purpose (a
// queued run must collect against current data), so every run started from
// the file published on 11 October and the seed was ignored. Each run then
// re-read rows under new reader versions within fixed time budgets and
// stopped short of the same rows, so nothing accumulated from run to run.
//
// THE RULE
// --------
// A run may be started from a seed: a branch of this repository whose copies
// of SEED_PATHS replace main's before any collector runs, and nothing else of
// it is taken (scripts/precedent-seed.mjs). Only a review run may be seeded
// (publicationTarget). The precedent guard's baseline is then the seed, so
// what it keeps and the revisions it records are relative to the seed, while
// the pull request's diff is against main.
//
// The collector records which dataset it started from in the file it writes,
// as `startedFrom` (database.started_from), and that record is read here
// twice: a scheduled publication whose precedent file says it started from a
// seed is refused (seedPublicationProblems), and a review body names the seed's
// ref, commit, generation time and sha256 (startedFromLines).

/** The producer whose collector can be seeded, and the files a seed may replace. */
export const SEEDED_PRODUCER = 'open-data';
export const SEED_PATHS = Object.freeze(['data/precedent-transactions.auto.json', 'data/merger-index.auto.json']);
/** The file that records where its run started. */
export const STARTED_FROM_PATH = 'data/precedent-transactions.auto.json';

const COMMIT_ID = /^[0-9a-f]{40}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const ISO_STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;
const SEED_REF_SHOWN = /^refs\/heads\/[A-Za-z0-9._\/-]{1,200}$/;

/**
 * Why a branch name cannot be a seed, or nothing. The name reaches `git
 * fetch` as an argument and a pull request body as text, so it is held to a
 * plain shape rather than cleaned: letters, digits and `._/-`, no `..`, no
 * leading dash or slash, no `.lock` component. A branch of this repository
 * only: a pull request ref, a tag or a full ref name is refused.
 */
export function seedBranchProblems(name) {
  const n = typeof name === 'string' ? name : '';
  if (!n) return ['the seed is empty'];
  if (n.length > 200) return ['the seed branch name is longer than 200 characters'];
  if (!/^[A-Za-z0-9._\/-]+$/.test(n)) return [`the seed must be a branch name of letters, digits and ._/- only, got ${JSON.stringify(n)}`];
  if (n.startsWith('-') || n.startsWith('/') || n.endsWith('/') || n.endsWith('.')) return [`the seed ${JSON.stringify(n)} is not a branch name`];
  if (n.includes('..') || n.includes('//') || n.split('/').some((c) => c === '' || c.startsWith('.') || c.endsWith('.lock'))) return [`the seed ${JSON.stringify(n)} is not a branch name`];
  if (n.startsWith('refs/')) return [`the seed is a branch name, without refs/heads/: got ${JSON.stringify(n)}`];
  return [];
}

/**
 * The `startedFrom` record a precedent file carries, as it may be shown, or
 * null when it has none. A value outside its shape is described rather than
 * quoted, as displayRef does, so the record cannot put markup into a body.
 */
export function startedFrom(file) {
  const s = file && typeof file === 'object' ? file.startedFrom : undefined;
  if (!s || typeof s !== 'object' || Array.isArray(s)) return null;
  const shown = (v, re) => (typeof v === 'string' && re.test(v) ? v : null);
  const dataset = ['seed', 'published main', 'file on disk'].includes(s.dataset) ? s.dataset : 'unrecognised';
  return {
    dataset,
    ref: shown(s.ref, SEED_REF_SHOWN),
    commit: shown(s.commit, COMMIT_ID),
    generatedAt: shown(s.generatedAt, ISO_STAMP),
    sha256: shown(s.sha256, SHA256_HEX),
    run: shown(s.run === undefined || s.run === null ? '' : String(s.run), RUN_ID),
  };
}

/**
 * The scheduled path never publishes a seeded collection. The seed step
 * already refuses to seed a run that is not review-only; this is the same
 * rule a second time, in the job that can merge, judged on what the
 * collector itself recorded rather than on how the run was dispatched.
 *
 * `review` is whether this publication is a review one. Only the publisher's
 * own call knows that, so validate-data-publication.mjs applies this when it
 * is writing the pull request body, and the collecting job's pre-flight,
 * which cannot know where its run will land, does not.
 */
export function seedPublicationProblems(producer, { staged, read }, { review }) {
  if (producer !== SEEDED_PRODUCER || !staged.includes(STARTED_FROM_PATH)) return [];
  const s = startedFrom(read(STARTED_FROM_PATH));
  if (s?.dataset === 'seed' && !review) {
    return [`the precedent transactions database was collected from a seed (${s.ref ?? 'an unrecognised ref'}), not from main; a seeded collection is published for review only, never on the scheduled branch`];
  }
  return [];
}

/**
 * What a review body says about where the precedent collector started, or
 * nothing when this publication carries no precedent file. `runId` is this
 * publication's run: a record written by another run (a seed file no
 * collector in this run rewrote carries its own run's record) is not
 * presented as this run's.
 */
export function startedFromLines(producer, { staged, read }, runId) {
  if (producer !== SEEDED_PRODUCER || !staged.includes(STARTED_FROM_PATH)) return [];
  const s = startedFrom(read(STARTED_FROM_PATH));
  const code = (v) => (v ? `\`${v}\`` : 'not recorded');
  const head = ['### Where the precedent collector started', ''];
  if (!s || (runId && s.run && s.run !== String(runId)) || (runId && !s.run)) {
    return [
      ...head,
      `The precedent transactions database does not record that this run wrote it${s?.run ? ` (its record is run ${s.run}'s)` : ''}, so which dataset its figures started from is not known here. If this run was seeded and the collector did not finish a write, the file is the seed as fetched.`,
      '',
    ];
  }
  if (s.dataset === 'seed') {
    return [
      ...head,
      `**This run started from a seed, not from main:** ${code(s.ref)} at commit ${code(s.commit)}. The seed's precedent file was generated at ${code(s.generatedAt)}, sha256 ${code(s.sha256)}.`,
      '',
      'The precedent guard compared this run against the seed: every figure it kept and every revision it recorded is relative to the seed, not to main. The diff of this pull request is against main, so it shows the seed\'s changes and this run\'s together.',
      '',
    ];
  }
  if (s.dataset === 'published main') {
    return [...head, `This run started from published main at ${code(s.commit)}: precedent file generated at ${code(s.generatedAt)}, sha256 ${code(s.sha256)}.`, ''];
  }
  return [...head, `The precedent transactions database says it started from ${s.dataset === 'file on disk' ? 'the file on disk, outside the collection workflow' : 'an unrecognised dataset'}: generated at ${code(s.generatedAt)}, sha256 ${code(s.sha256)}.`, ''];
}

/** Every path any producer may publish, for the cross-producer overlap check. */
export function allPaths() {
  const out = [];
  for (const [producer, c] of Object.entries(CONTRACTS)) {
    for (const f of c.files) out.push({ producer, path: f.path, pattern: f.pattern });
  }
  return out;
}

/** Does this file spec match a staged path? */
function matches(spec, path) {
  return spec.pattern ? spec.pattern.test(path) : spec.path === path;
}

/** Staged paths this producer may not publish. Empty means the run is clean. */
export function unexpectedPaths(producer, paths) {
  const contract = CONTRACTS[producer];
  if (!contract) return paths.slice();
  return paths.filter((p) => p && !contract.files.some((f) => matches(f, p)));
}

/** How many entries a value holds, whatever shape it is. */
function count(value, rowsKey, keyedKey) {
  if (rowsKey) return Array.isArray(value?.[rowsKey]) ? value[rowsKey].length : null;
  if (keyedKey) {
    const o = value?.[keyedKey];
    return o && typeof o === 'object' && !Array.isArray(o) ? Object.keys(o).length : null;
  }
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === 'object') return Object.keys(value).length;
  return null;
}

/**
 * Paths no producer may ever publish, whatever its allowlist says.
 *
 * The allowlist below is already the decision: a path it does not name is
 * refused. This is the second lock on the same door, and it exists because
 * the two are wrong in different ways. An allowlist goes wrong by gaining an
 * entry nobody thought hard about; this list goes wrong by being too narrow,
 * which costs a legitimate publication rather than admitting a hostile one.
 *
 * What it names is the set of paths that would turn a data publication into a
 * code or configuration change: the workflows themselves, the scripts they
 * run, the gate, the manifests, anything executable. No collector has ever
 * had a reason to write one, and a run that produces one is not a collection.
 */
const NEVER_PUBLISHABLE = [
  { test: (p) => p === '.git' || p.startsWith('.git/'), why: 'the git directory itself' },
  { test: (p) => p.startsWith('.github/'), why: 'a workflow or repository configuration file' },
  { test: (p) => p.startsWith('scripts/'), why: 'a script, including the gate that judges this archive' },
  { test: (p) => /(^|\/)(package|package-lock|tsconfig|jsconfig)\.json$/.test(p), why: 'a package or compiler manifest' },
  { test: (p) => /\.(mjs|cjs|js|jsx|ts|tsx|sh|bash|zsh|py|rb|pl|php|ps1)$/i.test(p), why: 'executable code' },
  { test: (p) => /\.(yml|yaml|toml|ini|cfg|conf|env|properties)$/i.test(p), why: 'a configuration file' },
  { test: (p) => /(^|\/)\.[^/]+$/.test(p), why: 'a dotfile' },
];

/**
 * Whether an archive handed over by a collecting job may be unpacked, decided
 * before a single byte of it is written to disk.
 *
 * THE BOUNDARY THIS DEFENDS
 * -------------------------
 * The collecting half of a producer runs with a read-only token because it
 * reads the open internet: a hundred and sixty careers pages, the SEC, a news
 * wire. It proposes bytes. It does not get a say in whether those bytes are
 * safe to publish, and "does not get a say" has to include the judge: this
 * function and the table above it are loaded by the privileged job from its
 * own checkout of `main`, never from the handoff, so a compromised collector
 * cannot hand over a gate that approves of it.
 *
 * WHY BEFORE EXTRACTION AND NOT AFTER
 * -----------------------------------
 * The gate that runs after extraction reads the git index, and a file written
 * outside the working tree never reaches the index. `tar` will follow a `..`
 * segment or a symlink out of the tree and write to the runner's home
 * directory, and by then the damage is done whatever the gate concludes. So
 * the member list is read first, the archive is refused whole if anything in
 * it is wrong, and only then is anything unpacked.
 *
 * `members` is the output of `tar -tf`, one path per line. `types` is the
 * first character of each line of `tar -tvf`, in the same order, which is how
 * a symlink, a hard link or a device node announces itself. Passing the types
 * is optional only so the policy can be unit-tested on paths alone; the
 * workflow always passes them.
 */
export function archiveMemberProblems(producer, members, types = null) {
  const problems = [];
  if (!CONTRACTS[producer]) return [`no publication contract named ${producer}`];
  if (!members.length) return ['the archive is empty'];

  if (types) {
    if (types.length !== members.length) {
      return [`the archive lists ${members.length} member(s) but ${types.length} type(s); it cannot be read reliably`];
    }
    members.forEach((p, i) => {
      // A plain file and nothing else. A directory entry cannot appear in an
      // archive built from a list of files, a symlink or hard link is how an
      // archive writes outside itself, and a device node has no business in a
      // data publication at all.
      if (types[i] !== '-') {
        problems.push(`${p} is not a plain file (tar calls it "${types[i]}")`);
      }
    });
  }

  for (const p of members) {
    if (p.startsWith('/')) problems.push(`${p} is an absolute path`);
    else if (p.startsWith('~')) problems.push(`${p} starts at a home directory`);
    else if (p.split('/').includes('..')) problems.push(`${p} traverses out of the working tree`);
    else if (p.startsWith('./')) problems.push(`${p} is not a plain relative path`);
    else if (p.includes('//')) problems.push(`${p} has an empty path segment`);
    else if (/[\\\r\n\0]/.test(p)) problems.push(`${JSON.stringify(p)} contains a character a collected path never has`);
    else {
      const banned = NEVER_PUBLISHABLE.find((rule) => rule.test(p));
      if (banned) problems.push(`${p} is ${banned.why}, which no collection may publish`);
    }
  }

  // And finally the producer's own allowlist: everything above is about what
  // no producer may publish, this is about what this one may.
  for (const p of unexpectedPaths(producer, members)) {
    problems.push(`${p} is outside ${producer}'s allowlist`);
  }

  return problems;
}

/** The rows of a file, when it has any. */
function rowsOf(value, rowsKey) {
  if (rowsKey) return Array.isArray(value?.[rowsKey]) ? value[rowsKey] : null;
  return Array.isArray(value) ? value : null;
}

export function groupCounts(rows, by) {
  const counts = new Map();
  for (const row of rows ?? []) {
    const key = row?.[by] ?? '(none)';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/**
 * Every group in either version of a file, with its movement, largest first.
 * Used for the collapse check and for the table in the pull request body, so
 * the number a reviewer reads is the number the gate decided on.
 */
export function groupMovement(prev, next, spec) {
  const before = groupCounts(rowsOf(prev, spec.rows), spec.groups.by);
  const after = groupCounts(rowsOf(next, spec.rows), spec.groups.by);
  return Array.from(new Set([...before.keys(), ...after.keys()]))
    .map((name) => {
      const from = before.get(name) ?? 0;
      const to = after.get(name) ?? 0;
      return { name, from, to, delta: to - from };
    })
    .sort((a, b) => b.to - a.to || a.name.localeCompare(b.name));
}

/** Hours since `obj[field]`, or null when there is no readable stamp. */
function stampAgeHours(obj, field, now) {
  const raw = field ? obj?.[field] : null;
  const t = raw ? new Date(raw).getTime() : Number.NaN;
  return Number.isNaN(t) ? null : (now.getTime() - t) / 3_600_000;
}

/**
 * One file against its spec. `prev` may be null on a first publication, in
 * which case the relative checks are skipped rather than failed: "there is
 * nothing to compare against" is not a defect.
 */
export function fileProblems(spec, next, prev, now = new Date()) {
  const problems = [];
  const name = spec.label ?? spec.path;

  if (next === undefined) {
    if (!spec.optional) problems.push(`${name} is missing from this run`);
    return { problems, stats: null };
  }
  if (next === null) {
    problems.push(`${name} is not readable JSON`);
    return { problems, stats: null };
  }
  if (spec.binary || spec.shapeOnly) return { problems, stats: { name, path: spec.path } };

  const rows = rowsOf(next, spec.rows);
  const n = count(next, spec.rows, spec.keyed);
  if (spec.rows && rows === null) {
    problems.push(`${name} has no ${spec.rows} array`);
    return { problems, stats: null };
  }
  if (spec.keyed && n === null) {
    problems.push(`${name} has no ${spec.keyed} object`);
    return { problems, stats: null };
  }
  if (n === null) {
    problems.push(`${name} is neither a list nor an object`);
    return { problems, stats: null };
  }
  if (spec.min !== undefined && n < spec.min) {
    problems.push(`${name} has only ${n} entries, below its floor of ${spec.min}`);
  }

  if (spec.required && rows) {
    const missing = new Map();
    for (const row of rows) {
      for (const field of spec.required) {
        if (row?.[field] === undefined || row[field] === null || row[field] === '') {
          missing.set(field, (missing.get(field) ?? 0) + 1);
        }
      }
    }
    for (const [field, c] of missing) problems.push(`${name}: ${c} row(s) missing ${field}`);
  }

  if (spec.eachRow && rows) {
    const short = rows.filter((r) => !Array.isArray(r?.[spec.eachRow.key]) || r[spec.eachRow.key].length < spec.eachRow.minLength);
    if (short.length) {
      problems.push(`${name}: ${short.length} entr(y/ies) with fewer than ${spec.eachRow.minLength} ${spec.eachRow.key}`);
    }
  }

  if (spec.stamp) {
    const raw = next?.[spec.stamp];
    const stamp = raw ? new Date(raw) : null;
    if (!stamp || Number.isNaN(stamp.getTime())) {
      problems.push(`${name} carries no readable ${spec.stamp}`);
    } else {
      const ageHours = (now.getTime() - stamp.getTime()) / 3_600_000;
      if (spec.maxAgeHours !== undefined && ageHours > spec.maxAgeHours) {
        problems.push(`${name} is ${Math.round(ageHours)}h old; a step may have failed quietly`);
      }
      if (ageHours < -1) problems.push(`${name} is stamped in the future`);
    }
  }

  const before = prev == null ? null : count(prev, spec.rows, spec.keyed);
  let movement = null;
  // Set when a `freshBaselineOnly` collapse comparison was skipped, so the
  // run says so rather than passing quietly.
  let staleBaseline = false;
  let baselineAgeHours = null;
  if (before !== null && before > 0) {
    const ratio = n / before;
    if (spec.neverShrinks && n < before) {
      problems.push(`${name} lost entries, ${before} to ${n}; it only ever grows`);
    }
    if (spec.minRatio !== undefined && ratio < spec.minRatio) {
      problems.push(`${name} fell from ${before} to ${n}, past its ${Math.round(spec.minRatio * 100)}% floor`);
    }
    if (spec.maxRatio !== undefined && ratio > spec.maxRatio) {
      problems.push(`${name} rose from ${before} to ${n}, past its ${spec.maxRatio}x ceiling`);
    }
    if (spec.groups) {
      movement = groupMovement(prev, next, spec);
      baselineAgeHours = spec.groups.freshBaselineOnly ? stampAgeHours(prev, spec.stamp, now) : null;
      const judged = !(baselineAgeHours !== null && spec.maxAgeHours !== undefined && baselineAgeHours > spec.maxAgeHours);
      if (!judged) staleBaseline = true;
      for (const g of judged ? movement : []) {
        if (g.from >= spec.groups.floor && g.to < g.from * spec.groups.minRatio) {
          problems.push(`${name}: ${g.name} collapsed from ${g.from} to ${g.to}`);
        }
      }
    }
  } else if (spec.groups) {
    movement = groupMovement(prev, next, spec);
  }

  return {
    problems,
    stats: {
      name,
      path: spec.path,
      entries: n,
      before,
      stamp: spec.stamp ? (next?.[spec.stamp] ?? null) : null,
      movement,
      ...(staleBaseline ? { staleBaseline: { ageHours: Math.round(baselineAgeHours), limitHours: spec.maxAgeHours } } : {}),
    },
  };
}

/**
 * The stamp a file carries about its own generation, or null. Only the two
 * fields collectors write into the file itself: a git commit date or a file's
 * modification time says when bytes moved, not when the data was collected,
 * and a file stamped `commit` or with no cadence stamp is simply not judged.
 */
const INTRINSIC_STAMPS = new Set(['generatedAt', 'updatedAt']);
export function intrinsicStamp(spec, obj) {
  const field = spec.freshness?.from;
  if (!INTRINSIC_STAMPS.has(field) || spec.binary) return { field: null, time: null };
  const raw = obj?.[field];
  const t = typeof raw === 'string' || typeof raw === 'number' ? new Date(raw).getTime() : Number.NaN;
  return { field, time: Number.isNaN(t) ? null : t };
}

/**
 * G2. A staged file may not be older than the copy already on main.
 *
 * Two runs of one producer can finish out of order (a rerun started before a
 * later run published, a queued run released after a newer one), and the
 * one that publishes last would otherwise roll main back to older data with
 * every other check passing. Judged on the file's own generation stamp, per
 * its contract (`freshness.from`), never on git or filesystem times.
 *
 * Equal is allowed (a rerun that changed nothing it stamps). A new copy
 * whose stamp cannot be read, where main's could, is refused: nothing then
 * shows it is not older. A file with no intrinsic stamp is not judged.
 */
export function staleProblems(spec, next, prev) {
  const { field, time: nextT } = intrinsicStamp(spec, next);
  if (!field || prev == null) return [];
  const { time: prevT } = intrinsicStamp(spec, prev);
  if (prevT === null) return [];
  const name = spec.label ?? spec.path;
  if (nextT === null) return [`${name} carries no readable ${field}, so it cannot be shown to be newer than the copy on main`];
  if (nextT < prevT) {
    return [`${name} was generated at ${new Date(nextT).toISOString()}, older than the copy on main (${new Date(prevT).toISOString()}); a late or overlapping run may not roll main back`];
  }
  return [];
}

/**
 * G3. A path the contract marks `immutable` is written once: a staged change
 * to one that already exists on main is refused. The workflows restore such
 * a path before staging (scripts/keep-published-observations.mjs), so a
 * same-day rerun publishes everything else; this is the gate that holds if
 * that step were ever skipped or wrong.
 *
 * @param existedBefore (path) => boolean, whether main already has the path
 */
export function immutableProblems(producer, staged, existedBefore) {
  const contract = CONTRACTS[producer];
  if (!contract) return [];
  const specs = contract.files.filter((f) => f.immutable);
  return staged
    .filter((p) => specs.some((f) => matches(f, p)) && existedBefore(p))
    .map((p) => `${p} is already published on main; a dated observation is written once and a rerun may not replace it`);
}

/** The contract entries marked `immutable`, for the restore step. */
export function immutablePaths(producer, paths) {
  const specs = (CONTRACTS[producer]?.files ?? []).filter((f) => f.immutable);
  return paths.filter((p) => specs.some((f) => matches(f, p)));
}

/**
 * A whole producer. `read(path)` returns the parsed new file, `undefined` if
 * it is not part of this run, `null` if it did not parse; `readPrev(path)`
 * the same for the copy on `main`. `existedBefore(path)` says whether main
 * has the path at all; without it nothing can be shown to be new, so every
 * staged immutable path is treated as already published.
 */
export function contractProblems(producer, { staged, read, readPrev, existedBefore = () => true }, now = new Date()) {
  const contract = CONTRACTS[producer];
  if (!contract) return { problems: [`no publication contract named ${producer}`], stats: [] };

  const problems = [];
  const unexpected = unexpectedPaths(producer, staged);
  if (unexpected.length) {
    problems.push(
      `this run changed ${unexpected.length} file(s) outside ${producer}'s allowlist: ${unexpected.join(', ')}`,
    );
  }

  const stats = [];
  for (const spec of contract.files) {
    if (spec.pattern) continue; // a family of files; membership is the whole check
    const isStaged = staged.includes(spec.path);
    if (!isStaged && spec.optional) continue;
    if (!isStaged && !spec.optional) {
      problems.push(`${spec.label ?? spec.path} is missing from this run`);
      continue;
    }
    // `optional` says the producing step does not run every cycle, not that
    // an unreadable file is acceptable. Once a path is staged it is part of
    // this run and has to stand up like any other.
    const next = read(spec.path);
    const prev = readPrev(spec.path);
    const verdict = fileProblems({ ...spec, optional: false }, next, prev, now);
    problems.push(...verdict.problems);
    // Separately from fileProblems, because that returns early for
    // shape-only files, which carry generation stamps too.
    if (next != null) problems.push(...staleProblems(spec, next, prev));
    if (verdict.stats) stats.push(verdict.stats);
  }

  problems.push(...immutableProblems(producer, staged, existedBefore));

  return { problems, stats };
}

// GitHub refuses a pull request body over 65,536 characters. The 13F history
// writes a file per manager and per symbol, well over a thousand on a first
// run, so past a few dozen paths the list is one line a folder with its count.
// The diff itself still names every file.
const ALSO_LISTED = 40;

export function alsoChanged(paths) {
  if (paths.length <= ALSO_LISTED) return paths.map((p) => `- \`${p}\``);
  const byDir = new Map();
  for (const p of paths) {
    const key = p.split('/').slice(0, 3).join('/');
    byDir.set(key, (byDir.get(key) ?? 0) + 1);
  }
  return Array.from(byDir, ([key, n]) => (n === 1 && paths.includes(key) ? `- \`${key}\`` : `- \`${key}/\`: ${n} files`));
}

/** The pull request body: what was collected, what moved, what was checked. */
export function publicationReport({ producer, stats, staged, runUrl, ref, extra, review, started = [] }) {
  const contract = CONTRACTS[producer] ?? { label: producer };
  const lines = [
    `## ${contract.label[0].toUpperCase()}${contract.label.slice(1)}`,
    '',
  ];
  // A review pull request says so first, before a reader reaches the table,
  // and names what a person has to check that no gate can: whether main has
  // moved on since. G2 was judged against main at `base`; a hand merge later
  // is not judged again.
  if (review) {
    const shown = displayRef(review.ref);
    lines.push(
      '> [!WARNING]',
      `> **Review only. This pull request will not be merged automatically.** It was opened by a controlled collection run from \`${shown}\`${runUrl ? ` (${runUrl})` : ''}, not by the scheduled publication, and it needs a person to read the diff and approve it.`,
      '>',
      `> Its branch belongs to that run alone: the scheduled publication never writes to it, force-pushes it or merges it. Every file was judged against \`main\`${review.base && /^[0-9a-f]{7,40}$/.test(review.base) ? ` at \`${review.base}\`` : ''}. If \`main\` has published a newer copy of any of these files since, merging would replace it with this older one, so check before merging, or close this and delete the branch.`,
      '',
    );
    // Where the precedent collector started (startedFromLines), for review
    // bodies only: the scheduled body is unchanged, and a scheduled run is
    // never seeded.
    lines.push(...started);
  }
  lines.push(
    'Opened by the collection workflow. Every file below is generated; nothing here is hand-written.',
    '',
    '| File | Entries | Generated |',
    '|---|---:|---|',
  );
  for (const s of stats) {
    const moved = s.before === null || s.before === undefined ? '' : ` (was ${s.before})`;
    lines.push(`| ${s.name} | ${s.entries ?? '—'}${moved} | ${s.stamp ?? '—'} |`);
  }
  const untracked = staged.filter((p) => !stats.some((s) => s.path === p));
  if (untracked.length) {
    lines.push('', '### Also changed', '', ...alsoChanged(untracked));
  }
  for (const s of stats) {
    const moved = (s.movement ?? []).filter((m) => m.delta !== 0);
    if (!moved.length) continue;
    lines.push('', `### ${s.name}, by category`, '', '| | Before | After | Change |', '|---|---:|---:|---:|');
    for (const m of moved) lines.push(`| ${m.name} | ${m.from} | ${m.to} | ${m.delta > 0 ? '+' : ''}${m.delta} |`);
  }
  lines.push(
    '',
    '### Checks',
    '',
    `- Every staged path is one of the ${contract.files.length} files this producer writes.`,
    '- Every file parses, carries the fields the site reads it by, and is stamped within its own horizon.',
    '- No file has lost or gained more entries than its own source can explain.',
    '',
    'A run that fails any of these opens nothing and publishes nothing.',
    '',
  );
  if (extra) lines.push(extra, '');
  if (ref) lines.push(`Collected by \`${review ? displayRef(ref) : ref}\`.`);
  if (runUrl) lines.push('', runUrl);
  return lines.join('\n');
}
