/**
 * From pending claims and a person's decisions to the reviewed feed the site
 * renders. Pure functions; scripts/thesis-review-pack.mjs and
 * scripts/thesis-build-reviewed.mjs are the two doors.
 *
 * WHERE THIS SITS
 * The extraction run (scripts/thesis-pilot.mjs, .github/workflows/
 * thesis-pilot.yml) stops at `data/thesis/claims.pending.json`: every claim
 * `needs_review` or `issuer_unresolved`, and only a person can move one
 * further (lib/thesis-states.mjs HUMAN_ONLY). Until now the only way to do
 * that was to hand-edit the JSON. This is the missing step:
 *
 *   claims.pending.json ──► review pack (markdown) + decisions file (JSON)
 *                                  │ a person fills in accept / edit / reject
 *                                  ▼
 *                       thesis.reviewed.json  (what the site reads)
 *
 * WHAT THE DECISIONS FILE MAY DO, AND WHAT IT MAY NOT
 * A decision may accept a claim, accept it with a rewritten paraphrase
 * (`edit`), or reject it. It may name the company and ticker, because the
 * pilot leaves every issuer unresolved, and it may say how the view moved
 * (`transition`). It may not touch the source, the excerpt, the attribution,
 * the filing date or the tags: those came out of the document and stay as
 * the evidence check left them. A claim with no decision, or `null`, stays
 * out of the feed; the feed is only ever what a person said yes to.
 *
 * THE OUTPUT
 * The shape and the rules of the site's `ThesisFeed` (L3vlup lib/
 * thesis-feed.ts): `checkReviewedFeed` below is the same fail-closed list,
 * so a feed that passes here passes there. One failing claim fails the whole
 * build, exactly as one failing claim blanks the whole page on the site.
 */

export const DECISIONS = ['accept', 'edit', 'reject'];

export const TRANSITIONS = [
  'initiated',
  'reiterated',
  'strengthened',
  'weakened',
  'revised',
  'catalyst_update',
  'risk_update',
  'closed_explicitly',
  'no_new_evidence',
];

const FORBIDDEN = ['text', 'fullText', 'sourceText', 'extractedText', 'pageText', 'body', 'html', 'prompt', 'systemPrompt', 'rawResponse', 'completion', 'apiKey'];

const SUPPORT_LABEL = {
  statement: 'Quoted statement',
  paraphrase: 'Close paraphrase',
  classification: 'Classification',
  inference: 'Inference',
  filing: 'From the filing',
};

/** The empty decisions file for a pending feed: one row per claim, nothing decided. */
export function decisionsTemplate(pending) {
  return {
    reviewVersion: 1,
    runId: pending.runId ?? null,
    reviewedBy: null,
    reviewedOn: null,
    instructions:
      'For each claim set "decision" to "accept", "edit" (and write "editedParaphrase") or "reject". Name the company and ticker. Leave "transition" as "initiated" for a first observation. A claim left null stays out of the feed.',
    decisions: (pending.claims ?? []).map((c) => ({
      claimId: c.claimId,
      decision: null,
      editedParaphrase: null,
      issuerName: null,
      ticker: null,
      transition: 'initiated',
    })),
  };
}

/** The review pack: one card per claim, in the order a person reads them. */
export function reviewPack(pending, taxonomy) {
  const label = new Map((taxonomy?.tags ?? []).map((t) => [t.code, t.label]));
  const lines = [
    `# Thesis review pack: run ${pending.runId ?? 'unknown'}`,
    '',
    `${(pending.claims ?? []).length} claims awaiting a decision. Model ${pending.model ?? 'unknown'}, prompt ${pending.promptVersion ?? 'unknown'}.`,
    'Decide each in `data/thesis/review.decisions.json` (same order), then run `npm run build:thesis-reviewed`.',
    '',
  ];
  (pending.claims ?? []).forEach((c, i) => {
    lines.push(`## ${i + 1}. ${c.managerName}: ${c.form} filed ${c.filingDate}`);
    lines.push('');
    lines.push(`| | |`);
    lines.push(`|---|---|`);
    lines.push(`| **Source** | [${c.accession}](${c.sourceUrl}) (${c.locator ?? 'no locator'}) |`);
    lines.push(`| **What the manager actually said** | ${c.excerpt ? `"${c.excerpt}"` : `_No quotation: ${c.excerptWithheld ?? 'none recorded'}. Check the source._`} |`);
    lines.push(`| **Proposed L3VLUP claim** | ${c.paraphrase} |`);
    lines.push(`| **Stance** | ${c.stance} |`);
    lines.push(`| **Tags** | ${(c.tags ?? []).map((t) => label.get(t) ?? t).join(', ') || 'none'} |`);
    lines.push(`| **Company** | ${c.issuerName ?? '_not resolved: name it in the decisions file_'} |`);
    lines.push(`| **Support type** | ${SUPPORT_LABEL[c.kind] ?? c.kind} (evidence ${c.evidenceState}) |`);
    lines.push(`| **Decision** | ACCEPT / EDIT / REJECT: \`decisions[${i}]\`, claim \`${c.claimId}\` |`);
    lines.push('');
  });
  return lines.join('\n');
}

/**
 * Apply decisions to pending claims. Returns { feed, problems }. A non-empty
 * problems list means no feed may be written.
 */
