// The pilot client, exercised against a stubbed transport.
//
// No test here constructs a real client, reads a credential or opens a
// socket. `anthropicModel` takes the client, so every failure a live run
// could hit — a malformed answer, missing usage, a 500, a timeout, a refusal,
// a truncated tool input — is reproducible here for nothing.
//
//   node scripts/__tests__/thesis-pilot.test.mjs

import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  actualUsd, anthropicModel, CANDIDATE_TOOL, classifyError, consolidationPrompt, extractionPrompt,
  MAX_RETRIES, ModelCallError, PROMPT_VERSION, preflightModel, readProposals, readUsage,
  REQUEST_TIMEOUT_MS, SELECTION_TOOL,
} from '../../lib/thesis-anthropic.mjs';
import { parseArgs, resolveDocuments } from '../thesis-pilot.mjs';
import { checkBudget, emptyCostLedger, LIMITS, MAX_CANDIDATES_PER_CHUNK, MAX_CLAIMS_PER_DOCUMENT, MODEL_ALIASES, MODEL_ALLOWLIST, PILOT_BUDGET_USD, PILOT_MODEL, recordCall, resolveModelId } from '../../lib/thesis-cost.mjs';
import { runDocument } from '../../lib/thesis-runner.mjs';
import { emptyDecisionLog } from '../../lib/thesis-review.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TAXONOMY = JSON.parse(readFileSync(join(REPO, 'data', 'letters.taxonomy.json'), 'utf8'));
const SOURCE = readFileSync(join(REPO, 'data', 'fixtures', 'thesis', 'source-text.txt'), 'utf8');
const SELECTION = JSON.parse(readFileSync(join(REPO, 'data', 'letters.selection.json'), 'utf8')).selection;

let passed = 0;
async function test(name, fn) { await fn(); passed += 1; console.log(`  ok  ${name}`); }

/** The SDK's error classes, reproduced structurally so no import is needed. */
class APIError extends Error { constructor(m, status, type) { super(m); this.status = status; this.type = type; } }
class APIConnectionError extends APIError {}
class AuthenticationError extends APIError {}
class NotFoundError extends APIError {}
class RateLimitError extends APIError {}
const SDK = { APIError, APIConnectionError, AuthenticationError, NotFoundError, RateLimitError };

/** A client whose every response the test dictates. */
// Two stages means two tools, so a stub that answered every request with the
// extraction shape would silently return no selections and no claims. Unless a
// test supplies its own consolidation answer, this ranks whatever it is given.
function stubClient(create, { models, select } = {}) {
  const c = {
    messages: {
      async create(req) {
        if (req.tools?.[0]?.name === SELECTION_TOOL.name) {
          if (select) return select(req);
          const body = req.messages[0].content;
          const offered = JSON.parse(body.slice(body.indexOf('[')));
          return {
            stop_reason: 'tool_use', usage: { input_tokens: 800, output_tokens: 200 },
            content: [{ type: 'tool_use', name: SELECTION_TOOL.name, input: { selections: offered.map((o, i) => ({ candidateId: o.candidateId, rank: i + 1 })) } }],
          };
        }
        return create(req);
      },
    },
    models: { retrieve: models || (async (id) => ({ id, display_name: 'Stub', max_input_tokens: 200_000 })) },
  };
  c.constructor = SDK;
  return c;
}

const span = (t) => { const i = SOURCE.indexOf(t); return [i, i + t.length]; };
const [GOOD_START, GOOD_END] = span('Gross margin should move from 31% to 38% as the second line fills');

const goodProposal = {
  issuerMention: 'Northwind Components', paraphrase: 'Margins should improve as the second line fills.',
  kind: 'statement', stance: 'long', tags: ['driver.margin_inflection'],
  evidenceExcerpt: SOURCE.slice(GOOD_START, GOOD_END), evidenceStartOffset: GOOD_START, evidenceEndOffset: GOOD_END,
};
const ok = (proposals, usage = { input_tokens: 1200, output_tokens: 300 }) => ({
  stop_reason: 'tool_use', usage,
  content: [{ type: 'tool_use', name: CANDIDATE_TOOL.name, input: { candidates: proposals } }],
});

// ── The client never reaches for a key or a socket ─────────────────────────

await test('the client module reads no credential, builds no client at import, and never retries', () => {
  const source = readFileSync(join(REPO, 'lib', 'thesis-anthropic.mjs'), 'utf8');
  // Comments and message text are stripped first, so this asserts about code
  // rather than about prose — the module explains in a comment that it never
  // touches process.env, and a crude grep would flag the explanation itself.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/process\.env/.test(code), 'the client reads an environment variable');
  assert.ok(!/apiKey\s*:/.test(code), 'the client passes an apiKey');
  // The client names no credential variable at all now that CI federates:
  // telling somebody to set ANTHROPIC_API_KEY would be advice that breaks the
  // run, because a set key outranks federation in the SDK's credential order.
  const mentions = [...code.matchAll(/ANTHROPIC_API_KEY/g)];
  assert.equal(mentions.length, 0, `ANTHROPIC_API_KEY appears ${mentions.length} times in code`);
  assert.match(code, /In CI it federates/);
  // The SDK import is inside realClient, so importing this module cannot
  // require a key — which is exactly what this test file just did.
  assert.match(source, /export async function realClient/);
  assert.match(source, /await import\('@anthropic-ai\/sdk'\)/);
  assert.equal(MAX_RETRIES, 0, 'a retry would double-charge a call the budget already counted');
  assert.equal(REQUEST_TIMEOUT_MS, 120_000);
});

