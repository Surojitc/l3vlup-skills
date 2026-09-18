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
  maxInputTokensPerDocument: 120_000,
  maxOutputTokensPerDocument: 8_000,
  maxModelCalls: 18,           // one extraction per document, one escalation
  hardStopUsd: 15.00,
  promptVersion: 'thesis-extract-v1',
});

export const estimateUsd = (model, inTok, outTok) => {
  const p = MODEL_ALLOWLIST[model];
  if (!p) return null;
  return (inTok / 1e6) * p.inputPerMTok + (outTok / 1e6) * p.outputPerMTok;
};

export const emptyCostLedger = () => ({
  costVersion: COST_VERSION,
  promptVersion: LIMITS.promptVersion,
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
export function checkBudget(ledger, { model, inputTokens, outputTokens, documentId }) {
  if (ledger.stopped) return { allowed: false, reason: ledger.stopReason };
  if (!MODEL_ALLOWLIST[model]) return { allowed: false, reason: `${model} is not on the allowlist: ${Object.keys(MODEL_ALLOWLIST).join(', ')}` };
  if (inputTokens > LIMITS.maxInputTokensPerDocument) return { allowed: false, reason: `${inputTokens} input tokens is over the ${LIMITS.maxInputTokensPerDocument} per-document limit` };
  if (outputTokens > LIMITS.maxOutputTokensPerDocument) return { allowed: false, reason: `${outputTokens} output tokens is over the ${LIMITS.maxOutputTokensPerDocument} per-document limit` };
  if (ledger.calls.length >= LIMITS.maxModelCalls) return { allowed: false, reason: `the ${LIMITS.maxModelCalls} call ceiling is reached` };

  const seen = new Set(ledger.calls.map((c) => c.documentId));
  if (!seen.has(documentId) && seen.size >= LIMITS.maxDocuments) {
    return { allowed: false, reason: `the ${LIMITS.maxDocuments} document ceiling is reached` };
  }
  const projected = ledger.estimatedUsd + estimateUsd(model, inputTokens, outputTokens);
  if (projected > LIMITS.hardStopUsd) {
    return { allowed: false, reason: `this call would reach $${projected.toFixed(2)}, over the $${LIMITS.hardStopUsd.toFixed(2)} hard stop` };
  }
  return { allowed: true, reason: null, projectedUsd: projected };
}

/** Record a call. A refused call stops the run; it never falls back. */
export function recordCall(ledger, call) {
  const check = checkBudget(ledger, call);
  if (!check.allowed) {
    return { ...ledger, stopped: true, stopReason: check.reason };
  }
  const estimated = estimateUsd(call.model, call.inputTokens, call.outputTokens);
  const calls = [...ledger.calls, { ...call, estimatedUsd: estimated, actualUsd: call.actualUsd ?? null }];
  return {
    ...ledger,
    calls,
    documentsProcessed: new Set(calls.map((c) => c.documentId)).size,
    estimatedUsd: Number((ledger.estimatedUsd + estimated).toFixed(6)),
    actualUsd: Number((ledger.actualUsd + (call.actualUsd ?? 0)).toFixed(6)),
  };
}