export function buildReviewedFeed(pending, decisionsFile, taxonomy) {
  const problems = [];
  if (!decisionsFile?.reviewedBy) problems.push('reviewedBy is empty: name the person who reviewed these claims');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(decisionsFile?.reviewedOn ?? '')) problems.push('reviewedOn must be YYYY-MM-DD');
  const byId = new Map((pending.claims ?? []).map((c) => [c.claimId, c]));
  const claims = [];
  for (const d of decisionsFile?.decisions ?? []) {
    const c = byId.get(d.claimId);
    if (!c) {
      problems.push(`${d.claimId}: not in the pending feed`);
      continue;
    }
    if (d.decision === null || d.decision === undefined || d.decision === 'reject') continue;
    if (!DECISIONS.includes(d.decision)) {
      problems.push(`${d.claimId}: decision ${JSON.stringify(d.decision)} is not accept, edit or reject`);
      continue;
    }
    if (d.decision === 'edit' && !(typeof d.editedParaphrase === 'string' && d.editedParaphrase.trim())) {
      problems.push(`${d.claimId}: an edit needs editedParaphrase`);
      continue;
    }
    if (!TRANSITIONS.includes(d.transition)) problems.push(`${d.claimId}: transition ${JSON.stringify(d.transition)} is not one of ${TRANSITIONS.join(', ')}`);
    const issuerName = typeof d.issuerName === 'string' && d.issuerName.trim() ? d.issuerName.trim() : null;
    const ticker = typeof d.ticker === 'string' && /^[A-Z][A-Z0-9.\-]{0,9}$/.test(d.ticker.trim()) ? d.ticker.trim() : null;
    if (d.ticker && !ticker) problems.push(`${d.claimId}: ticker ${JSON.stringify(d.ticker)} is not a ticker`);
    const state = d.decision === 'edit' ? 'edited' : 'accepted';
    claims.push({
      claimId: c.claimId,
      managerId: c.managerId,
      managerName: c.managerName,
      documentId: c.documentId,
      accession: c.accession,
      filingDate: c.filingDate,
      form: c.form,
      sourceUrl: c.sourceUrl,
      locator: c.locator ?? null,
      kind: c.kind,
      stance: c.stance,
      conviction: c.conviction ?? null,
      paraphrase: d.decision === 'edit' ? d.editedParaphrase.trim() : c.paraphrase,
      excerpt: c.excerpt ?? null,
      attribution: c.attribution ?? null,
      tags: c.tags ?? [],
      horizon: c.horizon ?? null,
      catalysts: c.catalysts ?? [],
      risks: c.risks ?? [],
      issuerId: issuerName ? issuerName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') : null,
      issuerName,
      issuerResolution: issuerName ? 'resolved' : 'unresolved',
      ticker,
      publicationState: state,
      reviewStatus: state,
      reviewedOn: decisionsFile.reviewedOn,
      transition: d.transition,
    });
  }
  const used = new Set(claims.flatMap((c) => c.tags));
  const feed = {
    feedVersion: 1,
    generatedFrom: `thesis run ${pending.runId ?? 'unknown'}, reviewed ${decisionsFile?.reviewedOn ?? '?'}`,
    reviewedBy: decisionsFile?.reviewedBy ?? '',
    claims,
    taxonomy: (taxonomy?.tags ?? [])
      .filter((t) => used.has(t.code))
      .map((t) => ({ code: t.code, label: t.label, axis: t.axis, definition: t.definition })),
  };
  problems.push(...checkReviewedFeed(feed));
  return { feed, problems };
}

/**
 * The site's fail-closed checks (L3vlup lib/thesis-feed.ts `checkFeed`), so a
 * feed that passes here renders there. Every problem is reported, not only
 * the first, because a person is about to fix them.
 */
export function checkReviewedFeed(feed) {
  const out = [];
  if (feed.feedVersion !== 1) out.push('feedVersion must be 1');
  if (feed.fixture) out.push('a reviewed feed is never a fixture');
  if (!Array.isArray(feed.claims) || feed.claims.length === 0) out.push('no accepted claims: nothing to publish');
  const wordsByDoc = new Map();
  for (const c of feed.claims ?? []) {
    for (const f of FORBIDDEN) if (f in c) out.push(`${c.claimId}: forbidden field ${f}`);
    if (!['accepted', 'edited'].includes(c.publicationState) || !['accepted', 'edited'].includes(c.reviewStatus)) out.push(`${c.claimId}: not accepted or edited`);
    if (!c.reviewedOn) out.push(`${c.claimId}: reviewedOn missing`);
    if (!/^https:\/\/www\.sec\.gov\//.test(c.sourceUrl ?? '')) out.push(`${c.claimId}: source is not on www.sec.gov`);
    if (!c.paraphrase) out.push(`${c.claimId}: paraphrase missing`);
    if (c.excerpt) {
      const words = c.excerpt.trim().split(/\s+/).length;
      if (c.kind === 'inference' || c.kind === 'filing') out.push(`${c.claimId}: an ${c.kind} may not carry a quotation`);
      if (words > 25 || c.excerpt.length > 200) out.push(`${c.claimId}: excerpt over 25 words or 200 characters`);
      if (!c.attribution) out.push(`${c.claimId}: excerpt without attribution`);
      wordsByDoc.set(c.documentId, (wordsByDoc.get(c.documentId) ?? 0) + words);
    }
  }
  for (const [doc, words] of wordsByDoc) if (words > 50) out.push(`${doc}: ${words} quoted words, over the 50-word document cap`);
  if (!Array.isArray(feed.taxonomy)) out.push('taxonomy missing');
  return out;
}