await test('the prompt forbids what the boundary forbids, and carries the closed taxonomy', () => {
  const p = extractionPrompt(TAXONOMY);
  for (const forbidden of ['ticker', 'CUSIP', 'share class', 'CIK', 'holding size']) {
    assert.ok(p.includes(forbidden), `the prompt does not tell the model to leave ${forbidden} alone`);
  }
  assert.match(p, /verbatim excerpt/);
  assert.match(p, /Do not invent a tag/);
  assert.match(p, /An empty list is a good answer/);
  for (const t of TAXONOMY.tags.slice(0, 3)) assert.ok(p.includes(t.code), `${t.code} is missing from the prompt`);
  assert.equal(CANDIDATE_TOOL.strict, true, 'the tool is not strict, so the shape is not enforced server-side');
  assert.equal(CANDIDATE_TOOL.input_schema.additionalProperties, false);
});

// ── Malformed model output ─────────────────────────────────────────────────

await test('malformed model output is rejected in every shape it can take', () => {
  assert.deepEqual(readProposals(ok([goodProposal])).length, 1);
  assert.deepEqual(readProposals({ stop_reason: 'end_turn', content: [] }), [], 'no tool call means no claims, not an error');

  const bad = [
    [null, /not an object/],
    [{ stop_reason: 'tool_use' }, /no content array/],
    [{ stop_reason: 'tool_use', content: 'nope' }, /no content array/],
    [{ stop_reason: 'tool_use', content: [{ type: 'tool_use', name: CANDIDATE_TOOL.name, input: null }] }, /tool input was not an object/],
    [{ stop_reason: 'tool_use', content: [{ type: 'tool_use', name: CANDIDATE_TOOL.name, input: { candidates: 'x' } }] }, /no candidates array/],
    [{ stop_reason: 'tool_use', content: [{ type: 'tool_use', name: CANDIDATE_TOOL.name, input: { candidates: [42] } }] }, /candidate was not an object/],
    [{ stop_reason: 'tool_use', content: [{ type: 'tool_use', name: CANDIDATE_TOOL.name, input: { candidates: [] } }, { type: 'tool_use', name: CANDIDATE_TOOL.name, input: { candidates: [] } }] }, /2 tool calls where one was expected/],
    [{ stop_reason: 'max_tokens', content: [] }, /hit max_tokens/],
    [{ stop_reason: 'refusal', stop_details: { category: 'cyber' }, content: [] }, /the model declined: cyber/],
  ];
  for (const [response, re] of bad) {
    assert.throws(() => readProposals(response), re, `this response should have been refused: ${JSON.stringify(response).slice(0, 80)}`);
  }
});

await test('a truncated tool input is refused rather than parsed', () => {
  // max_tokens is checked before the content, because a truncated strict tool
  // input can still look structurally valid.
  assert.throws(() => readProposals({ stop_reason: 'max_tokens', usage: {}, content: [{ type: 'tool_use', name: CANDIDATE_TOOL.name, input: { candidates: [goodProposal] } }] }), /hit max_tokens/);
});

// ── Missing usage ──────────────────────────────────────────────────────────

await test('a response with no usable usage is a failure, never a free call', () => {
  assert.deepEqual(readUsage({ usage: { input_tokens: 10, output_tokens: 2 } }), { inputTokens: 10, outputTokens: 2, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 });
  for (const u of [undefined, null, {}, { input_tokens: 10 }, { input_tokens: null, output_tokens: 2 }, { input_tokens: 'x', output_tokens: 2 }]) {
    assert.throws(() => readUsage({ usage: u }), /missing_usage|cannot be costed/, `usage ${JSON.stringify(u)} should have been refused`);
  }
  assert.equal(readUsage({ usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 900 } }).cacheReadInputTokens, 900);
});

await test('usage is read before the proposals, so a bad answer cannot mask an uncosted call', async () => {
  const model = anthropicModel({ modelId: PILOT_MODEL, taxonomy: TAXONOMY, client: stubClient(async () => ({ stop_reason: 'tool_use', content: 'malformed' })) });
  await assert.rejects(() => model.propose({ chunkId: 'c0', text: SOURCE }), /missing_usage/, 'the malformed content was reported before the missing usage');
});

// ── HTTP failures and timeouts ─────────────────────────────────────────────

