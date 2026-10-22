/**
 * Corporate actions behind large overnight moves in IEX reference prices.
 *
 * A move of more than 40% overnight may be a stock split, a reverse split, a
 * spin-off, a special distribution, a merger or reorganisation, a share-class
 * change, or an ordinary price move. The price series alone cannot tell them
 * apart: Corteva's 1 October 2026 spin-off of its seed business left a price
 * one sixth of the day before, which looks exactly like a 6-for-1 split.
 *
 * So the price detector here only proposes CANDIDATES. Each candidate is then
 * classified on evidence, in this order:
 *
 *   A. what the company's own SEC filings say near the date (8-K, 6-K, 10-Q,
 *      10-K, 20-F, registration and proxy materials): a stated split ratio,
 *      or a spin-off, separation, distribution, special dividend,
 *      reclassification or reorganisation;
 *   B. the share count on the filing covers before and after the date, as
 *      corroboration only: a count that moved as a split would confirms a
 *      filing's split, one that plainly did not contradicts it, and no count
 *      ever confirms a split on its own;
 *   C. the wording: a filing that describes a separation or distribution makes
 *      the event a corporate action even when the price ratio looks like a
 *      split.
 *
 * Five classes, and only the first two rescale earlier prices, at the ratio
 * the filing states:
 *
 *   CONFIRMED_SPLIT          a filing states the split and the move matches it
 *   CONFIRMED_REVERSE_SPLIT  the same, for a reverse split
 *   OTHER_CORPORATE_ACTION   a filing describes a non-split action; no ratio is
 *                            guessed, and the history is bounded at the date
 *   UNRESOLVED               shaped like a split but no filing explains it, or
 *                            the evidence conflicts; bounded at the date
 *   ORDINARY_PRICE_MOVE      a large move with no split shape and no action
 *                            behind it; the history stands as it is
 *
 * Pure: candidates from observations, the meaning of filing text, and the
 * classification. lib/corporate-action-evidence.mjs fetches the filings.
 */

export const ACTION = Object.freeze({
  SPLIT: 'CONFIRMED_SPLIT',
  REVERSE: 'CONFIRMED_REVERSE_SPLIT',
  OTHER: 'OTHER_CORPORATE_ACTION',
  UNRESOLVED: 'UNRESOLVED',
  ORDINARY: 'ORDINARY_PRICE_MOVE',
});

/** A move this large overnight is a candidate: |log(after / before)| > log(1.4). */
export const BIG_MOVE = Math.log(1.4);

/** Whole split ratios a price can move by, and how close a move must be to one to be split-shaped. */
const SPLIT_RATIOS = [2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 30, 40, 50, 1.5, 2.5];
const SPLIT_TOLERANCE = 0.03;

/** How far the day's move may sit from a filing's ratio and still be that split: prices move on the day too. */
export const RATIO_MATCH = 0.15;
/** A share count within this of what a split implies corroborates it; outside CONTRADICTION it contradicts. */
const SHARES_AGREE = 0.1;
const SHARES_CONTRADICT = 0.25;

/** Filings read for evidence, by form, and how far either side of the date. */
export const EVIDENCE_FORMS = new Set(['8-K', '8-K/A', '6-K', '10-Q', '10-K', '20-F', '40-F', '8-K12B', '425', 'S-4', '10-12B', 'DEF 14A', 'DEFM14A', 'PRE 14A', '424B3', '497']);
export const EVIDENCE_DAYS_BEFORE = 120;
export const EVIDENCE_DAYS_AFTER = 45;

/** The whole split ratio an overnight change matches, as price-after / price-before, or null. */
export function splitRatio(change) {
  for (const k of SPLIT_RATIOS) {
    if (Math.abs(change * k - 1) < SPLIT_TOLERANCE) return 1 / k; // k-for-1 split
    if (Math.abs(change / k - 1) < SPLIT_TOLERANCE) return k; // 1-for-k reverse split
  }
  return null;
}

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const P = 0;
const GRADE = 1;
const DOLLARS = 5;

/**
 * Every large overnight move in a symbol's observations (calendar order, null
 * on days without one): { index, change, splitShaped (the ratio or null),
 * ordinaryVolume, grade }.
 */
