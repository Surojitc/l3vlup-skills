#!/usr/bin/env node
/**
 * Claims proposed in a working session, put through the same runner as a model's.
 *
 *   node scripts/thesis-session.mjs dump --out /tmp/wxa-chunks
 *   node scripts/thesis-session.mjs run --proposals data/thesis/wxa/proposals.json
 *
 * WHY THIS EXISTS
 * ---------------
 * The Words × Actions pilot needs claims from eleven documents the paid
 * extraction workflow (thesis-pilot.yml) does not list. Rather than widen that
 * workflow or spend on it, an editor's working session reads the documents and
 * writes proposals: the company as the document names it, a paraphrase, kind,
 * stance, tags, a catalyst, a risk and the exact passage. Those proposals are
 * then handled exactly as a model's are, by runDocument with a model that only
 * replays them:
 *
 *   - anything not proposable (a ticker, a CUSIP, a position, a date) is
 *     stripped and reported;
 *   - the passage is located in the document by the code, and a passage that
 *     is not there byte for byte drops the claim;
 *   - tags must come from the taxonomy; quotations are capped per excerpt and
 *     per document;
 *   - every claim leaves as `reviewStatus: pending`. Nothing here can publish.
 *
 * `dump` writes each document's chunks as text for the session to read, and
 * refuses any directory inside the repository: no document text is committed,
 * the same rule as the extraction workflow. `run` fetches the documents again,
 * checks each is the one the proposals were written against (sha256), and
 * writes data/thesis/wxa/claims.pending.json and review.md.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { CAP_BYTES, fetchDocument } from '../lib/letters-fetch.mjs';
import { extractSections } from '../lib/letters-html.mjs';
import { parsePdf } from '../lib/letters-pdf.mjs';
import { chunkDocument } from '../lib/thesis-chunk.mjs';
import { fakeModel } from '../lib/thesis-model.mjs';
import { runDocument } from '../lib/thesis-runner.mjs';
import { emptyCostLedger, MODEL_ALLOWLIST } from '../lib/thesis-cost.mjs';
import { emptyDecisionLog, renderReview, reviewCard } from '../lib/thesis-review.mjs';
import { buildFeed, serialiseFeed, validateFeed } from '../lib/thesis-publish.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'data', 'thesis', 'wxa');
const TAXONOMY = join(ROOT, 'data', 'letters.taxonomy.json');
const UA = process.env.SEC_USER_AGENT || 'L3VLUP Research (contact: suro@l3vlup.com)';
export const SESSION_MODEL = 'editor-session';
export const SESSION_PROMPT = 'wxa-session-v1';

/**
 * The session's own allowlist: one entry, at no cost, because a working
 * session calls no API. Shaped like the API's entries so the runner's budget
 * checks run exactly as they do for a model; the API allowlist is untouched.
 */
export const SESSION_ALLOWLIST = Object.freeze({
  [SESSION_MODEL]: { ...Object.values(MODEL_ALLOWLIST)[0], inputPerMTok: 0, outputPerMTok: 0, cacheReadPerMTok: 0, alias: null, role: 'extraction' },
});

const arg = (n) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : null; };

/** A directory is acceptable for document text only outside the repository. */
export function outsideRepo(dir, root = ROOT) {
  const rel = relative(resolve(root), resolve(dir));
  return rel.startsWith('..') || isAbsolute(rel);
}

async function readDocument(d) {
  const got = await fetchDocument({ url: d.documentUrl, expectedFormat: d.format, cap: CAP_BYTES, userAgent: UA });
  let text = '';
  if (d.format === 'pdf') {
    const scratch = join(tmpdir(), `wxa-${got.sha256}.pdf`);
    writeFileSync(scratch, got.body);
    try {
      const out = await parsePdf(scratch);
      text = (out.pages || []).map((p) => p.text).join('\n\n');
    } finally {
      rmSync(scratch, { force: true });
    }
  } else {
    text = extractSections(got.body.toString('utf8')).sections.map((s) => s.text).join('\n\n');
  }
  return { sha256: got.sha256, text };
}

