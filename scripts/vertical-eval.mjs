#!/usr/bin/env node
// Does a bounded judgement place the roles the rules cannot, and at what price?
//
//   node scripts/vertical-eval.mjs                  # offline, deterministic, free
//   node scripts/vertical-eval.mjs --live --limit 60
//
// Read-only and standalone. It writes no data file, it is wired into no
// workflow, and it changes no row on the board. It exists to answer one
// question with numbers before anybody proposes changing the collector:
// `inferVertical` leaves a quarter of the live tracker in `Other`, and this
// says how much of that a cheap typed judgement would recover, how often it
// agrees with the rules where the rules are confident, and what a month of it
// would cost.
//
// WHAT IT MEASURES, AND WHAT IT CANNOT
// ------------------------------------
// There is no hand-labelled set of these roles. What there is, is 1,023 rows
// the regular expressions did place, and those are a fair test of a different
// thing: whether the judge reads the taxonomy the way this repository does.
// So the harness runs two passes.
//
//   control   rows the rules placed. The rules are the label. Disagreement
//             here is the honest error rate on roles whose vertical is not in
//             doubt, and a judge that cannot pass this has no business being
//             trusted on the ambiguous ones.
//
//   recovery  rows the rules left in `Other`. There is no label. What it
//             reports is coverage — how many the judge is confident enough to
//             place — and where they land, for a person to read.
//
// Coverage is not accuracy. A judge that confidently placed every row would
// score 100% coverage and could still be wrong about all of them. The control
// pass is what bounds that, and the two numbers only mean anything together.
//
// The offline mode answers from a deterministic stub, so the plumbing, the
// budget, the cutoffs and the arithmetic are all exercised in `npm test` with
// no key and no spend. It proves the harness works. It proves nothing about
// Jev, and it says so in its own output rather than leaving a reader to infer
// it from a number that looks like a result.

import { readFileSync } from 'node:fs';
import {
  BudgetExceeded,
  ModelCallError,
  ask,
  choiceConfidence,
  costUsd,
  emptyLedger,
  fakeClient,
  liveClient,
  readChoice,
  readNoul,
} from '../lib/typesafe.mjs';
import {
  CONFIDENT,
  IN_SCOPE,
  JUDGED_VERTICALS,
  JUDGE_VERSION,
  agreement,
  decideVertical,
  judgeQuestions,
  judgeState,
  judgeable,
} from '../lib/vertical-judge.mjs';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const LIVE = flag('live');
const LIMIT = Number(value('limit', '80'));
const FEED = value('feed', 'data/opportunities.auto.json');
const CUTOFFS = [0.7, 0.8, 0.85, 0.9, 0.95];

function loadRows(path) {
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  const rows = Array.isArray(parsed) ? parsed : parsed.opportunities ?? parsed.roles ?? [];
  if (!rows.length) throw new Error(`no rows in ${path}`);
  return rows;
}

/**
 * The offline stand-in.
 *
 * Deterministic and openly crude: it scores each vertical by how many words
 * its description shares with the title, and turns that into a distribution.
 * It is a stub for the transport, not a model, and every number it produces
 * is labelled as such in the output.
 */
function stubClient() {
  return fakeClient(({ state, questions }) => {
    const title = String(state.title ?? '').toLowerCase();
    const words = new Set(title.split(/[^a-z0-9]+/).filter((w) => w.length > 3));
    const raw = {};
    let total = 0;
    for (const [vertical, description] of Object.entries(questions.vertical.criteria)) {
      const terms = String(description).toLowerCase().split(/[^a-z0-9]+/);
      const hits = terms.filter((t) => t.length > 3 && words.has(t)).length;
      const score = Math.exp(hits);
      raw[vertical] = score;
      total += score;
    }
    const probabilities = {};
    for (const [k, v] of Object.entries(raw)) probabilities[k] = v / total;
    const choice = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0][0];
    const support = /\b(people|workplace|facilities|recruit|marketing|communications|office|vendor|experience)\b/.test(title);
    return {
      model: 'stub',
      answers: {
        inScope: { type: 'noul', noul: support ? 0.08 : 0.93 },
        vertical: {
          type: 'choice',
          choice,
          probabilities,
          confidence: choiceConfidence(probabilities),
        },
      },
      // Estimated from the bytes actually serialised for this request, the
      // same `chars / 3.5` the thesis pipeline uses, rather than invented.
      // The token count is therefore a real measurement of request size even
      // though the answers above are not real answers. The 22 option
      // descriptions dominate it, which is why one row per request is the
      // right shape: batching rows would repeat the criteria per question and
      // save nothing.
      usage: {
        input_tokens: Math.ceil(JSON.stringify({ state, questions }).length / 3.5),
        output_tokens: 0,
      },
    };
  });
}