export function findCandidates(entries) {
  const out = [];
  let prev = -1;
  for (let i = 0; i < entries.length; i += 1) {
    if (!entries[i]) continue;
    if (prev >= 0 && i - prev <= 5) {
      const change = entries[i][P] / entries[prev][P];
      if (Math.abs(Math.log(change)) > BIG_MOVE) {
        const usual = median(entries.slice(Math.max(0, prev - 20), prev + 1).filter(Boolean).map((e) => e[DOLLARS]));
        out.push({ index: i, change, splitShaped: splitRatio(change), ordinaryVolume: usual !== null && usual > 0 && entries[i][DOLLARS] <= usual * 3, grade: entries[i][GRADE] });
      }
    }
    prev = i;
  }
  return out;
}

// ── what a filing says ───────────────────────────────────────────────────

const WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20, 'twenty-five': 25, thirty: 30, forty: 40, fifty: 50, hundred: 100 };
// A number starts on its own: never the tail of 7,756,156, of $0.0001 or of "none".
const NUM = `(?<![\\w,.$])(\\d+(?:\\.\\d+)?|${Object.keys(WORDS).sort((a, b) => b.length - a.length).join('|')})(?![\\w,])`;
/** Any character of one sentence: a full stop counts only when it ends one, not inside $0.0001 or p.m. */
const IN_SENTENCE = '(?:[^.]|\\.(?=\\d|,|m\\b|\\s?[a-z]))';
const value = (s) => (/^\d/.test(s) ? Number(s) : WORDS[s.toLowerCase()]);

