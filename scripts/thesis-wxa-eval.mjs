#!/usr/bin/env node
/**
 * The Words × Actions pilot scored against its gold set.
 *
 *   node scripts/thesis-wxa-eval.mjs            # writes data/thesis/wxa/eval.md and eval.json
 *
 * WHY THIS EXISTS
 * ---------------
 * A claim pipeline is only as good as what it finds and whether it is right.
 * data/thesis/wxa/gold.json says, for each pilot document, which company it is
 * about, the stance, the catalysts, the risks and the figures that matter. This
 * scores two extractions against it on what a reader would notice:
 *
 *   company     every claim names the document's company (not a peer, a product
 *               or "the Company" where the gold names it)
 *   stance      the claim's stance is the document's
 *   catalysts   a gold catalyst is captured by at least one claim
 *   risks       a gold risk is captured
 *   figures     a gold figure's numbers appear in a claim's paraphrase or excerpt
 *   passages    every claim's passage was found byte for byte in the source
 *
 * Thesis fidelity (does the paraphrase say what the document says) is not
 * scored here: that is a reader's judgement, and the review pack is where it is
 * made. Ownership links and the change against the prior quarter are the
 * site's (lib/words-actions.ts, tested there).
 *
 * The two extractions: the editor session's (data/thesis/wxa/claims.pending.json)
 * and, for the three documents it also read, the model's earlier run
 * (data/thesis/claims.pending.json, claude-sonnet-5). Pure counting; no model.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'data', 'thesis', 'wxa');

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9$%.]+/g, ' ').trim();
const STOP = new Set(['the', 'inc', 'corp', 'corporation', 'company', 'co', 'holding', 'holdings', 'group', 'plc', 'ltd', 'and']);
const words = (s) => norm(s).split(' ').filter((w) => w && !STOP.has(w));

/** Does a claim's company mention name the gold company? "the Company" counts, a peer does not. */
export function sameCompany(mention, gold) {
  const m = words(mention);
  if (!m.length) return true; // "the Company" in a letter about one company
  const g = new Set(words(gold));
  return m.some((w) => g.has(w));
}

/** Do the key words of a gold phrase appear in any claim text? A loose recall test, not a judgement. */
export function covers(phrase, texts) {
  const key = words(phrase).filter((w) => w.length > 3);
  if (!key.length) return false;
  const hay = norm(texts.join(' '));
  return key.filter((w) => hay.includes(w)).length / key.length >= 0.5;
}

const digits = (s) => String(s).replace(/[^0-9.]/g, '').replace(/^\.+|\.+$/g, '');

export function scoreDocument(gold, claims) {
  const texts = claims.flatMap((c) => [c.paraphrase, c.excerpt, ...(c.catalysts ?? []).map((x) => x.description), ...(c.risks ?? []).map((x) => x.description)]);
  const n = claims.length;
  const pct = (k, t) => (t ? Math.round((k / t) * 100) : null);
  const figs = gold.figures ?? [];
  const figHit = figs.filter((f) => (f.numbers ?? []).some((num) => digits(num) && texts.some((t) => String(t ?? '').replace(/,/g, '').includes(digits(num)))));
  return {
    claims: n,
    company: pct(claims.filter((c) => sameCompany(c.issuerMention ?? c.issuerName, gold.company)).length, n),
    stance: pct(claims.filter((c) => c.stance === gold.stance).length, n),
    catalysts: pct((gold.catalysts ?? []).filter((x) => covers(x, texts)).length, (gold.catalysts ?? []).length),
    risks: pct((gold.risks ?? []).filter((x) => covers(x, texts)).length, (gold.risks ?? []).length),
    figures: pct(figHit.length, figs.length),
    passages: pct(claims.filter((c) => c.evidenceState === 'verified' || c.excerpt || c.excerptWithheld).length, n),
  };
}

function main() {
  const gold = JSON.parse(readFileSync(join(DIR, 'gold.json'), 'utf8')).documents;
  const { selection } = JSON.parse(readFileSync(join(DIR, 'selection.json'), 'utf8'));
  const session = JSON.parse(readFileSync(join(DIR, 'claims.pending.json'), 'utf8')).claims;
  const queue = JSON.parse(readFileSync(join(ROOT, 'data', 'thesis', 'claims.pending.json'), 'utf8')).claims;
  const model = queue.filter((c) => c.model && c.model !== 'editor-session');

  const rows = [];
  for (const d of selection) {
    const g = gold[d.id];
    if (!g) continue;
    const s = session.filter((c) => c.documentId === d.accession);
    const m = model.filter((c) => c.documentId === d.accession);
    rows.push({ id: d.id, extraction: 'session', ...scoreDocument(g, s) });
    if (m.length) rows.push({ id: d.id, extraction: m[0].model, ...scoreDocument(g, m) });
  }
  const cols = ['claims', 'company', 'stance', 'catalysts', 'risks', 'figures', 'passages'];
  const f = (v) => (v === null || v === undefined ? 'n.a.' : typeof v === 'number' && v <= 100 && cols.indexOf('claims') !== -1 ? `${v}` : `${v}`);
  const md = [
    '# Words × Actions pilot: extractions against the gold set',
    '',
    'Gold status: **draft** until a person confirms `data/thesis/wxa/gold.json`. Percentages; `n.a.` where the gold lists nothing to find.',
    'Thesis fidelity is judged in the review pack, not here.',
    '',
    `| Document | Extraction | ${cols.join(' | ')} |`,
    `|---|---|${cols.map(() => '---').join('|')}|`,
    ...rows.map((r) => `| ${r.id} | ${r.extraction} | ${cols.map((c) => f(r[c])).join(' | ')} |`),
    '',
  ].join('\n');
  writeFileSync(join(DIR, 'eval.md'), md);
  writeFileSync(join(DIR, 'eval.json'), `${JSON.stringify({ goldStatus: 'draft', rows }, null, 2)}\n`);
  console.log(md);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
