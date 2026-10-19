/**
 * The data-rights register (lib/rights-register.json) is complete and well formed.
 *
 *   node scripts/__tests__/rights-register.test.mjs
 *
 * What is held:
 *   1. the register parses, every source carries every field, the enumerations
 *      hold, ids are unique and lastReviewed is a real ISO date;
 *   2. every collector a workflow runs (found by reading .github/workflows, not
 *      from a list kept here) appears in at least one source's `collectors`,
 *      unless it is named below as fetching nothing external. A new collector
 *      added to a workflow without a register entry therefore fails this test;
 *   3. every script an entry names exists, so a rename cannot leave a stale row;
 *   4. no source in the register, and no collector, uses a prohibited host.
 *
 * The register records what the terms say. Whether a source is cleared is a
 * human decision: this test only holds that every source has been looked at.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SELF = 'scripts/__tests__/rights-register.test.mjs';
const REGISTER = 'lib/rights-register.json';

let pass = 0;
let fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
  if (ok) pass += 1;
  else fail += 1;
};

/*
 * Scripts a workflow runs that fetch NOTHING from an outside source, so they
 * need no register entry. Each line says why. If a script here starts fetching,
 * the guard further down fails it: move it into the register instead.
 */
const FETCHES_NOTHING_EXTERNAL = {
  // Test runners and validators
  'scripts/run-collector-tests.mjs': 'runs the offline test suites',
  'scripts/letters-validate-output.mjs': 'validates data/letters.parsed.json on disk',
  'scripts/validate-data-publication.mjs': 'publication gate: checks the files about to be committed',
  'scripts/validate-archive-members.mjs': 'publication gate: checks archive files on disk',
  'scripts/check-freshness.mjs': 'publication gate: compares file dates on disk',
  'scripts/keep-published-observations.mjs': 'publication gate: merges against the previously committed files via git',
  'scripts/publication-target.mjs': 'prints which files a producer may publish',
  'scripts/thesis-feed-check.mjs': 'validates a claims feed file on disk',
  'scripts/thesis-failure-check.mjs': 'validates a failure report file on disk',
};

/*
 * Scripts a workflow runs that talk to an outside service but collect no
 * third-party data, so there is no source to clear. The guard is not applied.
 */
const OUTBOUND_OR_PROCESSOR_ONLY = {
  'scripts/daily-post.mjs': 'posts the day\'s own data to Discord, Slack, Telegram, Bluesky and X; reads only committed files',
  'scripts/thesis-auth-check.mjs': 'asks the Anthropic Models API to accept the federated identity; a processor, collects no data',
};

/** Hosts L3VLUP has prohibited (policy of 19 Oct 2026). Matched case-insensitively as substrings. */
const PROHIBITED = [
  'yahoo.com', 'yahoo finance', 'query1.finance', 'query2.finance',
  'google.com/finance', 'marketwatch.com', 'investing.com', 'tradingview.com',
];

const text = (rel) => readFileSync(join(ROOT, rel), 'utf8');

// --- 1. The register itself --------------------------------------------------

let reg;
try {
  reg = JSON.parse(text(REGISTER));
  eq('the register parses', true, true);
} catch (e) {
  eq('the register parses', `${e.message}`, true);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(1);
}

const FIELDS = [
  'id', 'owner', 'source', 'collectors', 'outputs', 'termsUrl', 'businessUse', 'businessUseBasis',
  'displayRights', 'displayRightsBasis', 'derivedUseRights', 'derivedUseRightsBasis',
  'storageRights', 'storageRightsBasis', 'redistribution', 'attribution', 'lastReviewed', 'notes',
];
const RIGHTS = ['yes', 'no', 'conditional', 'unverified'];
const sources = Array.isArray(reg.sources) ? reg.sources : [];
eq('the register lists sources', sources.length > 10, true);

eq('every source has every field',
  sources.flatMap((s) => FIELDS.filter((f) => !(f in s) || s[f] === null || s[f] === '' || (Array.isArray(s[f]) && s[f].length === 0 && f !== 'outputs' && f !== 'collectors')).map((f) => `${s.id}.${f}`)),
  []);
eq('every source has at least one collector and one output',
  sources.filter((s) => !Array.isArray(s.collectors) || !s.collectors.length || !Array.isArray(s.outputs) || !s.outputs.length).map((s) => s.id),
  []);
eq('ids are unique', sources.map((s) => s.id).filter((id, i, a) => a.indexOf(id) !== i), []);
eq('businessUse is permitted, restricted or unverified',
  sources.filter((s) => !['permitted', 'restricted', 'unverified'].includes(s.businessUse)).map((s) => s.id), []);
eq('display, derived and storage rights use the enumeration',
  sources.flatMap((s) => ['displayRights', 'derivedUseRights', 'storageRights'].filter((f) => !RIGHTS.includes(s[f])).map((f) => `${s.id}.${f}`)),
  []);
eq('termsUrl is an https URL or says "unverified"',
  sources.filter((s) => !(/^https:\/\/\S+$/.test(s.termsUrl) || /^unverified/.test(s.termsUrl))).map((s) => s.id), []);
