// The budget, and the rule that it stops rather than degrades.
//
// Defined here and executed nowhere. No key, no client, no dependency: this
// is the ceiling the extraction milestone will run under, written before
// anything can run, so the limit is a precondition rather than a reaction.
//
// The important rule is the last one. A budget that silently switches to a
// cheaper model, or shortens the input, or skips the verification pass, has
// not saved money — it has changed the product without telling anybody. When
// the ceiling is reached this stops and says so.

export const COST_VERSION = 1;

/** Only these may be called, and only at these prices. */
/**
 * The models this pipeline may call, and what they cost.
 *
 * Verified against platform.claude.com on 2026-09-18: the models overview for
 * the identifiers and context windows, and the pricing page for the rates.
 *
 * On identifiers, the rule is not the one I assumed twice. Models before the
 * 4.6 generation carry a snapshot date in the canonical id, and the dateless
 * form is a *convenience alias that resolves to the most recent dated
 * snapshot for that minor version* — so an alias can repoint under us. From
 * the 4.6 generation on, the dateless id is itself the pinned snapshot and
 * there is no alias.
 *
 * Haiku 4.5 predates 4.6, so `claude-haiku-4-5-20251001` is the snapshot and
 * `claude-haiku-4-5` is the alias. We pin the snapshot, because every claim
 * records the model that produced it and an id that can quietly point
 * somewhere else makes that record a lie. Sonnet 5 is post-4.6, so
 * `claude-sonnet-5` is already a snapshot and needs no date.
 *
 * On prices, a wrong one fails silently and mis-states every budget check,
 * which is worse than a wrong identifier. Sonnet 5 is $2/$10: the increase to
 * $3/$15 that had been scheduled for 1 September 2026 was cancelled, and $2/$10
 * is now the standard price. Cache reads are a tenth of the base input rate.
 */
export const MODEL_ALLOWLIST = Object.freeze({
  'claude-haiku-4-5-20251001': {
    inputPerMTok: 1.00, outputPerMTok: 5.00, cacheReadPerMTok: 0.10,
    contextTokens: 200_000, maxOutputTokens: 64_000,
    alias: 'claude-haiku-4-5', role: 'extraction', pricedOn: '2026-09-18',
    // Extended-thinking model: with no `thinking` in the request it does not
    // think at all, so the whole per-call output ceiling is the answer.
    thinking: null,
  },
  'claude-sonnet-5': {
    inputPerMTok: 2.00, outputPerMTok: 10.00, cacheReadPerMTok: 0.20,
    contextTokens: 1_000_000, maxOutputTokens: 128_000,
    alias: null, role: 'extraction', pricedOn: '2026-09-18',
    // Thinking is on by default here and thinking tokens count toward
    // max_tokens, which LIMITS.maxOutputTokensPerCall pins at 4,000. At the
    // default effort of `high` the reasoning would share that ceiling with the
    // tool call and could leave no room for it; this pipeline does not retry
    // and does not repair, so a truncated answer is a claim lost and a call
    // paid for. Turning thinking off gives the answer the whole ceiling and
    // makes the request shape the same one the Haiku path already exercises.
    // The docs' own `disabled` example is this model at max_tokens 4096, and
    // the tool-call-as-plain-text failure mode documented for disabled
    // thinking is a Claude Opus 5 behaviour, not a Sonnet 5 one.
    thinking: { type: 'disabled' },
  },
});

/** An alias a person might reasonably type, mapped to the snapshot we pin. */
export const MODEL_ALIASES = Object.freeze({ 'claude-haiku-4-5': 'claude-haiku-4-5-20251001' });

export const resolveModelId = (id) => MODEL_ALIASES[id] || id;

/** The one model the pilot is authorised to use. */
export const PILOT_MODEL = 'claude-haiku-4-5-20251001';

