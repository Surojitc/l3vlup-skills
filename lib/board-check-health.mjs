/**
 * Is the board-check record whole? The Hiring Pulse's four questions of
 * data/board-checks/, as pure functions (scripts/check-board-checks.mjs runs
 * them in the tracker collection, scripts/data-health.mjs once a day from
 * outside it).
 *
 * WHY
 * ---
 * The Pulse compares two days only when both exist, both were collected under
 * the same labelled method, and a board was read completely on both. Each of
 * those failed quietly in autumn 2026, and the day files are immutable, so
 * every failure that is not caught on the day is permanent:
 *
 *   - five days have no file at all. Two were collections refused at the
 *     publication gate for an unrelated file (the economic backdrop), with
 *     the board checks already written; nothing outside the run said so.
 *   - three fingerprints ran unlabelled for seventeen days, because the suite
 *     that would have failed was in no workflow's list. 40 of 57 days were
 *     method breaks on weekly readings.
 *   - on 14 November 64 boards failed at once (149 read completely against
 *     about 210), a day no comparison can use.
 *
 * WHAT IT FLAGS
 * -------------
 *   missing-day             a date from the first day file through `through`
 *                           with no file, unless KNOWN_GAPS explains it. A gap
 *                           is acknowledged in a reviewed diff, the same way a
 *                           fingerprint is, and never by writing a file for it.
 *   unreadable-day          a day file that does not parse
 *   no-fingerprint          a day file that does not say what code collected it
 *   unlabelled-fingerprint  a day file, or the code on disk, whose fingerprint
 *                           is not in lib/collection-method.json
 *   registry-unpublished    data/collection-methods.json differs from the
 *                           registry, so the site would resolve stale labels
 *   stale                   the newest day file is older than STALE_HOURS
 *   coverage-drop           the newest day read completely (`ok`) far fewer
 *                           boards than the trailing median (COVERAGE)
 *
 * Every one is a problem, not a warning: each costs comparisons, and a run
 * that is red is the only alert this repository has (GitHub mails the owner).
 * None stops a publication. The collection publishes first and turns red
 * after, so a flagged day is still recorded.
 */

/**
 * Days with no file, each explained from the runs' own logs (the Actions API,
 * 27 November 2026). None can be recovered: no artefact of any of these runs
 * holds the day's checks. The handoff artifact is uploaded only after the
 * publication gate passes and is kept three days; no run log prints the file.
 * A day is never reconstructed from neighbouring days or from the feed.
 */
export const KNOWN_GAPS = {
  '2026-09-26':
    'before the Pulse\'s first clean day (27 Sep). The publication branch of PR #82 was rebuilt from main by the 27 Sep runs before observations were immutable (G3); its final head holds 25 and 27 Sep only, and the handoff artifact has expired',
  '2026-10-10':
    'run 38053897894 failed in the collector suites (a fixture #129 did not update) before the sync ran; no collection happened. Runs on 11 Oct failed the same way until it was fixed',
  '2026-11-17':
    'run 44125255731 failed in the collector suites (funds-explorer, a 13F book written by the open-data run) before the sync ran; no collection happened. Fixed by #330 (--producer tracker)',
  '2026-11-20':
    'run 44765901827 collected and wrote the day\'s checks (227 ok, 3 partial, 3 failed, per its log), then the publication gate refused the run because the economic backdrop (sync_econ.py: the IMF datamapper API answered 404) was "missing from this run"; the artifact is uploaded only after the gate, so nothing kept the file. The econ and premium files are now optional for the gate',
  '2026-11-21':
    'runs 44916246932 and 44954617019 each collected (230 ok, 3 partial, 2 failed) and were refused at the gate exactly as on 20 Nov (IMF API 404); nothing kept the file. Two dispatches on 22 Nov failed the same way (429) before run 45034923582 published 22 Nov',
};

/** How old the newest day file may be. The collection is daily but GitHub has started it up to twelve hours late; 48h is a day missed outright plus that. */
export const STALE_HOURS = 48;

/**
 * Coverage: the newest day's `ok` boards against the median of up to `window`
 * earlier days, flagged when below `ratio` of it AND at least `minDrop` boards
 * down. Calibrated on 25 Sep to 26 Nov 2026: day to day the count moves by one
 * to three boards and steps up when the registry grows; 14 November (149
 * against a trailing median of 210) is the one collapse, and the only day this flags.
 * The absolute floor keeps a registry of a few dozen boards from flagging a
 * one-board wobble. Fewer than `minDays` earlier days and nothing is said.
 */
export const COVERAGE = { window: 14, minDays: 5, ratio: 0.85, minDrop: 10 };

const DAY_MS = 86_400_000;
const iso = (t) => new Date(t).toISOString().slice(0, 10);

function datesBetween(from, to) {
  const out = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += DAY_MS) out.push(iso(t));
  return out;
}

