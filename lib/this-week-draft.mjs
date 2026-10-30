// This Week: the draft edition's rules, as pure functions.
//
// WHAT THIS IS
//
// The site's editorial page (/this-week on l3vlup.com) publishes one edition
// a week, written by a person and approved by a person: one headline, one
// deal, up to five market moves and one question. This module prepares the
// Thursday draft that person starts from. It is deterministic up to the one
// model call, and the model call is bounded: one request, a fixed tool
// schema, a budget stated out loud, and every URL it may cite chosen here
// from the week's feeds, never typed by the model.
//
// WHAT IT NEVER DOES
//
// Publish. The output is a draft file (data/this-week.draft.json) and a
// report. Nothing here sends a newsletter, posts to a channel or changes the
// site's record of editions; the approval step stays where it was, a person
// changing "draft" to "approved" in the site's own data file after reading
// every figure at its primary source.
//
// The shapes mirror lib/this-week.ts on the site (ThisWeekEdition and its
// validation). They are repeated here rather than imported because the two
// repositories do not share code; `validateDraft` applies the same rules so
// a draft that would fail the site's suite is marked before it is written.

const DAY_MS = 86_400_000;
export const MAX_MARKET_MOVES = 5;
export const MAX_SOURCES = 10;
export const SOURCE_TEXT_CHARS = 3_200;

/** Verbs that forecast. A fact line may not carry one; the site refuses it too. */
export const FORECAST = /\b(will|would|is set to|are set to|expected to|forecast|forecasts|likely to|poised to|could|may)\b/i;

const STOP = new Set(['the', 'a', 'an', 'of', 'to', 'in', 'for', 'and', 'on', 'with', 'by', 'at', 'from', 'as', 'its', 'is', 'are', 'be', 'after', 'over', 'into']);

export const LABELS = { ma: 'M&A', pe: 'Private equity', hf: 'Hedge funds', ib: 'Investment banking', macro: 'Macro', tape: 'Deal tape' };

