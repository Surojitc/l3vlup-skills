/**
 * Which firm a posting belongs to, when one board serves several.
 *
 * WHY
 * Marsh McLennan runs one Workday board for all of its businesses: Marsh,
 * Mercer, Guy Carpenter, Oliver Wyman and NERA. Oliver Wyman and NERA are two
 * of the strategy and economic consultancies a candidate searches for by name,
 * and neither has a board of its own. Read as one firm, every Oliver Wyman
 * intern consultant role would be published as "Marsh McLennan", which is
 * where nobody looks for it.
 *
 * The board carries no company field, but these two brands put their own name
 * at the front of the title ("Oliver Wyman – Intern Consultant – Madrid",
 * "NERA Summer Internship 2027 - London"), checked on the live board on
 * 25 November 2026. So the registry row lists the brands to read off the title,
 * and a title that names none keeps the row's own firm and tier.
 *
 * Narrow on purpose. A brand matches only as a whole word near the start of
 * the title, so "General" cannot read as NERA and a Mercer role that mentions
 * Oliver Wyman as a client in its last clause stays Mercer's.
 *
 * Pure, so the test can load it directly.
 */

const escapeRe = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * @param {string} title
 * @param {{ firm: string, tier?: string, titleBrands?: { match: string, firm: string, tier?: string }[] }} board
 * @returns {{ firm: string, tier?: string }}
 */
export function brandForTitle(title, board) {
  const own = { firm: board.firm, tier: board.tier };
  const brands = Array.isArray(board.titleBrands) ? board.titleBrands : [];
  if (!brands.length || !title) return own;
  // Leading year or punctuation is noise: "2027 Oliver Wyman – Intern ...".
  const head = String(title).replace(/^[\s\d\W]+/, '').slice(0, 40);
  for (const b of brands) {
    if (!b?.match || !b?.firm) continue;
    const re = new RegExp(`^${escapeRe(b.match)}(?![a-z0-9])`, 'i');
    if (re.test(head)) return { firm: b.firm, tier: b.tier ?? board.tier };
  }
  return own;
}
