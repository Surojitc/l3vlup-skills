/**
 * Jane Street.
 *
 * Self-hosted, and one of the few firms on the tracker with no ATS at all. The
 * site is client-rendered, but the data behind it is a plain public JSON file
 * at /jobs/main.json — 233 positions with the level encoded in `availability`.
 *
 * HOMOGLYPHS
 *
 * Titles arrive partly written in Lisu and other lookalike alphabets:
 *
 *   "ꓟachine ꓡearning ꓣesearcher"   (U+A4DF, U+A4E1, U+A4E3)
 *
 * Rendering that verbatim would put visibly broken text on a public page, and
 * it would defeat our own vertical classifier, which reads titles for words
 * like "Machine Learning" and would see none of them. The characters are folded
 * back to their Latin equivalents on the way in.
 *
 * Note this is cosmetic obfuscation on an endpoint that is public and needs no
 * key — folding it is the same kind of normalisation as trimming whitespace,
 * not a way past any access control.
 */

/**
 * Lookalike letters seen in the feed, mapped to Latin. Lisu (U+A4D0–U+A4FF)
 * supplies most of them; Cherokee and Cyrillic contribute the rest. Only
 * unambiguous single-letter substitutions are listed — anything uncertain is
 * left alone rather than guessed at, because a wrong fold corrupts a title
 * just as badly as no fold.
 */
const HOMOGLYPHS = {
  ꓐ: 'B', ꓒ: 'P', ꓓ: 'D', ꓔ: 'T', ꓖ: 'G', ꓗ: 'K', ꓙ: 'J', ꓚ: 'C',
  ꓜ: 'Z', ꓝ: 'F', ꓟ: 'M', ꓠ: 'N', ꓡ: 'L', ꓢ: 'S', ꓣ: 'R', ꓦ: 'V',
  ꓧ: 'H', ꓪ: 'W', ꓫ: 'X', ꓬ: 'Y', ꓮ: 'A', ꓰ: 'E', ꓲ: 'I', ꓳ: 'O', ꓴ: 'U',
  // Cyrillic
  А: 'A', В: 'B', Е: 'E', К: 'K', М: 'M', Н: 'H', О: 'O', Р: 'P', С: 'C',
  Т: 'T', У: 'Y', Х: 'X', а: 'a', е: 'e', о: 'o', р: 'p', с: 'c', у: 'y', х: 'x',
  // Greek
  Α: 'A', Β: 'B', Ε: 'E', Ζ: 'Z', Η: 'H', Ι: 'I', Κ: 'K', Μ: 'M', Ν: 'N',
  Ο: 'O', Ρ: 'P', Τ: 'T', Υ: 'Y', Χ: 'X', ο: 'o',
};

const HOMOGLYPH_RE = new RegExp(`[${Object.keys(HOMOGLYPHS).join('')}]`, 'g');

/** Fold lookalike letters back to Latin and collapse whitespace. */
export function deobfuscate(text) {
  if (typeof text !== 'string') return '';
  return text.replace(HOMOGLYPH_RE, (c) => HOMOGLYPHS[c] ?? c).replace(/\s+/g, ' ').trim();
}

/**
 * Jane Street writes city codes, not city names. Expanded so the region
 * inference downstream has something to work with — "LDN" tells it nothing.
 */
const CITIES = {
  NYC: 'New York, United States',
  LDN: 'London, United Kingdom',
  HKG: 'Hong Kong',
  AMS: 'Amsterdam, Netherlands',
  SGP: 'Singapore',
  SYD: 'Sydney, Australia',
  SHA: 'Shanghai, China',
  TYO: 'Tokyo, Japan',
};

export function expandCity(code) {
  if (typeof code !== 'string' || !code.trim()) return '';
  return code
    .split(/\s*[,/]\s*/)
    .map((c) => CITIES[c.trim().toUpperCase()] ?? c.trim())
    .join(', ');
}

/**
 * Keep only the early-career postings.
 *
 * `availability` is the authoritative field — "Summer Internship", "Full-Time:
 * New Grad", "Winter Co-Op" — and it is far more reliable than reading the
 * title, because a Jane Street title says "Trader" whether it is a graduate
 * seat or a senior one. "Full-Time: Experienced" is the one to exclude.
 */
export function isEarlyCareerAvailability(availability) {
  if (typeof availability !== 'string') return false;
  if (/experienced/i.test(availability)) return false;
  return /intern|new\s*grad|co-?op|graduate|campus/i.test(availability);
}

/** Normalise one position into the shape toOpportunity() expects. */
export function janeStreetToJob(p) {
  const title = deobfuscate(p.position ?? '');
  return {
    id: String(p.id),
    title,
    location: expandCity(p.city ?? ''),
    url: `https://www.janestreet.com/join-jane-street/position/${p.id}/`,
    department: deobfuscate(p.category ?? '') || undefined,
    // The feed carries no posting date and no deadline. Both stay undefined
    // rather than being inferred — a guessed datePosted invalidates the
    // JobPosting markup it would feed.
    description: [deobfuscate(p.overview ?? ''), p.availability ?? '', p.duration ?? '']
      .filter(Boolean)
      .join(' '),
    // `availability` has already established the level. Without this the shared
    // title test drops the whole board: "Software Engineer" carries no
    // early-career word, however plainly the feed marked it New Grad.
    earlyCareerConfirmed: true,
  };
}

/** Filter and map a whole /jobs/main.json payload. */
export function parseJaneStreetFeed(payload) {
  if (!Array.isArray(payload)) return [];
  return payload
    .filter((p) => p && p.id != null && isEarlyCareerAvailability(p.availability))
    .map(janeStreetToJob)
    .filter((j) => j.title);
}
