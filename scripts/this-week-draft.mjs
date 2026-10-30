#!/usr/bin/env node
// The Thursday draft of This Week, in stages a workflow can run with
// different permissions:
//
//   node scripts/this-week-draft.mjs shortlist --out DIR [--days 7]
//   node scripts/this-week-draft.mjs fetch     --out DIR
//   node scripts/this-week-draft.mjs draft     --out DIR --budget 0.50 [--model claude-sonnet-5] [--dry-run]
//   node scripts/this-week-draft.mjs render    --out DIR
//
// shortlist reads the committed feeds (data/newsflow.auto.json and
// data/deals.auto.json) and writes the deterministic shortlist. fetch reads
// the candidate pages and the site's sitemap, one request a second. draft is
// the one stage that can spend: a single model call under a budget the
// caller states, or nothing at all with --dry-run. render writes
// data/this-week.draft.json and the report, whatever the earlier stages
// managed, so a failure is published as a failure and never as silence.
//
// The credential is never read here. The Anthropic SDK resolves it itself;
// in Actions it is a federated identity token (docs/thesis-oidc-federation.md).

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EDITION_TOOL, HARD_STOP_USD, PROMPT_VERSION, allowedPaths, approxTokens, assembleEdition, checkDraftBudget, draftPrompt, draftUserMessage,
  extractText, readDraft, renderReport, shortlist, sourcesOf, weekEndingFor, DraftModelError,
} from '../lib/this-week-draft.mjs';
import { MODEL_ALLOWLIST, resolveModelId } from '../lib/thesis-cost.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const stage = argv[0];
const value = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] ?? null : null; };
const out = value('--out');
if (!stage || !out) { console.error('usage: this-week-draft.mjs <shortlist|fetch|draft|render> --out DIR'); process.exit(2); }
mkdirSync(out, { recursive: true });
const read = (name) => (existsSync(join(out, name)) ? JSON.parse(readFileSync(join(out, name), 'utf8')) : null);
const write = (name, data) => writeFileSync(join(out, name), typeof data === 'string' ? data : JSON.stringify(data, null, 2) + '\n');
const UA = { 'User-Agent': 'L3VLUP-this-week/1.0 (weekly editorial draft; contact: suro@l3vlup.com)' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (stage === 'shortlist') {
  const days = Number(value('--days') ?? 7);
  const news = JSON.parse(readFileSync(join(ROOT, 'data/newsflow.auto.json'), 'utf8'));
  const deals = JSON.parse(readFileSync(join(ROOT, 'data/deals.auto.json'), 'utf8'));
  const list = shortlist({ news: news.items ?? [], deals: deals.items ?? [], days });
  const now = new Date();
  write('shortlist.json', { generatedAt: now.toISOString(), weekEnding: weekEndingFor(now), feeds: { newsflow: news.generatedAt ?? null, deals: deals.generatedAt ?? null }, ...list });
  console.log(`shortlist: ${list.headlines.length} headlines, ${list.deals.length} deals, ${list.moves.length} moves from ${list.counts.newsInWindow} stories and ${list.counts.dealsInWindow} deals in ${days} days`);
  process.exit(0);
}

if (stage === 'fetch') {
  const list = read('shortlist.json');
  if (!list) { console.error('fetch: run shortlist first'); process.exit(2); }
  const sources = sourcesOf(list);
  for (const s of sources) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 15_000);
      const r = await fetch(s.url, { headers: UA, signal: ctrl.signal, redirect: 'follow' });
      clearTimeout(t);
      if (!r.ok) { s.fetched = false; s.error = `HTTP ${r.status}`; }
      else { const html = await r.text(); Object.assign(s, { fetched: true, ...extractText(html) }); }
    } catch (e) {
      s.fetched = false; s.error = String(e?.message ?? e);
    }
    await sleep(1_000);
  }
  let paths = [];
  try {
    const r = await fetch('https://www.l3vlup.com/sitemap.xml', { headers: UA });
    if (r.ok) paths = allowedPaths(await r.text());
  } catch { /* no paths: the edition carries none and the editor adds them */ }
  write('sources.json', { fetchedAt: new Date().toISOString(), sources, paths });
  console.log(`fetch: ${sources.filter((s) => s.fetched).length}/${sources.length} pages read, ${paths.length} site paths allowed`);
  process.exit(0);
}