await test('every HTTP failure class becomes a named, non-retried reason', async () => {
  const cases = [
    [new AuthenticationError('401', 401, 'authentication_error'), 'no_credential', false],
    [new NotFoundError('404', 404, 'not_found_error'), 'unknown_model', false],
    [new RateLimitError('429', 429, 'rate_limit_error'), 'rate_limited', true],
    [new APIError('500 overloaded', 500, 'overloaded_error'), 'api_error', true],
    [new APIError('400 bad', 400, 'invalid_request_error'), 'api_error', false],
    [new APIConnectionError('socket hang up', undefined, undefined), 'connection', true],
    [new APIConnectionError('Request timed out', undefined, undefined), 'timeout', true],
    [new Error('aborted after 120000ms'), 'timeout', true],
    [new Error('something else'), 'unknown', false],
  ];
  for (const [err, reason, retryable] of cases) {
    const c = classifyError(err, SDK);
    assert.equal(c.reason, reason, `${err.message} classified as ${c.reason}`);
    assert.equal(c.retryable, retryable, `${reason} retryable flag`);
  }
  assert.match(classifyError(new AuthenticationError('401', 401), SDK).message, /reads no key of its own/);

  // And the client records the failure against its chunk before rethrowing.
  const model = anthropicModel({ modelId: PILOT_MODEL, taxonomy: TAXONOMY, client: stubClient(async () => { throw new RateLimitError('429', 429); }) });
  await assert.rejects(() => model.propose({ chunkId: 'c7', text: 'x' }), /rate_limited/);
  assert.deepEqual(model.calls.map((c) => [c.chunkId, c.ok, c.reason]), [['c7', false, 'rate_limited']]);
});

await test('a call that never returns is abandoned, and the timeout is configured on the client', async () => {
  let aborted = false;
  const hang = async () => { aborted = true; throw new APIConnectionError('Request timed out.', undefined, undefined); };
  const model = anthropicModel({ modelId: PILOT_MODEL, taxonomy: TAXONOMY, client: stubClient(hang) });
  await assert.rejects(() => model.propose({ chunkId: 'c1', text: 'x' }), /timeout/);
  assert.ok(aborted);
  const pilot = readFileSync(join(REPO, 'lib', 'thesis-anthropic.mjs'), 'utf8');
  assert.match(pilot, /new Anthropic\(\{ timeout: timeoutMs, maxRetries \}\)/, 'the timeout is not passed to the client');
});

// ── Unexpected fields ──────────────────────────────────────────────────────

await test('fields the model may not decide are stripped even when it insists on them', async () => {
  const meddling = {
    ...goodProposal, ticker: 'NWC', cusip: '037833100', issuerCik: '0001111111',
    shares: 900_000, shareClass: 'A', evidenceVerified: true, publicationState: 'published', invented: 'x',
  };
  const model = anthropicModel({ modelId: PILOT_MODEL, taxonomy: TAXONOMY, client: stubClient(async () => ok([meddling])) });
  const out = await runDocument({
    model, modelId: PILOT_MODEL, document: { documentId: 'd1', documentUrl: 'https://www.sec.gov/x', filingDate: '2026-08-14', sha256: 'a'.repeat(64) },
    manager: { managerId: 'm' }, sourceText: SOURCE, taxonomy: TAXONOMY,
    aliases: [{ alias: 'Northwind Components', issuerId: 'i-nwc', reviewState: 'confirmed' }],
    ledger: emptyCostLedger({ budgetUsd: 3 }), decisionLog: emptyDecisionLog(),
  });
  const stripped = out.strippedFields.map((s) => s.field).sort();
  for (const f of ['cusip', 'evidenceVerified', 'invented', 'issuerCik', 'publicationState', 'shareClass', 'shares', 'ticker']) {
    assert.ok(stripped.includes(f), `${f} survived`);
  }
  assert.equal(out.claims.length, 1);
  for (const f of ['ticker', 'cusip', 'shares', 'shareClass', 'issuerCik']) assert.equal(out.claims[0].claim[f], undefined);
  assert.equal(out.claims[0].claim.publicationState, 'needs_review', 'the model set the publication state');
});

// ── Evidence the model cannot place, because it is no longer asked to ──────

await test('an offset the model volunteers is stripped and never used', async () => {
  // The model is not asked for a position any more, so one it sends anyway is
  // not a hint to fall back on: it is stripped like any other field outside
  // the proposable set, and the strip is reported.
  const withOffsets = { ...goodProposal, evidenceStartOffset: 99_999, evidenceEndOffset: 1 };
  const model = anthropicModel({ modelId: PILOT_MODEL, taxonomy: TAXONOMY, client: stubClient(async () => ok([withOffsets])) });
  const out = await runDocument({
    model, modelId: PILOT_MODEL, document: { documentId: 'd1', documentUrl: 'https://www.sec.gov/x', filingDate: '2026-08-14', sha256: 'a'.repeat(64) },
    manager: { managerId: 'm' }, sourceText: SOURCE, taxonomy: TAXONOMY,
    aliases: [{ alias: 'Northwind Components', issuerId: 'i-nwc', reviewState: 'confirmed' }],
    ledger: emptyCostLedger({ budgetUsd: 3 }), decisionLog: emptyDecisionLog(),
  });
  // Nonsense offsets no longer cost a true quotation its claim.
  assert.equal(out.claims.length, 1, 'a volunteered offset still decided the outcome');
  const names = out.strippedFields.map((f) => f.field ?? f.name ?? f);
  for (const f of ['evidenceStartOffset', 'evidenceEndOffset']) {
    assert.ok(JSON.stringify(names).includes(f), `${f} was not reported as stripped`);
  }
  // And the offsets on the claim are the ones found in the text.
  const ref = out.claims[0].reference;
  assert.equal(SOURCE.slice(ref.startOffset, ref.endOffset), goodProposal.evidenceExcerpt);
});

