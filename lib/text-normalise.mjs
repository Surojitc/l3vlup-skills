/**
 * Cleaning the text that decides a public URL.
 *
 * WHY THIS EXISTS
 * ---------------
 * Wells Fargo publishes two distinct 2027 Commercial Banking internships, one
 * in the US and one in Bengaluru. The Bengaluru posting's title ends in a
 * zero-width space (U+200B). It is invisible in every tool a person would look
 * at it with, it survives JSON, and it is what made the two titles *look*
 * identical while comparing as different strings. The slug rule then collapsed
 * both to the same text, treated it as a collision, and the second record was
 * pushed onto a region-suffixed URL that it later lost again.
 *
 * ATS boards are full of this. Titles are typed into a CMS, pasted out of Word
 * and round-tripped through HTML: non-breaking spaces, soft hyphens, a
 * bidirectional mark left over from a paste, doubled spaces, an accented
 * character that is sometimes one code point and sometimes two.
 *
 * So the text is normalised once, at ingestion, before anything is compared,
 * hashed or turned into a URL.
 *
 * WHAT THIS IS NOT
 * ----------------
 * It is not an identity. The durable identity of a role is the id the source
 * board gives it (`workday-wf-R-573977`), and that is what the slug registry is
 * keyed by. Cleaned display text is a *better* input to a slug than raw text;
 * it is still text, it still changes when an employer edits a title, and using
 * it as identity would put us back where we started.
 */

/**
 * Characters that carry no meaning in a job title and no width on a page.
 *
 * Zero-width space, non-joiner, joiner and no-break space; the word joiner; the
 * left-to-right and right-to-left marks and embedding controls; the soft
 * hyphen; and the byte-order mark, which arrives at the front of a string often
 * enough to be worth naming.
 *
 * `\p{Cf}` (format) would cover most of these in one class, but it also covers
 * characters that do carry meaning in other scripts, and this runs over every
 * title from every board. The named list is the conservative one.
 */
const INVISIBLE = new RegExp(
  '[' +
    '\\u00AD' + // soft hyphen
    '\\u200B-\\u200F' + // zero-width space, non-joiner, joiner, LTR/RTL marks
    '\\u202A-\\u202E' + // bidirectional embedding and override controls
    '\\u2060-\\u2064' + // word joiner and the invisible operators
    '\\uFEFF' + // byte-order mark
  ']',
  'g'
);

/** Everything Unicode considers a space, including the ones that are not U+0020. */
const SPACE_LIKE = new RegExp(
  '[' +
    '\\t\\n\\r\\f\\v' +
    '\\u00A0' + // non-breaking space
    '\\u1680' +
    '\\u2000-\\u200A' +
    '\\u2028\\u2029' + // line and paragraph separators
    '\\u202F\\u205F\\u3000' +
  ']',
  'g'
);

/**
 * Normalise a piece of text for comparison, slugging and storage.
 *
 * NFKC rather than NFC: compatibility composition folds the presentation forms
 * that ATS exports produce — full-width Latin from a Japanese board, ligatures,
 * superscript ordinals — onto the characters a person typing the same title
 * would use. The risk of NFKC is that it also rewrites some mathematical
 * notation, which does not appear in job titles.
 *
 * The order matters. Normalise first, because NFKC turns some space-like
 * characters into ordinary spaces and leaves others alone; then remove what is
 * invisible, so a zero-width space between two words does not become a gap;
 * then fold the remaining space-likes to U+0020, collapse runs and trim.
 */
export function normaliseText(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .normalize('NFKC')
    .replace(INVISIBLE, '')
    .replace(SPACE_LIKE, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
}

/**
 * True when two pieces of text are the same once the invisible differences are
 * taken out. What "looks identical" means, in code.
 */
export function sameText(a, b) {
  return normaliseText(a) === normaliseText(b);
}

/** Normalise the fields of a role that reach a URL, a title or a comparison. */
export function normaliseRoleText(role) {
  if (!role || typeof role !== 'object') return role;
  const out = { ...role };
  for (const field of ['firm', 'role', 'location', 'division', 'tier']) {
    if (typeof out[field] === 'string') out[field] = normaliseText(out[field]);
  }
  return out;
}