if (stage === 'draft') {
  const list = read('shortlist.json');
  const src = read('sources.json');
  if (!list || !src) { console.error('draft: run shortlist and fetch first'); process.exit(2); }
  const dryRun = argv.includes('--dry-run');
  const budgetUsd = Number(value('--budget'));
  const model = resolveModelId(value('--model') ?? 'claude-sonnet-5');
  const pricing = MODEL_ALLOWLIST[model];
  const system = draftPrompt({ weekEnding: list.weekEnding });
  const user = draftUserMessage({ weekEnding: list.weekEnding, list, sources: src.sources, paths: src.paths });
  const inputTokens = approxTokens(system) + approxTokens(user) + approxTokens(JSON.stringify(EDITION_TOOL));
  const maxTokens = 6_000;
  const check = checkDraftBudget({ budgetUsd, pricing, inputTokens, outputTokens: maxTokens });
  const base = { promptVersion: PROMPT_VERSION, model, budgetUsd: Number.isFinite(budgetUsd) ? budgetUsd : null, estimatedUsd: check.estimatedUsd ?? null, actualUsd: null, inputTokensApprox: inputTokens, hardStopUsd: HARD_STOP_USD };
  if (dryRun) { write('draft.json', { modelStage: 'skipped', failure: 'dry run: no model called', cost: base, input: null }); console.log(`draft: dry run, would send about ${inputTokens} input tokens for about $${(check.estimatedUsd ?? 0).toFixed(3)}`); process.exit(0); }
  if (!check.allowed) { write('draft.json', { modelStage: 'failed', failure: check.reason, cost: base, input: null }); console.error(`draft: refused before the call: ${check.reason}`); process.exit(0); }
  try {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({ timeout: 120_000, maxRetries: 0 });
    const response = await client.messages.create({
      model,
      max_tokens: maxTokens,
      ...(pricing.thinking ? { thinking: pricing.thinking } : {}),
      system,
      tools: [EDITION_TOOL],
      tool_choice: { type: 'tool', name: EDITION_TOOL.name },
      messages: [{ role: 'user', content: user }],
    });
    const usage = response.usage ?? {};
    const actual = pricing ? (((usage.input_tokens ?? 0) * pricing.inputPerMTok) + ((usage.output_tokens ?? 0) * pricing.outputPerMTok)) / 1_000_000 : null;
    const input = readDraft(response);
    write('draft.json', { modelStage: 'ok', failure: null, cost: { ...base, actualUsd: actual, usage: { input: usage.input_tokens ?? null, output: usage.output_tokens ?? null } }, input });
    console.log(`draft: one call, ${usage.input_tokens ?? '?'} in / ${usage.output_tokens ?? '?'} out, about $${(actual ?? 0).toFixed(4)}`);
  } catch (e) {
    const reason = e instanceof DraftModelError ? e.reason : (e?.status === 401 || e?.status === 403 ? 'not_authenticated' : 'call_failed');
    const detail = e instanceof DraftModelError ? e.detail : String(e?.message ?? e).slice(0, 300);
    write('draft.json', { modelStage: 'failed', failure: `${reason}: ${detail}`, cost: base, input: null });
    console.error(`draft: ${reason}: ${detail}`);
  }
  process.exit(0);
}

if (stage === 'render') {
  const list = read('shortlist.json');
  const src = read('sources.json') ?? { sources: [], paths: [] };
  const d = read('draft.json') ?? { modelStage: 'skipped', failure: 'the draft stage did not run', cost: null, input: null };
  if (!list) { console.error('render: run shortlist first'); process.exit(2); }
  let edition = null, cartoon = null, problems = [];
  if (d.input) ({ edition, cartoon, problems } = assembleEdition(d.input, { weekEnding: list.weekEnding, sources: src.sources, paths: src.paths }));
  const draft = {
    generatedAt: new Date().toISOString(),
    weekEnding: list.weekEnding,
    status: 'draft',
    modelStage: d.modelStage,
    failure: d.failure,
    cost: d.cost,
    feeds: list.feeds,
    shortlist: { headlines: list.headlines, deals: list.deals, moves: list.moves, counts: list.counts },
    sources: src.sources.map(({ text, description, ...rest }) => rest),
    edition,
    cartoon,
    problems,
  };
  mkdirSync(join(ROOT, 'data'), { recursive: true });
  writeFileSync(join(ROOT, 'data/this-week.draft.json'), JSON.stringify(draft, null, 2) + '\n');
  write('this-week-draft.md', renderReport(draft));
  console.log(`render: data/this-week.draft.json written (${draft.modelStage}${draft.failure ? `: ${draft.failure}` : ''}; ${problems.length} problem(s) for the editor)`);
  process.exit(0);
}

console.error(`unknown stage ${stage}`);
process.exit(2);