await test('an excerpt that is absent or ambiguous is dropped, with no second call', async () => {
  const absent = { ...goodProposal, evidenceExcerpt: 'Earnings will double by Thursday' };
  const model = anthropicModel({ modelId: PILOT_MODEL, taxonomy: TAXONOMY, client: stubClient(async () => ok([absent, goodProposal])) });
  const out = await runDocument({
    model, modelId: PILOT_MODEL, document: { documentId: 'd1', documentUrl: 'https://www.sec.gov/x', filingDate: '2026-08-14', sha256: 'a'.repeat(64) },
    manager: { managerId: 'm' }, sourceText: SOURCE, taxonomy: TAXONOMY,
    aliases: [{ alias: 'Northwind Components', issuerId: 'i-nwc', reviewState: 'confirmed' }],
    ledger: emptyCostLedger({ budgetUsd: 3 }), decisionLog: emptyDecisionLog(),
  });
  assert.equal(out.claims.length, 1, 'the invented quotation survived');
  assert.equal(out.dropped.length, 1);
  assert.match(out.dropped[0].reason, /does not occur/);
  // One call per chunk, still. Nothing is re-asked.
  assert.equal(out.ledger.calls.filter((c) => c.stage === 'extraction').length, 1);
});

// ── Budget ─────────────────────────────────────────────────────────────────

await test('an exhausted budget stops the run before the next call, not after it', async () => {
  let calls = 0;
  const model = anthropicModel({ modelId: PILOT_MODEL, taxonomy: TAXONOMY, client: stubClient(async () => { calls += 1; return ok([goodProposal]); }) });
  const spent = { ...emptyCostLedger({ budgetUsd: 3 }), estimatedUsd: 2.9999 };
  const out = await runDocument({
    model, modelId: PILOT_MODEL, document: { documentId: 'd1', documentUrl: 'https://www.sec.gov/x', filingDate: '2026-08-14', sha256: 'a'.repeat(64) },
    manager: { managerId: 'm' }, sourceText: SOURCE, taxonomy: TAXONOMY, aliases: [],
    ledger: spent, decisionLog: emptyDecisionLog(),
  });
  assert.equal(calls, 0, 'a call was made after the budget was spent');
  assert.equal(out.ledger.stopped, true);
  assert.match(out.notes.join(' '), /stopped before/);
});

await test('the $3 pilot default and the $15 absolute ceiling both hold', () => {
  assert.equal(PILOT_BUDGET_USD, 3);
  assert.equal(LIMITS.hardStopUsd, 15);
  assert.equal(emptyCostLedger().budgetUsd, 3, 'the default ledger is not the pilot budget');
  assert.equal(emptyCostLedger({ budgetUsd: 10_000 }).budgetUsd, 15, 'a run raised its own budget past the ceiling');
  assert.equal(parseArgs(['--documents', 'x', '--budget', '16']).problems.length, 1);
  assert.match(parseArgs(['--documents', 'x', '--budget', '16']).problems[0], /over the \$15\.00 milestone ceiling/);

  const wide = { ...emptyCostLedger({ budgetUsd: 15 }), estimatedUsd: 14.999 };
  assert.match(checkBudget(wide, { model: 'claude-sonnet-5', inputTokens: 40_000, outputTokens: LIMITS.maxOutputTokensPerCall, documentId: 'd' }).reason, /milestone ceiling/);
  const after = recordCall(wide, { model: 'claude-sonnet-5', inputTokens: 40_000, outputTokens: LIMITS.maxOutputTokensPerCall, documentId: 'd' });
  assert.equal(after.stopped, true);
  assert.equal(checkBudget(after, { model: PILOT_MODEL, inputTokens: 1, outputTokens: 1, documentId: 'd' }).allowed, false, 'the run continued after the stop');
});

await test('token usage and the real dollar cost are recorded per call', async () => {
  const model = anthropicModel({ modelId: PILOT_MODEL, taxonomy: TAXONOMY, client: stubClient(async () => ok([goodProposal], { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_input_tokens: 512 })) });
  const answer = await model.propose({ chunkId: 'c0', text: SOURCE });
  const price = MODEL_ALLOWLIST[PILOT_MODEL];
  assert.equal(answer.usage.inputTokens, 1_000_000);
  assert.equal(answer.usage.outputTokens, 1_000_000);
  assert.equal(answer.usage.cacheReadInputTokens, 512);
  // A million in, a million out, plus 512 cache-read tokens at a tenth rate.
  const expected = Number((price.inputPerMTok + price.outputPerMTok + (512 / 1e6) * price.cacheReadPerMTok).toFixed(6));
  assert.equal(answer.usage.actualUsd, expected);
  const [call] = model.calls;
  assert.equal(call.ok, true);
  assert.equal(call.actualUsd, expected);
  assert.ok(expected > price.inputPerMTok + price.outputPerMTok, 'the cache read was not charged at all');
  assert.ok(Number.isFinite(call.ms));
  assert.equal(actualUsd('not-on-the-allowlist', { inputTokens: 1, outputTokens: 1 }), null);
});

// ── Interrupted and resumed runs ───────────────────────────────────────────

