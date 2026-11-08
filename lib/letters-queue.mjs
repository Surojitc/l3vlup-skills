// The letters review queue: what discovery found, classified, deduplicated
// against the site's catalogue, and laid out for a person to read.
//
// WHAT IT IS FOR
// Discovery lists filings from the approved sources. Most of them are not
// letters: an activist files a dozen ownership amendments for every letter,
// and an open-end fund's shareholder report has carried figures rather than
// the manager's letter since the 2024 tailored-report rule. A reviewer should
// open the likely letters first and not open the ones the catalogue already
// holds. This module decides, deterministically and from metadata alone,
// which class each filing most likely falls in, why, and whether the site
// already has it, and drafts the parts of a catalogue record that are facts
// about the filing (its form, accession, dates, period, link).
//
// WHAT IT NEVER DOES
// It reads no document. Its inputs are EDGAR's submissions index and, where
// one was read, the filing index page: the form, the filer's description,
// each document's declared type, label, name and size. It never writes a
// title, a reason to read, an introduction or a note: those are written by a
// person from the document, and the site will not publish a record without
// them (lib/letters.ts `recordProblems` in the site repo requires `why`, and
// docs/letters-launch-2026-10.md: "A new filing never becomes a new page on
// its own"). So nothing here publishes; every entry is for review.
//
// THE FOUR CLASSES
//   investor-letter  a shareholder report whose registrant carries the
//                    manager's letter, or a solicitation or 13D exhibit
//                    labelled as a letter (or, at low confidence, an
//                    unlabelled PDF of a letter's size)
//   presentation     an exhibit labelled as a presentation, deck or slides
//   proxy-material   a proxy statement or a solicitation with no letter or
//                    presentation identified in it
//   other            ownership reports, press releases, amendments, tailored
//                    shareholder reports with no letter
// Each carries a confidence (high when a label says so, medium when the form
// decides, low when only a size or the form's habit suggests it) and the
// reasons, in words, so a reviewer can disagree with a line rather than a
// verdict.
//
// Pure functions, no network, tested in scripts/__tests__/letters-queue.test.mjs.

import { campaignKey, classifyDocument } from './letters.mjs';

export const QUEUE_CLASSES = ['investor-letter', 'presentation', 'proxy-material', 'other'];
export const CONFIDENCE = ['high', 'medium', 'low'];

const SOLICITATION_FORMS = /^(DFAN14A|DEFC14A|PREC14A|PX14A6G)$/;
const SCHEDULE_13D = /^(SC|SCHEDULE) 13D(\/A)?$/;
const REPORT_FORMS = /^N-CSRS?(\/A)?$/;

// ── Keys: how a filing is recognised as one the catalogue already has ──────

/** The accession number an sec.gov Archives URL names, dashed: 0000921895-26-000666. */
export function accessionFromUrl(url) {
  const m = /\/Archives\/edgar\/data\/\d+\/(\d{10})(\d{2})(\d{6})(?:\/|$)/i.exec(String(url || ''));
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/** A URL reduced to what identifies the document: https, no www., no query, no fragment, no trailing slash. */
export function canonicalUrl(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    const path = u.pathname.replace(/\/+$/, '');
    return `https://${host}${path}`;
  } catch {
    return null;
  }
}

/**
 * The keys of every record the site holds, published, held back or excluded,
 * as id, status, accession and canonical URLs. A held or excluded document is
 * as much a duplicate as a published one: a person has already decided it.
 */
export function catalogueKeys(records, status) {
  return (records || []).map((r) => {
    const urls = [r.sourceUrl, r.discoveryUrl].filter(Boolean);
    const accession = r.accession || urls.map(accessionFromUrl).find(Boolean) || null;
    return { id: r.id, status, accession, urls: urls.map(canonicalUrl).filter(Boolean) };
  });
}