/** Filing HTML to plain text: tags dropped, the common entities decoded, whitespace collapsed. */
export function plainText(html) {
  return String(html ?? '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;|&#xa0;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#8209;|&#8211;|&#8212;|&ndash;|&mdash;|&#x2011;|&#x2013;/gi, '-')
    .replace(/&#8220;|&#8221;|&ldquo;|&rdquo;|&quot;/gi, '"')
    .replace(/&#8217;|&rsquo;|&#39;/gi, "'")
    .replace(/&#\d+;|&[a-z]+;/gi, ' ')
    .replace(/[‐-―]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

const QUALIFIERS = '(?:(?:forward|stock|share|common|capital)\\s+){0,3}';
const SPLIT_PATTERNS = [
  // "4-for-1 stock split", "one-for-ten reverse stock split", "five-for-one forward stock split", "3 for 2 split"
  { re: new RegExp(`${NUM}\\s*-?\\s*for\\s*-?\\s*${NUM}\\s+(reverse\\s+)?${QUALIFIERS}split`, 'gi'), old: 2, new: 1, rev: 3 },
  // "reverse stock split ... at a ratio of one-for-ten", "stock split on a 4-for-1 basis"
  { re: new RegExp(`(reverse\\s+)?(?:stock|share)\\s+split${IN_SENTENCE}{0,240}?\\bratio of\\s+${NUM}\\s*-?\\s*for\\s*-?\\s*${NUM}`, 'gi'), old: 3, new: 2, rev: 1 },
  { re: new RegExp(`(reverse\\s+)?(?:stock|share)\\s+split\\s+on\\s+an?\\s+${NUM}\\s*-?\\s*for\\s*-?\\s*${NUM}\\s+basis`, 'gi'), old: 3, new: 2, rev: 1 },
  // "a 1:10 reverse split"
  { re: new RegExp(`${NUM}\\s*:\\s*${NUM}\\s+(reverse\\s+)?${QUALIFIERS}split`, 'gi'), old: 2, new: 1, rev: 3 },
  // "every ten shares ... will be automatically reclassified into one new share", "every five (5) of our common shares ... converted into one"
  { re: new RegExp(`\\bevery\\s+${NUM}\\s+(?:\\(\\d+\\)\\s+)?(?:of\\s+(?:our|the|its)\\s+)?(?:[\\w-]+\\s+){0,6}?shares?\\b${IN_SENTENCE}{0,200}?\\b(?:combined|converted|reclassified|consolidated)${IN_SENTENCE}{0,60}?\\binto\\s+${NUM}\\s+(?:\\(\\d+\\)\\s+)?(?:new\\s+|whole\\s+)?(?:[\\w-]+\\s+){0,6}?shares?\\b`, 'gi'), old: 1, new: 2, needsSplitWord: true },
  // "each share ... will be automatically subdivided and reclassified into five shares"
  { re: new RegExp(`\\beach\\s+(?:issued\\s+and\\s+outstanding\\s+|outstanding\\s+)?share\\b${IN_SENTENCE}{0,200}?\\bsubdivided${IN_SENTENCE}{0,60}?\\binto\\s+${NUM}\\s+(?:\\(\\d+\\)\\s+)?(?:[\\w-]+\\s+){0,6}?shares\\b`, 'gi'), oldFixed: 1, new: 1, needsSplitWord: true },
];

/** Wording that describes a corporate action other than a split. `distribution` marks those that move the price for a reason other than a share-count change. */
const OTHER_PATTERNS = [
  { kind: 'spin-off', distribution: true, re: /\bspin[- ]?off\b/i },
  { kind: 'separation', distribution: true, re: /\b(?:completed? (?:the )?separation\b|separation of (?:its |the |our )?[\w\s,&'-]{0,60}?(?:business|segment|division|unit|subsidiary))/i },
  { kind: 'distribution', distribution: true, re: /\b(?:pro rata distribution|distribution ratio|distribute[sd]? (?:all|substantially all) of the (?:issued and )?outstanding (?:shares|common stock))/i },
  { kind: 'special dividend', distribution: true, re: /\bspecial (?:cash )?(?:dividend|distribution)\b/i },
  { kind: 'reclassification', distribution: true, re: /\breclassification of (?:its |the |our )?(?:common|capital) stock\b|\bshare reclassification\b/i },
  { kind: 'holding company reorganization', distribution: true, re: /\bholding company reorgani[sz]ation\b/i },
  // Only behind a split-shaped move: a merger alone is a price move, but shares exchanged at a ratio change the basis.
  { kind: 'exchange ratio', distribution: false, re: /\bexchange ratio\b/i },
];

/**
 * Where a non-split action may be read from: a current report filed near the
 * date. Annual reports, quarterly reports and proxies mention spin-offs,
 * special dividends and mergers in passing (risk factors, history, proposals
 * for later), so they never establish one.
 */
export const CURRENT_FORMS = new Set(['8-K', '8-K/A', '6-K', '8-K12B', '10-12B', '424B3', '425']);
export const ACTION_DAYS_BEFORE = 45;
export const ACTION_DAYS_AFTER = 15;
/** A split stated only in a filing this long before the date counts only if the share counts corroborate it. */
const STALE_SPLIT_DAYS = 75;

/**
 * What one filing's text says: each split it states, as the multiplier for
 * earlier prices (0.25 for 4-for-1, 10 for 1-for-10), and each other action it
 * describes.
 */
export function readFilingText(text) {
  const t = plainText(text);
  const splits = [];
  const seen = new Set();
  const add = (a, b, reverseWord, phrase) => {
    const x = value(a);
    const y = value(b);
    if (!(x > 0 && y > 0) || x === y) return;
    // "A-for-B": A new shares for every B old ones, so an earlier price is multiplied by B / A.
    const ratio = y / x;
    const reverse = Boolean(reverseWord) || ratio > 1;
    if (Boolean(reverseWord) && ratio < 1) return; // "1-for-10 reverse" written backwards is not a ratio we can trust
    const key = ratio.toFixed(6);
    if (seen.has(key)) return;
    seen.add(key);
    splits.push({ ratio, reverse, phrase: phrase.slice(0, 160) });
  };
  const mentionsSplit = /\b(?:stock|share|reverse)\s+split\b/i.test(t);
  for (const p of SPLIT_PATTERNS) {
    if (p.needsSplitWord && !mentionsSplit) continue;
    p.re.lastIndex = 0;
    let m;
    while ((m = p.re.exec(t))) {
      // add(A, B) reads "A new for B old"; each pattern says which group is which.
      const newer = m[p.new];
      const older = p.oldFixed ? String(p.oldFixed) : m[p.old];
      add(newer, older, p.rev ? m[p.rev] : null, m[0]);
    }
  }
  const other = OTHER_PATTERNS.filter((p) => p.re.test(t)).map((p) => ({ kind: p.kind, distribution: p.distribution, phrase: (t.match(p.re)?.[0] ?? p.kind).slice(0, 120) }));
  return { splits, other };
}

// ── the classification ───────────────────────────────────────────────────

const millions = (n) => `${(n / 1e6).toLocaleString('en-US', { maximumFractionDigits: 1 })}m`;
const terms = (ratio) => {
  const r = ratio < 1 ? 1 / ratio : ratio;
  for (let d = 1; d <= 20; d += 1) {
    const n = Math.round(r * d);
    if (Math.abs(n / d - r) / r < 0.01) return ratio < 1 ? `${n}-for-${d}` : `${d}-for-${n}`;
  }
  return ratio < 1 ? `${r.toFixed(2)}-for-1` : `1-for-${r.toFixed(2)}`;
};

/** Cover share counts either side of the date: [before, after] or nulls. */
function sharesAround(shares, date) {
  const sorted = (shares ?? []).filter((x) => x && typeof x.val === 'number' && x.val > 0 && typeof x.end === 'string').sort((x, y) => x.end.localeCompare(y.end));
  const before = sorted.filter((x) => x.end < date).pop() ?? null;
  const after = sorted.find((x) => x.end >= date) ?? null;
  return [before, after];
}

const DAY = 86_400_000;
const daysFrom = (date, iso) => (Date.parse(`${iso}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / DAY;
/** Counts this close to the date bracket it tightly enough to say the share count did or did not move. */
const SHARES_BRACKET_DAYS = 120;

/**
 * The classification of one candidate on its evidence:
 *   { type, ratio, confirmed, reason, evidenceSource, evidenceFiling, evidenceUrl, pending? }
 * or null for an ordinary price move. `evidence` is null while no filing has
 * been read: a split-shaped move then stands UNRESOLVED (pending), never
 * adjusted on its shape alone; any other move stands as a move.
 *
 * evidence: { date, cik, filings: [{ form, filed, accession, url, text }], shares: [{ end, val, form, accession }] }
 */
export function classify(candidate, evidence) {
  const shape = candidate.splitShaped;
  if (!evidence) {
    return shape !== null
      ? { type: ACTION.UNRESOLVED, ratio: null, confirmed: false, reason: `a move shaped like a ${terms(shape)} ${shape < 1 ? 'split' : 'reverse split'}, not yet checked against SEC filings`, evidenceSource: null, evidenceFiling: null, evidenceUrl: null, pending: true }
      : null;
  }
  const date = evidence.date;
  const filings = (evidence.filings ?? [])
    .filter((f) => f && typeof f.form === 'string' && typeof f.filed === 'string' && typeof f.url === 'string')
    .map((f) => ({ ...f, read: readFilingText(f.text) }));
  const [before, after] = sharesAround(evidence.shares, date);
  const bracketed = before && after && daysFrom(date, before.end) >= -SHARES_BRACKET_DAYS && daysFrom(date, after.end) <= SHARES_BRACKET_DAYS;
  const sharesNote = before && after ? `share count ${millions(before.val)} on ${before.end} and ${millions(after.val)} on ${after.end}` : null;

  // A. A stated split the day's move matches.
  for (const f of filings) {
    for (const s of f.read.splits) {
      if (Math.abs(candidate.change / s.ratio - 1) > RATIO_MATCH) continue;
      // B. Share counts corroborate or contradict; they never confirm on their own.
      if (before && after) {
        const moved = after.val / before.val;
        const implied = 1 / s.ratio;
        if (Math.abs(moved / implied - 1) > SHARES_CONTRADICT) {
          return { type: ACTION.UNRESOLVED, ratio: null, confirmed: false, reason: `${f.form} filed ${f.filed} states a ${terms(s.ratio)} ${s.reverse ? 'reverse ' : ''}split, but the ${sharesNote} do not move as it would`, evidenceSource: f.form, evidenceFiling: f.accession ?? null, evidenceUrl: f.url };
        }
      }
      const corroborated = Boolean(before && after && Math.abs((after.val / before.val) * s.ratio - 1) <= SHARES_AGREE);
      // A split mentioned only long before the date (an old split in an annual report's history) is not this move's.
      if (daysFrom(date, f.filed) < -STALE_SPLIT_DAYS && !corroborated) continue;
      return {
        type: s.ratio < 1 ? ACTION.SPLIT : ACTION.REVERSE,
        ratio: s.ratio,
        confirmed: true,
        reason: `${terms(s.ratio)} ${s.ratio < 1 ? 'stock split' : 'reverse stock split'}, stated in the ${f.form} filed ${f.filed}${corroborated ? `; ${sharesNote}` : ''}`,
        evidenceSource: f.form,
        evidenceFiling: f.accession ?? null,
        evidenceUrl: f.url,
      };
    }
  }

  // C. A described non-split action, from a current report near the date. An exchange ratio counts only behind a
  // split-shaped move: plenty of current reports describe a merger, and a takeover premium is a price move.
  for (const f of filings) {
    if (!CURRENT_FORMS.has(f.form)) continue;
    const d = daysFrom(date, f.filed);
    if (d < -ACTION_DAYS_BEFORE || d > ACTION_DAYS_AFTER) continue;
    const hit = f.read.other.find((o) => o.distribution || shape !== null);
    if (hit) {
      return { type: ACTION.OTHER, ratio: null, confirmed: true, reason: `${hit.kind} described in the ${f.form} filed ${f.filed}`, evidenceSource: f.form, evidenceFiling: f.accession ?? null, evidenceUrl: f.url };
    }
  }

  if (shape !== null) {
    // No filing explains the move. A share count that plainly did not move across the date says it was not a split
    // either: then it is an ordinary move. The count never rescales anything; it only rules a split out.
    const unchanged = bracketed && Math.abs(after.val / before.val - 1) <= SHARES_AGREE && Math.abs(Math.log(1 / shape)) > Math.log(1 + 3 * SHARES_AGREE);
    if (unchanged) return null;
    return { type: ACTION.UNRESOLVED, ratio: null, confirmed: false, reason: `a move shaped like a ${terms(shape)} ${shape < 1 ? 'split' : 'reverse split'} that no SEC filing near the date explains${sharesNote ? `; ${sharesNote}` : ''}${evidence.cik ? '' : '; no SEC registrant found for the symbol'}`, evidenceSource: null, evidenceFiling: null, evidenceUrl: null };
  }
  return null;
}

/** Why a split-shaped move was ruled ordinary, for the state's record (never published: an ordinary move is not an action). */
export function ordinaryReason(candidate, evidence) {
  const [before, after] = sharesAround(evidence?.shares, evidence?.date);
  return before && after ? `no SEC filing near the date states a split or other action, and the share count did not move (${millions(before.val)} on ${before.end}, ${millions(after.val)} on ${after.end})` : 'no SEC filing near the date states a split or other action';
}

export const EDGAR_DOCUMENT = /^https:\/\/www\.sec\.gov\/Archives\/edgar\/data\/\d{1,10}\/\d{18}\/[\w.-]{1,120}$/;

/** How a classification is published: the file's own snake_case names (L3vlup lib/finance-os/providers/market-reference.ts). */
export function publishedAction(action, effectiveDate) {
  return {
    corporate_action_type: action.type,
    corporate_action_effective_date: effectiveDate,
    action_ratio: (action.type === ACTION.SPLIT || action.type === ACTION.REVERSE) && Number.isFinite(action.ratio) ? action.ratio : null,
    action_confirmed: Boolean(action.confirmed),
    corporate_action_reason: action.reason ?? null,
    evidence_source: action.evidenceSource ?? null,
    evidence_filing: action.evidenceFiling ?? null,
    // Only a document in EDGAR's archive is ever published as evidence.
    evidence_url: typeof action.evidenceUrl === 'string' && EDGAR_DOCUMENT.test(action.evidenceUrl) ? action.evidenceUrl : null,
  };
}
