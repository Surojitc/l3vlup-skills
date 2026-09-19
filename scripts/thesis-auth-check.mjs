#!/usr/bin/env node
// Prove the federated credential works, and spend nothing.
//
// This is the smoke test between configuring the Console and running the paid
// pilot. It answers one question: can this workflow run, on this branch, in
// this repository, obtain an Anthropic token and use it?
//
// It does three things and nothing else. The SDK exchanges the GitHub identity
// token for an access token; `models.retrieve` confirms the token is accepted
// and the pilot model exists; the result is printed. The Models API is not an
// inference endpoint and is not billed.
//
// It cannot do more than that. It imports no fetcher, so it cannot reach SEC;
// it never builds a model or calls `messages.create`, so it cannot spend a
// token. `scripts/__tests__/thesis-federation.test.mjs` asserts both by
// reading this file.
//
//   node scripts/thesis-auth-check.mjs

import { preflightModel, realClient } from '../lib/thesis-anthropic.mjs';
import { MODEL_ALLOWLIST, PILOT_MODEL, resolveModelId } from '../lib/thesis-cost.mjs';

const say = (line) => process.stdout.write(`${line}\n`);

async function main() {
  const modelId = resolveModelId(process.env.MODEL || PILOT_MODEL);
  if (!MODEL_ALLOWLIST[modelId]) {
    console.error(`${modelId} is not on the allowlist: ${Object.keys(MODEL_ALLOWLIST).join(', ')}`);
    process.exit(2);
  }

  // Report what the run is, never the credential. These are the claims the
  // federation rule matches on, so a refusal can be read straight against the
  // rule in the Console's authentication history.
  say('Authentication check. No document is fetched and no inference call is made.');
  say('');
  say(`  repository    ${process.env.GITHUB_REPOSITORY ?? '(not in Actions)'}`);
  say(`  ref           ${process.env.GITHUB_REF ?? '-'}`);
  say(`  event         ${process.env.GITHUB_EVENT_NAME ?? '-'}`);
  say(`  workflow_ref  ${process.env.GITHUB_WORKFLOW_REF ?? '-'}`);
  say(`  rule          ${process.env.ANTHROPIC_FEDERATION_RULE_ID ?? '(unset)'}`);
  say(`  service acct  ${process.env.ANTHROPIC_SERVICE_ACCOUNT_ID ?? '(unset)'}`);
  say(`  model         ${modelId}`);
  say('');

  let client;
  try {
    client = await realClient();
  } catch (err) {
    console.error(`Could not build a client: ${String(err?.message ?? err).slice(0, 300)}`);
    process.exit(1);
  }

  // The exchange happens here, on the first request the SDK makes.
  const result = await preflightModel(modelId, { client });
  if (!result.ok) {
    console.error(`FAILED: ${result.reason}`);
    console.error('');
    console.error('A refused exchange returns the same opaque 401 whichever check failed.');
    console.error('The reason is in the Console under Settings > Workload identity > History;');
    console.error('compare the claims above against the rule.');
    process.exit(1);
  }

  say('PASSED');
  say(`  the identity token was exchanged and the token was accepted`);
  say(`  ${result.id}${result.displayName ? ` (${result.displayName})` : ''}, context ${result.maxInputTokens ?? 'unknown'} tokens`);
  say('');
  say('Nothing was spent: the Models API is not an inference endpoint.');
}

main().catch((err) => {
  console.error(`FAILED: ${String(err?.message ?? err).slice(0, 300)}`);
  process.exit(1);
});