await test('a run interrupted mid-document resumes without paying for the same chunk twice', async () => {
  const seen = [];
  const client = stubClient(async (req) => {
    seen.push(req.messages[0].content.length);
    return ok([goodProposal]);
  });
  const model = anthropicModel({ modelId: PILOT_MODEL, taxonomy: TAXONOMY, client });
  const document = { documentId: 'd1', documentUrl: 'https://www.sec.gov/x', filingDate: '2026-08-14', sha256: 'a'.repeat(64) };
  const common = { model, modelId: PILOT_MODEL, document, manager: { managerId: 'm' }, sourceText: SOURCE, taxonomy: TAXONOMY, aliases: [] };

  const first = await runDocument({ ...common, ledger: emptyCostLedger({ budgetUsd: 3 }), decisionLog: emptyDecisionLog() });
  const extractionsBefore = first.ledger.calls.filter((c) => c.stage === 'extraction').length;
  assert.ok(extractionsBefore > 0);

  const resumed = await runDocument({ ...common, ledger: first.ledger, decisionLog: emptyDecisionLog() });
  const extractionsAfter = resumed.ledger.calls.filter((c) => c.stage === 'extraction').length;
  assert.equal(extractionsAfter, extractionsBefore, 'the resumed run charged for a chunk it had already paid for');
  assert.match(resumed.notes.join(' '), /already charged for; resuming past it/);
  assert.equal(seen.length, extractionsBefore, 'the model was asked again about a chunk already in the ledger');

  // And it does not pretend to have produced a document. A resumed run skips
  // chunks it already paid for, so their candidates are missing and there is
  // nothing honest to consolidate: the document reports incomplete coverage
  // and no claims rather than a shorter answer that reads like a whole one.
  assert.equal(resumed.coverage.complete, false, 'a resumed document claimed complete coverage');
  assert.equal(resumed.claims.length, 0);
  assert.match(resumed.coverage.reason, /extracted in an earlier run/);
  assert.equal(resumed.ledger.calls.filter((c) => c.stage === 'consolidation').length, 1, 'consolidation was paid for twice');
});

// ── Preflight ──────────────────────────────────────────────────────────────

await test('the model identifier is confirmed by the API before any billable token', async () => {
  const good = await preflightModel(PILOT_MODEL, { client: stubClient(async () => ok([])) });
  assert.equal(good.ok, true);
  assert.equal(good.id, PILOT_MODEL);

  const offList = await preflightModel('gpt-fictional', { client: stubClient(async () => ok([])) });
  assert.equal(offList.ok, false);
  assert.match(offList.reason, /not on the allowlist/);

  const unknown = await preflightModel(PILOT_MODEL, {
    client: stubClient(async () => ok([]), { models: async () => { throw new NotFoundError('404', 404); } }),
  });
  assert.equal(unknown.ok, false);
  assert.match(unknown.reason, /does not know that model identifier/);
});

await test('the allowlist pins snapshots, not aliases, and carries dated prices', () => {
  assert.deepEqual(Object.keys(MODEL_ALLOWLIST).sort(), ['claude-haiku-4-5-20251001', 'claude-sonnet-5']);
  for (const [id, p] of Object.entries(MODEL_ALLOWLIST)) {
    for (const f of ['inputPerMTok', 'outputPerMTok', 'cacheReadPerMTok', 'contextTokens', 'maxOutputTokens']) {
      assert.ok(Number.isFinite(p[f]), `${id} has no ${f}`);
    }
    assert.ok(p.pricedOn, `${id} does not say when its price was checked`);
    // Pre-4.6 models carry a snapshot date; 4.6 and later are dateless and
    // are themselves snapshots. Neither may be an alias.
    assert.ok(!Object.keys(MODEL_ALIASES).includes(id), `${id} is an alias, which can repoint`);
  }
  const haiku = MODEL_ALLOWLIST['claude-haiku-4-5-20251001'];
  assert.equal(haiku.inputPerMTok, 1.00);
  assert.equal(haiku.outputPerMTok, 5.00);
  assert.equal(haiku.cacheReadPerMTok, 0.10, 'a cache read is a tenth of base input');
  assert.equal(haiku.contextTokens, 200_000);
  assert.equal(haiku.alias, 'claude-haiku-4-5');
  const sonnet = MODEL_ALLOWLIST['claude-sonnet-5'];
  assert.equal(sonnet.inputPerMTok, 2.00);
  assert.equal(sonnet.outputPerMTok, 10.00);
  assert.equal(sonnet.alias, null, 'a 4.6-generation id is its own snapshot and has no alias');
  assert.equal(PILOT_MODEL, 'claude-haiku-4-5-20251001');
  // An alias a person types resolves to the snapshot before anything records it.
  assert.equal(resolveModelId('claude-haiku-4-5'), 'claude-haiku-4-5-20251001');
  assert.equal(resolveModelId('claude-sonnet-5'), 'claude-sonnet-5');
});

await test('cache reads are costed at their own rate, and the estimate stays conservative', () => {
  const m = 'claude-haiku-4-5-20251001';
  const plain = actualUsd(m, { inputTokens: 1e6, outputTokens: 0 });
  const cached = actualUsd(m, { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 1e6 });
  assert.equal(plain, 1.00);
  assert.equal(cached, 0.10, 'a cache read was charged at the full input rate');
  assert.equal(actualUsd(m, { inputTokens: 1e6, outputTokens: 1e6, cacheReadInputTokens: 1e6 }), 6.10);
  // The budget check knows nothing about cache hits, so it over-estimates —
  // which is the safe direction for a ceiling.
  const cost = readFileSync(join(REPO, 'lib', 'thesis-cost.mjs'), 'utf8');
  assert.ok(!/cacheRead/.test(cost.slice(cost.indexOf('export function checkBudget'))), 'the budget check discounts for cache hits');
});