async function main() {
  const mode = process.argv[2];
  const { selection } = JSON.parse(readFileSync(join(DIR, 'selection.json'), 'utf8'));

  if (mode === 'dump') {
    const out = arg('--out');
    if (!out || !outsideRepo(out)) {
      console.error('Refusing: --out must be a directory outside the repository; document text is never committed.');
      process.exit(2);
    }
    mkdirSync(out, { recursive: true });
    const index = [];
    for (const d of selection) {
      const doc = await readDocument(d);
      const { chunks } = chunkDocument(doc.text, { documentId: d.accession });
      for (const c of chunks) writeFileSync(join(out, `${d.id}.${c.chunkId.replace(/[^\w.-]/g, '_')}.txt`), c.text);
      index.push({ id: d.id, accession: d.accession, sha256: doc.sha256, characters: doc.text.length, chunks: chunks.map((c) => c.chunkId) });
      console.log(`${d.id.padEnd(34)} ${String(doc.text.length).padStart(7)} chars  ${chunks.length} chunk(s)`);
    }
    writeFileSync(join(out, 'index.json'), `${JSON.stringify(index, null, 2)}\n`);
    return;
  }

  if (mode === 'run') {
    const path = arg('--proposals');
    if (!path) { console.error('Refusing: --proposals is required.'); process.exit(2); }
    const proposals = JSON.parse(readFileSync(resolve(path), 'utf8'));
    const taxonomy = JSON.parse(readFileSync(TAXONOMY, 'utf8'));
    let ledger = emptyCostLedger({ budgetUsd: 0 });
    const decisionLog = emptyDecisionLog();
    const quoted = new Map();
    const results = [];
    for (const d of selection) {
      const p = proposals.documents?.[d.id];
      if (!p) { console.log(`${d.id}: no proposals, skipped`); continue; }
      const doc = await readDocument(d);
      if (p.sha256 && p.sha256 !== doc.sha256) {
        console.error(`${d.id}: the document changed since the proposals were written (sha256); skipped`);
        continue;
      }
      const model = fakeModel({ responses: Object.fromEntries(Object.entries(p.chunks).map(([k, v]) => [k, { proposals: v, usage: { inputTokens: 0, outputTokens: 0 } }])), id: SESSION_MODEL });
      const document = {
        documentId: d.accession, managerId: d.managerId, managerName: d.managerName, accession: d.accession,
        form: d.form, filingDate: d.filingDate, documentUrl: d.documentUrl, sha256: doc.sha256,
      };
      // A fresh ledger per document. The paid runner's ceilings on documents
      // and calls a run are about spend, and a session spends nothing; every
      // per-document and per-chunk limit still applies inside runDocument.
      ledger = emptyCostLedger({ budgetUsd: 0 });
      const run = await runDocument({
        model, modelId: SESSION_MODEL, document, manager: { managerId: d.managerId, legalName: d.managerName },
        sourceText: doc.text, taxonomy, aliases: [], ledger, decisionLog, quotedWordsByDocument: quoted,
        promptVersion: SESSION_PROMPT, allowlist: SESSION_ALLOWLIST,
      });
      results.push({ document, run });
      console.log(`${d.id.padEnd(34)} ${run.claims.length} claim(s), ${run.dropped.length} dropped, ${run.strippedFields.length} stripped`);
    }

    // The same sanitised shape the extraction workflow writes (thesis-pilot.mjs):
    // no source text, the public excerpt only, every claim awaiting a person.
    const references = new Map();
    for (const r of results) for (const c of r.run.claims) {
      references.set(c.claim.claimId, {
        sourceUrl: r.document.documentUrl,
        locator: c.reference.locator,
        excerpt: c.reference.publicExcerpt ?? null,
        excerptWithheld: c.reference.excerptWithheld ?? null,
        attribution: c.reference.publicExcerpt ? `${r.document.managerName}, ${r.document.filingDate}` : null,
      });
    }
    const feed = buildFeed({
      claims: results.flatMap((r) => r.run.claims.map((c) => ({ ...c.claim, accession: r.document.accession, form: r.document.form, managerName: r.document.managerName, candidateId: c.candidateId ?? null, rank: c.rank ?? null }))),
      coverage: results.map((r) => r.run.coverage).filter(Boolean),
      selectionRejects: results.flatMap((r) => r.run.selectionRejects || []),
      references,
      dropped: results.flatMap((r) => r.run.dropped),
      stripped: results.flatMap((r) => r.run.strippedFields),
      ledger, model: SESSION_MODEL, promptVersion: SESSION_PROMPT, runId: 'wxa-pilot',
    });
    const problems = validateFeed(feed);
    if (problems.length) {
      console.error(`Not written: the feed fails its own checks.\n- ${problems.join('\n- ')}`);
      process.exit(4);
    }
    writeFileSync(join(DIR, 'claims.pending.json'), serialiseFeed(feed));
    writeFileSync(join(DIR, 'review.md'), renderReview(results.flatMap((r) => r.run.claims.map((c) => reviewCard(c.claim, {
      reference: c.reference.publicExcerpt ? { ...c.reference, excerpt: c.reference.publicExcerpt } : null,
      issuer: null, manager: { legalName: r.document.managerName }, position: null,
    })))));
    console.log(`\n${feed.claims.length} claim(s) pending review · ${feed.refused.length} refused · ${feed.dropped.length} dropped`);

    // Into the one review queue, so the same decisions file and the same
    // reviewed feed carry these claims: there is no second pipeline. A document
    // that already has claims in the queue is left out, so nobody is asked to
    // review the same filing twice.
    if (process.argv.includes('--merge')) {
      const mainPath = join(ROOT, 'data', 'thesis', 'claims.pending.json');
      const main = JSON.parse(readFileSync(mainPath, 'utf8'));
      const queuedDocs = new Set((main.claims ?? []).map((c) => c.documentId));
      const known = new Set((main.claims ?? []).map((c) => c.claimId));
      const added = feed.claims.filter((c) => !queuedDocs.has(c.documentId) && !known.has(c.claimId));
      main.claims = [...(main.claims ?? []), ...added];
      writeFileSync(mainPath, `${JSON.stringify(main, null, 2)}\n`);
      console.log(`merged ${added.length} claim(s) into data/thesis/claims.pending.json; run npm run review:pack next`);
    }
    return;
  }

  console.error('Usage: thesis-session.mjs dump --out <dir outside the repo> | run --proposals <file>');
  process.exit(2);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
