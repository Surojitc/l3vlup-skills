// The one place in this repository that can talk to Anthropic.
//
// It implements the `Model` shape the runner already takes: an object with an
// async `propose`. Everything else about the pipeline is unchanged, which is
// the point of having built the harness against an interface first — this
// file is small, and it is the only file a reviewer has to trust with a
// credential.
//
// Three things it deliberately does not do.
//
// It never reads the credential. `new Anthropic()` resolves one itself; this
// module never touches `process.env`, never logs a credential, and never
// accepts one as an argument. In CI that credential is federated: the SDK
// exchanges a GitHub OIDC identity token for a half-hour access token it holds
// in memory, so there is no key here to read even in principle. If there is no
// credential the SDK raises its own authentication error and we translate it
// into a sentence a person can act on.
//
// It never constructs a client at import time. The client is built lazily on
// the first call, so importing this module — which every test does — cannot
// reach the network or require a key.
//
// It never retries a refusal into existence. A malformed answer, a missing
// usage block, a timeout: each becomes a recorded failure with its reason.
// The pipeline drops what it cannot verify, and a second attempt at a
// fabricated quotation only produces a better-looking fabrication.

import { LIMITS, MAX_CANDIDATES_PER_CHUNK, MAX_CLAIMS_PER_DOCUMENT, MODEL_ALLOWLIST } from './thesis-cost.mjs';

export const CLIENT_VERSION = 1;
export const PROMPT_VERSION = 'thesis-extract-v1';

/** How long one call may take before it is abandoned. */
export const REQUEST_TIMEOUT_MS = 120_000;
export const MAX_RETRIES = 0;

/** The tool the model answers through, so the shape is enforced server-side. */
export const CANDIDATE_TOOL = Object.freeze({
  name: 'propose_candidates',
  description: `Report at most ${MAX_CANDIDATES_PER_CHUNK} material investment claims this passage makes, each anchored to an exact quotation from it.`,
  strict: true,
  input_schema: {
    type: 'object',
    properties: {
      candidates: {
        type: 'array',
        // Structural, not advisory: `strict: true` makes the schema binding, so a
        // third candidate is not a thing the model can return.
        maxItems: MAX_CANDIDATES_PER_CHUNK,
        items: {
          type: 'object',
          properties: {
            issuerMention: { type: 'string', description: 'The company exactly as this passage names it. Do not normalise, expand or correct it.' },
            paraphrase: { type: 'string', description: 'One sentence, in your own words, saying what the manager claims.' },
            kind: { type: 'string', enum: ['statement', 'paraphrase', 'classification', 'inference'] },
            stance: { type: 'string', enum: ['long', 'short', 'unclear'] },
            tags: { type: 'array', items: { type: 'string' } },
            horizon: { type: 'string' },
            evidenceExcerpt: { type: 'string', description: 'A verbatim run of characters copied from the passage. It must match exactly, including punctuation and spacing.' },
            evidenceStartOffset: { type: 'integer', description: 'The index of the first character of the excerpt within this passage, counting from 0.' },
            evidenceEndOffset: { type: 'integer', description: 'The index one past the last character of the excerpt within this passage.' },
          },
          required: ['issuerMention', 'paraphrase', 'kind', 'stance', 'tags', 'evidenceExcerpt', 'evidenceStartOffset', 'evidenceEndOffset'],
          additionalProperties: false,
        },
      },
    },
    required: ['candidates'],
    additionalProperties: false,
  },
});

/**
 * The instruction, versioned alongside the schema it produces.
 *
 * It says what the model may not decide as plainly as the code does, because
 * a prompt that invites a ticker will get one, and a stripped field that
 * never had to be stripped is cheaper than one that did.
 */
export function extractionPrompt(taxonomy) {
  const tags = taxonomy.tags.map((t) => `${t.code}: ${t.definition}`).join('\n');
  return [
    'You read a passage from an investment manager’s public filing and report the claims it makes.',
    '',
    'Rules, in order of importance.',
    '',
    '1. Every claim must carry a verbatim excerpt copied from the passage, with the exact character offsets at which it appears. Count characters from the start of the passage, beginning at 0. If you cannot copy an exact run of characters that supports a claim, do not report that claim.',
    '2. Never invent, paraphrase, tidy or join up an excerpt. It is checked character by character against the passage and a claim whose excerpt does not match is discarded.',
    '3. Use only the tags listed below. Do not invent a tag. A claim that fits none of them should carry an empty tag list.',
    '4. Name the company exactly as the passage names it. Do not supply a ticker, a CUSIP, a share class, a CIK, a legal name you know from elsewhere, or any holding size. Those are looked up, not recalled, and anything of that kind you return is discarded.',
    '5. `statement` means the manager said it. `inference` means you concluded it. Never label a conclusion as a statement.',
    '6. `stance` is `unclear` unless the passage makes the direction plain. Saying nothing about a holding is not a stance.',
    `7. Report at most ${MAX_CANDIDATES_PER_CHUNK} claims, and only material ones: a thesis, a driver of value, a catalyst, a risk, a stance, or a statement of conviction. If the passage offers more than ${MAX_CANDIDATES_PER_CHUNK}, keep the most material and leave the rest.`,
    '8. Do not report background description, market or economic commentary, a restatement of something already reported, or a detail too small to change a view. These are the most common wrong answers. An empty list is a good answer.',
    '9. Report nothing if the passage is a financial table, a legal notice or boilerplate.',
    '',
    'Tags:',
    tags,
  ].join('\n');
}

