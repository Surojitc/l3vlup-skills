// The final Phase 0 document selection: exactly two documents per fund,
// chosen from the enumeration report by rule, with a bounded human-readable
// validation of any candidate the index page did not label.
//
// Rules, in the order they bind: two distinct campaigns for an activist and
// two distinct reporting periods for a registered fund; documents under the
// 15 MB fetch cap before any over it; a labelled letter, presentation or
// report before an unlabelled document that validation confirmed, before
// one it did not; covers, proxy cards, schedules, certifications and
// boilerplate never. Where no document meets the rules, the row says so
// and names an exception or an alternative rather than lowering the bar.
//
// Validation reads only enough of a document to say what it is: the title
// and the opening markers of an HTML page, the page geometry and metadata
// of a PDF's first bytes. Nothing it reads is stored beyond a title and a
// classification, and it never quotes the body.

import { FETCH_CAP_BYTES } from './letters.mjs';

const NEVER = new Set(['routine', 'solicitation_cover', 'schedule_13d', 'proxy_material']);
const LABELLED = new Set(['letter', 'presentation', 'shareholder_report']);

/** Rows worth choosing from, per fund: labelled writing or unlabelled documents, never boilerplate. */
export function candidateRows(shortlist) {
  return shortlist.filter((r) => !NEVER.has(r.likelyContent) && r.eligible !== 'no' && r.format !== 'text');
}

function score(r) {
  const validated = r.validation?.classification;
  let s = 0;
  if (LABELLED.has(r.likelyContent)) s += 100;
  else if (validated === 'letter' || validated === 'presentation' || validated === 'shareholder_report') s += 80;
  else if (validated) s -= 50; // validated as something else: a release, a cover
  if (!r.overFetchCap) s += 20;
  return s;
}

