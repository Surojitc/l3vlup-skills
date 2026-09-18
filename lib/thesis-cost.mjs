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
export const MODEL_ALLOWLIST = Object.freeze({
  'claude-haiku-4-5-20251001': { inputPerMTok: 1.00, outputPerMTok: 5.00, role: 'extraction' },
  'claude-sonnet-5': { inputPerMTok: 3.00, outputPerMTok: 15.00, role: 'escalation on a failed verification' },
});

export const LIMITS = Object.freeze({
  maxDocuments: 9,
  maxChunksPerDocument: 12,
  maxInputTokensPerDocument: 120_000,
  maxOutputTokensPerDocument: 8_000,
  maxInputTokensPerCall: 40_000,
  maxOutputTokensPerCall: 4_000,
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