export function keyIndex(keys) {
  const byAccession = new Map();
  const byUrl = new Map();
  for (const k of keys || []) {
    if (k.accession && !byAccession.has(k.accession)) byAccession.set(k.accession, k);
    for (const u of k.urls || []) if (!byUrl.has(u)) byUrl.set(u, k);
  }
  return { byAccession, byUrl };
}

/** The catalogue key this filing matches, by accession first and then by any URL it carries. */
export function findDuplicate(candidate, index, documents = []) {
  const acc = candidate.accession;
  if (acc && index.byAccession.has(acc)) return { ...index.byAccession.get(acc), matchedBy: 'accession' };
  const urls = [candidate.documentUrl, candidate.indexUrl, ...documents.map((d) => d.url)].map(canonicalUrl).filter(Boolean);
  for (const u of urls) if (index.byUrl.has(u)) return { ...index.byUrl.get(u), matchedBy: 'url' };
  return null;
}

// ── Periods ────────────────────────────────────────────────────────────────

/**
 * The reporting period in the site's vocabulary (FY2025, 2026H1, FY2025H1, or
 * an event date). An annual report covers the fiscal year its period ends in.
 * A semi-annual report ending in June is the calendar half; one ending in any
 * other month is the first half of the fiscal year that ends six months later
 * (Oakmark's March report is H1 of the year to September). An activist filing
 * is an event, dated by its filing until a person reads the date it bears.
 */
export function reportingPeriodFor(form, reportDate, filingDate) {
  const base = form.replace(/\/A$/, '');
  const m = /^(\d{4})-(\d{2})-\d{2}$/.exec(reportDate || '');
  if (base === 'N-CSR' && m) return `FY${m[1]}`;
  if (base === 'N-CSRS' && m) {
    if (m[2] === '06') return `${m[1]}H1`;
    const end = Number(m[2]) + 6;
    const fy = end > 12 ? Number(m[1]) + 1 : Number(m[1]);
    return `FY${fy}H1`;
  }
  return filingDate || null;
}

// ── Classification ─────────────────────────────────────────────────────────

// Exhibit labels that name a legal instrument, not a piece of writing: a
// "registration rights letter agreement" is not a letter, and an exhibit that
// is the Schedule 13D amendment itself is not a deck.
// A label addressed to someone ("letter to the board regarding the agreement")
// is writing whatever else it names.
export const NOT_WRITING = /\b(agreement|undertaking|amendment no\.?\s*\d*\s*to the schedule 13d|schedule 13d\/a|power of attorney|joint filing|indenture|term sheet)\b/i;
const ADDRESSED = /\b(letter|memo|memorandum) to\b/i;
export function namesAnInstrument(label) {
  return NOT_WRITING.test(label || '') && !ADDRESSED.test(label || '');
}

const DEFAULT_TITLE = /^\S+(?: \S+)? filed \d{4}-\d{2}-\d{2}$/;

function reportClassification(candidate, source) {
  const form = candidate.form;
  const kind = form.startsWith('N-CSRS') ? 'semi-annual' : 'annual';
  const who = source.registrant || source.manager;
  if (/\/A$/.test(form)) {
    return {
      classification: 'other',
      confidence: 'medium',
      reasons: [`${form} amends an earlier shareholder report of ${who}, usually to correct it; the original filing is the one to read`],
      suggestedContentType: null,
    };
  }
  if (source.reportCarriesLetter === true) {
    return {
      classification: 'investor-letter',
      confidence: 'high',
      reasons: [`the ${kind} shareholder report of ${who}`, `this registrant's report was checked to carry the manager's letter (${source.verifiedOn || 'date not recorded'})`],
      suggestedContentType: 'manager-letter',
    };
  }
  if (source.reportCarriesLetter === false) {
    return {
      classification: 'other',
      confidence: 'high',
      reasons: [`the ${kind} shareholder report of ${who}`, "a tailored shareholder report: since 2024 an open-end fund's report carries figures, not the manager's letter", 'if catalogued at all, it is a fund-report, never a letter'],
      suggestedContentType: 'fund-report',
    };
  }
  return {
    classification: 'investor-letter',
    confidence: 'low',
    reasons: [`the ${kind} shareholder report of ${who}`, "whether this registrant's report carries the manager's letter has not been checked"],
    suggestedContentType: 'manager-letter',
  };
}

