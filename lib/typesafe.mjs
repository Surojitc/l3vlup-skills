// The one place this repository puts a question to TypeSafe.
//
// Everything that decides anything lives beside it in a module that calls
// nothing, the same split `lib/thesis-model.mjs` already draws around the
// Anthropic client: a shape, a deterministic fake, and exactly one file that
// holds a key. A test drives the fake and never spends a penny.
//
// WHAT THIS IS FOR, AND WHAT IT IS NOT FOR
// ----------------------------------------
// The collectors in this repository classify with regular expressions, on
// purpose. The comments say so repeatedly, and they are right to: a rule you
// can read is auditable, reproducible, free, and cannot invent a vertical that
// was never in the taxonomy. Nothing here proposes replacing any of that.
//
// It is for the cases those rules already refuse to answer. `inferVertical`
// returns `Other` for a quarter of the live board, and the code says plainly
// why a bare "Investment Analyst" is left there: the title is ambiguous and
// guessing is worse than admitting it. That is a judgement, not a missing
// rule, and a judgement priced at $0.042 per million input tokens is a
// different proposition from one priced at a reasoning model's rate.
//
// THE RULE THAT DOES NOT BEND
// ---------------------------
// A wrong vertical is worse than `Other`. `Other` is visible, countable and
// obviously incomplete; a confident wrong label looks exactly like a right
// one and nothing downstream would catch it. So the judge only ever moves a
// row that is already `Other`, it never overrides a rule that fired, and it
// declines unless the answer is concentrated. Everything else stays where the
// regular expressions put it.

import { TypeSafeClient } from '@typesafe-ai/sdk';

/** Vercel's TypeSafe-compatible endpoint. Same request shape, same SDK. */
export const GATEWAY_BASE_URL = 'https://ai-gateway.vercel.sh/typesafe';

/**
 * Same model, two names.
 *
 * The Gateway namespaces model ids by provider and does not accept TypeSafe's
 * bare versioned id; TypeSafe's own endpoint does not accept the namespaced
 * one. Which name goes on the wire follows from which credential was found.
 */
export const MODEL_FOR = { gateway: 'typesafe-ai/jev', direct: 'jev-1.13.0' };

/**
 * The direct id, pinned rather than `jev-latest`.
 *
 * The confidence cutoff in `lib/vertical-judge.mjs` is meant to be calibrated
 * against observed answers. An alias that moves under a calibrated threshold
 * throws the calibration away without telling anybody. The Gateway exposes no
 * versioned id today, which is a real difference between the two routes and a
 * reason to record which one an evaluation ran on.
 */
export const MODEL = MODEL_FOR.direct;

/**
 * Which route out, given what the environment offers.
 *
 * The Gateway first, because a key issued there can carry its own spending
 * limit and its own expiry, which is exactly what a one-off evaluation wants:
 * the cap lives on the credential rather than on this file's good intentions.
 * A TypeSafe key still works and is the fallback.
 */
export function readTransport(env = process.env) {
  if (env.AI_GATEWAY_API_KEY?.trim()) return 'gateway';
  if (env.TYPESAFE_API_KEY?.trim()) return 'direct';
  return 'none';
}

/** Published rate: $42 per billion input tokens. Output tokens are free. */
export const INPUT_USD_PER_MTOK = 0.042;

export const costUsd = (inputTokens) => (inputTokens / 1_000_000) * INPUT_USD_PER_MTOK;

/**
 * A ceiling on a run, checked before each call rather than after it.
 *
 * The same shape as `lib/thesis-cost.mjs`, and for the same reason stated
 * there: a ceiling enforced after the spend is not a ceiling. Far smaller
 * numbers here, because Jev is far cheaper, but a runaway loop is a runaway
 * loop at any unit price.
 */
export const LIMITS = Object.freeze({
  maxRequests: 200,
  maxQuestionsPerRequest: 40,
  maxStateChars: 24_000,
  hardStopUsd: 1.0,
});

export class BudgetExceeded extends Error {}
export class ModelCallError extends Error {
  constructor(reason, message) {
    super(message);
    this.reason = reason;
  }
}

export function emptyLedger({ budgetUsd = LIMITS.hardStopUsd, transport = readTransport() } = {}) {
  return {
    transport,
    model: MODEL_FOR[transport] ?? MODEL,
    budgetUsd: Math.min(budgetUsd, LIMITS.hardStopUsd),
    requests: 0,
    inputTokens: 0,
    actualUsd: 0,
    stopped: false,
    stopReason: null,
  };
}

/**
 * The fake, and the only implementation a test ever sees.
 *
 * Answers from a function keyed by the question map, so a suite asserts on the
 * whole output rather than on its shape, and a rerun returns the same thing.
 */
export function fakeClient(answer) {
  const calls = [];
  return {
    calls,
    async systemOne({ state, questions }) {
      calls.push({ state, questions });
      return answer({ state, questions, calls });
    },
  };
}

/**
 * A client, or nothing.
 *
 * Nothing is the answer whenever the key is absent, and every caller has to
 * cope with it. This repository's whole posture is that a collector which
 * cannot reach a source fails loudly rather than publishing a thinner feed, so
 * a judge that cannot reach TypeSafe reports that it could not, and the rows
 * stay exactly as the rules classified them.
 */
