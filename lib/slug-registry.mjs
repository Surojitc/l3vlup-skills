/**
 * Canonical tracker URLs, owned by the producer.
 *
 * WHY THE COLLECTOR ASSIGNS THE URL
 * ---------------------------------
 * A tracker slug used to be computed by the website from the feed it happened
 * to be holding: `firm role`, with the region appended when two rows collided,
 * assigned in id order across the whole board. That makes a record's URL a
 * function of the other records around it. When the row holding the base slug
 * left, the row that had been pushed to `-asia` was promoted into the base slug
 * and its own URL ceased to exist, with no role deleted and nothing wrong with
 * the data. Forty URLs the site had published were pointing at records that had
 * since moved.
 *
 * The fix has to live where the identity lives. This repository is the only
 * place that sees a role arrive, sees it every day afterwards and sees it go,
 * and it is the only place with a durable key for it: the id the source board
 * gives the requisition, `workday-wf-R-573977`, `greenhouse-stripe-8130883`.
 * So the slug is assigned here, once, recorded against that id, and published
 * in the feed. The website reads it rather than deriving it, which means a role
 * collected this morning has a stable URL this morning, with no commit to the
 * website and no deploy.
 *
 * WHAT THE REGISTRY GUARANTEES
 * ----------------------------
 *   - a record's slug is assigned once and never reassigned;
 *   - every slug ever issued stays reserved to the record it was issued to,
 *     including records that have left the board, so nothing is ever promoted
 *     into a slug its neighbour vacated and no new record is handed a URL that
 *     already answers for something else;
 *   - the outcome does not depend on the order the boards answered in.
 *
 * WHAT IT DOES NOT DO
 * -------------------
 * It does not rewrite history. A slug already published stays published, and
 * `was` records the slugs a record was reachable at before this file existed,
 * so the website can redirect them. Nothing in the daily run creates a new one:
 * an employer editing a job title no longer moves its URL.
 */

import { normaliseText } from './text-normalise.mjs';

/** The slug alphabet. Must stay identical to lib/tracker-urls.ts on the website. */
export function slugifyProgramme(text) {
  return normaliseText(text)
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** `firm role`, normalised, as a slug. */
export function baseSlugFor(role) {
  return slugifyProgramme(`${role?.firm ?? ''} ${role?.role ?? ''}`);
}

/**
 * The registry file, read into the three indexes the assignment needs.
 *
 * `reserved` is the one that matters: every slug ever issued, current or
 * historical, mapped to the record it belongs to. Assignment skips all of it.
 */
export function buildRegistry(file) {
  const byId = new Map();
  const reserved = new Map();
  const history = [];

  for (const [id, record] of Object.entries(file?.roles ?? {})) {
    const slug = String(record?.slug ?? '').trim();
    if (!id || !slug) continue;
    byId.set(id, slug);
    // A current slug always wins its reservation, so a historical entry cannot
    // take it from the record published at it now.
    reserved.set(slug, id);
    for (const old of record?.was ?? []) {
      const past = String(old ?? '').trim();
      if (past && past !== slug) history.push([past, id]);
    }
  }

  const current = new Set(byId.values());
  const aliases = new Map();
  for (const [past, id] of history) {
    if (current.has(past)) continue;
    if (!reserved.has(past)) reserved.set(past, id);
    const destination = byId.get(id);
    if (destination) aliases.set(past, destination);
  }

  return { byId, aliases, reserved };
}

export function emptyRegistry() {
  return { byId: new Map(), aliases: new Map(), reserved: new Map() };
}

/**
 * Slugs for a set of records, given what has already been issued.
 *
 * Two passes. A record the registry knows gets its slug back, whatever else is
 * on the board. A record it does not know is assigned around every slug ever
 * issued plus everything assigned in this pass, taking the base slug, then the
 * region, then a counter; sorted by id so the board's own ordering cannot
 * change the answer.
 *
 * With an empty registry this is the rule the website used before the registry
 * existed, which is what the seeding pass wants: it reproduces exactly the URLs
 * already published.
 */
export function assignSlugs(records, registry = emptyRegistry()) {
  const byId = new Map();
  const taken = new Set(registry.reserved.keys());
  const pending = [];

  for (const record of records ?? []) {
    if (!record?.id) continue;
    const held = registry.byId.get(String(record.id));
    if (held) byId.set(String(record.id), held);
    else pending.push(record);
  }

  for (const record of pending.sort((a, b) => String(a.id).localeCompare(String(b.id)))) {
    const base = baseSlugFor(record);
    if (!base) continue;
    let slug = base;
    if (taken.has(slug)) slug = slugifyProgramme(`${base} ${record.region ?? ''}`);
    let n = 2;
    while (taken.has(slug)) slug = `${base}-${n++}`;
    taken.add(slug);
    byId.set(String(record.id), slug);
  }

  return byId;
}

/**
 * Fold a day's board into the registry and hand back the slug for every record.
 *
 * `roles` is mutated in place, which is what the caller wants: it is about to
 * write the file. Nothing already in it is changed, ever. A record that is new
 * is written once, with the date it was first assigned; a record that is known
 * is left exactly as it is, including a record whose title the employer has
 * since rewritten.
 */
export function updateRegistry(roles, records, date) {
  const registry = buildRegistry({ roles });
  const assigned = assignSlugs(records, registry);

  let added = 0;
  for (const [id, slug] of assigned) {
    if (roles[id]) continue;
    roles[id] = { slug, since: date };
    added += 1;
  }

  return { assigned, added };
}

/**
 * Record that a record used to be published at another URL.
 *
 * Only for URLs published before this registry existed: from here on a record's
 * slug does not move, so nothing generates a new one. A slug that is some other
 * record's current URL is never recorded, because redirecting it would take a
 * live page down.
 */
export function recordFormerSlug(roles, id, formerSlug) {
  const record = roles[id];
  if (!record || !formerSlug || formerSlug === record.slug) return false;
  const current = new Set(Object.values(roles).map((r) => r?.slug));
  if (current.has(formerSlug)) return false;
  const was = record.was ?? [];
  if (was.includes(formerSlug)) return false;
  was.push(formerSlug);
  record.was = was;
  return true;
}

/** The registry as it is written to disk: ordered, counted, stamped. */
export function serialiseRegistry(roles, generatedAt = new Date().toISOString()) {
  const ordered = Object.fromEntries(Object.entries(roles).sort(([a], [b]) => a.localeCompare(b)));
  return { generatedAt, count: Object.keys(ordered).length, roles: ordered };
}