export function normaliseTitle(t) {
  return String(t ?? '')
    .toLowerCase()
    .replace(/[’'"“”]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !STOP.has(w))
    .join(' ');
}

export function canonicalLink(link) {
  try {
    const u = new URL(link);
    u.hash = '';
    u.search = '';
    return `${u.host.replace(/^www\./, '')}${u.pathname.replace(/\/$/, '')}`;
  } catch {
    return String(link ?? '');
  }
}

/** The proper nouns of a title: capitalised words of three letters or more, the stop words aside. */
function entities(title) {
  return new Set(
    String(title ?? '')
      .replace(/[^A-Za-z0-9 ]+/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 3 && /^[A-Z]/.test(w) && !STOP.has(w.toLowerCase()))
      .map((w) => w.toLowerCase()),
  );
}

function sharedEntities(a, b) {
  let n = 0;
  for (const w of a) if (b.has(w)) n += 1;
  return n;
}

function jaccard(a, b) {
  const A = new Set(a.split(' ')), B = new Set(b.split(' '));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter += 1;
  return inter / (A.size + B.size - inter);
}

/** "$3.7B", "$850M", "£1.2bn" to billions; null when it cannot be read. */
export function billions(v) {
  const m = String(v ?? '').replace(/,/g, '').match(/([\d.]+)\s*(bn|b|billion|m|mn|million|k)?/i);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const unit = (m[2] ?? '').toLowerCase();
  return unit.startsWith('b') ? n : unit.startsWith('m') ? n / 1000 : unit === 'k' ? n / 1e6 : null;
}

/**
 * One item per story. Exact duplicates share a link or a normalised title;
 * near duplicates share enough title words (Jaccard 0.6) and fall within two
 * days of each other. The earliest dated copy is kept, as the first report,
 * and the other sources are recorded on it so the editor sees who else ran it.
 */
export function dedupe(items) {
  const dated = items
    .filter((i) => i && i.title && i.link && i.date && Number.isFinite(Date.parse(i.date)))
    .map((i) => ({ ...i, _norm: normaliseTitle(i.title), _link: canonicalLink(i.link), _ents: entities(i.title) }))
    .sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  const out = [];
  for (const i of dated) {
    // Near duplicates: the same story told in other words shares most of its
    // words, or at least two of its proper nouns (the companies) plus some of
    // its words, within two days of the first report.
    const close = (o) => Math.abs(Date.parse(o.date) - Date.parse(i.date)) <= 2 * DAY_MS;
    const dup = out.find(
      (o) => o._link === i._link || o._norm === i._norm || (close(o) && (jaccard(o._norm, i._norm) >= 0.6 || (sharedEntities(o._ents, i._ents) >= 2 && jaccard(o._norm, i._norm) >= 0.2))),
    );
    if (dup) {
      if (i.source && i.source !== dup.source && !dup.alsoReportedBy.includes(i.source)) dup.alsoReportedBy.push(i.source);
      if (!dup.dealValue && i.dealValue) dup.dealValue = i.dealValue;
      continue;
    }
    out.push({ ...i, alsoReportedBy: [] });
  }
  return out.map(({ _norm, _link, _ents, ...rest }) => rest).sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
}

function inWindow(items, days) {
  if (!items.length) return [];
  const newest = Date.parse(items[0].date);
  return items.filter((i) => newest - Date.parse(i.date) <= days * DAY_MS);
}

/** Most recent, largest disclosed value, then the most recent from an area not yet picked. The site's own shortlist rule. */
function pickThree(items, area, { valuedOnly = false } = {}) {
  const out = [];
  const add = (item, why) => item && !out.some((o) => o.item.link === item.link) && out.push({ item, why });
  add(valuedOnly ? items.find((i) => i.value) : items[0], valuedOnly ? 'most recent with a disclosed value' : 'most recent');
  const valued = items.filter((i) => i.value).sort((a, b) => b.value - a.value);
  add(valued[0], `largest disclosed value (${valued[0]?.dealValue})`);
  const seen = new Set(out.map((o) => area(o.item)));
  add(items.find((i) => !seen.has(area(i)) && !out.some((o) => o.item.link === i.link)), 'most recent from another area');
  for (const i of items) if (out.length < 3) add(i, 'next most recent');
  return out;
}

/**
 * The shortlist: three headline candidates, three deal candidates and up to
 * eight market-move candidates (the most recent story in each area, then the
 * next most recent, none already offered as a headline or a deal).
 */
export function shortlist({ news, deals, days = 7 }) {
  const n = inWindow(dedupe((news ?? []).map((i) => ({ ...i, value: i.valueUsdB ?? billions(i.dealValue) }))), days);
  const tape = dedupe((deals ?? []).map((i) => ({ ...i, vertical: 'tape', value: billions(i.dealValue) })));
  const d = inWindow(dedupe([...tape, ...n.filter((i) => i.vertical === 'ma' || i.vertical === 'pe')]), days);
  const area = (i) => LABELS[i.vertical] ?? i.vertical;
  const headlines = pickThree(n, (i) => i.vertical);
  const taken = new Set(headlines.map((h) => h.item.link));
  const dealPicks = pickThree(d.filter((x) => !taken.has(x.link)), (i) => i.vertical, { valuedOnly: true });
  for (const p of dealPicks) taken.add(p.item.link);
  const moves = [];
  const byArea = new Map();
  for (const i of n) if (!taken.has(i.link)) byArea.set(i.vertical, [...(byArea.get(i.vertical) ?? []), i]);
  // One per area first, in the order the areas first appear, then a second round.
  for (let round = 0; round < 2 && moves.length < 8; round++) {
    for (const [, list] of byArea) {
      const next = list[round];
      if (next && moves.length < 8 && !taken.has(next.link)) { moves.push({ item: next, why: round === 0 ? `most recent in ${area(next)}` : `next in ${area(next)}` }); taken.add(next.link); }
    }
  }
  return { headlines, deals: dealPicks, moves, counts: { newsInWindow: n.length, dealsInWindow: d.length, days } };
}

/** The pages the model may read: every distinct candidate link, in shortlist order, at most MAX_SOURCES. */
export function sourcesOf(list) {
  const out = [];
  const seen = new Set();
  for (const p of [...list.headlines, ...list.deals, ...list.moves]) {
    const i = p.item;
    const key = canonicalLink(i.link);
    if (seen.has(key) || out.length >= MAX_SOURCES) continue;
    seen.add(key);
    out.push({ index: out.length, url: i.link, name: i.source ?? '', date: String(i.date).slice(0, 10), title: i.title, area: LABELS[i.vertical] ?? i.vertical, dealValue: i.dealValue ?? null, alsoReportedBy: i.alsoReportedBy ?? [] });
  }
  return out;
}

/**
 * Hosts the draft may not read: every source in the data-rights register whose
 * business use is restricted. Their items still reach the shortlist (the feed
 * entry is theirs), but the page is never fetched; the editor sees the headline
 * and reads the story at its source.
 */
export function restrictedHosts(register) {
  const out = new Set();
  for (const s of register?.sources ?? []) {
    if (s.businessUse !== 'restricted') continue;
    for (const m of String(s.source ?? '').matchAll(/([a-z0-9-]+(?:\.[a-z0-9-]+)+)/gi)) {
      const host = m[1].toLowerCase().replace(/^www\./, '');
      // Keep the registrable part: feeds.bloomberg.com restricts bloomberg.com.
      const parts = host.split('.');
      out.add(parts.length > 2 ? parts.slice(-2).join('.') : host);
    }
  }
  return out;
}

export function isRestricted(link, hosts) {
  try {
    const host = new URL(link).hostname.toLowerCase().replace(/^www\./, '');
    return Array.from(hosts).some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

/** Readable text from a fetched page: the title, the description and the first run of body text. */
export function extractText(html) {
  const s = String(html ?? '');
  const title = (s.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').replace(/\s+/g, ' ').trim();
  const desc = (s.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i)?.[1] ?? s.match(/<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i)?.[1] ?? '').trim();
  const body = s
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#?\w+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return { title, description: desc, text: body.slice(0, SOURCE_TEXT_CHARS) };
}

/** Paths from the site's sitemap that an edition may link: guides, models, careers, comparisons, intel hubs, labs. */
export function allowedPaths(sitemapXml) {
  const urls = Array.from(String(sitemapXml ?? '').matchAll(/<loc>([^<]+)<\/loc>/g)).map((m) => m[1]);
  const paths = urls
    .map((u) => { try { return new URL(u).pathname; } catch { return null; } })
    .filter((p) => p && /^\/(guides|models|career|compare|intel|labs|glossary|industry-map|venture-capital|tools)\//.test(p) && !/\/(tracker)\//.test(p));
  return Array.from(new Set(paths)).sort();
}

/** The coming Friday on or after `now` (UTC): the edition's weekEnding. */
export function weekEndingFor(now) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const day = d.getUTCDay(); // 0 Sunday .. 5 Friday
  const ahead = (5 - day + 7) % 7;
  d.setUTCDate(d.getUTCDate() + ahead);
  return d.toISOString().slice(0, 10);
}

/* ------------------------------------------------------------- the model -- */

export const PROMPT_VERSION = 'this-week-draft-v1';

/**
 * The one tool. Sources and related links are indexes into lists this code
 * built, so the model cannot cite a page it was not given or link a path
 * that does not exist. Strict, so the shape is enforced before inference.
 */
export const EDITION_TOOL = Object.freeze({
  name: 'draft_edition',
  description: 'Draft the week\'s edition from the numbered sources only, and brief the week\'s cartoon.',
  strict: true,
  input_schema: {
    type: 'object',
    properties: {
      headline: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'A plain statement of what happened, no forecast verb.' },
          summary: { type: 'string', description: 'Two or three sentences. Every figure from the named source.' },
          whatHappened: { type: 'string', description: 'One or two sentences of fact only.' },
          whyItMatters: { type: 'string', description: 'One or two sentences of analysis for a candidate.' },
          secondOrder: { type: 'string', description: 'One sentence: who else is affected and how.' },
          sourceIndex: { type: 'integer', description: 'The index of the source this rests on.' },
          companies: { type: 'array', items: { type: 'string' } },
          relatedPathIndexes: { type: 'array', items: { type: 'integer' }, description: 'Indexes into the allowed paths list, at most four.' },
        },
        required: ['title', 'summary', 'whatHappened', 'whyItMatters', 'secondOrder', 'sourceIndex', 'companies', 'relatedPathIndexes'],
        additionalProperties: false,
      },
      deal: {
        type: 'object',
        properties: {
          target: { type: 'string' },
          acquirer: { type: 'string', description: 'Empty string when none was named.' },
          value: { type: 'string', description: 'As the source states it, or empty when undisclosed. Never estimate.' },
          sector: { type: 'string' },
          metrics: {
            type: 'array',
            items: {
              type: 'object',
              properties: { label: { type: 'string' }, value: { type: 'string' }, sourceIndex: { type: 'integer' } },
              required: ['label', 'value', 'sourceIndex'],
              additionalProperties: false,
            },
          },
          advisers: { type: 'array', items: { type: 'string' }, description: 'Only advisers the source names. Empty otherwise.' },
          whyInstructive: { type: 'string', description: 'Two or three sentences on what a candidate learns from it.' },
          sourceIndex: { type: 'integer' },
          relatedPathIndexes: { type: 'array', items: { type: 'integer' } },
        },
        required: ['target', 'acquirer', 'value', 'sector', 'metrics', 'advisers', 'whyInstructive', 'sourceIndex', 'relatedPathIndexes'],
        additionalProperties: false,
      },
      marketInFive: {
        type: 'array',
        items: {
          type: 'object',
          properties: { title: { type: 'string' }, implication: { type: 'string' }, sourceIndex: { type: 'integer' } },
          required: ['title', 'implication', 'sourceIndex'],
          additionalProperties: false,
        },
      },
      prediction: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['forecast', 'quiz'] },
          question: { type: 'string' },
          options: { type: 'array', items: { type: 'string' } },
          resolvesAt: { type: 'string', description: 'YYYY-MM-DD, after the week ends.' },
          resolutionCriteria: { type: 'string' },
          resolutionSourceIndex: { type: 'integer' },
        },
        required: ['kind', 'question', 'options', 'resolvesAt', 'resolutionCriteria', 'resolutionSourceIndex'],
        additionalProperties: false,
      },
      cartoon: {
        type: 'object',
        properties: {
          scene: { type: 'string', description: 'One paragraph describing a single still image: what is drawn, where, what one thing is happening. No words inside the picture.' },
          caption: { type: 'string', description: 'One deadpan sentence beneath the picture that carries the joke.' },
          groundedIn: { type: 'string', description: 'Which verified fact of the headline the joke rests on.' },
        },
        required: ['scene', 'caption', 'groundedIn'],
        additionalProperties: false,
      },
    },
    required: ['headline', 'deal', 'marketInFive', 'prediction', 'cartoon'],
    additionalProperties: false,
  },
});