/**
 * Stage B. Identifiers and integers, and nothing else.
 *
 * No string field exists on this schema, so consolidation has no way to write
 * a word of the output. It names candidates already verified in Stage A and
 * says what order they go in; the claim that reaches review is the candidate,
 * unchanged. `strict: true` makes that a property of the request rather than
 * an instruction the model is trusted to follow.
 */
export const SELECTION_TOOL = Object.freeze({
  name: 'select_claims',
  description: `Choose at most ${MAX_CLAIMS_PER_DOCUMENT} of the numbered candidates as this document's claims, most material first.`,
  strict: true,
  input_schema: {
    type: 'object',
    properties: {
      selections: {
        type: 'array',
        maxItems: MAX_CLAIMS_PER_DOCUMENT,
        items: {
          type: 'object',
          properties: {
            candidateId: { type: 'string', description: 'The id of a candidate from the list you were given. Copy it exactly. Do not invent one.' },
            rank: { type: 'integer', description: '1 for the most material claim, then 2, 3, and so on.' },
          },
          required: ['candidateId', 'rank'],
          additionalProperties: false,
        },
      },
    },
    required: ['selections'],
    additionalProperties: false,
  },
});

/** The instruction for Stage B. It asks for a choice, never for words. */
export function consolidationPrompt() {
  return [
    'You are given the candidate claims extracted from one investment manager’s filing, each with an id, a paraphrase and the quotation it rests on.',
    '',
    `Choose at most ${MAX_CLAIMS_PER_DOCUMENT} that together say what this manager argues about this company, most material first.`,
    '',
    '1. Return ids and ranks only. You cannot write, correct or improve any text here, and nothing you write would be used: the claim that reaches a reader is the candidate you named, exactly as it was extracted.',
    '2. Copy each id exactly from the list. An id that is not in the list is discarded.',
    '3. Prefer a claim that states a thesis, a driver of value, a catalyst, a risk, or the manager’s conviction, over one that restates a fact or describes background.',
    '4. Where two candidates make the same point, choose the one whose quotation supports it most directly and leave the other.',
    `5. Fewer than ${MAX_CLAIMS_PER_DOCUMENT} is a good answer. Choose none if none of them is material.`,
  ].join('\n');
}

export class ModelCallError extends Error {
  constructor(reason, detail, { retryable = false } = {}) {
    super(`${reason}: ${detail}`);
    this.reason = reason;
    this.detail = detail;
    this.retryable = retryable;
  }
}

/**
 * Pull the proposals out of a response, refusing anything that is not one.
 *
 * Separated from the call so the tests can drive every shape a model can
 * return — no tool use, two tool blocks, a non-array, a truncated answer —
 * without a transport at all.
 */
export function readProposals(response, tool = CANDIDATE_TOOL, field = 'candidates') {
  if (!response || typeof response !== 'object') throw new ModelCallError('malformed_response', 'the response was not an object');
  if (response.stop_reason === 'refusal') {
    throw new ModelCallError('refused', `the model declined: ${response.stop_details?.category ?? 'no category given'}`);
  }
  if (response.stop_reason === 'max_tokens') {
    throw new ModelCallError('truncated', 'the answer hit max_tokens, so any tool input may be incomplete');
  }
  if (!Array.isArray(response.content)) throw new ModelCallError('malformed_response', 'the response carried no content array');

  const uses = response.content.filter((b) => b && b.type === 'tool_use' && b.name === tool.name);
  if (!uses.length) return [];
  if (uses.length > 1) throw new ModelCallError('malformed_response', `${uses.length} tool calls where one was expected`);

  const input = uses[0].input;
  if (!input || typeof input !== 'object') throw new ModelCallError('malformed_response', 'the tool input was not an object');
  if (!Array.isArray(input[field])) throw new ModelCallError('malformed_response', `the tool input carried no ${field} array`);
  for (const p of input[field]) {
    if (!p || typeof p !== 'object') throw new ModelCallError('malformed_response', `a ${field.replace(/s$/, '')} was not an object`);
  }
  return input[field];
}

