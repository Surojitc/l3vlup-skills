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
        path: 'data/opportunities.auto.json',
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
      { path: 'data/tracker-slugs.json', label: 'the slug registry', shapeOnly: true },
      { path: 'data/tracker-archive.json', label: 'the archive of published URLs', shapeOnly: true },
      { path: 'data/tracker-history.json', label: 'the board history', shapeOnly: true },
      { path: 'data/deadlines.learned.json', label: 'the deadline ledger', shapeOnly: true },
      { path: 'data/econ.auto.json', label: 'the economic backdrop', shapeOnly: true },
      { path: 'data/erp.auto.json', label: 'equity and country risk premiums', shapeOnly: true },
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
        path: 'data/calendar.auto.json',
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
        path: 'data/deals.auto.json',
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
        path: 'data/newsflow.auto.json',
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
        path: 'data/macro.auto.json',
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
        path: 'data/decks.auto.json',
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
        path: 'data/cusip-tickers.auto.json',
        label: 'the CUSIP to ticker map',
        // Monthly, and a stale map is still a correct one, so freshness is
        // deliberately not checked here. What matters is that it never
        // shrinks: a mapping is only ever added.
        neverShrinks: true,
        optional: true,
      },
      {
        path: 'data/precedent-transactions.auto.json',
        label: 'the precedent transactions database',
        neverShrinks: true,
        optional: true,
      },
      { path: 'data/funds.auto.json', label: '13F holdings', neverShrinks: true, optional: true },
      { path: 'data/funds.universe.json', label: 'the 13F manager universe', shapeOnly: true, optional: true },
      { path: 'data/peers.auto.json', label: 'the industry peer lists', neverShrinks: true, optional: true },
      { path: 'data/career-snapshots.json', label: 'the careers-page snapshots', shapeOnly: true, optional: true },
      { path: 'data/career-review-queue.json', label: 'the careers review queue', shapeOnly: true, optional: true },
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
        path: 'lib/sources/ats-registry.json',
        label: 'the board registry',
        neverShrinks: true,
        maxRatio: 1.5,
      },
      { path: 'data/ats-discovery.json', label: 'the discovery report', shapeOnly: true },
    ],
  },
};

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