export function draftPrompt({ weekEnding }) {
  return [
    'You draft the weekly edition of a finance careers site for students and junior analysts, and brief its cartoon. A person will read every figure at its source before anything is published; your draft is where they start.',
    '',
    'Rules, in order of importance.',
    '',
    '1. Every fact comes from the numbered sources you are given and nowhere else. Cite the source by its index. Do not add a figure, a date, an adviser or a name the sources do not state. Where the source does not say, leave the field empty rather than estimate.',
    '2. Facts do not forecast. In the headline title, summary and whatHappened, and in every market move title, never write will, would, is set to, expected to, likely to, could or may. Say what happened. Analysis belongs in whyItMatters, secondOrder and implication, in the present tense.',
    '3. British English. Plain words in well-built sentences. No exclamation marks, no rhetorical questions, nothing about the site itself.',
    `4. The edition is for the week ending ${weekEnding}. The prediction resolves after that week; a quiz resolves on its own answer, a forecast on a dated public fact, and its resolution source must be one of the sources.`,
    '5. Choose the headline a candidate could be asked about in an interview next week; choose the deal that teaches the most mechanics; choose at most five market moves across different areas, each with one sentence on what it means for someone entering the industry.',
    '6. Related pages: pick from the allowed paths list by index, at most four for the headline and four for the deal, only where the page genuinely helps understand the story.',
    '7. The cartoon: a single-panel editorial drawing in a fixed house style, which the brief must respect. White paper, black ink line, generous empty space, one idea played completely straight, no words anywhere inside the picture, two small accents of colour at most. It may include a small round character called Lev doing one thing. The humour is intelligent and deadpan and rests on a verified fact of the headline, named in groundedIn. It must be fair to every party in the story: no mockery of a named person, nothing that could be read as an accusation. The caption is one sentence and carries the joke; the picture carries the situation.',
  ].join('\n');
}