function describe(doc) {
  const label = doc.description ? `labelled "${doc.description}"` : 'unlabelled';
  return `document ${doc.seq || '?'} (${doc.type || 'no type'}, ${doc.filename || 'no name'}) is ${label}`;
}

function byFormAlone(candidate, needsIndex) {
  const form = candidate.form;
  const reasons = [];
  if (needsIndex) reasons.push('the filing index was not read, so its exhibits are unknown');
  if (SOLICITATION_FORMS.test(form)) {
    reasons.push(`${form} is proxy soliciting material; a letter or a deck arrives in one, but nothing here says this is one`);
    return { classification: 'proxy-material', confidence: needsIndex ? 'low' : 'medium', reasons, suggestedContentType: null };
  }
  if (SCHEDULE_13D.test(form)) {
    reasons.push(`${form} reports a holding and its purpose; a letter arrives only as an exhibit, and none is identified`);
    return { classification: 'other', confidence: needsIndex ? 'low' : 'medium', reasons, suggestedContentType: null };
  }
  reasons.push(`${form} is not a form that carries a letter`);
  return { classification: 'other', confidence: 'medium', reasons, suggestedContentType: null };
}

/**
 * The class of one filing, with its reasons, the document a reviewer should
 * open first, and whether the filing index still needs reading.
 *
 * `documents` is the filing index page's table (parseFilingIndex in
 * lib/letters.mjs), each with an absolute `url`; null when the index was not
 * read. A shareholder report is decided by its registrant, which was checked
 * once; an activist filing by the labels its filer gave its documents.
 */
export function classifyCandidate(candidate, source, { documents = null } = {}) {
  const form = candidate.form;
  if (REPORT_FORMS.test(form)) {
    const primary = (documents || []).find((d) => /^N-CSR/.test(d.type || '')) || null;
    return { ...reportClassification(candidate, source), letterDocument: primary, needsIndex: false };
  }

  const description = candidate.title && !DEFAULT_TITLE.test(candidate.title) ? candidate.title : null;
  if (!documents) {
    // The submissions index's one-line description of the primary document is
    // all there is. It can say "LETTER TO STOCKHOLDERS"; mostly it is blank.
    if (description) {
      const kind = classifyDocument({ seq: '1', type: form, description }, form);
      if (kind === 'letter' || kind === 'presentation') {
        return {
          classification: kind === 'letter' ? 'investor-letter' : 'presentation',
          confidence: 'medium',
          reasons: [`the filer describes the primary document as "${description}"`, 'the filing index was not read, so its exhibits are unknown'],
          suggestedContentType: kind === 'letter' ? 'activist-letter' : null,
          letterDocument: null,
          needsIndex: true,
        };
      }
    }
    return { ...byFormAlone(candidate, true), letterDocument: null, needsIndex: true };
  }

  const docs = documents.map((d) => ({ ...d, kind: namesAnInstrument(d.description) ? 'routine' : classifyDocument(d, form, { siblings: documents }) }));
  const pick = (k) => docs.filter((d) => d.kind === k).sort((a, b) => (b.size || 0) - (a.size || 0));
  const letters = pick('letter');
  if (letters.length) {
    return {
      classification: 'investor-letter',
      confidence: 'high',
      reasons: letters.map(describe),
      suggestedContentType: 'activist-letter',
      letterDocument: letters[0],
      needsIndex: false,
    };
  }
  const decks = pick('presentation');
  if (decks.length) {
    return {
      classification: 'presentation',
      confidence: 'high',
      reasons: [...decks.map(describe), 'a presentation is not a content type the catalogue holds; it belongs only if it reads as a letter'],
      suggestedContentType: null,
      letterDocument: decks[0],
      needsIndex: false,
    };
  }
  // Unlabelled exhibits: a PDF's size is the only signal, and it is a hint.
  // (A DFAN14A's blank primary document beside an exhibit is already a
  // solicitation_cover, so what is left unclassified is content.)
  const unlabelled = pick('unclassified');
  const pdf = unlabelled.find((d) => /\.pdf$/i.test(d.filename || ''));
  if (pdf) {
    const large = (pdf.size || 0) >= 2_000_000;
    return {
      classification: large ? 'presentation' : 'investor-letter',
      confidence: 'low',
      reasons: [describe(pdf), large ? 'a PDF this large is usually a presentation' : 'a PDF this size is usually a letter', 'open it before deciding: the label says nothing'],
      suggestedContentType: large ? null : 'activist-letter',
      letterDocument: pdf,
      needsIndex: false,
    };
  }
  const releases = pick('press_release');
  if (releases.length && !unlabelled.length) {
    return { classification: 'other', confidence: 'medium', reasons: [...releases.map(describe), 'a press release is not a letter'], suggestedContentType: null, letterDocument: null, needsIndex: false };
  }
  const proxies = pick('proxy_material');
  if (proxies.length) {
    return { classification: 'proxy-material', confidence: 'high', reasons: proxies.map(describe), suggestedContentType: null, letterDocument: null, needsIndex: false };
  }
  const base = byFormAlone(candidate, false);
  if (unlabelled.length) {
    base.reasons.unshift(...unlabelled.map(describe));
    base.reasons.push('an unlabelled short document is a letter, a release or a cover: open it to tell');
    base.confidence = 'low';
  }
  return { ...base, letterDocument: unlabelled[0] || null, needsIndex: false };
}