/**
 * Usage, or a refusal to guess it.
 *
 * A call whose token counts are missing cannot be costed, and an uncosted
 * call cannot be kept under a budget. Treating it as zero is the one failure
 * mode that spends money silently, so it is an error rather than a default.
 */
export function readUsage(response) {
  const u = response?.usage;
  if (!u || typeof u !== 'object') throw new ModelCallError('missing_usage', 'the response carried no usage block, so the call cannot be costed');
  const inputTokens = u.input_tokens;
  const outputTokens = u.output_tokens;
  if (!Number.isFinite(inputTokens) || !Number.isFinite(outputTokens)) {
    throw new ModelCallError('missing_usage', `usage held input_tokens=${inputTokens} output_tokens=${outputTokens}; a call that cannot be costed cannot be budgeted`);
  }
  return {
    inputTokens,
    outputTokens,
    cacheReadInputTokens: Number.isFinite(u.cache_read_input_tokens) ? u.cache_read_input_tokens : 0,
    cacheCreationInputTokens: Number.isFinite(u.cache_creation_input_tokens) ? u.cache_creation_input_tokens : 0,
  };
}

/** What a call actually cost, from the tokens the API reported. */
export function actualUsd(modelId, usage) {
  const p = MODEL_ALLOWLIST[modelId];
  if (!p) return null;
  // The API reports cache reads separately and does not include them in
  // input_tokens, so they are priced separately too — a tenth of the base
  // input rate. The budget *estimate* still assumes no cache hits, which
  // keeps it conservative; only the actual figure knows better.
  const cacheRead = (usage.cacheReadInputTokens || 0) / 1e6 * (p.cacheReadPerMTok ?? p.inputPerMTok);
  const cacheWrite = (usage.cacheCreationInputTokens || 0) / 1e6 * p.inputPerMTok * 1.25;
  return Number((((usage.inputTokens / 1e6) * p.inputPerMTok) + ((usage.outputTokens / 1e6) * p.outputPerMTok) + cacheRead + cacheWrite).toFixed(6));
}

/**
 * Translate an SDK failure into something a person can act on.
 *
 * Checked most specific first, and the network class before the base class,
 * because in this SDK a connection error is a subclass of the API error.
 */
export function classifyError(err, Anthropic) {
  const A = Anthropic || {};
  if (err instanceof ModelCallError) return err;
  if (A.AuthenticationError && err instanceof A.AuthenticationError) {
    return new ModelCallError('no_credential', 'the API rejected the credential. This run reads no key of its own. In CI it federates: check the federation variables and the rule, and read the refusal reason in the Console under Settings > Workload identity > History. Locally, sign in with `ant auth login`.');
  }
  if (A.NotFoundError && err instanceof A.NotFoundError) {
    return new ModelCallError('unknown_model', 'the API does not know that model identifier');
  }
  if (A.RateLimitError && err instanceof A.RateLimitError) {
    return new ModelCallError('rate_limited', 'the API rate-limited this call', { retryable: true });
  }
  if (A.APIConnectionError && err instanceof A.APIConnectionError) {
    const timedOut = /timeout|timed out|aborted/i.test(String(err.message));
    return new ModelCallError(timedOut ? 'timeout' : 'connection', String(err.message).slice(0, 200), { retryable: true });
  }
  if (A.APIError && err instanceof A.APIError) {
    return new ModelCallError('api_error', `HTTP ${err.status ?? '?'} ${err.type ?? ''} ${String(err.message).slice(0, 160)}`.trim(), { retryable: (err.status ?? 0) >= 500 });
  }
  if (/timeout|timed out|aborted/i.test(String(err?.message))) return new ModelCallError('timeout', String(err.message).slice(0, 200), { retryable: true });
  return new ModelCallError('unknown', String(err?.message ?? err).slice(0, 200));
}

/**
 * Confirm the identifier exists before a billable token is spent.
 *
 * The Models API is not an inference call and costs nothing. It exists here
 * because a hard-coded model identifier is exactly the kind of thing that
 * rots quietly, and finding out at the first chunk is worse than finding out
 * before the run starts.
 */
export async function preflightModel(modelId, { client }) {
  if (!MODEL_ALLOWLIST[modelId]) {
    return { ok: false, reason: `${modelId} is not on the allowlist: ${Object.keys(MODEL_ALLOWLIST).join(', ')}` };
  }
  try {
    const model = await client.models.retrieve(modelId);
    return { ok: true, id: model.id, displayName: model.display_name ?? null, maxInputTokens: model.max_input_tokens ?? null };
  } catch (err) {
    return { ok: false, reason: classifyError(err, client.constructor).message };
  }
}

