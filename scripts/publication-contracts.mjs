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
 *   min          the fewest rows worth publishing over yesterday's copy
 *   minRatio     how far the count may fall in one run, as a fraction
 *   maxRatio     and how far it may rise
 *   required     fields every row must carry, because the site indexes by them
 *   stamp        the field carrying the collector's own generation time
 *   maxAgeHours  how old that stamp may be before the file is a leftover
 *   groups       {by, floor, minRatio}: no category of this size may halve
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
      { pattern: /^data\/board-checks\/\d{4}-\d{2}-\d{2}\.json$/, label: 'the day\'s board checks' },
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
        groups: { by: 'vertical', floor: 15, minRatio: 0.5 },
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
      { path: 'data/funds.universe.json', freshness: { cadence: 'manual' }, label: 'the 13F manager universe', shapeOnly: true, optional: true },
      { path: 'data/peers.auto.json', freshness: { cadence: 'monthly', from: 'generatedAt' }, label: 'the industry peer lists', neverShrinks: true, optional: true },
      { path: 'data/career-snapshots.json', freshness: { cadence: 'daily', from: 'commit' }, label: 'the careers-page snapshots', shapeOnly: true, optional: true },
      { path: 'data/career-review-queue.json', freshness: { cadence: 'daily', from: 'generatedAt' }, label: 'the careers review queue', shapeOnly: true, optional: true },
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
 */
export function fileFreshness(spec, value, committedAt, now = new Date()) {
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
export function freshnessReport(producer, { read, committedAt }, now = new Date()) {
  const contract = CONTRACTS[producer];
  if (!contract) return { sources: [], blocking: true, degraded: false, problems: [`no publication contract named ${producer}`] };

  const sources = contract.files
    .filter((spec) => spec.path)
    .map((spec) => fileFreshness(spec, read(spec.path), committedAt(spec.path), now));

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
function count(value, rowsKey) {
  if (rowsKey) return Array.isArray(value?.[rowsKey]) ? value[rowsKey].length : null;
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
  const n = count(next, spec.rows);
  if (spec.rows && rows === null) {
    problems.push(`${name} has no ${spec.rows} array`);
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

  const before = prev == null ? null : count(prev, spec.rows);
  let movement = null;
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
      for (const g of movement) {
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
    stats: { name, path: spec.path, entries: n, before, stamp: spec.stamp ? (next?.[spec.stamp] ?? null) : null, movement },
  };
}

/**
 * A whole producer. `read(path)` returns the parsed new file, `undefined` if
 * it is not part of this run, `null` if it did not parse; `readPrev(path)`
 * the same for the copy on `main`.
 */
export function contractProblems(producer, { staged, read, readPrev }, now = new Date()) {
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
    const verdict = fileProblems({ ...spec, optional: false }, read(spec.path), readPrev(spec.path), now);
    problems.push(...verdict.problems);
    if (verdict.stats) stats.push(verdict.stats);
  }

  return { problems, stats };
}

/** The pull request body: what was collected, what moved, what was checked. */
export function publicationReport({ producer, stats, staged, runUrl, ref, extra }) {
  const contract = CONTRACTS[producer] ?? { label: producer };
  const lines = [
    `## ${contract.label[0].toUpperCase()}${contract.label.slice(1)}`,
    '',
    'Opened by the collection workflow. Every file below is generated; nothing here is hand-written.',
    '',
    '| File | Entries | Generated |',
    '|---|---:|---|',
  ];
  for (const s of stats) {
    const moved = s.before === null || s.before === undefined ? '' : ` (was ${s.before})`;
    lines.push(`| ${s.name} | ${s.entries ?? '—'}${moved} | ${s.stamp ?? '—'} |`);
  }
  const untracked = staged.filter((p) => !stats.some((s) => s.path === p));
  if (untracked.length) {
    lines.push('', '### Also changed', '', ...untracked.map((p) => `- \`${p}\``));
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
  if (ref) lines.push(`Collected by \`${ref}\`.`);
  if (runUrl) lines.push('', runUrl);
  return lines.join('\n');
}