eq('every page read is an https URL',
  sources.flatMap((s) => (s.termsReadUrls ?? []).filter((u) => !/^https:\/\/\S+$/.test(u)).map((u) => `${s.id}: ${u}`)), []);

const isoDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().startsWith(d);
eq('lastReviewed is an ISO date on every source', sources.filter((s) => !isoDate(s.lastReviewed)).map((s) => s.id), []);
eq('the register carries an ISO review date', isoDate(reg.lastReviewed), true);

// --- 2. Every workflow collector has an entry -------------------------------

const wfDir = join(ROOT, '.github/workflows');
const workflows = readdirSync(wfDir).filter((f) => /\.ya?ml$/.test(f)).map((f) => readFileSync(join(wfDir, f), 'utf8')).join('\n');
// `node scripts/x.mjs`, `python3 scripts/x.py` and `python3 skills/x/build.py`.
// Tests under scripts/__tests__ are not collectors.
const runByWorkflows = [...new Set(
  [...workflows.matchAll(/\b(?:node|python3?)\s+((?:scripts|skills)\/[A-Za-z0-9_./-]+\.(?:mjs|py))\b/g)].map((m) => m[1])
)].filter((p) => !p.startsWith('scripts/__tests__/')).sort();
eq('the workflows run collectors', runByWorkflows.length > 15, true);

const covered = new Set(sources.flatMap((s) => s.collectors ?? []));
const exempt = new Set([...Object.keys(FETCHES_NOTHING_EXTERNAL), ...Object.keys(OUTBOUND_OR_PROCESSOR_ONLY)]);
eq('every collector a workflow runs has a register entry (or is named as fetching nothing external)',
  runByWorkflows.filter((p) => !covered.has(p) && !exempt.has(p)), []);
eq('no script is both in the register and on the exemption lists',
  [...exempt].filter((p) => covered.has(p)), []);
eq('every exemption is still run by a workflow (remove stale lines)',
  [...exempt].filter((p) => !runByWorkflows.includes(p)), []);

// A script on the "fetches nothing" list must really fetch nothing.
const NETWORK = /\bfetch\(|urllib\.request|https?\.get\(|https?\.request\(|\bcurl\b|requests\.(?:get|post)/;
eq('scripts said to fetch nothing external contain no network call',
  Object.keys(FETCHES_NOTHING_EXTERNAL).filter((p) => existsSync(join(ROOT, p)) && NETWORK.test(text(p))), []);

// --- 3. Named scripts exist --------------------------------------------------

eq('every collector an entry names exists',
  sources.flatMap((s) => (s.collectors ?? []).filter((p) => !existsSync(join(ROOT, p))).map((p) => `${s.id}: ${p}`)), []);
eq('every exemption exists', [...exempt].filter((p) => !existsSync(join(ROOT, p))), []);

// --- 4. Prohibited sources ---------------------------------------------------

const lc = (v) => JSON.stringify(v).toLowerCase();
eq('no source entry uses a prohibited host',
  sources.filter((s) => PROHIBITED.some((h) => lc([s.source, s.termsUrl, s.termsReadUrls, s.outputs, s.collectors]).includes(h))).map((s) => s.id), []);

const wanted = ['yahoo-finance-scraping', 'google-finance-scraping', 'marketwatch-scraping', 'investing-com-scraping', 'tradingview-scraping', 'undocumented-private-apis'];
const prohibited = Array.isArray(reg.prohibitedSources) ? reg.prohibitedSources : [];
eq('prohibitedSources lists the six prohibited kinds', wanted.filter((id) => !prohibited.some((p) => p.id === id)), []);
eq('each prohibited entry carries the policy reason',
  prohibited.filter((p) => p.reason !== 'not to be used (L3VLUP policy, 19 Oct 2026)').map((p) => p.id), []);

// No collector code reaches a prohibited host. The register, docs and this
// file are excluded: they name the hosts in order to forbid them.
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '__pycache__' || name === 'fixtures') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(mjs|js|py)$/.test(name)) out.push(p);
  }
  return out;
}
const codeHits = ['scripts', 'lib', 'skills']
  .flatMap((d) => walk(join(ROOT, d)))
  .map((p) => relative(ROOT, p))
  .filter((p) => p !== SELF)
  .filter((p) => PROHIBITED.filter((h) => h !== 'yahoo finance').some((h) => text(p).toLowerCase().includes(h)));
eq('no collector or library code names a prohibited host', codeHits, []);

// --- 5. IEX: the attribution in the register is the one the code publishes ----

const iex = sources.find((s) => s.id === 'iex-historical-data');
eq('the IEX entry exists', Boolean(iex), true);
if (iex) {
  const m = /export const IEX_ATTRIBUTION\s*=\s*\n?\s*'([^']+)'/.exec(text('lib/iex-tops.mjs'));
  eq('the code carries the IEX attribution', Boolean(m), true);
  eq('the register carries the exact attribution the code publishes', m ? iex.attribution.includes(m[1]) : false, true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