export function liveClient({ timeoutMs = 20_000, maxRetries = 2, env = process.env } = {}) {
  const transport = readTransport(env);
  if (transport === 'none') return null;
  const key = (transport === 'gateway' ? env.AI_GATEWAY_API_KEY : env.TYPESAFE_API_KEY).trim();
  return new TypeSafeClient({
    apiKey: key,
    ...(transport === 'gateway' ? { baseURL: GATEWAY_BASE_URL } : {}),
    defaultModel: MODEL_FOR[transport],
    timeout: timeoutMs,
    // The SDK's `debug` level prints request and response bodies unredacted.
    // The body here is a job posting, which is public, but the habit is not
    // one to form in a repository that also reads filings.
    logLevel: 'warn',
    retry: { maxRetries },
  });
}

/** True when the request would take the run past a ceiling. Checked first. */
export function checkBudget(ledger, { questions, stateChars }) {
  if (questions > LIMITS.maxQuestionsPerRequest) {
    return { allowed: false, reason: `${questions} questions is over the ${LIMITS.maxQuestionsPerRequest} per request` };
  }
  if (stateChars > LIMITS.maxStateChars) {
    return { allowed: false, reason: `${stateChars} characters of state is over the ${LIMITS.maxStateChars} ceiling` };
  }
  if (ledger.requests >= LIMITS.maxRequests) {
    return { allowed: false, reason: `the ${LIMITS.maxRequests}-request ceiling for one run is reached` };
  }
  if (ledger.actualUsd >= ledger.budgetUsd) {
    return { allowed: false, reason: `the run's $${ledger.budgetUsd} budget is spent` };
  }
  return { allowed: true, reason: null };
}

/**
 * One request, budget-checked before and accounted for after.
 *
 * Throws rather than returning a partial answer. A caller that wants to carry
 * on past a failure has to say so, because the alternative — a run that
 * quietly classified some rows and not others, and reported a number as if it
 * had done them all — is the exact failure this repository spent September
 * fixing in its collectors.
 */
export async function ask(client, ledger, { state, questions }) {
  const names = Object.keys(questions);
  const stateChars = JSON.stringify(state).length;
  const budget = checkBudget(ledger, { questions: names.length, stateChars });
  if (!budget.allowed) {
    ledger.stopped = true;
    ledger.stopReason = budget.reason;
    throw new BudgetExceeded(budget.reason);
  }

  let response;
  try {
    response = await client.systemOne({ state, questions, model: MODEL });
  } catch (err) {
    throw new ModelCallError(classify(err), `the request failed: ${classify(err)}`);
  }

  if (!response || typeof response !== 'object' || !response.answers) {
    throw new ModelCallError('malformed_response', 'the response carried no answers');
  }
  const inputTokens = Number(response.usage?.input_tokens);
  if (!Number.isFinite(inputTokens)) {
    // Borrowed verbatim from the thesis pipeline's reasoning: a response we
    // cannot cost is a failure whatever it says.
    throw new ModelCallError('missing_usage', 'the response carried no usable token count');
  }

  // The Gateway reports what it billed, surcharge included. Prefer it to
  // arithmetic over a price list that can move without anybody noticing.
  const reported = Number(response.provider_metadata?.gateway?.cost);
  ledger.requests += 1;
  ledger.inputTokens += inputTokens;
  ledger.actualUsd += Number.isFinite(reported) ? reported : costUsd(inputTokens);
  return { answers: response.answers, inputTokens };
}

/** The class of a failure, from the error's own name. Never its message. */
export function classify(err) {
  switch (err?.name) {
    case 'APITimeoutError': return 'timeout';
    case 'RateLimitError': return 'rate_limited';
    case 'AuthenticationError':
    case 'PermissionDeniedError': return 'no_credential';
    case 'APIUserAbortError': return 'aborted';
    case 'APIConnectionError': return 'connection';
    default:
      // The Gateway answers 402 when a budget in scope is spent. Retrying
      // cannot help, and it is the one failure a capped evaluation key is
      // most likely to produce, so it gets its own name.
      if (err?.status === 402) return 'budget_exceeded';
      return typeof err?.status === 'number' ? 'api_error' : 'unknown';
  }
}

/**
 * Confidence, as TypeSafe derives it from a Choice distribution.
 *
 * `(n × peak − 1) / (n − 1)`, clamped. Recomputed here so a stored
 * distribution can be re-judged at a different cutoff without asking again,
 * which is most of the point of keeping the probabilities.
 */
export function choiceConfidence(probabilities) {
  const values = Object.values(probabilities ?? {});
  if (values.length < 2) return values.length === 1 ? 1 : 0;
  const peak = Math.max(...values);
  return Math.max(0, Math.min(1, (values.length * peak - 1) / (values.length - 1)));
}

/** A yes/no probability, or null for anything that is not one. */
export function readNoul(answers, key) {
  const a = answers?.[key];
  if (!a || a.type !== 'noul') return null;
  return Number.isFinite(a.noul) ? a.noul : null;
}

/** A choice and its distribution, or null. */
export function readChoice(answers, key) {
  const a = answers?.[key];
  if (!a || a.type !== 'choice' || typeof a.choice !== 'string') return null;
  if (!a.probabilities || typeof a.probabilities !== 'object') return null;
  const probabilities = {};
  for (const [k, v] of Object.entries(a.probabilities)) {
    if (Number.isFinite(v)) probabilities[k] = v;
  }
  return Object.keys(probabilities).length ? { choice: a.choice, probabilities } : null;
}