// ── The command's refusals ─────────────────────────────────────────────────

await test('the pilot refuses to start without both an allowlist and a budget', () => {
  assert.equal(parseArgs([]).problems.length, 2);
  assert.match(parseArgs([]).problems.join(' '), /--documents is required/);
  assert.match(parseArgs([]).problems.join(' '), /--budget is required/);
  assert.equal(parseArgs(['--documents', 'a,b']).problems.length, 1, 'a missing budget was tolerated');
  assert.equal(parseArgs(['--budget', '3']).problems.length, 1, 'a missing document list was tolerated');
  // A flag with no value is not a value.
  assert.ok(parseArgs(['--documents', '--budget', '3']).problems.some((p) => /--documents is required/.test(p)));
  for (const b of ['0', '-1', 'free', 'NaN']) {
    assert.ok(parseArgs(['--documents', 'a', '--budget', b]).problems.length, `--budget ${b} was accepted`);
  }
  assert.deepEqual(parseArgs(['--documents', 'a, b ,c', '--budget', '3']).documents, ['a', 'b', 'c']);
  assert.equal(parseArgs(['--documents', 'a', '--budget', '3']).model, PILOT_MODEL);
  assert.match(parseArgs(['--documents', 'a', '--budget', '3', '--model', 'gpt-fictional']).problems[0], /not on the allowlist/);
  assert.equal(parseArgs(['--documents', 'a', '--budget', '3', '--model', 'claude-haiku-4-5']).model, PILOT_MODEL, 'the alias was not resolved to the snapshot');
});

await test('only approved documents are reachable, by name', () => {
  const { found, missing } = resolveDocuments(['starboard-value-2026-03-11', 'southeastern-2026-09-04'], SELECTION);
  assert.equal(found.length, 2);
  assert.equal(missing.length, 0);
  assert.equal(found[0].fund, 'starboard-value');
  assert.equal(found[1].fund, 'southeastern');

  const bad = resolveDocuments(['../../etc/passwd', 'https://example.com/x.htm', 'nonsense'], SELECTION);
  assert.equal(bad.found.length, 0, 'something outside the approved selection resolved');
  assert.equal(bad.missing.length, 3);
  assert.ok(bad.available.length > 0);
});

