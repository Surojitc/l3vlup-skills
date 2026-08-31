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

// A firm usually runs several Workday sites off a single tenant: a campus one,
// a lateral one, sometimes a returners or alumni one. They are all real boards
// that answer with real postings, so validation cannot tell them apart — only
// the site name can.
const CAMPUS_SITE = /campus|student|graduate|early|university|school|intern/i;
const EXPERIENCED_SITE = /lateral|experienc|professional|alumni|returner/i;

/**
 * First recognised board on a page, preferring Workday (what banks actually use)
 * and, within Workday, the site that carries early-career roles.
 *
 * The first run without this put Bank of America on 'lateral-us' and Moelis on
 * 'Experienced-Hires'. Both validated, because both are real boards with
 * hundreds of postings — just not the postings this tracker exists to show. A
 * bank listed with zero early-career roles is indistinguishable from a bank
 * that has not opened applications yet, so the error would have sat there.
 *
 * A lateral board is still taken when it is the only one: visible and wrong
 * beats absent, because someone can correct what they can see.
 */
export function firstBoard(html, baseUrl) {
  const found = candidateUrls(html, baseUrl).map(detectBoard).filter(Boolean);
  const wd = found.filter((b) => b.ats === 'workday');
  return (
    wd.find((b) => CAMPUS_SITE.test(b.site)) ??
    wd.find((b) => !EXPERIENCED_SITE.test(b.site)) ??
    wd[0] ??
    found[0] ??
    null
  );
}

/* ------------------------- token guessing --------------------------------- */
/**
 * Candidate ATS tokens derived from a firm's name.
 *
 * Reading the careers page finds nothing when that page is client-rendered,
 * which most fund sites are: a sweep of 128 seed firms returned "no board
 * found" for 106 of them, and guessing tokens against the Greenhouse, Ashby and
 * Lever APIs then resolved eleven of those immediately — AQR, Man Group,
 * Squarepoint, Qube, Schonfeld, Lincoln International and William Blair among
 * them. Firms overwhelmingly use their own name as the token.
 *
 * Order matters: the collapsed form ("williamblair") is by far the most common,
 * so it is tried first and the loop stops at the first board that answers.
 */
export function candidateTokens(firmName) {
  const base = String(firmName || '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9 ]/g, '')
    .trim();
  if (!base) return [];
  const collapsed = base.replace(/ /g, '');
  const dashed = base.replace(/ +/g, '-');
  const first = base.split(' ')[0];
  // "Man Group" -> "man", "AQR Capital Management" -> "aqr".
  const withoutSuffix = base
    .replace(/\b(group|partners|capital|management|advisors|advisers|securities|global|holdings|company|co|inc|llc|lp|international)\b/g, '')
    .trim()
    .replace(/ +/g, '');
  return [...new Set([collapsed, dashed, first, withoutSuffix])].filter((t) => t.length > 2);
}

/**
 * Does this board plausibly belong to this firm?
 *
 * Venture and growth firms publish their *portfolio companies'* boards on their
 * own careers pages, and those boards validate perfectly — they are real, they
 * answer, they are full of early-career roles. The first sweep therefore
 * credited Verkada's jobs to General Catalyst, Flexport's to Andreessen
 * Horowitz and Bitmovin's to Atomico. Every one would have shipped as that VC
 * hiring dozens of interns.
 *
 * A token is accepted when it shares a meaningful stem with the firm name.
 * Anything else has to be confirmed by hand.
 */
export function tokenMatchesFirm(firmName, token) {
  if (!firmName || !token) return false;
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  const t = norm(token);
  const f = norm(firmName);
  if (!t || !f) return false;
  if (f.includes(t) || t.includes(f)) return true;
  // Fall back to the first meaningful word, so "aqr" matches "AQR Capital
  // Management" while "verkada" still fails against "General Catalyst".
  const head = norm(String(firmName).split(/\s+/)[0]);
  return head.length > 2 && (t.startsWith(head) || head.startsWith(t));
}