export const LIMITS = Object.freeze({
  maxDocuments: 9,
  maxChunksPerDocument: 12,
  maxInputTokensPerDocument: 120_000,
  // Derived, not chosen: see completionHeadroom() below. A document is
  // reserved the full per-call ceiling before each call and charged its actual
  // output after, so a per-document ceiling under (chunks + 1) x per-call
  // silently stops a document part-way and reports success. At 4,000/8,000
  // Longleaf admitted two of its nine chunks.
  maxOutputTokensPerDocument: 26_000,
  maxInputTokensPerCall: 40_000,
  // 2,000, down from 4,000. Two candidates measure about 420 tokens of JSON
  // and six selections about 210, so this is roughly five times what either
  // stage needs. The first design reached for a bigger number; bounding what
  // a call may return turned out to need a smaller one.
  maxOutputTokensPerCall: 2_000,
  maxModelCalls: 18,           // one extraction per document, one escalation
  hardStopUsd: 15.00,          // the absolute ceiling for the whole milestone
  promptVersion: 'thesis-extract-v1',
});

/**
 * The pilot's own budget, well below the milestone ceiling.
 *
 * Two budgets rather than one because they answer different questions. The
 * pilot budget is what this first run may spend before somebody looks at the
 * output; the milestone ceiling is what the whole exercise may spend ever.
 * A run stops at whichever it reaches first, and reaching the pilot budget
 * is the expected outcome of a well-scoped pilot, not a failure.
 */
/**
 * Stage A: the most evidence-backed candidates one chunk may offer.
 *
 * Two, enforced in the tool schema rather than asked for in the prompt. A
 * chunk is a few hundred words; more than two material claims in one is
 * almost always background description dressed up.
 */
export const MAX_CANDIDATES_PER_CHUNK = 2;

/**
 * Stage B: the most claims one document may end with.
 *
 * Six per *document*, not per chunk. Nine Longleaf chunks at six each would be
 * fifty-four claims to review, which is a queue nobody works through, and a
 * queue nobody works through publishes nothing.
 */
export const MAX_CLAIMS_PER_DOCUMENT = 6;

/**
 * Whether a document of `chunks` chunks can be finished without the output
 * budget stopping it part-way.
 *
 * The runner cannot know a call's output before making it, so it reserves the
 * whole per-call ceiling and is charged the actual afterwards. Worst case
 * every call uses its whole reservation, so call i needs i x perCall of
 * room. One extra call is the consolidation.
 */
export const completionHeadroom = (chunks = LIMITS.maxChunksPerDocument, limits = LIMITS) =>
  (chunks + 1) * limits.maxOutputTokensPerCall;

export const canCompleteDocument = (chunks = LIMITS.maxChunksPerDocument, limits = LIMITS) =>
  limits.maxOutputTokensPerDocument >= completionHeadroom(chunks, limits);

export const PILOT_BUDGET_USD = 3.00;

/**
 * The cost of a call, or null when we do not know the price.
 *
 * Null is the important return. A model whose price we do not hold cannot be
 * costed, and a cost that cannot be computed must never be treated as zero —
 * that is precisely how a budget is silently exceeded.
 */
export const estimateUsd = (model, inTok, outTok, allowlist = MODEL_ALLOWLIST) => {
  const p = allowlist[model];
  if (!p || typeof p.inputPerMTok !== 'number' || typeof p.outputPerMTok !== 'number') return null;
  return (inTok / 1e6) * p.inputPerMTok + (outTok / 1e6) * p.outputPerMTok;
};

export const isPriced = (model, allowlist = MODEL_ALLOWLIST) => estimateUsd(model, 1, 1, allowlist) !== null;

export const emptyCostLedger = ({ budgetUsd = PILOT_BUDGET_USD } = {}) => ({
  costVersion: COST_VERSION,
  promptVersion: LIMITS.promptVersion,
  // The effective ceiling: the run's own budget, never above the milestone's.
  budgetUsd: Math.min(budgetUsd, LIMITS.hardStopUsd),
  calls: [],
  documentsProcessed: 0,
  estimatedUsd: 0,
  actualUsd: 0,
  stopped: false,
  stopReason: null,
});

/**
 * Whether one more call is allowed, and why not when it is not.
 *
 * Checked before the call, using the estimate, because a ceiling enforced
 * after the spend is not a ceiling.
 */
