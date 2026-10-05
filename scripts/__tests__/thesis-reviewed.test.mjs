/**
 * The step from pending claims to the reviewed feed: only a person's yes
 * publishes, nothing from the document can be rewritten on the way, and the
 * output passes the same fail-closed rules the site applies.
 *
 *   node --test scripts/__tests__/thesis-reviewed.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReviewedFeed, checkReviewedFeed, decisionsTemplate, reviewPack } from '../../lib/thesis-reviewed.mjs';

const claim = (id, extra = {}) => ({
  claimId: id, managerId: 'starboard-value', managerName: 'Starboard Value LP', documentId: 'doc1', accession: 'doc1',
  filingDate: '2026-03-11', form: 'DFAN14A', sourceUrl: 'https://www.sec.gov/Archives/x.pdf', locator: 'chunk 1',
  kind: 'statement', stance: 'long', paraphrase: `paraphrase ${id}`, excerpt: 'five words in this excerpt',
  attribution: 'Starboard Value LP, 2026-03-11', tags: ['case.turnaround'], horizon: null, catalysts: [], risks: [],
  issuerId: null, issuerResolution: 'unresolved', publicationState: 'issuer_unresolved', evidenceState: 'verified',
  reviewStatus: 'pending', ...extra,
});
const pending = { runId: '1', model: 'm', promptVersion: 'p', claims: [claim('a'), claim('b'), claim('c')] };
const taxonomy = { tags: [{ code: 'case.turnaround', label: 'Turnaround', axis: 'investment_case', definition: 'd' }, { code: 'x.unused', label: 'U', axis: 'a', definition: 'd' }] };
const signed = (decisions) => ({ reviewedBy: 'Suro', reviewedOn: '2026-10-06', decisions });

test('the template decides nothing', () => {
  const t = decisionsTemplate(pending);
  assert.equal(t.decisions.length, 3);
  assert.ok(t.decisions.every((d) => d.decision === null));
  const { problems } = buildReviewedFeed(pending, { ...t, reviewedBy: 'Suro', reviewedOn: '2026-10-06' }, taxonomy);
  assert.ok(problems.includes('no accepted claims: nothing to publish'));
});

test('only accepted and edited claims are published, with the reviewer and the company named', () => {
  const { feed, problems } = buildReviewedFeed(pending, signed([
    { claimId: 'a', decision: 'accept', issuerName: 'CarMax', ticker: 'KMX', transition: 'initiated' },
    { claimId: 'b', decision: 'edit', editedParaphrase: 'rewritten', transition: 'reiterated' },
    { claimId: 'c', decision: 'reject', transition: 'initiated' },
  ]), taxonomy);
  assert.deepEqual(problems, []);
  assert.deepEqual(feed.claims.map((c) => [c.claimId, c.publicationState, c.paraphrase]), [['a', 'accepted', 'paraphrase a'], ['b', 'edited', 'rewritten']]);
  assert.equal(feed.claims[0].issuerResolution, 'resolved');
  assert.equal(feed.claims[0].ticker, 'KMX');
  assert.equal(feed.claims[1].issuerResolution, 'unresolved');
  assert.equal(feed.reviewedBy, 'Suro');
  assert.deepEqual(feed.taxonomy.map((t) => t.code), ['case.turnaround']);
});

test('a decision cannot rewrite the evidence', () => {
  const { feed } = buildReviewedFeed(pending, signed([
    { claimId: 'a', decision: 'accept', transition: 'initiated', excerpt: 'invented quote', sourceUrl: 'https://evil.example', filingDate: '1999-01-01', tags: ['x'] },
  ]), taxonomy);
  assert.equal(feed.claims[0].excerpt, 'five words in this excerpt');
  assert.equal(feed.claims[0].sourceUrl, 'https://www.sec.gov/Archives/x.pdf');
  assert.equal(feed.claims[0].filingDate, '2026-03-11');
  assert.deepEqual(feed.claims[0].tags, ['case.turnaround']);
});

test('nothing is published without a named reviewer and a date', () => {
  const { problems } = buildReviewedFeed(pending, { decisions: [{ claimId: 'a', decision: 'accept', transition: 'initiated' }] }, taxonomy);
  assert.ok(problems.some((p) => /reviewedBy/.test(p)) && problems.some((p) => /reviewedOn/.test(p)));
});

test('the site rules: quotation caps, sec.gov only, forbidden fields', () => {
  const long = claim('q', { excerpt: Array(30).fill('w').join(' ') });
  const { problems } = buildReviewedFeed({ ...pending, claims: [long] }, signed([{ claimId: 'q', decision: 'accept', transition: 'initiated' }]), taxonomy);
  assert.ok(problems.some((p) => /over 25 words/.test(p)));
  const bad = { feedVersion: 1, claims: [{ ...claim('z'), publicationState: 'accepted', reviewStatus: 'accepted', reviewedOn: 'x', sourceUrl: 'https://example.com', body: 'x' }], taxonomy: [] };
  const out = checkReviewedFeed(bad);
  assert.ok(out.some((p) => /www\.sec\.gov/.test(p)) && out.some((p) => /forbidden field body/.test(p)));
  const words = { feedVersion: 1, claims: [1, 2, 3].map((i) => ({ ...claim(`w${i}`), excerpt: Array(20).fill('w').join(' '), publicationState: 'accepted', reviewStatus: 'accepted', reviewedOn: 'x' })), taxonomy: [] };
  assert.ok(checkReviewedFeed(words).some((p) => /50-word document cap/.test(p)));
});

test('the review pack shows each field a reviewer needs', () => {
  const md = reviewPack(pending, taxonomy);
  for (const h of ['**Source**', '**What the manager actually said**', '**Proposed L3VLUP claim**', '**Tags**', '**Company**', '**Support type**', '**Decision**']) assert.ok(md.includes(h), h);
  assert.ok(md.includes('Turnaround'));
});