export function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** The coverage verdict for the newest of `days` (sorted by date, parsed). */
export function coverageVerdict(days, opts = COVERAGE) {
  const usable = days.filter((d) => d.file && Number.isFinite(d.file.counts?.ok));
  if (!usable.length) return null;
  const latest = usable[usable.length - 1];
  const before = usable.slice(0, -1).slice(-opts.window).map((d) => d.file.counts.ok);
  if (before.length < opts.minDays) return { date: latest.date, ok: latest.file.counts.ok, median: null, flagged: false };
  const med = median(before);
  const ok = latest.file.counts.ok;
  const flagged = ok < opts.ratio * med && med - ok >= opts.minDrop;
  return { date: latest.date, ok, median: med, flagged };
}

/**
 * @param days                [{ date, file }] where file is the parsed day file, or null if unreadable
 * @param registry            lib/collection-method.json, parsed
 * @param publishedMatches    whether data/collection-methods.json equals the registry
 * @param currentFingerprint  the code on disk, when the caller is the collection (optional)
 * @param through             the last date a file is due for (YYYY-MM-DD)
 * @param now                 Date
 * @param gaps                KNOWN_GAPS, injectable for tests
 */
export function boardCheckHealth({ days, registry, publishedMatches = true, currentFingerprint, through, now = new Date(), gaps = KNOWN_GAPS }) {
  const problems = [];
  const sorted = [...days].sort((a, b) => a.date.localeCompare(b.date));
  const have = new Set(sorted.map((d) => d.date));
  const labelled = registry?.fingerprints ?? {};

  if (!sorted.length) {
    problems.push({ code: 'missing-day', detail: 'there are no board-check files at all' });
    return { problems, latest: null, coverage: null, gapsAcknowledged: [] };
  }

  const gapsAcknowledged = [];
  for (const date of datesBetween(sorted[0].date, through)) {
    if (have.has(date)) continue;
    if (gaps[date]) gapsAcknowledged.push(date);
    else problems.push({ code: 'missing-day', detail: `no board-check file for ${date}; find out why from that day's run, then recover it from a genuine artefact of that run or record the reason in KNOWN_GAPS (lib/board-check-health.mjs)` });
  }

  for (const { date, file } of sorted) {
    if (!file) {
      problems.push({ code: 'unreadable-day', detail: `data/board-checks/${date}.json is not readable JSON` });
      continue;
    }
    if (!file.fingerprint) problems.push({ code: 'no-fingerprint', detail: `data/board-checks/${date}.json does not carry the fingerprint of the code that collected it` });
    else if (!labelled[file.fingerprint]) {
      problems.push({ code: 'unlabelled-fingerprint', detail: `${date} was collected by fingerprint ${file.fingerprint}, which lib/collection-method.json does not label; run node scripts/collection-method.mjs --fingerprint ${file.fingerprint} --new-method|--same-as <fp> --note "..."` });
    }
  }
  if (currentFingerprint && !labelled[currentFingerprint]) {
    problems.push({ code: 'unlabelled-fingerprint', detail: `the collector's code (fingerprint ${currentFingerprint}) is not labelled; every day it runs compares with nothing until it is. Run node scripts/collection-method.mjs` });
  }
  if (!publishedMatches) {
    problems.push({ code: 'registry-unpublished', detail: 'data/collection-methods.json differs from lib/collection-method.json; run node scripts/collection-method.mjs --publish' });
  }

  const latest = sorted[sorted.length - 1];
  const stamp = Date.parse(latest.file?.checkedAt ?? `${latest.date}T00:00:00Z`);
  const ageHours = Math.round((now.getTime() - stamp) / 3_600_000);
  if (!Number.isFinite(stamp) || ageHours > STALE_HOURS) {
    problems.push({ code: 'stale', detail: `the newest board-check file is ${latest.date}, ${ageHours}h old, past ${STALE_HOURS}h` });
  }

  const coverage = coverageVerdict(sorted);
  if (coverage?.flagged) {
    problems.push({ code: 'coverage-drop', detail: `${coverage.date} read ${coverage.ok} boards completely against a trailing median of ${coverage.median}; below ${COVERAGE.ratio * 100}% and ${COVERAGE.minDrop}+ boards down, so most comparisons with that day are lost` });
  }
  return { problems, latest: latest.date, ageHours, coverage, gapsAcknowledged };
}

/** The operator's table, for a job summary. */
export function healthSummary(result, title = 'Board-check record') {
  const lines = [`### ${title}`, ''];
  lines.push(`Newest day file: \`${result.latest ?? 'none'}\`${result.ageHours !== undefined ? ` (${result.ageHours}h old)` : ''}.`);
  if (result.coverage) {
    lines.push(`Boards read completely on ${result.coverage.date}: ${result.coverage.ok}${result.coverage.median !== null ? ` (trailing median ${result.coverage.median})` : ''}.`);
  }
  if (result.gapsAcknowledged?.length) lines.push(`Acknowledged gaps: ${result.gapsAcknowledged.join(', ')} (lib/board-check-health.mjs KNOWN_GAPS).`);
  lines.push('');
  if (!result.problems.length) lines.push('No problems: every day is on file, every fingerprint is labelled and published, the record is fresh and coverage is normal.');
  else for (const p of result.problems) lines.push(`- **${p.code}**: ${p.detail}`);
  return lines.join('\n') + '\n';
}
