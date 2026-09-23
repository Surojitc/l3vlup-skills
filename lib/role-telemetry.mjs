/**
 * Facts about a role's age that can be derived without asking anyone.
 *
 * WHY THIS IS MEASUREMENT AND NOT A RULE
 * --------------------------------------
 * About three quarters of the live feed carries no closing date, and the site
 * shows those rows as "Listed" for as long as the employer's own board keeps
 * them. An audit found one still published in September 2026 under the title
 * "2025 Markets Internship Colombia". The obvious fix is an expiry rule, and
 * every candidate rule (N days in the feed, N days since posting, a past year
 * in the title) would remove real, open seats along with the stale ones:
 * rolling graduate schemes stay up for months, Workday reports anything older
 * than thirty days as "30+" and so has no posted date at all, and Jane Street
 * publishes no dates of any kind.
 *
 * So this module only derives, and docs/role-lifecycle-telemetry-2026-09.md
 * reads what it derives across the live feed before anyone decides on a rule.
 * Everything here is pure and takes `today` as an argument, so a report run on
 * a given day reproduces exactly.
 */

const ISO = /^\d{4}-\d{2}-\d{2}$/;

function daysBetween(from, to) {
  if (!ISO.test(String(from ?? '')) || !ISO.test(String(to ?? ''))) return null;
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86400000);
}

/** Whole days since the ATS posted the role, or null when it gave no date. */
export function postedAgeDays(openingDate, today) {
  const d = daysBetween(openingDate, today);
  return d === null || d < 0 ? null : d;
}

/** Whole days between two ISO dates, or null. Exported for the report. */
export { daysBetween };

const expand = (yy) => (yy.length === 2 ? 2000 + Number(yy) : Number(yy));
const plausible = (y) => y >= 2015 && y <= 2040;

/**
 * The recruiting year a title refers to, and every year it names.
 *
 * A cycle is read as its later year: "2025-2026", "2025/26" and "2026/27" are
 * the 2026, 2026 and 2027 cohorts, because a cycle that ends this year is not
 * yet over. "FY26" is 2026. A number that runs into other digits is not a
 * year, so the requisition 25843173 does not read as 2584. When a title names
 * several years the latest wins: "Summer 2026 / Full-time 2027" is still
 * recruiting for 2027.
 *
 * Returns { cohortYear: number|null, years: number[] }.
 */
export function inferCohortYear(title) {
  const text = String(title ?? '');
  const years = [];

  const cycle = /(?<![\d])(20\d{2})\s*[-–—/]\s*(20\d{2}|\d{2})(?![\d])/g;
  let stripped = text;
  for (const m of text.matchAll(cycle)) {
    const start = Number(m[1]);
    const end = expand(m[2]);
    // "2025-26" must end after it starts; "2026-2" is not a cycle.
    if (plausible(start) && plausible(end) && end >= start && end - start <= 2) {
      years.push(start, end);
      stripped = stripped.replace(m[0], ' ');
    }
  }
  for (const m of stripped.matchAll(/(?<![\d])(20\d{2})(?![\d])/g)) {
    const y = Number(m[1]);
    if (plausible(y)) years.push(y);
  }
  for (const m of stripped.matchAll(/\bFY\s?'?(\d{2})\b/gi)) {
    const y = expand(m[1]);
    if (plausible(y)) years.push(y);
  }

  const unique = [...new Set(years)].sort((a, b) => a - b);
  return { cohortYear: unique.length ? unique[unique.length - 1] : null, years: unique };
}

/**
 * The first date each id appears in the board history.
 *
 * A floor, not the truth: the history keeps 120 snapshots and began on
 * 2026-08-18, so a role first seen that day may be much older.
 */
export function firstSeenIndex(snapshots) {
  const first = new Map();
  const ordered = [...(snapshots ?? [])].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  for (const snap of ordered) {
    for (const id of snap?.ids ?? []) if (!first.has(id)) first.set(id, snap.date);
  }
  return first;
}

/**
 * How often each id has left the board and come back. A role that flaps is
 * one an absence rule would have closed and then had to reopen.
 */
export function absenceSpells(snapshots, id) {
  const ordered = [...(snapshots ?? [])].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  let seen = false;
  let absent = false;
  let spells = 0;
  for (const snap of ordered) {
    const present = (snap?.ids ?? []).includes(id);
    if (present) {
      if (seen && absent) spells += 1;
      seen = true;
      absent = false;
    } else if (seen) {
      absent = true;
    }
  }
  return spells;
}

/** The source family of a row, read from its id prefix. */
export function sourceFamily(row) {
  const id = String(row?.id ?? '');
  const cut = id.indexOf('-');
  return cut > 0 ? id.slice(0, cut) : 'unknown';
}
