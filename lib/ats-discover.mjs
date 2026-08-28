/**
 * Resolve a firm's careers page to the ATS board behind it.
 *
 * WHY
 * The registry is 34 Greenhouse + 11 Ashby + 3 Workday, and those are what tech
 * companies and prop shops use. That is the whole reason a finance careers
 * tracker came back 72% software engineering: the collection method selects
 * against the market the site serves. Banks and funds sit on Workday, Oracle
 * and bespoke sites, so their boards have to be found rather than assumed.
 *
 * Tenant IDs are guessable and silently wrong when guessed — a plausible-looking
 * tenant returns an empty board rather than an error, which reads as "this firm
 * has no early-career roles". So nothing here guesses: detection is pattern
 * matching against a URL the firm itself linked to, and the caller validates by
 * asking the board for postings before anything is written.
 */

/** Board API endpoints, so the caller can prove a board is real before trusting it. */
export function boardApiUrl(board) {
  if (!board) return null;
  switch (board.ats) {
    case 'greenhouse':
      return `https://boards-api.greenhouse.io/v1/boards/${board.token}/jobs?content=false`;
    case 'lever':
      return `https://api.lever.co/v0/postings/${board.token}?mode=json`;
    case 'ashby':
      return `https://api.ashbyhq.com/posting-api/job-board/${board.token}`;
    case 'workday':
      // The CxS endpoint the Workday front end itself calls. POST, unlike the rest.
      return `https://${board.tenant}.${board.shard}.myworkdayjobs.com/wday/cxs/${board.tenant}/${board.site}/jobs`;
    default:
      return null;
  }
}

const CLEAN = (s) => String(s || '').split('?')[0].split('#')[0].replace(/\/+$/, '');

/**
 * @param {string} url  A URL found on, or redirected to from, a careers page.
 * @returns {{ats:string, token?:string, tenant?:string, shard?:string, site?:string}|null}
 */
export function detectBoard(url) {
  const u = CLEAN(url);
  if (!u) return null;

  // Workday: https://{tenant}.{shard}.myworkdayjobs.com/[locale/]{site}
  const wd = u.match(
    /^https?:\/\/([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?([^/]+)/i
  );
  if (wd) return { ats: 'workday', tenant: wd[1].toLowerCase(), shard: wd[2].toLowerCase(), site: wd[3] };

  // Greenhouse, on any of the hosts it has used.
  const gh = u.match(
    /^https?:\/\/(?:boards|job-boards)\.greenhouse\.io\/(?:embed\/job_board\?for=)?([a-z0-9_-]+)/i
  );
  if (gh && gh[1] !== 'embed') return { ats: 'greenhouse', token: gh[1].toLowerCase() };

  const ghEmbed = u.match(/greenhouse\.io\/embed\/job_board\/?.*?\bfor=([a-z0-9_-]+)/i);
  if (ghEmbed) return { ats: 'greenhouse', token: ghEmbed[1].toLowerCase() };

  const lever = u.match(/^https?:\/\/jobs\.(?:eu\.)?lever\.co\/([a-z0-9_-]+)/i);
  if (lever) return { ats: 'lever', token: lever[1].toLowerCase() };

  const ashby = u.match(/^https?:\/\/jobs\.ashbyhq\.com\/([a-z0-9_.-]+)/i);
  if (ashby) return { ats: 'ashby', token: ashby[1].toLowerCase() };

  return null;
}

/**
 * Families we can recognise but cannot poll. Naming them is useful: it turns
 * "we found nothing" into "this firm is on SuccessFactors", which is a
 * different piece of work rather than a failure.
 */
export function detectUnsupportedFamily(url) {
  const u = CLEAN(url).toLowerCase();
  if (!u) return null;
  if (u.includes('fa.oraclecloud.com') || u.includes('oraclecloud.com/hcmui')) return 'oracle-cloud';
  if (u.includes('successfactors') || u.includes('sapsf.com')) return 'successfactors';
  if (u.includes('icims.com')) return 'icims';
  if (u.includes('taleo.net')) return 'taleo';
  if (u.includes('eightfold.ai')) return 'eightfold';
  if (u.includes('phenompeople.com') || u.includes('.phenom.')) return 'phenom';
  if (u.includes('smartrecruiters.com')) return 'smartrecruiters';
  if (u.includes('workable.com')) return 'workable';
  if (u.includes('avature.net')) return 'avature';
  if (u.includes('brassring.com') || u.includes('kenexa')) return 'brassring';
  return null;
}

/** Pull every candidate board URL out of a careers page's HTML. */
export function candidateUrls(html, baseUrl) {
  const urls = new Set();
  for (const m of String(html || '').matchAll(/https?:\/\/[^\s"'<>()\\]+/g)) {
    urls.add(m[0]);
  }
  // Protocol-relative and root-relative links that still name a known host.
  for (const m of String(html || '').matchAll(/\/\/[a-z0-9.-]+\.(?:myworkdayjobs|greenhouse|lever|ashbyhq)\.[a-z]+[^\s"'<>()\\]*/gi)) {
    urls.add(`https:${m[0]}`);
  }
  if (baseUrl) urls.add(baseUrl);
  return [...urls];
}

/** First recognised board on a page, preferring Workday (what banks actually use). */
export function firstBoard(html, baseUrl) {
  const found = candidateUrls(html, baseUrl).map(detectBoard).filter(Boolean);
  return found.find((b) => b.ats === 'workday') ?? found[0] ?? null;
}
