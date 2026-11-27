/**
 * Hosts an automated agent must not request, or must ask about first, BEFORE
 * the first request.
 *
 * WHY
 * On 27 November 2026 a research agent compiling VC boards made GET requests
 * to six Getro and Consider boards before it recognised them as Getro or
 * Consider boards, whose terms prohibit automated access without permission.
 * Nothing was kept, but the request had already been made. The collector's own
 * readers are governed by lib/sources/source-terms.json and the registry; this
 * list is for everything else that fetches: research agents, audits, one-off
 * scripts. Check a URL here first:
 *
 *   node lib/restricted-hosts.mjs https://jobs.sequoiacap.com/jobs
 *
 * prints the verdict and exits 0 for `allowed`, 2 for `ask` and 3 for `blocked`,
 * so a script can stop on a non-zero exit before it fetches.
 *
 * VERDICTS
 *   blocked  The site's terms or robots.txt exclude automated reading, or the
 *            site refuses automated requests. Do not request it at all,
 *            including robots.txt and the home page, until a recorded permission
 *            changes the entry.
 *   ask      Terms are unclear or a permission is pending. Do not request it from
 *            an agent; the collector's existing reader may continue as recorded in
 *            source-terms.json, and nothing else may be added without a decision.
 *   allowed  Nothing recorded against it. Normal care still applies: robots.txt,
 *            rate, and the employer's own page as the source of truth.
 *
 * A Getro or Consider board usually sits on the fund's own domain
 * (jobs.accel.com), so the host alone cannot catch every one. Each known board
 * is listed; an unknown `jobs.<fund>` or `careers.<fund>` host that is a talent
 * network should be treated as `ask` until checked by its terms page, not by
 * fetching its job list.
 *
 * Sources for every entry: L3vlup docs/tracker-coverage-consulting-vc-2026-11.md,
 * sections 2 and 3.
 */

export const RESTRICTED_HOSTS = [
  // Aggregators: never a source for the tracker.
  { match: 'linkedin.com', verdict: 'blocked', reason: 'Aggregator; its terms prohibit automated access. Never a tracker source.' },
  { match: 'indeed.com', verdict: 'blocked', reason: 'Aggregator; never a tracker source.' },
  { match: 'glassdoor.com', verdict: 'blocked', reason: 'Aggregator; never a tracker source.' },
  { match: 'glassdoor.co.uk', verdict: 'blocked', reason: 'Aggregator; never a tracker source.' },

  // Robots.txt excludes every crawler but LinkedInBot (checked 27 November 2026).
  { match: 'api.smartrecruiters.com', verdict: 'blocked', reason: 'robots.txt is Disallow: / for every agent but LinkedInBot. Reader suspended.' },
  { match: 'jobs.smartrecruiters.com', verdict: 'blocked', reason: 'SmartRecruiters host; link to it as the apply URL, never fetch it.' },
  { match: 'careers.smartrecruiters.com', verdict: 'blocked', reason: 'SmartRecruiters host; never fetch it.' },

  // Getro: terms cover "any job board operated by Getro" and prohibit crawling.
  { match: 'getro.com', verdict: 'blocked', reason: 'Getro terms prohibit crawling, scraping or spidering any board it operates. Permission pending.' },
  { match: 'jobs.accel.com', verdict: 'blocked', reason: 'Getro board (Accel). Permission request drafted, not sent.' },
  { match: 'jobs.insightpartners.com', verdict: 'blocked', reason: 'Getro board.' },
  { match: 'jobs.notioncapital.com', verdict: 'blocked', reason: 'Getro board.' },
  { match: 'jobs.phoenixcourt.vc', verdict: 'blocked', reason: 'Getro board.' },

  // Consider: terms 1.4(l), no automated means without written permission.
  { match: 'consider.com', verdict: 'blocked', reason: 'Consider terms 1.4(l): no automated access without written permission.' },
  { match: 'jobs.sequoiacap.com', verdict: 'blocked', reason: 'Consider board (Sequoia). Permission request drafted, not sent.' },
  { match: 'jobs.lsvp.com', verdict: 'blocked', reason: 'Consider board (Lightspeed). Permission request drafted, not sent.' },
  { match: 'careers.balderton.com', verdict: 'blocked', reason: 'Consider board (Balderton). Permission request drafted, not sent.' },

  // Employers whose own sites refuse automated requests.
  { match: 'mckinsey.com', verdict: 'blocked', reason: 'careers search answers 503 to an automated request. Not added; do not retry.' },
  { match: 'alvarezandmarsal.com', verdict: 'blocked', reason: 'careers page answers 403 to an automated request. Not added; do not retry.' },

  // Read by the collector under recorded terms, owed a decision: no new use.
  { match: 'myworkdayjobs.com', verdict: 'ask', reason: 'Workday terms unclear; the collector reads listing metadata on registered boards only. No agent fetches, no new board, no description text, until the clarification is answered.' },
  { match: 'myworkdaysite.com', verdict: 'ask', reason: 'Workday host; as myworkdayjobs.com.' },
];

/** The entry for a URL or bare host, or null. A suffix match on a dot boundary. */
export function restrictionFor(urlOrHost) {
  let host;
  try {
    host = new URL(/^[a-z]+:\/\//i.test(urlOrHost) ? urlOrHost : `https://${urlOrHost}`).hostname.toLowerCase();
  } catch {
    return { match: String(urlOrHost), verdict: 'blocked', reason: 'Not a URL; refuse rather than guess.' };
  }
  for (const entry of RESTRICTED_HOSTS) {
    if (host === entry.match || host.endsWith(`.${entry.match}`)) return entry;
  }
  return null;
}

export function verdictFor(urlOrHost) {
  return restrictionFor(urlOrHost)?.verdict ?? 'allowed';
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const targets = process.argv.slice(2);
  if (!targets.length) {
    console.error('usage: node lib/restricted-hosts.mjs <url> [url...]');
    process.exit(64);
  }
  let worst = 0;
  for (const t of targets) {
    const e = restrictionFor(t);
    const v = e?.verdict ?? 'allowed';
    console.log(`${v.padEnd(7)} ${t}${e ? `  (${e.reason})` : ''}`);
    worst = Math.max(worst, v === 'blocked' ? 3 : v === 'ask' ? 2 : 0);
  }
  process.exit(worst);
}
