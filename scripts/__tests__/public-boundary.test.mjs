/**
 * The public boundary: nothing private reaches the commons.
 *
 *   node scripts/__tests__/public-boundary.test.mjs
 *
 * This repository is public and is the open ring of the Finance OS
 * architecture. A private research operation sits beside it, in a private
 * repository, and its methods, positions and paths must never arrive here,
 * whether by an export, a copied file or a careless comment. This suite reads
 * every tracked file and fails on the things a leak most plausibly looks like:
 * the private operation's names and method names, private filesystem paths,
 * portfolio and watchlist files, credential shapes, and anything under a
 * folder that only exists privately.
 *
 * It is a guardrail, not a proof. A clean run does not show that nothing
 * proprietary is here; a person still reviews every promotion into this
 * repository. Data files are third-party records (SEC filings name companies
 * such as athenahealth and Time Warner Cable), so they are checked for
 * credentials and private paths only, not for names.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('../../', import.meta.url).pathname;
let pass = 0;
let fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
};

/** Names and method names of the private operation. Case-sensitive where the word is also common. */
const PRIVATE_NAMES = [
  /Third Wave Capital/i, /\bTWC\b/, /ClaudeSkills/i, /athenatwc/i, /\bAthena\b/, /Hermes dispatcher/i, /OpenClaw/i,
  /Unusual Whales/i, /Edge Score/, /Thesis Pulse/, /SumZero/, /Kelly (criterion|sizing)/i,
  /kill[- ]criteri(on|a) headroom/i, /polarity convention/i, /six-item diligence/i, /2nd Order Thoughts/i,
];
/** Private paths and files that only exist in the private repository. */
const PRIVATE_PATHS = [
  /\/Users\/[a-z]+/, /~\/TWC\b/, /\.twc\//, /current_portfolio\.json/, /portfolio_config\.json/, /TWC_Portfolio/,
  /deepvue_cookies/, /sec-13f-watchlist/, /skills\/investment\/(earnings-edge|thesis-tracker|ls-idea-sourcing|portfolio-construction)/,
];
/** Credential shapes. Values are never printed, only the file and pattern. */
const CREDENTIALS = [
  /sk-ant-[A-Za-z0-9_-]{20,}/, /\bAKIA[0-9A-Z]{16}\b/, /\bgh[pousr]_[A-Za-z0-9]{36,}\b/, /\bxox[baprs]-[A-Za-z0-9-]{10,}/,
  /discord(app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+/, /-----BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY/, /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\b[MN][A-Za-z\d]{23,}\.[\w-]{6}\.[\w-]{27,}/,
];

const SELF = 'scripts/__tests__/public-boundary.test.mjs';
const BINARY = /\.(xlsx|png|jpg|jpeg|gif|pdf|ico|woff2?|zip)$/i;
const files = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT }).toString().split('\0').filter(Boolean);
eq('the repository has tracked files to check', files.length > 50, true);

const hits = { names: [], paths: [], credentials: [] };
for (const f of files) {
  if (f === SELF || BINARY.test(f)) continue;
  const full = join(ROOT, f);
  if (statSync(full).size > 25 * 1024 * 1024) continue;
  const text = readFileSync(full, 'utf8');
  const isData = f.startsWith('data/');
  if (!isData) for (const rx of PRIVATE_NAMES) if (rx.test(text)) hits.names.push(`${f}: ${rx}`);
  for (const rx of PRIVATE_PATHS) if (rx.test(text)) hits.paths.push(`${f}: ${rx}`);
  for (const rx of CREDENTIALS) if (rx.test(text)) hits.credentials.push(`${f}: ${rx}`);
}
eq('no private operation or method name outside third-party data', hits.names, []);
eq('no private path, portfolio, watchlist or private-only folder anywhere', hits.paths, []);
eq('no credential-shaped string anywhere', hits.credentials, []);

// The guard must bite on what it is for, and stay quiet on what it is not.
const fires = (rx, s) => rx.some((r) => r.test(s));
eq('fires on a private method name', fires(PRIVATE_NAMES, 'Score the Edge Score before the print'), true);
eq('fires on a private path', fires(PRIVATE_PATHS, 'open /Users/someone/TWC/state'), true);
eq('fires on a key shape', fires(CREDENTIALS, 'key = AKIAABCDEFGHIJKLMNOP'), true);
eq('quiet on standard finance vocabulary', fires(PRIVATE_NAMES, 'Define the kill criteria and the variant perception'), false);
eq('quiet on the generic word athletic or a company like athenahealth in prose', fires(PRIVATE_NAMES, 'athenahealth, athletic'), false);

// Published workflows are generic: their ownership never names the private ring.
const published = files.filter((f) => /^workflows\/.+\/workflow\.json$/.test(f));
const privateOwned = published.filter((f) => /"(specOwner|runtimeOwner|publicationRing)":\s*"twc"/.test(readFileSync(join(ROOT, f), 'utf8')));
eq('no published workflow is owned, run or published in the private ring', privateOwned, []);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