// ── The record skeleton ────────────────────────────────────────────────────

function slug(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const CORPORATE = /\b(the|inc|incorporated|corp|corporation|co|company|plc|ltd|limited|lp|llc|l\.p|holdings|group|n\.v|s\.a|ag|se)\b\.?/gi;

function companySlug(name) {
  return slug(String(name || '').replace(/,/g, ' ').replace(CORPORATE, ' ')).split('-').slice(0, 3).join('-');
}

function periodSlug(period) {
  const m = /^(?:FY(\d{4})(H[12])?|(\d{4})H([12]))$/.exec(period || '');
  if (!m) return null;
  if (m[1]) return m[2] ? `${m[2].toLowerCase()}-fy${m[1]}` : `fy${m[1]}`;
  return `h${m[4]}-${m[3]}`;
}

/** A suggested id in the catalogue's style: starboard-carmax-2026-03, gamco-gabelli-equity-trust-fy2025. */
export function suggestedId(entry, source) {
  const prefix = slug(source.fund).replace(/-(value|capital|partners|management)$/, '');
  if (REPORT_FORMS.test(entry.form)) {
    const fund = companySlug(source.registrant || source.manager);
    const head = fund.startsWith(prefix) ? fund : `${prefix}-${fund}`;
    return [head, periodSlug(entry.period) || entry.filingDate.slice(0, 7)].filter(Boolean).join('-');
  }
  const subject = entry.subject?.name ? companySlug(entry.subject.name) : null;
  return [prefix, subject, entry.filingDate.slice(0, 7)].filter(Boolean).join('-');
}

function containerFor(entry) {
  if (REPORT_FORMS.test(entry.form)) return 'sec-n-csr';
  const doc = entry.letterDocument;
  if (doc && doc.seq && doc.seq !== '1') return 'sec-exhibit';
  if (SCHEDULE_13D.test(entry.form)) return 'sec-schedule-13d';
  return 'sec-proxy-material';
}

/** The fields a person writes from the document. The site refuses a record without them. */
export const FIELDS_FOR_A_PERSON = ['title', 'writerIds', 'sector', 'companies', 'topics', 'intro', 'why', 'notice', 'grounded'];

/**
 * A catalogue record with every fact about the filing filled in and every
 * editorial field empty. It cannot be published as it stands: `why` is null,
 * `notice` is empty and `grounded` is false, and the site's recordProblems
 * refuses the first. No text is quoted from the filing.
 */
export function recordSkeleton(entry, source) {
  const url = entry.letterDocument?.url || entry.documentUrl || null;
  const skeleton = {
    id: suggestedId(entry, source),
    collection: 'investment',
    contentType: entry.suggestedContentType,
    title: null,
    titleOrigin: 'l3vlup',
    writerIds: [],
    organisation: source.organisation || source.manager,
    publicationDate: entry.filingDate,
    reportingPeriod: entry.period,
    containerType: containerFor(entry),
    sourceUrl: url,
    sourceHost: 'www.sec.gov',
    filedOn: entry.filingDate,
    form: entry.form,
    accession: entry.accession,
    sourceRights: 'sec-public',
    sector: null,
    companies: entry.subject?.name ? [{ name: entry.subject.name, ticker: null, role: 'subject' }] : [],
    topics: [],
    intro: null,
    why: null,
    notice: [],
    quote: null,
    grounded: false,
    origin: 'sec-pipeline',
    rights: 'link-only',
  };
  if (source.fundSlug) skeleton.fundSlug = source.fundSlug;
  const check = [];
  check.push('publicationDate is the filing date: replace it with the date the letter bears, if it bears one');
  if (!REPORT_FORMS.test(entry.form)) check.push('reportingPeriod is the filing date: an activist letter is dated by its event, usually the date it bears');
  if (!url) check.push('sourceUrl is unknown until the filing index is read: link the letter itself, never the index');
  if (!entry.suggestedContentType) check.push('contentType is left empty: nothing here says this is a letter');
  if (entry.subject?.name) check.push('the subject company is as EDGAR names it: restore its usual capitalisation and add its ticker only where the letter states it');
  return { ...skeleton, publishable: false, toWrite: FIELDS_FOR_A_PERSON, toCheck: check };
}

// ── The queue ──────────────────────────────────────────────────────────────

const CLASS_RANK = Object.fromEntries(QUEUE_CLASSES.map((c, i) => [c, i]));
const CONF_RANK = Object.fromEntries(CONFIDENCE.map((c, i) => [c, i]));

export function compareEntries(a, b) {
  return (
    CLASS_RANK[a.classification] - CLASS_RANK[b.classification] ||
    CONF_RANK[a.confidence] - CONF_RANK[b.confidence] ||
    b.filingDate.localeCompare(a.filingDate) ||
    a.accession.localeCompare(b.accession)
  );
}

/** The part of a filing index worth keeping: the documents that can carry content, and where they are. */
export function storedIndex(idx) {
  return {
    indexUrl: idx.indexUrl || null,
    subject: idx.subject?.name ? { name: idx.subject.name, cik: idx.subject.cik || null } : null,
    documents: (idx.documents || [])
      .filter((d) => d.seq && !/^GRAPHIC/i.test(d.type || ''))
      .map((d) => ({ seq: d.seq, type: d.type || '', description: d.description || '', filename: d.filename || '', size: d.size ?? null, url: d.url || null })),
  };
}

/** Indexes a previous queue read, keyed by accession, for a run that cannot or need not read them again. */
export function indexesFromQueue(previous) {
  const out = new Map();
  for (const e of previous?.entries || []) if (e.index?.documents) out.set(e.accession, e.index);
  return out;
}

/**
 * Candidates in, a review queue out.
 *
 *   candidates   discovery candidates (selectCandidates), every source, uncapped
 *   sourcesById  the registry rows
 *   keys         catalogueKeys() of the site's published, held and excluded records
 *   indexes      Map of accession to { documents, subject, indexUrl } for the
 *                filing indexes that were read; documents carry absolute urls
 *   previous     the last queue written, so an entry keeps the day it was first seen
 *
 * One filing is one entry however many approved filers list it (a joint
 * filing appears under each); the first source in registry order owns it and
 * the rest are named in `alsoFiledBy`.
 */
// A decision already made on a filing (data/letters.queue-decisions.json)
// travels with it into every later queue: a rejected filing stays rejected,
// with its reason, rather than coming back to be read again each week. A
// published one leaves the queue by the catalogue keys, like any record.
export const DECISIONS = ['rejected', 'review'];

export function decisionIndex(file) {
  const out = new Map();
  for (const d of Array.isArray(file?.decisions) ? file.decisions : []) {
    if (d && typeof d.accession === 'string' && DECISIONS.includes(d.decision)) out.set(d.accession, d);
  }
  return out;
}

export function buildQueue({ candidates, sourcesById, keys, indexes = new Map(), previous = null, now = new Date(), decisions = new Map() }) {
  const index = keyIndex(keys);
  const seenBefore = new Map((previous?.entries || []).map((e) => [e.accession, e.firstSeen]));
  const today = now.toISOString().slice(0, 10);
  const byAccession = new Map();
  const duplicates = [];
  const order = Object.keys(sourcesById);
  const sorted = [...candidates].sort((a, b) => order.indexOf(a.sourceId) - order.indexOf(b.sourceId));

  for (const c of sorted) {
    const owner = byAccession.get(c.accession);
    if (owner) {
      if (!owner.alsoFiledBy.includes(c.fund) && owner.fund !== c.fund) owner.alsoFiledBy.push(c.fund);
      continue;
    }
    if (duplicates.some((d) => d.accession === c.accession)) continue;
    const source = sourcesById[c.sourceId];
    const idx = indexes.get(c.accession) || null;
    const documents = idx?.documents || null;
    const dup = findDuplicate(c, index, documents || []);
    if (dup) {
      duplicates.push({ accession: c.accession, fund: c.fund, form: c.form, filingDate: c.filingDate, catalogueId: dup.id, catalogueStatus: dup.status, matchedBy: dup.matchedBy });
      continue;
    }
    const verdict = classifyCandidate(c, source, { documents });
    const letterDocument = verdict.letterDocument
      ? { seq: verdict.letterDocument.seq || null, type: verdict.letterDocument.type || null, label: verdict.letterDocument.description || null, filename: verdict.letterDocument.filename || null, size: verdict.letterDocument.size ?? null, url: verdict.letterDocument.url || null }
      : null;
    const entry = {
      accession: c.accession,
      fund: c.fund,
      sourceId: c.sourceId,
      manager: source.manager,
      form: c.form,
      filingDate: c.filingDate,
      reportDate: c.reportDate || null,
      period: reportingPeriodFor(c.form, c.reportDate, c.filingDate),
      subject: idx?.subject?.name ? { name: idx.subject.name, cik: idx.subject.cik || null } : null,
      classification: verdict.classification,
      confidence: verdict.confidence,
      reasons: verdict.reasons,
      suggestedContentType: verdict.suggestedContentType,
      letterDocument,
      documentUrl: c.documentUrl || null,
      indexUrl: idx?.indexUrl || c.indexUrl,
      needsIndex: verdict.needsIndex,
      campaign: SOLICITATION_FORMS.test(c.form) || SCHEDULE_13D.test(c.form) ? campaignKey(c) : null,
      repeatOf: null,
      // The index table as read (labels, names, sizes, links; never a
      // document's text), so the next run classifies the same way without
      // reading the page again.
      index: idx ? storedIndex(idx) : null,
      alsoFiledBy: [],
      firstSeen: seenBefore.get(c.accession) || today,
      status: decisions.get(c.accession)?.decision || 'review',
      ...(decisions.get(c.accession)?.reason ? { decisionReason: decisions.get(c.accession).reason, decidedOn: decisions.get(c.accession).decidedOn || null } : {}),
    };
    entry.skeleton = recordSkeleton(entry, source);
    byAccession.set(c.accession, entry);
  }

  const entries = Array.from(byAccession.values()).sort(compareEntries);
  markRepeats(entries);
  // A suggested id is never one the catalogue already uses, nor another
  // entry's: the later filing takes a numeric suffix.
  const taken = new Set((keys || []).map((k) => k.id));
  for (const e of [...entries].sort((a, b) => a.filingDate.localeCompare(b.filingDate) || a.accession.localeCompare(b.accession))) {
    let id = e.skeleton.id;
    for (let n = 2; taken.has(id); n += 1) id = `${e.skeleton.id}-${n}`;
    e.skeleton.id = id;
    taken.add(id);
  }
  const byClass = Object.fromEntries(QUEUE_CLASSES.map((k) => [k, entries.filter((e) => e.classification === k).length]));
  const byConfidence = Object.fromEntries(QUEUE_CLASSES.map((k) => [k, Object.fromEntries(CONFIDENCE.map((c) => [c, entries.filter((e) => e.classification === k && e.confidence === c).length]))]));
  return {
    counts: {
      candidates: candidates.length,
      entries: entries.length,
      toReview: entries.filter((e) => e.status === 'review').length,
      rejected: entries.filter((e) => e.status === 'rejected').length,
      duplicates: duplicates.length,
      newSinceLastQueue: entries.filter((e) => !seenBefore.has(e.accession)).length,
      needsIndex: entries.filter((e) => e.needsIndex).length,
      byClass,
      byConfidence,
    },
    entries,
    duplicates: duplicates.sort((a, b) => b.filingDate.localeCompare(a.filingDate)),
  };
}

/**
 * An activist often files one letter twice: as a DFAN14A exhibit and again
 * behind its Schedule 13D amendment the same day. Same subject, same label,
 * same size in bytes: the later or the 13D copy is marked as a repeat of the
 * other, so the reviewer reads it once. A hint, never a deletion.
 */
export function markRepeats(entries) {
  const seen = new Map();
  const ordered = [...entries].sort((a, b) => a.filingDate.localeCompare(b.filingDate) || (SCHEDULE_13D.test(a.form) ? 1 : 0) - (SCHEDULE_13D.test(b.form) ? 1 : 0));
  for (const e of ordered) {
    const d = e.letterDocument;
    if (!d || !d.size || !e.subject?.name) continue;
    const key = `${e.subject.name.toLowerCase()}|${(d.label || '').toLowerCase()}|${d.size}`;
    if (seen.has(key)) e.repeatOf = seen.get(key);
    else seen.set(key, e.accession);
  }
  return entries;
}

// ── The page a reviewer reads ──────────────────────────────────────────────

const CLASS_HEADING = {
  'investor-letter': 'Likely investor letters',
  presentation: 'Presentations',
  'proxy-material': 'Proxy material',
  other: 'Other filings',
};

function cell(text) {
  return String(text ?? '').replace(/\|/g, '/').replace(/\s+/g, ' ').trim();
}

export function queueMarkdown(queue) {
  const c = queue.counts;
  const lines = [
    '# Letters review queue',
    '',
    `Generated ${queue.generatedAt}. ${c.candidates} filing(s) from ${queue.sources} approved source(s) in the window since ${queue.since}; ${c.duplicates} already in the site catalogue (published, held or excluded), ${c.entries} to review, ${c.newSinceLastQueue} new since the last queue.`,
    '',
    'Nothing here is published. Each entry is a filing on sec.gov, classified from its form and its documents\' labels, never from its text. A record reaches the site only when a person has read the filing, written the title, why and notes from it, and added it to data/letters.catalogue.json in the site repository.',
    '',
    '| Class | High | Medium | Low | Total |',
    '|---|---|---|---|---|',
  ];
  for (const k of QUEUE_CLASSES) {
    const b = c.byConfidence[k];
    lines.push(`| ${CLASS_HEADING[k]} | ${b.high} | ${b.medium} | ${b.low} | ${c.byClass[k]} |`);
  }
  if (c.needsIndex) lines.push('', `${c.needsIndex} entr${c.needsIndex === 1 ? 'y has' : 'ies have'} not had the filing index read; their class is the form's and may change when it is.`);
  for (const k of QUEUE_CLASSES) {
    // What is still to read; a rejected filing is counted above, not relisted.
    const list = queue.entries.filter((e) => e.classification === k && e.status === 'review');
    if (!list.length) continue;
    lines.push('', `## ${CLASS_HEADING[k]} (${list.length})`, '');
    if (k === 'investor-letter' || k === 'presentation') {
      const low = list.filter((e) => e.confidence === 'low');
      for (const e of list.filter((x) => x.confidence !== 'low')) {
        const subject = e.subject?.name ? ` on ${e.subject.name}` : '';
        lines.push(`### ${e.manager}${subject}: ${e.form}, filed ${e.filingDate}`);
        lines.push('');
        lines.push(`- Confidence: ${e.confidence}. Period: ${e.period}. Accession ${e.accession}. First seen ${e.firstSeen}.`);
        lines.push(`- Why: ${e.reasons.join('; ')}.`);
        if (e.letterDocument?.url) lines.push(`- Open first: [${e.letterDocument.filename || 'document'}](${e.letterDocument.url})`);
        lines.push(`- Filing index: [${e.accession}](${e.indexUrl})`);
        lines.push(`- Suggested id: \`${e.skeleton.id}\`, contentType ${e.skeleton.contentType || 'not set'}, containerType ${e.skeleton.containerType}.`);
        if (e.alsoFiledBy.length) lines.push(`- Also filed by: ${e.alsoFiledBy.join(', ')}.`);
        if (e.repeatOf) lines.push(`- Probably the same document as ${e.repeatOf} (same subject, label and size).`);
        lines.push('');
      }
      if (low.length) {
        lines.push(`Low confidence (${low.length}): an unlabelled exhibit, judged by its size alone. Open before deciding.`, '');
        lines.push('| Manager | Subject | Form | Filed | Exhibit | Size | Filing |', '|---|---|---|---|---|---|---|');
        for (const e of low) {
          const d = e.letterDocument || {};
          const doc = d.url ? `[${cell(d.filename)}](${d.url})` : 'n.a.';
          lines.push(`| ${cell(e.manager)} | ${cell(e.subject?.name || '')} | ${e.form} | ${e.filingDate} | ${doc}${e.repeatOf ? ` (repeat of ${e.repeatOf})` : ''} | ${d.size ?? ''} | [index](${e.indexUrl}) |`);
        }
      }
    } else {
      lines.push('| Manager | Form | Filed | Confidence | Why | Filing |', '|---|---|---|---|---|---|');
      for (const e of list) lines.push(`| ${cell(e.manager)} | ${e.form} | ${e.filingDate} | ${e.confidence} | ${cell(e.reasons[0])} | [index](${e.indexUrl}) |`);
    }
  }
  if (queue.duplicates.length) {
    lines.push('', `## Already in the catalogue (${queue.duplicates.length})`, '', '| Fund | Form | Filed | Accession | Catalogue record | Status | Matched by |', '|---|---|---|---|---|---|---|');
    for (const d of queue.duplicates) lines.push(`| ${d.fund} | ${d.form} | ${d.filingDate} | ${d.accession} | ${d.catalogueId} | ${d.catalogueStatus} | ${d.matchedBy} |`);
  }
  if (queue.stopped) lines.push('', `**Stopped:** ${queue.stopped}`);
  return `${lines.join('\n')}\n`;
}