async function judgeRows(client, ledger, rows) {
  const results = [];
  for (const row of rows) {
    const state = judgeState(row);
    let answers;
    try {
      ({ answers } = await ask(client, ledger, { state, questions: judgeQuestions() }));
    } catch (err) {
      if (err instanceof BudgetExceeded) {
        console.error(`\nstopped: ${err.message}`);
        break;
      }
      if (err instanceof ModelCallError) {
        console.error(`\nstopped: ${err.reason} — ${err.message}`);
        break;
      }
      throw err;
    }
    const choice = readChoice(answers, 'vertical');
    results.push({
      row,
      inScope: readNoul(answers, 'inScope'),
      choice: choice?.choice ?? null,
      probabilities: choice?.probabilities ?? null,
      confidence: choice ? choiceConfidence(choice.probabilities) : null,
    });
  }
  return results;
}

const pct = (n) => (n === null || n === undefined ? '  n/a' : `${(n * 100).toFixed(1)}%`);

function reportControl(results) {
  console.log('\nCONTROL — rows the rules placed, judged blind');
  console.log('  The rules are the label. Disagreement here is the error rate on roles');
  console.log('  whose vertical is not in doubt.\n');
  console.log('  cutoff   coverage   agreement when it decided');
  for (const cutoff of CUTOFFS) {
    const pairs = results.map((r) => {
      const d = decideVertical(r, { confident: cutoff });
      return { expected: r.row.vertical, got: d.vertical, changed: d.changed };
    });
    const a = agreement(pairs);
    const marker = cutoff === CONFIDENT ? '  <- shipped' : '';
    console.log(`  ${cutoff.toFixed(2)}     ${pct(a.coverage)}      ${pct(a.accuracyWhenDecided)}${marker}`);
  }

  const shipped = results.map((r) => {
    const d = decideVertical(r);
    return { expected: r.row.vertical, got: d.vertical, changed: d.changed, title: r.row.role };
  });
  const wrong = shipped.filter((p) => p.changed && p.got !== p.expected);
  if (wrong.length) {
    console.log(`\n  disagreements at ${CONFIDENT} (${wrong.length}), which are the cases to read:`);
    for (const w of wrong.slice(0, 12)) {
      console.log(`    ${String(w.title).slice(0, 52).padEnd(54)} rules: ${w.expected}  judge: ${w.got}`);
    }
  }
}