export function checkBudget(ledger, { model, inputTokens, outputTokens, documentId }, allowlist = MODEL_ALLOWLIST) {
  if (ledger.stopped) return { allowed: false, reason: ledger.stopReason };
  if (!allowlist[model]) return { allowed: false, reason: `${model} is not on the allowlist: ${Object.keys(allowlist).join(', ')}` };

  // An unpriced model refuses to run. Not a warning, not a zero: if we
  // cannot say what a call costs, we cannot say we stayed under a ceiling,
  // and a budget that cannot be enforced is not a budget.
  const cost = estimateUsd(model, inputTokens, outputTokens, allowlist);
  if (cost === null) return { allowed: false, reason: `no price is configured for ${model}; refusing to run rather than assuming it is free` };

  if (inputTokens > LIMITS.maxInputTokensPerCall) return { allowed: false, reason: `${inputTokens} input tokens is over the ${LIMITS.maxInputTokensPerCall} per-call limit` };
  if (outputTokens > LIMITS.maxOutputTokensPerCall) return { allowed: false, reason: `${outputTokens} output tokens is over the ${LIMITS.maxOutputTokensPerCall} per-call limit` };
  if (ledger.calls.length >= LIMITS.maxModelCalls) return { allowed: false, reason: `the ${LIMITS.maxModelCalls} call ceiling is reached` };

  const forDocument = ledger.calls.filter((c) => c.documentId === documentId);
  const inSoFar = forDocument.reduce((n, c) => n + (c.inputTokens || 0), 0);
  const outSoFar = forDocument.reduce((n, c) => n + (c.outputTokens || 0), 0);
  if (inSoFar + inputTokens > LIMITS.maxInputTokensPerDocument) return { allowed: false, reason: `${inSoFar + inputTokens} input tokens is over the ${LIMITS.maxInputTokensPerDocument} per-document limit` };
  if (outSoFar + outputTokens > LIMITS.maxOutputTokensPerDocument) return { allowed: false, reason: `${outSoFar + outputTokens} output tokens is over the ${LIMITS.maxOutputTokensPerDocument} per-document limit` };
  if (forDocument.length >= LIMITS.maxChunksPerDocument) return { allowed: false, reason: `the ${LIMITS.maxChunksPerDocument} chunk ceiling for ${documentId} is reached` };

  const seen = new Set(ledger.calls.map((c) => c.documentId));
  if (!seen.has(documentId) && seen.size >= LIMITS.maxDocuments) {
    return { allowed: false, reason: `the ${LIMITS.maxDocuments} document ceiling is reached` };
  }

  const projected = ledger.estimatedUsd + cost;
  const ceiling = Math.min(ledger.budgetUsd ?? LIMITS.hardStopUsd, LIMITS.hardStopUsd);
  if (projected > LIMITS.hardStopUsd) {
    return { allowed: false, reason: `this call would reach $${projected.toFixed(2)}, over the $${LIMITS.hardStopUsd.toFixed(2)} milestone ceiling` };
  }
  if (projected > ceiling) {
    return { allowed: false, reason: `this call would reach $${projected.toFixed(2)}, over this run's $${ceiling.toFixed(2)} budget` };
  }
  return { allowed: true, reason: null, projectedUsd: projected };
}

/** Record a call. A refused call stops the run; it never falls back. */
export function recordCall(ledger, call, allowlist = MODEL_ALLOWLIST) {
  const check = checkBudget(ledger, call, allowlist);
  if (!check.allowed) {
    return { ...ledger, stopped: true, stopReason: check.reason };
  }
  const estimated = estimateUsd(call.model, call.inputTokens, call.outputTokens, allowlist);
  const calls = [...ledger.calls, { ...call, estimatedUsd: estimated, actualUsd: call.actualUsd ?? null }];
  return {
    ...ledger,
    calls,
    documentsProcessed: new Set(calls.map((c) => c.documentId)).size,
    estimatedUsd: Number((ledger.estimatedUsd + estimated).toFixed(6)),
    actualUsd: Number((ledger.actualUsd + (call.actualUsd ?? 0)).toFixed(6)),
  };
}