export function draftUserMessage({ weekEnding, list, sources, paths }) {
  const src = sources.map((s) => `[${s.index}] ${s.name} · ${s.date} · ${s.area}${s.dealValue ? ` · ${s.dealValue}` : ''}\nTitle: ${s.title}\nURL: ${s.url}\n${s.text ? `Text: ${s.text}` : 'Text: (the page could not be read; use the title and the feed line only, and do not state figures from memory)'}`).join('\n\n');
  const paths_ = paths.map((p, i) => `[${i}] ${p}`).join('\n');
  const picks = (arr, name) => `${name}:\n${arr.map((p) => `- [${sources.find((s) => s.url === p.item.link)?.index ?? '?'}] ${p.item.title} (${p.why})`).join('\n')}`;
  return [
    `Week ending ${weekEnding}.`,
    '',
    picks(list.headlines, 'Headline candidates'),
    picks(list.deals, 'Deal candidates'),
    picks(list.moves, 'Market move candidates'),
    '',
    'Sources:',
    src,
    '',
    'Allowed related paths:',
    paths_,
  ].join('\n');
}

export class DraftModelError extends Error {
  constructor(reason, detail) {
    super(`${reason}: ${detail}`);
    this.reason = reason;
    this.detail = detail;
  }
}

/** The tool input out of a response, refusing anything that is not exactly one call of the tool. */
export function readDraft(response) {
  if (!response || typeof response !== 'object') throw new DraftModelError('malformed_response', 'the response was not an object');
  if (response.stop_reason === 'refusal') throw new DraftModelError('refused', `the model declined: ${response.stop_details?.category ?? 'no category given'}`);
  if (response.stop_reason === 'max_tokens') throw new DraftModelError('truncated', 'the answer hit max_tokens');
  if (!Array.isArray(response.content)) throw new DraftModelError('malformed_response', 'no content array');
  const uses = response.content.filter((b) => b && b.type === 'tool_use' && b.name === EDITION_TOOL.name);
  if (uses.length !== 1) throw new DraftModelError('malformed_response', `${uses.length} tool calls where one was expected`);
  const input = uses[0].input;
  if (!input || typeof input !== 'object') throw new DraftModelError('malformed_response', 'the tool input was not an object');
  return input;
}

