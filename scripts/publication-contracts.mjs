/**
 * What each producer collects, and how recently each source has to have
 * worked.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `collect.yml` reported success on the mornings of 19 and 20 September while
 * publishing nothing. The push was refused by a ruleset and the failure was
 * swallowed; that half is fixed elsewhere. This is the other half, and it is
 * the one that would still have been there afterwards.
 *
 * Three of that workflow's collectors are `continue-on-error`, which is
 * right: one dead wire should not cost the whole morning. It also means a
 * collector that fails every day looks exactly like a quiet day. Nothing is
 * staged, so the publication gate has nothing to object to, and the committed
 * file ages behind a green tick. Fixing a silently refused push and leaving
 * silent collection staleness in place would be half a guarantee.
 *
 * So every file a producer owns declares a cadence, whether being late blocks
 * a run or merely degrades it, and where its timestamp comes from. The sweep
 * in scripts/check-freshness.mjs reads the committed state rather than what a
 * run happened to stage, which is the only way to see a collector that has
 * stopped producing anything at all.
 *
 * Pure data and pure functions, so the whole contract runs offline in
 * scripts/__tests__/publication-freshness.test.mjs.
 */

/**
 * The files each producer owns.
 *
 * One table, because "who writes this file" is a question two workflows must
 * never answer differently. A file appearing under two producers is two
 * workflows racing to write it, and there is a test for that.
 */
export const CONTRACTS = {
  // build-samples.yml, daily at 06:30. The feed is what a candidate acts
  // on, so it and the two economic files block; the rest are written in the
  // same pass and would only repeat the same alarm.
  'tracker': {
    label: 'the daily tracker collection',
    files: [
      { path: 'data/opportunities.auto.json', label: 'the tracker feed', freshness: { cadence: 'daily', required: true, from: 'generatedAt' } },
      { path: 'data/tracker-slugs.json', label: 'the slug registry', freshness: { cadence: 'daily', from: 'generatedAt' } },
      { path: 'data/tracker-archive.json', label: 'the archive of published URLs', freshness: { cadence: 'daily', from: 'generatedAt' } },
      { path: 'data/tracker-history.json', label: 'the board history', freshness: { cadence: 'manual' } },
      { path: 'data/deadlines.learned.json', label: 'the deadline ledger', freshness: { cadence: 'daily', from: 'updatedAt' } },
      { path: 'data/econ.auto.json', label: 'the economic backdrop', freshness: { cadence: 'daily', required: true, from: 'generatedAt' } },
      { path: 'data/erp.auto.json', label: 'equity and country risk premiums', freshness: { cadence: 'daily', required: true, from: 'generatedAt' } },
    ],
  },
  // collect.yml, three cadences in one workflow: daily at 06:00, the
  // chartbook and board books on Mondays, the SEC-heavy collectors on the
  // first of the month. Each file therefore answers to its own clock.
  'open-data': {
    label: 'the open-data collection',
    files: [
      { path: 'data/calendar.auto.json', label: 'the economic calendar', freshness: { cadence: 'daily', required: true, from: 'generatedAt' } },
      { path: 'data/deals.auto.json', label: 'the deal tape', freshness: { cadence: 'daily', required: true, from: 'generatedAt' } },
      { path: 'data/newsflow.auto.json', label: 'the news map', freshness: { cadence: 'daily', required: true, from: 'generatedAt' } },
      { path: 'data/macro.auto.json', label: 'the macro chartbook', freshness: { cadence: 'weekly', required: true, from: 'generatedAt' } },
      { path: 'data/decks.auto.json', label: 'the board-book index', freshness: { cadence: 'weekly', required: true, from: 'generatedAt' } },
      { path: 'data/cusip-tickers.auto.json', label: 'the CUSIP to ticker map', freshness: { cadence: 'monthly', from: 'generatedAt' } },
      { path: 'data/precedent-transactions.auto.json', label: 'the precedent transactions database', freshness: { cadence: 'monthly', from: 'generatedAt' } },
      { path: 'data/funds.auto.json', label: '13F holdings', freshness: { cadence: 'monthly', from: 'generatedAt' } },
      { path: 'data/funds.universe.json', label: 'the 13F manager universe', freshness: { cadence: 'manual' } },
      { path: 'data/peers.auto.json', label: 'the industry peer lists', freshness: { cadence: 'monthly', from: 'generatedAt' } },
      { path: 'data/career-snapshots.json', label: 'the careers-page snapshots', freshness: { cadence: 'daily', from: 'commit' } },
      { path: 'data/career-review-queue.json', label: 'the careers review queue', freshness: { cadence: 'daily', from: 'generatedAt' } },
    ],
  },
  // discover-ats.yml is dispatch-only and writes nothing unless asked, so
  // neither file has a schedule to be late for. Declared anyway, so the
  // producer is not a hole in the table.
  'ats-registry': {
    label: 'the discovered ATS boards',
    files: [
      { path: 'lib/sources/ats-registry.json', label: 'the board registry', freshness: { cadence: 'manual' } },
      { path: 'data/ats-discovery.json', label: 'the discovery report', freshness: { cadence: 'manual' } },
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

/** The operator's table: every source, its state, and when it last worked. */
export function freshnessSummary(producer, report) {
  const icon = { fresh: '🟢', degraded: '🟡', stale: '🔴', manual: '⚪', 'not-due': '⚪' };
  const lines = [
    `### ${CONTRACTS[producer]?.label ?? producer}: source freshness`,
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

/** Every path any producer owns, for the cross-producer overlap check. */
export function allPaths() {
  const out = [];
  for (const [producer, c] of Object.entries(CONTRACTS)) {
    for (const f of c.files) out.push({ producer, path: f.path });
  }
  return out;
}
