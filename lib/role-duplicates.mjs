/**
 * Rows that look like the same role, and which of them actually are.
 *
 * WHY THIS REPORTS AND DOES NOT COLLAPSE
 * --------------------------------------
 * An SEO audit read `stripe-software-engineer-new-grad`, `-2`, `-us`, `-uk`,
 * `-europe`, `-asia` and `-frontend` as seven copies of one page. They are not.
 * Each is its own Greenhouse posting with its own job id, in its own city
 * (San Francisco, Toronto, Bucharest, London, Dublin, Singapore, Barcelona),
 * and a candidate applies to each separately. The feed on 2026-09-20 carries
 * 79 groups of rows sharing a firm and a title, 228 rows in all, and not one
 * pair shares an application URL or a source requisition. Jane Street is the
 * clearest case: its feed titles "Software Engineer" three times in New York
 * because the level lives in a separate field (internship, new grad), so the
 * three rows are three different seats with one title.
 *
 * Collapsing is also unsafe on its own terms. Every row already has a
 * published slug, and a slug is permanent. Removing a row from the feed puts
 * its URL into the archive, where the site keeps it indexable for ninety days;
 * it cannot be redirected to the surviving row, because the registry refuses
 * to alias a slug that is some record's current URL and the site only builds
 * redirects at deploy. So a collapse here would not remove a duplicate page,
 * it would turn a live page into a stale one.
 *
 * What this module does instead is classify, deterministically:
 *
 *   samePosting             one posting reached the feed twice: the same
 *                           application URL, or the same id. This is a
 *                           collector bug (usually a firm registered twice)
 *                           and is raised as a warning to fix at the source.
 *   sameTitleSameLocation   different postings, same firm, title and city.
 *                           Usually a repost or a second requisition for the
 *                           same seat; reported for a human to read.
 *   sameTitleManyLocations  the same programme posted per location. Expected,
 *                           and kept as distinct records.
 *
 * Titles are compared on a core that has lost a trailing location segment
 * ("… - Hong Kong", "… (London)") when that segment names the row's own
 * location or a region, so "Summer Internship Program - Singapore" and
 * "Summer Internship Program - Japan" group together.
 */

import { normaliseText } from './text-normalise.mjs';

const fold = (s) =>
  normaliseText(s)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** Words that name a place rather than a programme, beyond the row's own location. */
const REGION_WORDS = new Set([
  'us', 'usa', 'uk', 'emea', 'apac', 'amer', 'americas', 'asia', 'europe', 'eu', 'latam',
  'na', 'north', 'america', 'global', 'hk', 'sg', 'jp', 'in', 'remote', 'hybrid',
]);

/** A trailing segment after a dash, pipe or comma, or in parentheses. */
const TRAILING_SEGMENT = /(?:\s+[-–—|]\s+|,\s*|\s*\()([^-–—|,()]+)\)?\s*$/;

function isPlaceSegment(segment, location) {
  const words = fold(segment).split(' ').filter(Boolean);
  if (!words.length) return false;
  const loc = new Set(fold(location).split(' ').filter(Boolean));
  return words.every((w) => loc.has(w) || REGION_WORDS.has(w));
}

/** The title with trailing location segments removed, folded for comparison. */
export function titleCore(role, location) {
  let text = normaliseText(role);
  for (let i = 0; i < 3; i += 1) {
    const m = text.match(TRAILING_SEGMENT);
    if (!m || !isPlaceSegment(m[1], location)) break;
    const next = text.slice(0, m.index).trim();
    if (!next) break;
    text = next;
  }
  return fold(text);
}

/**
 * An application URL reduced to what identifies the posting.
 *
 * Case in the scheme and host, a fragment, a trailing slash and tracking
 * parameters carry no identity. The rest of the query does: Stripe's
 * `?gh_jid=8128744` is the posting.
 */
export function canonicalPostingUrl(url) {
  if (!url) return null;
  try {
    const u = new URL(String(url).trim());
    u.hash = '';
    for (const key of [...u.searchParams.keys()]) {
      if (/^utm_|^(ref|source|src|gh_src|lever-source)$/i.test(key)) u.searchParams.delete(key);
    }
    const path = u.pathname.replace(/\/+$/, '');
    const query = u.searchParams.toString();
    return `${u.protocol}//${u.host.toLowerCase()}${path}${query ? `?${query}` : ''}`;
  } catch {
    return String(url).trim();
  }
}

function groupBy(rows, key) {
  const map = new Map();
  for (const row of rows) {
    const k = key(row);
    if (!k) continue;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(row);
  }
  return [...map.entries()].filter(([, members]) => members.length > 1);
}

const byId = (a, b) => String(a.id).localeCompare(String(b.id));

/**
 * The three kinds of apparent duplicate in a set of rows. Deterministic: the
 * same rows in any order give the same groups in the same order.
 */
export function duplicateGroups(rows) {
  const list = (rows ?? []).filter(Boolean);

  const samePosting = [];
  const seenPosting = new Set();
  const addPosting = (key, members) => {
    const ids = members.map((r) => r.id).sort();
    const sig = ids.join('|');
    if (seenPosting.has(sig)) return;
    seenPosting.add(sig);
    samePosting.push({ key, rows: [...members].sort(byId) });
  };
  for (const [key, members] of groupBy(list, (r) => (r.id ? `id:${r.id}` : null))) addPosting(key, members);
  for (const [key, members] of groupBy(list, (r) => {
    const u = canonicalPostingUrl(r.applicationUrl);
    return u ? `url:${u}` : null;
  })) addPosting(key, members);

  const sameTitleSameLocation = [];
  const sameTitleManyLocations = [];
  for (const [key, members] of groupBy(list, (r) => `${fold(r.firm)}|${titleCore(r.role, r.location)}`)) {
    const sorted = [...members].sort(byId);
    const byPlace = groupBy(sorted, (r) => fold(r.location) || '(none)');
    for (const [place, same] of byPlace) sameTitleSameLocation.push({ key: `${key}|${place}`, rows: same });
    if (new Set(sorted.map((r) => fold(r.location))).size > 1) sameTitleManyLocations.push({ key, rows: sorted });
  }

  const order = (a, b) => a.key.localeCompare(b.key);
  return {
    samePosting: samePosting.sort(order),
    sameTitleSameLocation: sameTitleSameLocation.sort(order),
    sameTitleManyLocations: sameTitleManyLocations.sort(order),
  };
}