/**
 * The Model the runner takes.
 *
 * `client` is injectable and that is not only for testing: it keeps the SDK
 * import itself lazy, so nothing about this module requires a key or a
 * network until somebody deliberately runs the pilot.
 */
// Defaulted from the ceiling rather than repeated as a literal. The two had
// drifted: the cost ledger estimated every call at LIMITS.maxOutputTokensPerCall
// while the request asked for a hardcoded 4,000, so raising the ceiling alone
// would have changed what a call was priced at and nothing about what it could
// return.
export function anthropicModel({ modelId, taxonomy, client, promptVersion = PROMPT_VERSION, maxOutputTokens = LIMITS.maxOutputTokensPerCall }) {
  const system = extractionPrompt(taxonomy);
  const consolidationSystem = consolidationPrompt();
  // Data, not a branch: the allowlist is the one place a model's request shape
  // is decided, so adding a model cannot leave its thinking configuration to
  // whatever the default happens to be.
  const thinking = MODEL_ALLOWLIST[modelId]?.thinking ?? null;
  const calls = [];
  return {
    id: modelId,
    promptVersion,
    calls,
    async propose(request) {
      const started = Date.now();
      let response;
      try {
        response = await client.messages.create({
          model: modelId,
          max_tokens: maxOutputTokens,
          ...(thinking ? { thinking } : {}),
          system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
          tools: [CANDIDATE_TOOL],
          tool_choice: { type: 'tool', name: CANDIDATE_TOOL.name },
          messages: [{ role: 'user', content: `Passage to read:\n\n${request.text}` }],
        });
      } catch (err) {
        const failure = classifyError(err, client.constructor);
        calls.push({ stage: 'extraction', chunkId: request.chunkId, ok: false, reason: failure.reason, detail: failure.detail, ms: Date.now() - started });
        throw failure;
      }

      // Usage is read before the proposals: a response we cannot cost is a
      // failure whatever it says, and reading it second would mean a
      // malformed answer masked an uncosted call.
      const usage = readUsage(response);
      const proposals = readProposals(response);
      const cost = actualUsd(modelId, usage);
      calls.push({
        stage: 'extraction', chunkId: request.chunkId, ok: true, ms: Date.now() - started,
        inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
        cacheReadInputTokens: usage.cacheReadInputTokens, actualUsd: cost, proposals: proposals.length,
      });
      return { proposals, usage: { ...usage, actualUsd: cost } };
    },

    /**
     * Stage B. One call per document, after every chunk has been extracted.
     *
     * It is handed the candidates and returns ids and ranks. Nothing it says
     * becomes text a reader sees, so a wrong answer here costs a worse
     * ordering, never a wrong quotation.
     */
    async select(request) {
      const started = Date.now();
      let response;
      const body = JSON.stringify(request.candidates, null, 1);
      try {
        response = await client.messages.create({
          model: modelId,
          max_tokens: maxOutputTokens,
          ...(thinking ? { thinking } : {}),
          system: [{ type: 'text', text: consolidationSystem, cache_control: { type: 'ephemeral' } }],
          tools: [SELECTION_TOOL],
          tool_choice: { type: 'tool', name: SELECTION_TOOL.name },
          messages: [{ role: 'user', content: `Candidates for ${request.documentId}:\n\n${body}` }],
        });
      } catch (err) {
        const failure = classifyError(err, client.constructor);
        calls.push({ stage: 'consolidation', chunkId: `${request.documentId}:consolidate`, ok: false, reason: failure.reason, detail: failure.detail, ms: Date.now() - started });
        throw failure;
      }

      const usage = readUsage(response);
      const selections = readProposals(response, SELECTION_TOOL, 'selections');
      const cost = actualUsd(modelId, usage);
      calls.push({
        stage: 'consolidation', chunkId: `${request.documentId}:consolidate`, ok: true, ms: Date.now() - started,
        inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
        cacheReadInputTokens: usage.cacheReadInputTokens, actualUsd: cost, selections: selections.length,
      });
      return { selections, usage: { ...usage, actualUsd: cost } };
    },
  };
}

/**
 * Build the real SDK client. The only function here that imports the SDK,
 * and it is never called by a test.
 */
export async function realClient({ timeoutMs = REQUEST_TIMEOUT_MS, maxRetries = MAX_RETRIES } = {}) {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  // No apiKey argument: the SDK resolves the credential itself, so this
  // process never holds, copies or logs it.
  const client = new Anthropic({ timeout: timeoutMs, maxRetries });
  client.constructor = Anthropic;
  return client;
}
