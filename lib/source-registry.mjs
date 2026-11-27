/**
 * One record per source the tracker reads: how it may be read, when it last
 * answered, and what is wrong with it. And the alerts a daily report should
 * raise about the whole set.
 *
 * WHY THIS EXISTS
 * Three facts about a board lived in three places. Its address in
 * lib/sources/ats-registry.json, its daily outcome in data/board-checks/, and
 * the terms of the method it is read through nowhere at all, which is how
 * Roland Berger and Legal & General were read for weeks through an API whose
 * robots.txt disallows every crawler but LinkedInBot. This module joins the
 * three, and lib/sources/source-terms.json supplies the third.
 *
 * WHAT IT ALERTS ON (each one cheap, each one a real fault):
 *   not-permitted   an active row on a method whose terms say it may not be read
 *   undecided       an active row on a method whose terms are still 'unclear'
 *                   (a warning, so the decision is never forgotten)
 *   failing         the board failed on each of its last `failRun` checks
 *   unexpected-zero the board answered 0 today after holding roles on most of
 *                   the previous `zeroWindow` checks: an empty answer from a
 *                   board that changed shape looks exactly like this
 *   stale           no successful check in `staleDays` days
 *   shape           the fetcher said the page or payload changed shape
 *   breaking        a provider change announced within `breakingDays` days
 *   duplicate-firm  two active rows share a name, so their checks collide
 *
 * Pure: every input is passed in, so the test drives it with fixtures.
 */

export const DEFAULTS = { failRun: 3, zeroWindow: 5, staleDays: 3, breakingDays: 75 };

const day = (s) => Date.parse(`${s}T00:00:00Z`);
const daysBetween = (a, b) => Math.round((day(b) - day(a)) / 86_400_000);

/**
 * @param registry  ats-registry.json `firms`
 * @param terms     source-terms.json
 * @param checks    board-check files, any order: [{ date, boards: { firm: { s, n, reason? } } }]
 * @returns         one record per registry row, keyed by firm name and method
 */
export function buildSourceRegistry(registry, terms, checks) {
  const history = [...(checks ?? [])].filter((c) => c?.date && c?.boards).sort((a, b) => a.date.localeCompare(b.date));
  return (registry ?? []).map((row) => {
    const method = terms?.methods?.[row.ats] ?? null;
    const seen = history.filter((c) => c.boards[row.firm]).map((c) => ({ date: c.date, ...c.boards[row.firm] }));
    const lastOk = [...seen].reverse().find((c) => c.s === 'ok' || c.s === 'partial');
    const last = seen[seen.length - 1] ?? null;
    return {
      firm: row.firm,
      ats: row.ats,
      tier: row.tier ?? null,
      active: !row.parked,
      parkedReason: row.parked ? row.parkedReason ?? 'parked' : null,
      permitted: method ? method.permitted : 'unknown',
      basis: method?.basis ?? 'no terms recorded for this method',
      attribution: method?.attribution ?? null,
      limitations: method?.limitations ?? null,
      breaking: method?.breaking ?? [],
      lastChecked: last?.date ?? null,
      lastStatus: last?.s ?? null,
      lastSuccess: lastOk?.date ?? null,
      roles: last && typeof last.n === 'number' ? last.n : null,
      history: seen.map((c) => ({ date: c.date, s: c.s, n: typeof c.n === 'number' ? c.n : null, reason: c.reason ?? null })),
    };
  });
}

/** Alerts for a built registry, as { level: 'problem' | 'warning', kind, firm?, message }. */
export function sourceAlerts(records, { today, ...opts } = {}) {
  const o = { ...DEFAULTS, ...opts };
  const out = [];
  const push = (level, kind, firm, message) => out.push({ level, kind, firm, message });
  const methodsWarned = new Set();

  for (const r of records) {
    if (!r.active) continue;
    if (r.permitted === false) push('problem', 'not-permitted', r.firm, `${r.firm} is read through ${r.ats}, which may not be read (${r.basis}). Park the row or move it to a permitted route.`);
    else if (r.permitted === 'unclear' || r.permitted === 'unknown') {
      if (!methodsWarned.has(r.ats)) {
        methodsWarned.add(r.ats);
        const n = records.filter((x) => x.active && x.ats === r.ats).length;
        push('warning', 'undecided', null, `${n} active board(s) are read through ${r.ats}, whose terms are undecided: ${r.basis}`);
      }
    }

    const h = r.history;
    if (!h.length) {
      push('warning', 'stale', r.firm, `${r.firm} has never been checked`);
      continue;
    }
    const tail = h.slice(-o.failRun);
    if (tail.length === o.failRun && tail.every((c) => c.s === 'failed')) {
      push('problem', 'failing', r.firm, `${r.firm} failed on each of its last ${o.failRun} checks${tail[tail.length - 1].reason ? ` (${tail[tail.length - 1].reason})` : ''}`);
    }
    const last = h[h.length - 1];
    if (last.reason && /changed shape|no jobs parsed|unexpected/i.test(last.reason)) {
      push('problem', 'shape', r.firm, `${r.firm}: ${last.reason}`);
    }
    if (last.s === 'ok' && last.n === 0) {
      const before = h.slice(-1 - o.zeroWindow, -1).filter((c) => c.s === 'ok' && typeof c.n === 'number');
      const held = before.filter((c) => c.n > 0).length;
      if (before.length >= 3 && held > before.length / 2) {
        push('warning', 'unexpected-zero', r.firm, `${r.firm} answered 0 roles after holding roles on ${held} of its previous ${before.length} checks`);
      }
    }
    if (today && r.lastSuccess && daysBetween(r.lastSuccess, today) > o.staleDays) {
      push('problem', 'stale', r.firm, `${r.firm} last answered successfully on ${r.lastSuccess}, ${daysBetween(r.lastSuccess, today)} days ago`);
    } else if (today && !r.lastSuccess) {
      push('problem', 'stale', r.firm, `${r.firm} has never answered successfully`);
    }
  }

  // Board checks, the Hiring Pulse and the run log are all keyed by firm name,
  // so two active rows with one name overwrite each other's record every day.
  const names = new Map();
  for (const r of records) if (r.active) names.set(r.firm, (names.get(r.firm) ?? 0) + 1);
  for (const [firm, n] of names) {
    if (n > 1) push('warning', 'duplicate-firm', firm, `${n} active registry rows are named ${firm}; their daily checks overwrite each other. Give each a distinct name or read one board.`);
  }

  // Announced provider changes, once per method that still has an active row.
  const methods = new Map();
  for (const r of records) if (r.active) for (const b of r.breaking) methods.set(`${r.ats}|${b.on}`, { ats: r.ats, ...b });
  for (const b of methods.values()) {
    const until = today ? daysBetween(today, b.on) : null;
    if (until !== null && until <= o.breakingDays) {
      push(until <= 14 ? 'problem' : 'warning', 'breaking', null, `${b.ats}: ${b.what} (${until >= 0 ? `in ${until} days, on ${b.on}` : `since ${b.on}`})`);
    }
  }
  return out;
}