await test('the pilot writes only under .pilot, which git ignores', () => {
  const source = readFileSync(join(REPO, 'scripts', 'thesis-pilot.mjs'), 'utf8');
  assert.match(source, /const OUT = join\(ROOT, '\.pilot'\)/);
  // Every writeFileSync target must be rooted at OUT (.pilot) or at the
  // ephemeral workspace. Matched to the closing paren so `join(OUT, name)`
  // is read whole rather than truncated at its comma.
  const writes = [...source.matchAll(/writeFileSync\(\s*(join\([^)]*\)|[A-Za-z_$][\w$]*)/g)].map((m) => m[1].trim());
  assert.ok(writes.length >= 2, `only ${writes.length} writes found; the check is not looking at anything`);
  const rooted = (target) => {
    if (/^join\(OUT,|^join\(workspace\.path,/.test(target)) return true;
    // A bare identifier is followed to its definition, which must itself be
    // rooted — writeFileSync(scratch, ...) is fine only because scratch is
    // join(workspace.path, ...).
    const def = source.match(new RegExp(`const ${target} = (join\\([^)]*\\))`));
    return Boolean(def && /^join\(OUT,|^join\(workspace\.path,/.test(def[1]));
  };
  for (const w of writes) assert.ok(rooted(w), `a write outside .pilot and the workspace: ${w}`);
  assert.match(readFileSync(join(REPO, '.gitignore'), 'utf8'), /^\.pilot\/$/m);
  assert.ok(!existsSync(join(REPO, '.pilot')), 'a test left .pilot behind');
});

await test('the workspace is removed however the run ends, and the runner owns the cleanup', () => {
  const source = readFileSync(join(REPO, 'scripts', 'thesis-pilot.mjs'), 'utf8');
  // withWorkspace covers the finally block; onExitCleanup covers the signals.
  assert.match(source, /onExitCleanup\(workspace\)/);
  assert.match(source, /await withWorkspace\(workspace,/);
  assert.match(source, /cleanup\.clean/);
  assert.match(source, /process\.exitCode = 4/, 'a failed cleanup does not fail the run');
  // The fetched bytes are removed the moment they are parsed.
  assert.match(source, /rmSync\(scratch, \{ force: true \}\)/);
  assert.match(source, /mode: 'ephemeral-sec'/);
  assert.ok(!/local-private|LETTERS_ARCHIVE_ROOT/.test(source), 'the pilot reaches for the retaining mode');
  // The outputs are written outside the withWorkspace callback, so a failed
  // or interrupted run still leaves its cost behind.
  assert.ok(source.indexOf("writeOut('cost.json'") > source.indexOf('await withWorkspace'));
});

rmSync(join(REPO, '.pilot'), { recursive: true, force: true });
await test('every allowlisted model states its thinking configuration', () => {
  // Thinking tokens count toward max_tokens, which the per-call ceiling pins
  // at 4,000. A model added without deciding this inherits whatever the API
  // defaults to, and on a thinking-by-default model that silently shares the
  // ceiling with the answer.
  for (const [id, m] of Object.entries(MODEL_ALLOWLIST)) {
    assert.ok('thinking' in m, `${id} does not say whether it thinks`);
    if (m.thinking !== null) {
      assert.equal(typeof m.thinking, 'object');
      assert.ok(['disabled', 'adaptive'].includes(m.thinking.type), `${id} has an unknown thinking type`);
    }
  }
  // Sonnet 5 thinks by default; under a 4,000-token ceiling it must not.
  assert.deepEqual(MODEL_ALLOWLIST['claude-sonnet-5'].thinking, { type: 'disabled' });
  // Haiku 4.5 is an extended-thinking model and does not think unconfigured.
  assert.equal(MODEL_ALLOWLIST['claude-haiku-4-5-20251001'].thinking, null);
});

// Awaited: the helper is async and the call sites are not, so an async test
// left unawaited would print its result after the count and turn a failure
// into an unhandled rejection rather than a failing suite.
await test('the thinking configuration reaches the request, and only when set', async () => {
  const taxonomy = JSON.parse(readFileSync(join(REPO, 'data', 'letters.taxonomy.json'), 'utf8'));
  const sent = [];
  const fakeClient = (id) => ({
    constructor: class {},
    messages: { create: async (req) => { sent.push({ id, req }); return {
      content: [{ type: 'tool_use', name: 'propose_candidates', input: { candidates: [] } }],
      usage: { input_tokens: 10, output_tokens: 5 },
    }; } },
  });
  for (const id of Object.keys(MODEL_ALLOWLIST)) {
    const model = anthropicModel({ modelId: id, taxonomy, client: fakeClient(id) });
    await model.propose({ chunkId: 'c', text: 'x' });
  }
  const sonnet = sent.find((r) => r.id === 'claude-sonnet-5').req;
  const haiku = sent.find((r) => r.id === 'claude-haiku-4-5-20251001').req;
  assert.deepEqual(sonnet.thinking, { type: 'disabled' }, 'Sonnet 5 was asked to think inside a 4,000-token ceiling');
  assert.ok(!('thinking' in haiku), 'a thinking key was sent to a model that takes none');
  // The ceiling itself is unchanged for both.
  for (const req of [sonnet, haiku]) assert.equal(req.max_tokens, LIMITS.maxOutputTokensPerCall);
});

await test('the workflow offers Sonnet 5 as a fixed option, never as free text', () => {
  const wf = readFileSync(join(REPO, '.github', 'workflows', 'thesis-pilot.yml'), 'utf8');
  const block = wf.slice(wf.indexOf('      model:'), wf.indexOf('      budget_usd:'));
  assert.match(block, /type: choice/);
  assert.ok(!/type: string/.test(block), 'the model input accepts free text');
  const options = [...block.matchAll(/^          - (\S+)$/gm)].map((m) => m[1]);
  assert.deepEqual(options, ['claude-haiku-4-5-20251001', 'claude-sonnet-5']);
  // Everything offered is priced and allowlisted, so no dropdown entry can
  // reach a model the cost ledger cannot cost.
  for (const o of options) {
    assert.ok(MODEL_ALLOWLIST[o], `${o} is offered but not on the allowlist`);
    assert.equal(typeof MODEL_ALLOWLIST[o].inputPerMTok, 'number');
    assert.equal(typeof MODEL_ALLOWLIST[o].outputPerMTok, 'number');
  }
});

await test('Sonnet 5 resolves to itself, and no alias can redirect it', () => {
  assert.equal(resolveModelId('claude-sonnet-5'), 'claude-sonnet-5');
  assert.equal(MODEL_ALLOWLIST['claude-sonnet-5'].alias, null);
  assert.ok(!Object.keys(MODEL_ALIASES).includes('claude-sonnet-5'), 'an alias points at Sonnet 5');
  assert.ok(!Object.values(MODEL_ALIASES).includes('claude-sonnet-5'), 'an alias resolves to Sonnet 5');
  // Its published price, checked against the model table.
  assert.equal(MODEL_ALLOWLIST['claude-sonnet-5'].inputPerMTok, 2.00);
  assert.equal(MODEL_ALLOWLIST['claude-sonnet-5'].outputPerMTok, 10.00);
});

// ── The bounded Sonnet 5 configuration ──────────────────────────────────────

await test('two candidates per chunk and six claims per document, both deterministic', () => {
  assert.equal(MAX_CANDIDATES_PER_CHUNK, 2);
  assert.equal(MAX_CLAIMS_PER_DOCUMENT, 6);
  // No array-size constraint anywhere in either strict schema. The API
  // compiles a strict schema against a subset that excludes them, and sending
  // one is a 400 before inference rather than a tighter guarantee: run
  // 35501855065 died on its first call for exactly this. The caps live in
  // code, where a model's cooperation is not required.
  assert.equal(CANDIDATE_TOOL.strict, true);
  assert.equal(SELECTION_TOOL.strict, true);
  for (const [name, tool] of [['CANDIDATE_TOOL', CANDIDATE_TOOL], ['SELECTION_TOOL', SELECTION_TOOL]]) {
    const json = JSON.stringify(tool.input_schema);
    for (const banned of ['maxItems', 'minItems', 'maxLength', 'minLength', 'minimum', 'maximum', 'multipleOf', 'pattern']) {
      assert.ok(!json.includes(`"${banned}"`), `${name} carries ${banned}, which a strict schema rejects`);
    }
  }
  // And each instruction says the same number, so the two cannot disagree.
  const taxonomy = JSON.parse(readFileSync(join(REPO, 'data', 'letters.taxonomy.json'), 'utf8'));
  assert.match(extractionPrompt(taxonomy), /at most 2 claims/);
  assert.match(CANDIDATE_TOOL.description, /at most 2 material/);
  assert.match(consolidationPrompt(), /at most 6/);
});

await test('the prompt asks for material claims and names what to leave out', () => {
  const taxonomy = JSON.parse(readFileSync(join(REPO, 'data', 'letters.taxonomy.json'), 'utf8'));
  const prompt = extractionPrompt(taxonomy);
  for (const material of ['thesis', 'driver of value', 'catalyst', 'risk', 'stance', 'conviction']) {
    assert.ok(prompt.includes(material), `the prompt does not ask for ${material}`);
  }
  for (const excluded of ['background description', 'commentary', 'restatement', 'too small to change a view']) {
    assert.ok(prompt.includes(excluded), `the prompt does not exclude ${excluded}`);
  }
});

await test('the request asks for exactly the per-call output ceiling', async () => {
  // These had drifted: the ledger priced every call at the ceiling while the
  // request asked for a hardcoded 4,000, so raising the ceiling would have
  // changed the price of a call and nothing about what it could return.
  assert.equal(LIMITS.maxOutputTokensPerCall, 2_000);
  const taxonomy = JSON.parse(readFileSync(join(REPO, 'data', 'letters.taxonomy.json'), 'utf8'));
  const sent = [];
  const client = { constructor: class {}, messages: { create: async (req) => { sent.push(req); return {
    content: [{ type: 'tool_use', name: 'propose_candidates', input: { candidates: [] } }],
    usage: { input_tokens: 10, output_tokens: 5 },
  }; } } };
  const model = anthropicModel({ modelId: 'claude-sonnet-5', taxonomy, client });
  await model.propose({ chunkId: 'c', text: 'x' });
  assert.equal(sent[0].max_tokens, LIMITS.maxOutputTokensPerCall, 'the request and the ceiling disagree');
  assert.deepEqual(sent[0].thinking, { type: 'disabled' }, 'thinking came back on');
  // The strongest form of the guard: what actually goes on the wire carries no
  // constraint the strict compiler rejects. Asserting on the exported
  // constant would not have caught this; asserting on the request does.
  const wire = JSON.stringify(sent[0].tools);
  for (const banned of ['maxItems', 'minItems', 'maxLength', 'minLength', 'minimum', 'maximum', 'multipleOf', 'pattern']) {
    assert.ok(!wire.includes(`"${banned}"`), `the request sent ${banned} inside a strict tool schema`);
  }
  assert.equal(sent[0].tools[0].strict, true);
});

await test('the 2,000-token ceiling is priced, and the pilot still fits the budget', () => {
  const p = MODEL_ALLOWLIST['claude-sonnet-5'];
  const usd = (i, o) => (i / 1e6) * p.inputPerMTok + (o / 1e6) * p.outputPerMTok;
  // One call at both ceilings.
  assert.equal(Number(usd(LIMITS.maxInputTokensPerCall, LIMITS.maxOutputTokensPerCall).toFixed(4)), 0.10);
  // Two documents, bounded by the per-document ceilings, well under $3.
  const worstTwoDocuments = usd(2 * LIMITS.maxInputTokensPerDocument, 2 * LIMITS.maxOutputTokensPerDocument);
  assert.ok(worstTwoDocuments < PILOT_BUDGET_USD, `two documents could cost $${worstTwoDocuments.toFixed(2)}`);
  // Every ceiling the approval fixed is still where it was.
  assert.equal(PILOT_BUDGET_USD, 3.00);
  assert.equal(LIMITS.hardStopUsd, 15.00);
  assert.equal(LIMITS.maxInputTokensPerCall, 40_000);
  assert.equal(LIMITS.maxDocuments, 9);
  assert.equal(LIMITS.maxChunksPerDocument, 12);
  assert.equal(LIMITS.maxOutputTokensPerDocument, 26_000);
  assert.equal(LIMITS.maxModelCalls, 18);
  assert.equal(MAX_RETRIES, 0);
});

await test('a truncated answer aborts with no retry and keeps no partial claim', () => {
  // The tool input of a truncated answer may be half-parsed JSON, so it is
  // refused before anything reads it rather than after.
  const truncated = {
    stop_reason: 'max_tokens',
    content: [{ type: 'tool_use', name: 'propose_candidates', input: { candidates: [{ paraphrase: 'half a claim' }] } }],
    usage: { input_tokens: 2500, output_tokens: 8000 },
  };
  assert.throws(() => readProposals(truncated), (e) => {
    assert.equal(e.reason, 'truncated');
    assert.equal(e.retryable, false, 'a truncated answer is marked retryable');
    return true;
  });
  // The usage is still readable, so the call is costed even though it is lost.
  const usage = readUsage(truncated);
  assert.equal(usage.outputTokens, 8000);
  assert.ok(actualUsd('claude-sonnet-5', usage) > 0, 'a truncated call is treated as free');
});

console.log(`${passed} passed`);