const isIsoDay = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(`${v}T00:00:00Z`));
export function sentenceCount(v) {
  return String(v ?? '').trim().split(/(?<=[.!?])\s+(?=[A-Z0-9"“'‘$£€])/).filter((s) => s.trim().length > 0).length;
}

/**
 * The tool input, resolved against the sources and paths it indexed, into the
 * site's edition shape. An index outside its list is a problem, never a
 * guess; a related path outside the allowed list is dropped.
 */
export function assembleEdition(input, { weekEnding, sources, paths }) {
  const problems = [];
  const src = (i, field) => {
    const s = Number.isInteger(i) ? sources[i] : undefined;
    if (!s) problems.push({ field, message: `source index ${i} is not one of the ${sources.length} sources` });
    return s;
  };
  const links = (idx, field) => {
    const out = [];
    for (const i of idx ?? []) {
      if (Number.isInteger(i) && paths[i]) out.push(paths[i]);
      else problems.push({ field, message: `path index ${i} is not in the allowed list; dropped` });
    }
    return out.slice(0, 4);
  };
  const h = input.headline ?? {};
  const hs = src(h.sourceIndex, 'headline.sourceUrl');
  const d = input.deal ?? {};
  const ds = src(d.sourceIndex, 'deal.sourceUrl');
  const p = input.prediction ?? {};
  const ps = src(p.resolutionSourceIndex, 'prediction.resolutionSourceUrl');
  const moves = (Array.isArray(input.marketInFive) ? input.marketInFive : []).slice(0, MAX_MARKET_MOVES).map((m, i) => {
    const ms = src(m.sourceIndex, `marketInFive[${i}].sourceUrl`);
    return { title: m.title, implication: m.implication, date: ms?.date ?? weekEnding, sourceUrl: ms?.url ?? '', sourceName: ms?.name ?? '' };
  });
  const edition = {
    weekEnding,
    status: 'draft',
    headline: {
      title: h.title ?? '', summary: h.summary ?? '', whatHappened: h.whatHappened ?? '', whyItMatters: h.whyItMatters ?? '', secondOrder: h.secondOrder ?? '',
      sourceUrl: hs?.url ?? '', sourceName: hs?.name ?? '', publishedAt: hs?.date ?? weekEnding,
      companies: Array.isArray(h.companies) ? h.companies.filter((c) => typeof c === 'string' && c.trim()) : [],
      relatedLinks: links(h.relatedPathIndexes, 'headline.relatedLinks'),
    },
    deal: {
      target: d.target ?? '', ...(d.acquirer ? { acquirer: d.acquirer } : {}), value: d.value ? d.value : null, announcedAt: ds?.date ?? weekEnding, sector: d.sector ?? '',
      metrics: (Array.isArray(d.metrics) ? d.metrics : []).map((m, i) => ({ label: m.label, value: m.value, source: src(m.sourceIndex, `deal.metrics[${i}].source`)?.url ?? '' })),
      advisers: Array.isArray(d.advisers) ? d.advisers.filter((a) => typeof a === 'string' && a.trim()) : [],
      whyInstructive: d.whyInstructive ?? '', sourceUrl: ds?.url ?? '', relatedLinks: links(d.relatedPathIndexes, 'deal.relatedLinks'),
    },
    marketInFive: moves,
    prediction: {
      kind: p.kind === 'quiz' ? 'quiz' : 'forecast', question: p.question ?? '', options: Array.isArray(p.options) ? p.options : [], resolvesAt: p.resolvesAt ?? '',
      resolutionCriteria: p.resolutionCriteria ?? '', resolutionSourceUrl: ps?.url ?? '', outcome: null,
    },
  };
  const cartoon = input.cartoon && typeof input.cartoon === 'object' ? { scene: input.cartoon.scene ?? '', caption: input.cartoon.caption ?? '', groundedIn: input.cartoon.groundedIn ?? '' } : null;
  return { edition, cartoon, problems: [...problems, ...validateDraft(edition)] };
}

/** The site's rules, applied before the draft is written, so the report names what a person must fix. */
export function validateDraft(e) {
  const out = [];
  const need = (ok, field, message) => { if (!ok) out.push({ field, message }); };
  const text = (v) => typeof v === 'string' && v.trim().length > 0;
  const https = (v) => { try { return new URL(v).protocol === 'https:'; } catch { return false; } };
  need(isIsoDay(e.weekEnding), 'weekEnding', 'weekEnding must be YYYY-MM-DD');
  const h = e.headline;
  need(text(h.title) && !FORECAST.test(h.title), 'headline.title', 'A title states what happened; it does not forecast.');
  need(text(h.summary) && sentenceCount(h.summary) >= 2 && sentenceCount(h.summary) <= 3, 'headline.summary', 'The summary needs two or three sentences.');
  need(!FORECAST.test(h.summary), 'headline.summary', 'The summary forecasts.');
  need(text(h.whatHappened) && !FORECAST.test(h.whatHappened), 'headline.whatHappened', 'What happened is fact, with no forecast verb.');
  need(text(h.whyItMatters) && text(h.secondOrder), 'headline.analysis', 'Why it matters and the second-order line are needed.');
  need(https(h.sourceUrl), 'headline.sourceUrl', 'The headline needs an https source.');
  need(isIsoDay(h.publishedAt), 'headline.publishedAt', 'publishedAt must be a day.');
  const d = e.deal;
  need(text(d.target), 'deal.target', 'The deal needs a target.');
  need(https(d.sourceUrl), 'deal.sourceUrl', 'The deal needs an https source.');
  need(d.metrics.every((m) => text(m.label) && text(m.value) && https(m.source)), 'deal.metrics', 'Every metric needs a label, a value and an https source.');
  need(text(d.whyInstructive), 'deal.whyInstructive', 'The deal needs its lesson.');
  need(e.marketInFive.length >= 1 && e.marketInFive.length <= MAX_MARKET_MOVES, 'marketInFive', `One to ${MAX_MARKET_MOVES} market moves.`);
  e.marketInFive.forEach((m, i) => {
    need(text(m.title) && !FORECAST.test(m.title), `marketInFive[${i}].title`, 'A move title states a fact.');
    need(text(m.implication), `marketInFive[${i}].implication`, 'A move needs its implication.');
    need(https(m.sourceUrl), `marketInFive[${i}].sourceUrl`, 'A move needs an https source.');
  });
  const p = e.prediction;
  need(text(p.question), 'prediction.question', 'The prediction needs a question.');
  need(p.options.length >= 2 && p.options.length <= 5 && new Set(p.options).size === p.options.length, 'prediction.options', 'Two to five distinct options.');
  need(isIsoDay(p.resolvesAt) && Date.parse(`${p.resolvesAt}T00:00:00Z`) > Date.parse(`${e.weekEnding}T00:00:00Z`), 'prediction.resolvesAt', 'The prediction resolves after the week ends.');
  need(https(p.resolutionSourceUrl), 'prediction.resolutionSourceUrl', 'The resolution source must be an https link.');
  return out;
}

/* ------------------------------------------------------------- the money -- */

/** A draft's budget: one call, a ceiling stated by the caller, never above the hard stop. */
export const HARD_STOP_USD = 1.0;
export function estimateUsd(pricing, inputTokens, outputTokens) {
  if (!pricing) return null;
  return (inputTokens * pricing.inputPerMTok + outputTokens * pricing.outputPerMTok) / 1_000_000;
}
export const approxTokens = (text) => Math.ceil(String(text ?? '').length / 4);

export function checkDraftBudget({ budgetUsd, pricing, inputTokens, outputTokens }) {
  if (!Number.isFinite(budgetUsd) || budgetUsd <= 0) return { allowed: false, reason: 'a positive budget in dollars is required' };
  if (budgetUsd > HARD_STOP_USD) return { allowed: false, reason: `budget $${budgetUsd} is over the $${HARD_STOP_USD.toFixed(2)} hard stop for a weekly draft` };
  const cost = estimateUsd(pricing, inputTokens, outputTokens);
  if (cost === null) return { allowed: false, reason: 'the model is not priced; refusing rather than assuming it is free' };
  if (cost > budgetUsd) return { allowed: false, reason: `the call would cost about $${cost.toFixed(3)}, over the $${budgetUsd.toFixed(2)} budget` };
  return { allowed: true, reason: null, estimatedUsd: cost };
}

/* ------------------------------------------------------------ the report -- */

export function renderReport(draft) {
  const lines = [];
  lines.push(`# This Week draft for the week ending ${draft.weekEnding}`);
  lines.push('');
  lines.push(`Generated ${draft.generatedAt}. Status: **${draft.status}**. Model stage: **${draft.modelStage}**${draft.failure ? ` (${draft.failure})` : ''}.`);
  if (draft.cost) lines.push(`Spend: ${draft.cost.actualUsd !== null ? `$${draft.cost.actualUsd.toFixed(4)} actual` : 'no call made'} (estimated $${(draft.cost.estimatedUsd ?? 0).toFixed(4)}, budget $${draft.cost.budgetUsd.toFixed(2)}, model ${draft.cost.model ?? 'none'}).`);
  lines.push('');
  lines.push('This is a draft. Nothing is published until a person has read every figure at its source, pasted the edition into the site\'s `data/this-week.manual.json`, run `npm test -- this-week` and changed its status to approved.');
  lines.push('');
  lines.push('## Shortlist (deterministic, from the feeds)');
  const pick = (arr, name) => { lines.push(`### ${name}`); if (!arr.length) lines.push('- (nothing in the window)'); for (const p of arr) lines.push(`- ${p.item.title} · ${String(p.item.date).slice(0, 10)} · ${p.item.source}${p.item.dealValue ? ` · ${p.item.dealValue}` : ''} · ${p.why}${p.item.alsoReportedBy?.length ? ` · also: ${p.item.alsoReportedBy.join(', ')}` : ''}\n  ${p.item.link}`); };
  pick(draft.shortlist.headlines, 'Headline candidates');
  pick(draft.shortlist.deals, 'Deal candidates');
  pick(draft.shortlist.moves, 'Market move candidates');
  lines.push('');
  if (draft.problems?.length) {
    lines.push('## Problems a person must fix before approval');
    for (const p of draft.problems) lines.push(`- \`${p.field}\`: ${p.message}`);
    lines.push('');
  }
  if (draft.edition) {
    lines.push('## Draft edition');
    lines.push(`**${draft.edition.headline.title}**`);
    lines.push('');
    lines.push(draft.edition.headline.summary);
    lines.push('');
    lines.push(`Deal: ${draft.edition.deal.target}${draft.edition.deal.acquirer ? ` / ${draft.edition.deal.acquirer}` : ''}${draft.edition.deal.value ? ` · ${draft.edition.deal.value}` : ' · value undisclosed'}`);
    lines.push('');
    for (const m of draft.edition.marketInFive) lines.push(`- ${m.title}: ${m.implication}`);
    lines.push('');
    lines.push(`Question: ${draft.edition.prediction.question} (${draft.edition.prediction.options.join(' / ')})`);
    lines.push('');
  }
  if (draft.cartoon) {
    lines.push('## Lev cartoon brief (satire, labelled as such on the page)');
    lines.push(`Scene: ${draft.cartoon.scene}`);
    lines.push('');
    lines.push(`Caption: ${draft.cartoon.caption}`);
    lines.push('');
    lines.push(`Grounded in: ${draft.cartoon.groundedIn}`);
    lines.push('');
    lines.push('House style: white paper, black ink line with a hand-drawn wobble, red #E20102 and orange #F87825 used at most once each, generous empty space, one idea played straight, no words inside the picture, fair to everyone in the story. Outputs: 1200x630 card, 1080x1350.');
    lines.push('');
  }
  lines.push('## Sources read');
  for (const s of draft.sources ?? []) lines.push(`- [${s.index}] ${s.name} · ${s.date} · ${s.url}${s.fetched === false ? ' · could not be read' : ''}`);
  return lines.join('\n') + '\n';
}