/** The single best row per campaign or period, under the rules above. */
export function bestPerGroup(rows, keyOf) {
  const groups = new Map();
  for (const r of rows) {
    const k = keyOf(r);
    if (!k) continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  return Array.from(groups.entries()).map(([key, list]) => ({
    key,
    best: [...list].sort((a, b) => score(b) - score(a) || b.filingDate.localeCompare(a.filingDate))[0],
    alternatives: [...list].sort((a, b) => score(b) - score(a)).slice(1),
  }));
}

function accepted(r) {
  if (!r) return false;
  if (LABELLED.has(r.likelyContent)) return true;
  const v = r.validation;
  return !!v && v.confidence !== 'weak' && (v.classification === 'letter' || v.classification === 'presentation' || v.classification === 'shareholder_report');
}

/** Weakly validated: the head read leaned one way without settling it. */
export function weaklyValidated(r) {
  return !!r?.validation && r.validation.confidence === 'weak';
}

/**
 * Two per fund. For a registered fund: the newest acceptable under-cap
 * report, then the earliest acceptable under-cap report of another period;
 * an over-cap report only as an explicit exception when no under-cap one
 * gives a second period. For an activist: the best acceptable document of
 * each of two campaigns, under-cap first, with the same exception rule.
 */
export function selectFinal(shortlist, sourcesById) {
  const byFund = {};
  for (const r of candidateRows(shortlist)) (byFund[r.fund] ||= []).push(r);
  const out = [];
  for (const [fund, rows] of Object.entries(byFund)) {
    const isReport = sourcesById[rows[0].sourceId]?.sourceType === 'sec_shareholder_report';
    const groups = bestPerGroup(rows, (r) => (isReport ? r.reportingPeriod : r.campaign));
    // An over-cap document that validation only leaned towards is still offered, as an exception that says both things.
    const usable = groups.filter((g) => accepted(g.best) || (g.best.overFetchCap && weaklyValidated(g.best) && ['letter', 'presentation'].includes(g.best.validation.classification)));
    const under = usable.filter((g) => !g.best.overFetchCap).sort((a, b) => b.best.filingDate.localeCompare(a.best.filingDate));
    const over = usable.filter((g) => g.best.overFetchCap).sort((a, b) => b.best.filingDate.localeCompare(a.best.filingDate));
    const picks = [];
    if (isReport) {
      if (under[0]) picks.push({ ...under[0], exception: null });
      const rest = under.slice(1).sort((a, b) => a.best.reportingPeriod.localeCompare(b.best.reportingPeriod));
      if (rest[0]) picks.push({ ...rest[0], exception: null });
    } else {
      for (const g of under) if (picks.length < 2) picks.push({ ...g, exception: null });
    }
    if (picks.length < 2 && over[0]) {
      const g = over[0];
      const weak = weaklyValidated(g.best) ? `; content only weakly validated (${g.best.validation.evidence})` : '';
      picks.push({ ...g, exception: `size: ${(g.best.size / 1048576).toFixed(1)} MB against the ${(FETCH_CAP_BYTES / 1048576).toFixed(0)} MB cap; no under-cap document gives a second ${isReport ? 'period' : 'campaign'} among the inspected indexes${weak}` });
    }
    const unvalidated = groups.filter((g) => !accepted(g.best) && !g.best.validation && !picks.some((p) => p.key === g.key)).map((g) => g.best);
    out.push({ fund, isReport, picks, groups, needsValidation: unvalidated, shortfall: picks.length < 2 ? `only ${picks.length} acceptable ${isReport ? 'period' : 'campaign'}(s)` : null });
  }
  return out;
}

// ── What a document is, from its head only ──────────────────────────────────

const HTML_MARKERS = [
  // The legend a filer agent puts on a DFAN14A cover page is decisive and comes first.
  ['cover', /Filed by[\s\S]{0,400}pursuant to Rule 14a-12|written materials|This filing consists of/i],
  ['press_release', /FOR IMMEDIATE RELEASE|PRESS RELEASE|\bannounce[sd]?\b/i],
  ['letter', /\bDear\s+(Fellow\s+)?(Share|Stock)holders?|\bDear\s+(Members of the )?Board|\bOpen Letter\b|\bLetter to\b/i],
  ['presentation', /\bInvestor Presentation\b|\bSlide\b/i],
];
const LETTER_MARKER = HTML_MARKERS[2][1];

/** Title, opening markers and word count of an HTML document; body not retained. */
export function classifyHtmlHead(html) {
  const text = String(html || '')
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
  const title = (String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').replace(/\s+/g, ' ').trim() || null;
  const confidence = 'firm'; // the whole page was read
  const head = text.slice(0, 4000);
  const words = text.split(' ').filter(Boolean).length;
  let classification = 'unclear';
  let evidence = null;
  for (const [kind, re] of HTML_MARKERS) {
    const m = re.exec(head);
    if (m) {
      classification = kind;
      evidence = `marker "${m[0].slice(0, 40)}" in the opening text`;
      break;
    }
  }
  // A release that then carries a letter is still the letter the fund wrote.
  if (classification === 'press_release' && LETTER_MARKER.test(head)) {
    classification = 'letter';
    evidence = 'a release wrapping a letter: the letter marker follows the release marker';
  }
  // A page of a few lines is a cover whatever its words, unless it is itself the letter.
  if (words < 150 && classification !== 'letter') classification = 'cover';
  return { title, classification, confidence, evidence, words, bytesInspected: String(html || '').length };
}

/** Page geometry and metadata from a PDF's first bytes; nothing else read. */
export function classifyPdfHead(bytes) {
  const s = Buffer.isBuffer(bytes) ? bytes.toString('latin1') : String(bytes || '');
  const boxes = [...s.matchAll(/\/MediaBox\s*\[\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\]/g)].map((m) => [Number(m[3]) - Number(m[1]), Number(m[4]) - Number(m[2])]);
  const landscape = boxes.filter(([w, h]) => w > h).length;
  const count = Number(s.match(/\/Type\s*\/Pages[^>]*?\/Count\s+(\d+)/)?.[1] || s.match(/\/Count\s+(\d+)[^>]*?\/Type\s*\/Pages/)?.[1] || 0) || null;
  const title = (s.match(/\/Title\s*\(([^)]{0,200})\)/)?.[1] || s.match(/<dc:title>[\s\S]*?<rdf:li[^>]*>([^<]{0,200})<\/rdf:li>/)?.[1] || '').trim() || null;
  let classification = 'unclear';
  let evidence = null;
  if (boxes.length && landscape / boxes.length > 0.6) {
    classification = 'presentation';
    evidence = `${landscape} of ${boxes.length} page boxes seen are landscape`;
  } else if (boxes.length && landscape === 0) {
    classification = count && count > 40 ? 'unclear' : 'letter';
    evidence = `${boxes.length} portrait page boxes seen${count ? `, ${count} pages` : ''}`;
  } else if (count) {
    classification = count > 20 ? 'presentation' : 'letter';
    evidence = `${count} pages, page orientation not seen in the first bytes`;
  }
  const confidence = classification === 'unclear' ? 'none' : boxes.length >= 3 || (count && count > 0) ? 'firm' : 'weak';
  return { title, classification, confidence, evidence, pages: count, landscapeBoxes: landscape, boxesSeen: boxes.length, bytesInspected: s.length };
}
