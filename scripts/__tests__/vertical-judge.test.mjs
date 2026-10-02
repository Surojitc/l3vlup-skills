/**
 * What a bounded judgement is allowed to do to a row, and what it may never do.
 *
 *   node scripts/__tests__/vertical-judge.test.mjs
 *
 * Offline. No key, no request, no spend.
 *
 * The load-bearing property is one sentence: this can move a row out of
 * `Other` and it can do nothing else. It cannot move a row the rules placed,
 * it cannot move a row between two verticals, it cannot invent a vertical the
 * taxonomy does not declare, and a row it declines to judge is byte for byte
 * the row that exists today. Everything below either asserts that property or
 * asserts the arithmetic that keeps a run from costing more than it should.
 *
 * `sync-ats.mjs` says, of the bare "Investment Analyst" title it leaves in
 * Other, that guessing it into a vertical "would be worse than leaving it
 * visible in the Other report". That sentence is the specification. A change
 * that makes this file fail is a change that stopped honouring it.
 */

import { readFileSync } from 'node:fs';
import {
  BudgetExceeded,
  LIMITS,
  ModelCallError,
  GATEWAY_BASE_URL,
  MODEL,
  MODEL_FOR,
  ask,
  checkBudget,
  choiceConfidence,
  classify,
  costUsd,
  emptyLedger,
  fakeClient,
  liveClient,
  readChoice,
  readTransport,
  readNoul,
} from '../../lib/typesafe.mjs';
import {
  CONFIDENT,
  IN_SCOPE,
  JUDGED_VERTICALS,
  JUDGE_VERSION,
  VERTICAL_CRITERIA,
  agreement,
  decideVertical,
  judgeQuestions,
  judgeState,
  judgeable,
} from '../../lib/vertical-judge.mjs';

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`
  );
  ok ? pass++ : fail++;
};

/* ---------------------------------------------- the taxonomy is the list -- */
// A vertical the collector declares and this file does not describe is one the
// judge could never assign, and nothing would say so.

const taxonomy = JSON.parse(readFileSync(new URL('../../data/taxonomy.json', import.meta.url), 'utf8'));
const declared = taxonomy.verticals.filter((v) => v !== 'Other');

eq('every declared vertical except Other has a description', declared.filter((v) => !VERTICAL_CRITERIA[v]), []);
eq('the judge describes nothing the taxonomy does not declare', JUDGED_VERTICALS.filter((v) => !taxonomy.verticals.includes(v)), []);
eq('Other is never an option the model may pick', JUDGED_VERTICALS.includes('Other'), false);
eq('a pending vertical is not offered either', JUDGED_VERTICALS.filter((v) => (taxonomy.pending ?? []).includes(v)), []);
eq('every description is a sentence, not a label', JUDGED_VERTICALS.filter((v) => VERTICAL_CRITERIA[v].length < 40), []);
eq('the option count is far inside the 255 a Choice allows', JUDGED_VERTICALS.length < 255, true);

/* ------------------------------------------------- only Other is touched -- */

const rows = [
  { role: 'Investment Analyst Intern', vertical: 'Other' },
  { role: 'Markets Graduate Programme', vertical: 'Sales & Trading' },
  { role: 'Software Engineer Intern', vertical: 'Software Engineering' },
  { role: '   ', vertical: 'Other' },
  { role: 'Business Analyst', vertical: 'Other' },
  { vertical: 'Other' },
  null,
];
eq('only rows in Other are judged', judgeable(rows).map((r) => r.role), ['Investment Analyst Intern', 'Business Analyst']);
eq('a row with no title is left alone', judgeable(rows).some((r) => !String(r.role ?? '').trim()), false);
eq('nothing at all is judged in an empty feed', judgeable([]), []);
eq('a malformed feed judges nothing rather than throwing', judgeable(null), []);

/* --------------------------------------------------------- the decision -- */

const answer = (over = {}) => ({
  inScope: 0.95,
  choice: 'Equity Research',
  probabilities: { 'Equity Research': 0.96, Quant: 0.03, Risk: 0.01 },
  confidence: 0.94,
  ...over,
});
const decide = (over, opts) => decideVertical(answer(over), opts);

eq('a confident in-scope answer is assigned', decide().vertical, 'Equity Research');
eq('and is marked as a change', decide().changed, true);

eq('a role out of scope stays in Other', decide({ inScope: 0.1 }).vertical, 'Other');
eq('and says why', decide({ inScope: 0.1 }).reason, 'out-of-scope');
eq('a role the scope question was unsure about stays in Other', decide({ inScope: 0.5 }).vertical, 'Other');

eq('a spread choice stays in Other', decide({ confidence: 0.6 }).vertical, 'Other');
eq('and says why', decide({ confidence: 0.6 }).reason, 'not-confident-enough');
eq('exactly at the cutoff is confident enough', decide({ confidence: CONFIDENT }).changed, true);
eq('a hair under is not', decide({ confidence: CONFIDENT - 0.0001 }).changed, false);
eq('exactly at the scope floor is in scope', decide({ inScope: IN_SCOPE }).changed, true);

eq('a choice outside the taxonomy is refused', decide({ choice: 'Blockchain Strategy' }).vertical, 'Other');
eq('and named as such', decide({ choice: 'Blockchain Strategy' }).reason, 'choice-outside-taxonomy');
eq('Other offered back as a choice is refused', decide({ choice: 'Other' }).reason, 'choice-outside-taxonomy');

eq('a missing scope reading stays in Other', decide({ inScope: null }).reason, 'no-scope-reading');
eq('a missing choice stays in Other', decide({ choice: null }).reason, 'no-choice');
eq('a confidence that is not a number stays in Other', decide({ confidence: undefined }).changed, false);
eq('a confidence that is not finite stays in Other', decide({ confidence: Number.NaN }).changed, false);

// The whole safety argument in one assertion: whatever goes wrong, the row
// ends up exactly where the rules left it.
const badAnswers = [
  { inScope: null }, { choice: null }, { confidence: Number.NaN }, { choice: 'Nonsense' },
  { inScope: 0 }, { confidence: 0 }, { inScope: 0.69 }, { confidence: 0.89 },
];
eq(
  'every way of failing leaves the row in Other and none of them leaves it worse',
  badAnswers.map((a) => decide(a).vertical),
  badAnswers.map(() => 'Other'),
);
eq('a declined row is never reported as changed', badAnswers.filter((a) => decide(a).changed), []);

eq('the raw numbers survive a decline, so a cutoff can be moved without asking again',
  decide({ confidence: 0.5 }).probabilities, answer().probabilities);
eq('every decision carries the version it was made under', decide().version, JUDGE_VERSION);

// The cutoff is a parameter, which is what lets the harness sweep it.
eq('a lower cutoff assigns what the shipped one declines', decide({ confidence: 0.8 }, { confident: 0.75 }).changed, true);
eq('and the shipped cutoff still declines it', decide({ confidence: 0.8 }).changed, false);

/* ---------------------------------------------------------- the questions -- */

const q = judgeQuestions();
eq('two questions go in one request', Object.keys(q).sort(), ['inScope', 'vertical']);
eq('scope is a yes/no', q.inScope.type, 'noul');
eq('the vertical is a choice', q.vertical.type, 'choice');
eq('the choice offers every judged vertical', Object.keys(q.vertical.criteria).sort(), [...JUDGED_VERTICALS].sort());
eq('a yes and a no are both described', [typeof q.inScope.criteria.true, typeof q.inScope.criteria.false], ['string', 'string']);
// Editing the returned map must not edit the module's copy.
delete q.vertical.criteria['Quant'];
eq('the criteria handed out are a copy', Object.keys(judgeQuestions().vertical.criteria).includes('Quant'), true);

/* -------------------------------------------------------------- the state -- */

const state = judgeState({
  role: 'Investment Analyst Intern', firm: 'Robinhood', tier: 'Fintech',
  location: 'Menlo Park, CA', applicationUrl: 'https://example.com', id: 'x', slug: 'y',
});
eq('the state is four fields and no more', Object.keys(state).sort(), ['firm', 'firmKind', 'location', 'title']);
eq('nothing the question does not need is sent', JSON.stringify(state).includes('example.com'), false);
eq('a very long title is truncated rather than sent whole', judgeState({ role: 'x'.repeat(5000) }).title.length, 300);
eq('an absent location is null rather than an empty string', judgeState({ role: 'a' }).location, null);

/* ---------------------------------------------------------- the confidence -- */

eq('all the weight on one option is certainty', choiceConfidence({ a: 1, b: 0 }), 1);
eq('an even split across 22 is no confidence', Math.round(choiceConfidence(Object.fromEntries(JUDGED_VERTICALS.map((v) => [v, 1 / 22]))) * 1000) / 1000, 0);
eq('one option at 0.96 out of 22 reads high', choiceConfidence({ ...Object.fromEntries(JUDGED_VERTICALS.map((v) => [v, 0.04 / 21])), 'Quant': 0.96 }) > 0.9, true);
eq('nothing at all is no confidence', choiceConfidence(undefined), 0);

/* -------------------------------------------------------- reading answers -- */

eq('a yes/no reads as its probability', readNoul({ a: { type: 'noul', noul: 0.4 } }, 'a'), 0.4);
eq('a missing answer reads as null', readNoul({}, 'a'), null);
eq('an answer of the wrong type reads as null', readNoul({ a: { type: 'choice' } }, 'a'), null);
eq('a choice reads as winner and distribution', readChoice({ c: { type: 'choice', choice: 'b', probabilities: { a: 0.2, b: 0.8 } } }, 'c'),
  { choice: 'b', probabilities: { a: 0.2, b: 0.8 } });
eq('a choice with no distribution reads as null', readChoice({ c: { type: 'choice', choice: 'b' } }, 'c'), null);

/* ------------------------------------------------------------- the budget -- */

eq('a fresh ledger has spent nothing', emptyLedger().actualUsd, 0);
eq('a ledger records which model it is for', emptyLedger().model, MODEL);
eq('a run cannot raise its own budget past the hard stop', emptyLedger({ budgetUsd: 1e6 }).budgetUsd, LIMITS.hardStopUsd);
eq('a smaller budget is kept', emptyLedger({ budgetUsd: 0.05 }).budgetUsd, 0.05);

const ok = { questions: 2, stateChars: 200 };
eq('an ordinary request is allowed', checkBudget(emptyLedger(), ok).allowed, true);
eq('too many questions is refused', checkBudget(emptyLedger(), { ...ok, questions: LIMITS.maxQuestionsPerRequest + 1 }).allowed, false);
eq('too much state is refused', checkBudget(emptyLedger(), { ...ok, stateChars: LIMITS.maxStateChars + 1 }).allowed, false);
eq('the request ceiling is refused at it, not past it', checkBudget({ ...emptyLedger(), requests: LIMITS.maxRequests }, ok).allowed, false);
eq('a spent budget is refused', checkBudget({ ...emptyLedger(), actualUsd: 5 }, ok).allowed, false);
eq('a refusal always says why', typeof checkBudget({ ...emptyLedger(), actualUsd: 5 }, ok).reason, 'string');

/* ----------------------------------------------------------- the transport -- */
// Two ways out, and which one is used follows from which credential exists.
// The Gateway first, because a key issued there carries its own spending limit
// and its own expiry, which is what a one-off evaluation wants: the cap lives
// on the credential rather than on this file's good intentions.

eq('nothing configured has no route out', readTransport({}), 'none');
eq('a gateway key goes through the gateway', readTransport({ AI_GATEWAY_API_KEY: 'k' }), 'gateway');
eq('a typesafe key goes direct', readTransport({ TYPESAFE_API_KEY: 'k' }), 'direct');
eq('with both, the capped one wins', readTransport({ TYPESAFE_API_KEY: 'a', AI_GATEWAY_API_KEY: 'b' }), 'gateway');
eq('an empty value is not a credential', readTransport({ AI_GATEWAY_API_KEY: '  ' }), 'none');
eq('no credential means no client, rather than a client that fails later', liveClient({ env: {} }), null);

// Same model, two names: the gateway namespaces model ids, TypeSafe's own
// endpoint does not take the namespaced form.
eq('the gateway is asked for the namespaced model', MODEL_FOR.gateway, 'typesafe-ai/jev');
eq('the direct endpoint is asked for a pinned version', MODEL_FOR.direct, 'jev-1.13.0');
eq('and the pinned one is not an alias', MODEL.includes('latest'), false);
eq('the gateway url is the documented one', GATEWAY_BASE_URL, 'https://ai-gateway.vercel.sh/typesafe');
eq('a ledger records which route it was spent on', emptyLedger({ transport: 'gateway' }).transport, 'gateway');
eq('and which model that meant', emptyLedger({ transport: 'gateway' }).model, 'typesafe-ai/jev');

// A capped evaluation key is most likely to fail by running out, so that
// failure has its own name rather than being read as a transport problem.
eq('a spent budget is named', classify({ status: 402 }), 'budget_exceeded');

// The gateway reports what it billed. Prefer it to arithmetic over a price
// list that can move without anybody noticing.
const billed = emptyLedger();
await ask(
  fakeClient(() => ({
    answers: { inScope: { type: 'noul', noul: 0.9 } },
    usage: { input_tokens: 1000, output_tokens: 0 },
    provider_metadata: { gateway: { cost: '0.00004200' } },
  })),
  billed,
  { state, questions: judgeQuestions() },
);
eq('the reported cost is what the run is charged', billed.actualUsd, 0.000042);
const computed = emptyLedger();
await ask(
  fakeClient(() => ({ answers: {}, usage: { input_tokens: 1000, output_tokens: 0 } })),
  computed,
  { state, questions: judgeQuestions() },
);
eq('and without a reported cost the arithmetic stands in', computed.actualUsd, costUsd(1000));

/* --------------------------------------------------------------- the cost -- */

eq('the published rate is per million input tokens', costUsd(1_000_000), 0.042);
eq('output tokens are not priced, because they are free', costUsd(0), 0);
eq('a thousand-token judgement is well under a hundredth of a penny', costUsd(1000) < 0.0001, true);
// The whole board, judged every day for a month, against what one marked
// answer on the paid Claude model costs.
const ONE_MARK_USD = (1500 / 1e6) * 2 + (2000 / 1e6) * 10;
eq('judging 1,386 rows daily for a month costs less than 100 marked answers',
  costUsd(1100 * 1386 * 30) < ONE_MARK_USD * 100, true);

/* ------------------------------------------------------------ one request -- */

const answered = (usage) => fakeClient(() => ({
  model: MODEL,
  answers: { inScope: { type: 'noul', noul: 0.9 }, vertical: { type: 'choice', choice: 'Quant', probabilities: { Quant: 0.95, Risk: 0.05 } } },
  usage,
}));

const ledger = emptyLedger();
const result = await ask(answered({ input_tokens: 1000, output_tokens: 0 }), ledger, { state, questions: judgeQuestions() });
eq('a good answer comes back', result.answers.vertical.choice, 'Quant');
eq('and the run is charged for it', ledger.actualUsd, costUsd(1000));
eq('and the request is counted', ledger.requests, 1);

const thrown = async (client, l = emptyLedger()) => {
  try {
    await ask(client, l, { state, questions: judgeQuestions() });
    return 'no error';
  } catch (err) {
    return err instanceof BudgetExceeded ? `budget: ${err.message}` : err instanceof ModelCallError ? err.reason : 'wrong error type';
  }
};

// Taken from the thesis pipeline's rule: a response we cannot cost is a
// failure whatever it says.
eq('a response with no token count is a failure', await thrown(answered({ output_tokens: 0 })), 'missing_usage');
eq('a token count that is not a number is a failure', await thrown(answered({ input_tokens: 'lots' })), 'missing_usage');
eq('a response with no answers is a failure', await thrown(fakeClient(() => ({ usage: { input_tokens: 5 } }))), 'malformed_response');
eq('nothing at all is a failure', await thrown(fakeClient(() => null)), 'malformed_response');

const spent = { ...emptyLedger(), actualUsd: 99 };
eq('a request past the budget throws before it is made', (await thrown(answered({ input_tokens: 1 }), spent)).startsWith('budget:'), true);
eq('and the ledger records that the run stopped', spent.stopped, true);

const counting = fakeClient(() => { throw Object.assign(new Error('nope'), { name: 'RateLimitError', status: 429 }); });
eq('a transport failure is reported by category', await thrown(counting), 'rate_limited');

/* ------------------------------------------------------------ the classes -- */

eq('a timeout', classify({ name: 'APITimeoutError' }), 'timeout');
eq('a bad key', classify({ name: 'AuthenticationError' }), 'no_credential');
eq('a refused key', classify({ name: 'PermissionDeniedError' }), 'no_credential');
eq('a dropped connection', classify({ name: 'APIConnectionError' }), 'connection');
eq('anything else with a status', classify({ name: 'InternalServerError', status: 500 }), 'api_error');
eq('and anything else at all', classify(new Error('?')), 'unknown');

/* ----------------------------------------------------------- the agreement -- */

eq('agreement counts the three outcomes apart', agreement([
  { expected: 'Quant', got: 'Quant', changed: true },
  { expected: 'Quant', got: 'Risk', changed: true },
  { expected: 'Risk', got: 'Other', changed: false },
]), {
  total: 3, agreed: 1, disagreed: 1, declined: 1,
  byVertical: { Quant: { total: 2, agreed: 1, disagreed: 1, declined: 0 }, Risk: { total: 1, agreed: 0, disagreed: 0, declined: 1 } },
  accuracyWhenDecided: 0.5, coverage: 2 / 3,
});
eq('a decline is never counted as a wrong answer', agreement([{ expected: 'Quant', got: 'Other', changed: false }]).disagreed, 0);
eq('nothing judged reports no accuracy rather than a perfect one', agreement([]).accuracyWhenDecided, null);

/* ------------------------------------------------- what the harness is not -- */

const harness = readFileSync(new URL('../vertical-eval.mjs', import.meta.url), 'utf8');
eq('the harness writes no file', /writeFileSync|appendFileSync|mkdirSync|createWriteStream/.test(harness), false);
eq('the harness is live only when asked in so many words', harness.includes("flag('live')"), true);
eq('and refuses to pretend, rather than falling back to the stub, when a live run has no key', harness.includes('process.exit(2)'), true);
eq('the offline mode says in its own output that it measures nothing about the model', harness.includes('measures nothing about the model'), true);

const workflows = readFileSync(new URL('../../.github/workflows/collect.yml', import.meta.url), 'utf8');
eq('nothing in the daily collection calls this', /vertical-eval|typesafe|TYPESAFE/i.test(workflows), false);

const collector = readFileSync(new URL('../sync-ats.mjs', import.meta.url), 'utf8');
eq('the collector is untouched by any of this', /typesafe|vertical-judge/i.test(collector), false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