function reportRecovery(results, otherTotal) {
  console.log('\nRECOVERY — rows the rules left in Other, where there is no label');
  console.log('  Coverage only. How many it is confident enough to place, and where.');
  console.log('  This is not an accuracy figure and must not be read as one.\n');
  console.log('  cutoff   placed    left in Other');
  for (const cutoff of CUTOFFS) {
    const decided = results.map((r) => decideVertical(r, { confident: cutoff }));
    const placed = decided.filter((d) => d.changed).length;
    const marker = cutoff === CONFIDENT ? '  <- shipped' : '';
    console.log(
      `  ${cutoff.toFixed(2)}     ${pct(placed / results.length)}    ${pct(1 - placed / results.length)}${marker}`,
    );
  }

  const shipped = results.map((r) => ({ d: decideVertical(r), title: r.row.role, firm: r.row.firm }));
  const reasons = {};
  const landed = {};
  for (const { d } of shipped) {
    reasons[d.reason] = (reasons[d.reason] ?? 0) + 1;
    if (d.changed) landed[d.vertical] = (landed[d.vertical] ?? 0) + 1;
  }
  console.log('\n  why a row stayed in Other:');
  for (const [reason, n] of Object.entries(reasons).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(n).padStart(4)}  ${reason}`);
  }
  console.log('\n  where the placed rows landed:');
  for (const [vertical, n] of Object.entries(landed).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(n).padStart(4)}  ${vertical}`);
  }
  console.log('\n  a sample, for reading rather than counting:');
  for (const s of shipped.filter((x) => x.d.changed).slice(0, 12)) {
    console.log(`    ${String(s.title).slice(0, 46).padEnd(48)} ${String(s.firm).slice(0, 16).padEnd(18)} -> ${s.d.vertical}`);
  }
  if (results.length < otherTotal) {
    console.log(`\n  (${results.length} of ${otherTotal} Other rows sampled; raise --limit for more)`);
  }
}

function reportCost(ledger, otherTotal, controlTotal) {
  const perRow = ledger.requests ? ledger.inputTokens / ledger.requests : 0;
  console.log('\nCOST');
  console.log(`  requests            ${ledger.requests}`);
  console.log(`  input tokens        ${Math.round(ledger.inputTokens).toLocaleString()} (${Math.round(perRow)} per row)`);
  console.log(`  spent this run      $${ledger.actualUsd.toFixed(6)}`);
  console.log(`  output tokens       free, by TypeSafe's published pricing`);
  const daily = costUsd(perRow * otherTotal);
  console.log(`\n  one full daily pass over ${otherTotal} Other rows: $${daily.toFixed(4)}`);
  console.log(`  a month of daily passes:                  $${(daily * 30).toFixed(3)}`);
  console.log(`  a month if every row were judged (${otherTotal + controlTotal}):    $${(costUsd(perRow * (otherTotal + controlTotal)) * 30).toFixed(3)}`);
}

async function main() {
  const rows = loadRows(FEED);
  const other = judgeable(rows);
  const placed = rows.filter((r) => r.vertical && r.vertical !== 'Other' && JUDGED_VERTICALS.includes(r.vertical));

  console.log(`judge ${JUDGE_VERSION} · cutoff ${CONFIDENT} · in-scope floor ${IN_SCOPE}`);
  console.log(`feed ${FEED}: ${rows.length} rows, ${other.length} in Other (${pct(other.length / rows.length)})`);

  let client;
  if (LIVE) {
    client = liveClient();
    if (!client) {
      console.error('\n--live needs TYPESAFE_API_KEY in the environment. Nothing was called.');
      process.exit(2);
    }
    console.log('mode: LIVE — this run calls the API and spends money.');
  } else {
    client = stubClient();
    console.log('mode: OFFLINE — answers come from a deterministic stub, not from Jev.');
    console.log('      Every figure below exercises the harness and measures nothing about the model.');
  }

  // Sampled evenly rather than from the head, so one firm's board of interns
  // does not become the whole control set.
  const stride = (list, n) => {
    if (list.length <= n) return list;
    const step = list.length / n;
    return Array.from({ length: n }, (_, i) => list[Math.floor(i * step)]);
  };

  const ledger = emptyLedger();
  const controlRows = stride(placed, Math.min(LIMIT, placed.length));
  const otherRows = stride(other, Math.min(LIMIT, other.length));

  reportControl(await judgeRows(client, ledger, controlRows));
  reportRecovery(await judgeRows(client, ledger, otherRows), other.length);
  reportCost(ledger, other.length, placed.length);

  if (!LIVE) {
    console.log('\nThis was the offline stub. For a real reading:');
    console.log('  TYPESAFE_API_KEY=... node scripts/vertical-eval.mjs --live --limit 80');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
