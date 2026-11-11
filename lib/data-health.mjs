// The daily health check's two judgements, pure (scripts/data-health.mjs).

// How long the live /intel/funds page may trail main before it is a failure.
// Since 11 November 2026 (L3vlup docs/vercel-cost-2026-11.md) the site reads
// the data origin through a six-hour cache and rebuilds the 13F pages once a
// day on top of it, so a fresh collection can take up to 24 + 6 = 30 hours to
// show there. 31 leaves an hour's margin: the old 6 would have failed every
// filing-window morning for a cost decision, not a fault. A collection that
// never reaches the site (the 1 November failure was days) still fails.
export const LAG_HOURS = 31;

const hours = (ms) => ms / 3_600_000;

/**
 * Whether the live site lags `main`. `main` and `live` are the collection's
 * generatedAt as main holds it and as the page shows it; `mainCommitted` is
 * when main's copy landed.
 */
export function productionLag({ main, mainCommitted, live, now }) {
  const m = main ? new Date(main) : null;
  if (!m || Number.isNaN(m.getTime())) return { verdict: 'main unreadable', problem: '13F holdings on main carry no readable generatedAt' };
  if (!live) return { verdict: 'live date not found', warning: 'the live 13F page shows no collection date; the page may have changed' };
  // The page may print the day alone; a day means any time within it.
  const l = new Date(/^\d{4}-\d{2}-\d{2}$/.test(live) ? `${live}T23:59:59Z` : live);
  if (Number.isNaN(l.getTime())) return { verdict: 'live date unreadable', warning: `the live 13F page shows an unreadable date (${live})` };
  const behind = hours(m.getTime() - l.getTime());
  if (behind <= 1) return { verdict: 'live matches main' };
  const landed = mainCommitted ? new Date(mainCommitted) : m;
  const waiting = hours(now.getTime() - landed.getTime());
  if (waiting < LAG_HOURS) return { verdict: `live is ${Math.round(behind)}h behind, within the ${LAG_HOURS}h the caches may take` };
  return {
    verdict: `live is ${Math.round(behind)}h behind`,
    problem: `the live 13F pages serve a collection ${Math.round(behind)}h older than main's, ${Math.round(waiting)}h after main's landed`,
  };
}

/** Counts across discovery, the queue and the catalogue. */
export function letterFunnel(queue, keys) {
  const entries = Array.isArray(queue?.entries) ? queue.entries : [];
  const published = Array.isArray(keys?.keys) ? keys.keys.length : 0;
  return {
    published,
    queued: entries.filter((e) => e.status === 'review').length,
    likely: entries.filter((e) => e.status === 'review' && e.classification === 'investor-letter').length,
    decided: entries.filter((e) => e.status !== 'review').length,
  };
}
