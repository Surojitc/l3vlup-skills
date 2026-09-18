// The constraints the letters workflow was approved under, as a test.
//
// A workflow file is the one thing in the repository that runs with a token,
// so the limits it was agreed under should not depend on anyone remembering
// them. Each check below is one of those limits: read it as the list of what
// a change to .github/workflows/letters-parse.yml is not allowed to quietly
// undo.
//
//   node scripts/__tests__/letters-workflow.test.mjs

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildOutput, renderMarkdown, serialiseOutput, toPublicRecord } from '../../lib/letters-output.mjs';
import { validateOutputFiles } from '../letters-validate-output.mjs';
import { appendDurable, appendRunLog, isMaterial, ledgerSummary, MATERIAL_EVENTS, renderRunSummary } from '../../lib/letters-ledger.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORKFLOW = join(REPO, '.github', 'workflows', 'letters-parse.yml');
const yaml = readFileSync(WORKFLOW, 'utf8');

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

/** The block of YAML belonging to one job, from its key to the next job's. */
function job(name) {
  const start = yaml.indexOf(`\n  ${name}:\n`);
  assert.notEqual(start, -1, `there is no ${name} job`);
  const rest = yaml.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][a-z0-9-]*:\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

test('the workflow is manual only, with no schedule and no push trigger', () => {
  assert.match(yaml, /^on:\n {2}workflow_dispatch:/m);
  assert.ok(!/^ {2}schedule:/m.test(yaml), 'a schedule was added');
  assert.ok(!/^ {2}(push|pull_request|pull_request_target|repository_dispatch|issue_comment):/m.test(yaml), 'an automatic trigger was added');
});

test('both switches default to the safe answer', () => {
  assert.match(yaml, /dry_run:[\s\S]*?default: true/, 'dry_run does not default to true');
  assert.match(yaml, /open_pull_request:[\s\S]*?default: false/, 'open_pull_request does not default to false');
});

test('the workflow is read-only at the top, and the parsing job cannot write', () => {
  assert.match(yaml, /^permissions:\n {2}contents: read\n/m);
  const parse = job('parse');
  assert.match(parse, /permissions:\n {6}contents: read\n/);
  assert.ok(!/contents: write/.test(parse), 'the parsing job can write');
  assert.ok(!/pull-requests: write/.test(parse), 'the parsing job can open a pull request');
});

test('the write-enabled job asks for the least that can open a pull request, and never fetches', () => {
  const open = job('open-pull-request');
  assert.match(open, /permissions:\n {6}contents: write\n {6}pull-requests: write\n/);
  for (const scope of ['packages:', 'actions: write', 'deployments:', 'id-token:', 'security-events:']) {
    assert.ok(!open.includes(scope), `the pull-request job asks for ${scope}`);
  }
  assert.ok(!/retrieve-letters\.mjs/.test(open), 'the write-enabled job runs the retrieval script');
  // It may name sec.gov in the pull-request body it writes; what it may not
  // do is address it.
  assert.ok(!/https?:\/\/\S*sec\.gov/.test(open), 'the write-enabled job addresses sec.gov');
  assert.ok(!/\bcurl\b|\bwget\b/.test(open), 'the write-enabled job fetches something of its own');
});

test('there is a concurrency lock and a fifteen-minute ceiling on every job', () => {
  assert.match(yaml, /^concurrency:\n {2}group: letters-parse\n {2}cancel-in-progress: false\n/m);
  const timeouts = yaml.match(/timeout-minutes: \d+/g) || [];
  assert.equal(timeouts.length, 2, 'every job should carry a timeout');
  assert.ok(timeouts.every((t) => t === 'timeout-minutes: 15'), `a timeout is not fifteen minutes: ${timeouts}`);
});

test('every action is pinned to a full forty-character commit SHA', () => {
  const uses = [...yaml.matchAll(/uses: (\S+)/g)].map((m) => m[1]);
  assert.ok(uses.length >= 4, 'the workflow uses no actions, which is unexpected');
  for (const u of uses) {
    assert.match(u, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, `${u} is not pinned to a commit SHA`);
  }
  // Every pin carries the tag it came from, so a reviewer can check it.
  for (const line of yaml.split('\n').filter((l) => l.includes('uses:'))) {
    assert.match(line, /# v\d/, `${line.trim()} does not say which version the SHA is`);
  }
});

test('the nine-document ceiling is checked before anything is fetched', () => {
  assert.ok(yaml.includes('MAX_DOCUMENTS = 9'), 'the workflow does not check the document ceiling');
  assert.ok(yaml.includes('MAX_REQUESTS = 9'), 'the workflow does not check the request ceiling');
  assert.ok(yaml.indexOf('MAX_DOCUMENTS = 9') < yaml.indexOf('- name: Retrieve and parse'), 'the ceiling is checked after the fetch');
  const script = readFileSync(join(REPO, 'scripts', 'retrieve-letters.mjs'), 'utf8');
  assert.ok(script.includes('const MAX_DOCUMENTS = 9;'), 'the script no longer holds the ceiling the workflow checks for');
  assert.ok(script.includes('const MAX_REQUESTS = 9;'), 'the script no longer holds the request ceiling');
});

test('nothing but the three metadata files may be uploaded', () => {
  const parse = job('parse');
  const upload = parse.slice(parse.indexOf('- name: Upload the parsed metadata'));
  const paths = upload.slice(upload.indexOf('path: |')).split('\n').slice(1).map((l) => l.trim()).filter((l) => l.startsWith('data/'));
  assert.deepEqual(paths, ['data/letters.parsed.json', 'data/letters.parsed.md', 'data/letters.requests.jsonl']);
  assert.ok(!upload.includes('data/**'), 'the upload uses a wildcard');
  assert.ok(!/path: data\/?$/m.test(upload), 'the upload names a directory');
  assert.ok(yaml.includes('- name: Check nothing else is staged for upload'), 'nothing checks what the run left behind');
});

test('no pull request is opened when the output is unchanged', () => {
  assert.match(yaml, /needs\.parse\.outputs\.publication_changed == 'true'/, 'the job does not depend on the published output having changed');
  assert.match(yaml, /git diff --quiet -- data\/letters\.parsed\.json data\/letters\.parsed\.md\; then/);
  assert.match(yaml, /if git diff --quiet -- data\/; then\n\s+echo "nothing changed after all/, 'the second job does not re-check before committing');
});

test('the workflow carries no model, no key, no OCR, no Supabase, no Vercel and no site change', () => {
  for (const forbidden of ['ANTHROPIC', 'OPENAI', 'anthropic', 'openai', 'API_KEY', 'SUPABASE', 'VERCEL', 'FIRECRAWL', 'tesseract', 'ocrmypdf', 'RESEND']) {
    assert.ok(!yaml.includes(forbidden), `the workflow mentions ${forbidden}`);
  }
  assert.ok(!/\bocr\b/i.test(yaml.replace(/optical character recognition/gi, '')), 'the workflow mentions OCR');
  // github.token is the run's own token. Any other secret would be a new
  // grant, and this workflow was approved as needing none.
  const secrets = [...yaml.matchAll(/secrets\.(\w+)/g)].map((m) => m[1]);
  assert.deepEqual(secrets, [], `the workflow reads ${secrets.join(', ')}`);
  assert.match(yaml, /GH_TOKEN: \$\{\{ github\.token \}\}/);
});

test('the parsing job runs in the mode that retains nothing', () => {
  assert.match(yaml, /retrieve-letters\.mjs --mode ephemeral-sec/);
  assert.ok(!yaml.includes('local-private'), 'the workflow reaches for the private archive mode');
  assert.ok(!yaml.includes('LETTERS_ARCHIVE_ROOT'), 'the workflow sets an archive root');
});

test('a dry run asked to open a pull request is refused, not quietly half-run', () => {
  const step = yaml.slice(yaml.indexOf('- name: Refuse a contradictory request'), yaml.indexOf('- uses: actions/checkout'));
  assert.match(step, /if: \$\{\{ inputs\.dry_run && inputs\.open_pull_request \}\}/);
  assert.match(step, /exit 1/, 'the contradiction does not fail the run');
  // It is the first step, so nothing is installed or fetched before it.
  assert.ok(yaml.indexOf('- name: Refuse a contradictory request') < yaml.indexOf('- uses: actions/checkout'),
    'the refusal runs after the checkout');
});

test('the SEC user agent is identified without needing a repository variable or any secret', () => {
  const m = yaml.match(/SEC_USER_AGENT: "\$\{\{ vars\.SEC_USER_AGENT \|\| '([^']+)' \}\}"/);
  assert.ok(m, 'there is no identified fallback user agent');
  assert.match(m[1], /L3VLUP/, 'the fallback does not name us');
  assert.match(m[1], /@/, 'the fallback carries no contact address');
  assert.ok(!/secrets\.SEC_USER_AGENT/.test(yaml), 'the user agent is read from a secret');
});

test('a cleanup check runs whatever happened, and looks in both places a leftover could be', () => {
  const step = yaml.slice(yaml.indexOf('- name: Confirm nothing was left behind'));
  assert.match(step, /if: always\(\)/, 'the cleanup check is conditional on success');
  assert.match(step, /letters-run-\*/, 'it does not look where the workspace is made');
  assert.match(step, /RUNNER_TEMP/, 'it does not look in the runner temp directory');
  assert.match(step, /pdf\|html\?\|txt/, 'it does not look for a document or text file');
  assert.match(step, /exit \$status/, 'it reports rather than fails');
  // The prefix it looks for must be the one the workspace actually uses.
  const workspace = readFileSync(join(REPO, 'lib', 'letters-workspace.mjs'), 'utf8');
  assert.match(workspace, /prefix = 'letters-run-'/, 'the workspace prefix no longer matches the cleanup check');
});

test('the generated branch name cannot collide with a concurrent, previous or retried run', () => {
  const open = job('open-pull-request');
  assert.match(open, /GITHUB_RUN_ID/, 'the branch name does not carry the run id');
  assert.match(open, /GITHUB_RUN_ATTEMPT/, 'a re-run of the same run would collide');
  assert.match(open, /git ls-remote --exit-code --heads origin "\$branch"/, 'nothing checks the branch is free');
  assert.ok(!/parsed-\$\(date -u \+%Y%m%d-%H%M%S\)/.test(open), 'the branch is still named by a same-second timestamp');
});

test('the write-enabled job proves only the three metadata files arrived before it trusts them', () => {
  const open = job('open-pull-request');
  const check = open.indexOf('- name: Confirm only the three metadata files arrived');
  const validate = open.indexOf('- name: Validate what arrived');
  const commit = open.indexOf('git commit');
  assert.ok(check !== -1, 'nothing checks what the artifact carried');
  assert.ok(check < validate, 'the contents check runs after validation');
  assert.ok(validate < commit, 'validation runs after the commit');
  assert.ok(open.indexOf('git checkout -b') > validate, 'a branch is created before validation');
});

// The classic Actions injection: an attacker-controlled string interpolated
// by the runner into the text of a shell script, where it becomes code. This
// workflow has no untrusted input to begin with — workflow_dispatch can only
// be fired by someone with write access, and both inputs are typed booleans
// used only in if: expressions — but the absence of the vector is worth
// holding in place rather than re-deriving.
test('no expression is interpolated into any run: script', () => {
  const runBlocks = [...yaml.matchAll(/\n\s+run: \|?\n([\s\S]*?)(?=\n\s+- |\n\s{2}\w|$)/g)].map((m) => m[1]);
  assert.ok(runBlocks.length >= 5, 'the run blocks were not found; the test is not looking at anything');
  for (const block of runBlocks) {
    const found = block.match(/\$\{\{[^}]*\}\}/);
    assert.equal(found, null, `an expression reaches a shell script: ${found?.[0]}`);
  }
});

test('the two inputs are typed booleans and never reach a shell', () => {
  assert.match(yaml, /dry_run:[\s\S]*?type: boolean/);
  assert.match(yaml, /open_pull_request:[\s\S]*?type: boolean/);
  // They appear only in if: conditions, which the runner evaluates itself.
  for (const m of yaml.matchAll(/inputs\.(dry_run|open_pull_request)/g)) {
    const line = yaml.slice(yaml.lastIndexOf('\n', m.index) + 1, yaml.indexOf('\n', m.index));
    assert.match(line.trim(), /^(if:|#)/, `an input is used outside an if: condition — ${line.trim()}`);
  }
});

// ── Change detection: what may and may not start the write-enabled job ─────
//
// The rule these eight hold in place: a generated branch, commit or pull
// request exists only when data/letters.parsed.json or data/letters.parsed.md
// moved. Request activity never starts one — that was the defect the first
// production run exposed, where nine appended ledger lines made an otherwise
// unchanged run look like news and started a job that had nothing to do.

/** The `if` expression guarding the write-enabled job, as GitHub sees it. */
const WRITE_JOB_IF = job('open-pull-request').match(/\n {4}if: (.+)/)[1];

/** Evaluate the workflow's gating logic against a hypothetical run. */
function writeJobRuns({ dryRun = false, openPr = true, publicationChanged }) {
  assert.match(WRITE_JOB_IF, /!inputs\.dry_run/, 'the write job no longer checks dry_run');
  assert.match(WRITE_JOB_IF, /inputs\.open_pull_request/, 'the write job no longer checks open_pull_request');
  assert.match(WRITE_JOB_IF, /needs\.parse\.outputs\.publication_changed == 'true'/, 'the write job no longer gates on the published output');
  return !dryRun && openPr && publicationChanged === 'true';
}

/** The `Did the published output change` step, as a function of what moved. */
function publicationChangedFor(paths) {
  const step = yaml.slice(yaml.indexOf('- name: Did the published output change'), yaml.indexOf('- name: Check nothing else is staged'));
  const watched = [...step.matchAll(/data\/[\w.]+/g)].map((m) => m[0]);
  const gate = step.match(/git diff --quiet -- ([^\n]+)\; then/)[1].trim().split(/\s+/);
  assert.deepEqual(gate, ['data/letters.parsed.json', 'data/letters.parsed.md'],
    `the change gate watches ${gate.join(' ')}`);
  assert.ok(watched.includes('data/letters.parsed.json'));
  return paths.some((f) => gate.includes(f)) ? 'true' : 'false';
}

await test('1. unchanged parsed outputs with request activity only does not start the write job', () => {
  const changed = publicationChangedFor(['data/letters.requests.jsonl']);
  assert.equal(changed, 'false', 'request activity moved the publication gate');
  assert.equal(writeJobRuns({ publicationChanged: changed }), false, 'the write job started on request activity alone');
});

await test('2. a changed parsed JSON makes the write job eligible', () => {
  const changed = publicationChangedFor(['data/letters.parsed.json']);
  assert.equal(changed, 'true');
  assert.equal(writeJobRuns({ publicationChanged: changed }), true);
});

await test('3. a changed parsed Markdown makes the write job eligible', () => {
  const changed = publicationChangedFor(['data/letters.parsed.md']);
  assert.equal(changed, 'true');
  assert.equal(writeJobRuns({ publicationChanged: changed }), true);
});

await test('4. ledger or job-summary data alone never starts the write job', () => {
  for (const f of ['data/letters.requests.jsonl', 'letters-requests.run.jsonl', 'GITHUB_STEP_SUMMARY']) {
    assert.equal(writeJobRuns({ publicationChanged: publicationChangedFor([f]) }), false, `${f} started the write job`);
  }
  // And the gate expression names neither the ledger nor the run log.
  const step = yaml.slice(yaml.indexOf('- name: Did the published output change'), yaml.indexOf('- name: Check nothing else is staged'));
  const gate = step.match(/git diff --quiet -- ([^\n]+)\; then/)[1];
  assert.ok(!gate.includes('requests.jsonl'), 'the ledger is back in the change gate');
});

await test('5. no changed output means no branch is generated, because the job never starts', () => {
  assert.equal(writeJobRuns({ publicationChanged: 'false' }), false);
  // Everything that creates a branch lives in the job that does not run.
  const parse = job('parse');
  for (const forbidden of ['git checkout -b', 'git push origin', 'gh pr create', 'git commit']) {
    assert.ok(!parse.includes(forbidden), `the read-only job can ${forbidden}`);
  }
});

await test('6. a validation failure stops the run before the write job can act', () => {
  const parse = job('parse');
  const validate = parse.indexOf('- name: Validate the output against the allowlist');
  const diff = parse.indexOf('- name: Did the published output change');
  const upload = parse.indexOf('- name: Upload the parsed metadata');
  assert.ok(validate !== -1 && validate < diff && diff < upload, 'validation does not precede the change gate and the upload');
  // The validator exits non-zero, and no step between it and the upload
  // carries continue-on-error, so a failure fails the job and needs: parse
  // never resolves.
  assert.ok(!parse.includes('continue-on-error'), 'a step may swallow a validation failure');
  assert.match(job('open-pull-request'), /needs: parse/);
  // And the write job validates again, before it creates anything.
  const open = job('open-pull-request');
  assert.ok(open.indexOf('- name: Validate what arrived') < open.indexOf('git checkout -b'));
});

await test('7. routine polling is written to the run log, never to the tracked ledger', () => {
  const script = readFileSync(join(REPO, 'scripts', 'retrieve-letters.mjs'), 'utf8');
  assert.match(script, /onAttempt: \(\{ url, status \}\) => appendRunLog\(/, 'attempts still go to the tracked ledger');
  assert.ok(!/appendLedger\(/.test(script), 'the script writes the tracked ledger directly');

  const tmp = mkdtempSync(join(tmpdir(), 'letters-policy-'));
  const runLog = join(tmp, 'run.jsonl');
  const durable = join(tmp, 'durable.jsonl');
  for (let i = 0; i < 9; i += 1) appendRunLog({ script: 'retrieve-letters', url: `https://www.sec.gov/Archives/x${i}.htm`, status: 200, attempt: 0 }, runLog);
  assert.equal(readFileSync(runLog, 'utf8').trim().split('\n').length, 9);
  assert.ok(!existsSync(durable), 'routine polling reached the durable ledger');

  // The workflow points the run log at the runner temp directory, so it is
  // discarded with the runner rather than committed.
  assert.match(yaml, /LETTERS_RUN_LOG: \$\{\{ runner\.temp \}\}/);
  assert.match(renderRunSummary(runLog), /## Requests: 9/);
  rmSync(tmp, { recursive: true, force: true });
});

await test('8. a material event can be recorded durably, and only a material event', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'letters-material-'));
  const durable = join(tmp, 'durable.jsonl');
  const base = { script: 'retrieve-letters', url: 'https://www.sec.gov/Archives/x.htm', status: 200, attempt: 0, observedIn: '123' };

  for (const kind of Object.keys(MATERIAL_EVENTS)) {
    appendDurable({ ...base, material: kind }, durable);
    assert.ok(isMaterial(kind));
  }
  assert.equal(readFileSync(durable, 'utf8').trim().split('\n').length, 4);

  assert.throws(() => appendDurable({ ...base }, durable), /not a material event/, 'an unnamed event was written durably');
  assert.throws(() => appendDurable({ ...base, material: 'routine' }, durable), /not a material event/, 'routine polling was written durably');
  assert.throws(() => appendDurable({ ...base, material: 'seemed_interesting' }, durable), /not a material event/);
  assert.throws(() => appendDurable({ script: 's', url: 'u', status: 200, material: 'new_document' }, durable), /where it was observed/);
  assert.equal(readFileSync(durable, 'utf8').trim().split('\n').length, 4, 'a refused write still appended');

  // The script records exactly the four, at the four moments they occur.
  const script = readFileSync(join(REPO, 'scripts', 'retrieve-letters.mjs'), 'utf8');
  assert.match(script, /recordMaterial\('new_document'/);
  assert.match(script, /recordMaterial\('source_change'/);
  assert.equal((script.match(/recordMaterial\('error'/g) || []).length, 2, 'a refused fetch and a failed parse should both be recorded');
  rmSync(tmp, { recursive: true, force: true });
});

await test('the durable ledger holds 36 observed document GETs, the nine from the production run marked', () => {
  const lines = readFileSync(join(REPO, 'data', 'letters.requests.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const gets = lines.filter((l) => l.script === 'retrieve-letters');
  assert.equal(gets.length, 36, 'the durable observed total should be 36');

  const production = gets.filter((l) => l.workflowRunId === 35265891040);
  assert.equal(production.length, 9);
  assert.ok(production.every((l) => l.purpose === 'production_verification'), 'the nine are not marked production_verification');
  assert.ok(production.every((l) => l.material === 'milestone_verification' && l.observedIn === '35265891040'));
  assert.ok(production.every((l) => l.status === 200 && l.attempt === 0));
  assert.equal(new Set(production.map((l) => l.url)).size, 9, 'the nine are not nine distinct documents');

  const summary = ledgerSummary(join(REPO, 'data', 'letters.requests.jsonl'));
  assert.equal(summary.byScript['retrieve-letters'].observed, 36);
  assert.equal(summary.byScript['retrieve-letters'].reconstructed, 0);
  assert.equal(summary.reconstructed, 20, 'reconstructed entries must stay separate and unchanged');
  assert.match(summary.note, /never added together/);
  assert.match(summary.note, /36 observed GETs/);
});

// ── The validator the write-enabled job gates on ────────────────────────────

const approvedUrl = 'https://www.sec.gov/Archives/edgar/data/872323/000110465926000001/report.htm';
const approvedUrls = new Set([approvedUrl]);
const record = toPublicRecord({
  schemaVersion: 1, manager: 'oakmark', documentId: 'b'.repeat(64), subjectOrPeriod: '2026-03-31',
  filingDate: '2026-06-04', form: 'N-CSRS',
  filingIndexUrl: 'https://www.sec.gov/Archives/edgar/data/872323/000110465926000001/0001104659-26-000001-index.htm',
  documentUrl: approvedUrl, accession: '0001104659-26-000001', sourceBytes: 4096, sha256: 'b'.repeat(64),
  mimeType: 'text/html', parser: 'parse5', parserVersion: '8.0.1', extractionConfigVersion: 1,
  extractionStatus: 'ok', units: 'sections', unitCount: 12, characterCount: 3400,
  quality: { emptyUnitRatio: 0 }, warnings: [], processedAt: '2026-01-01T00:00:00.000Z',
});
const good = buildOutput([record]);
const files = { jsonText: serialiseOutput(good), markdownText: renderMarkdown(good), approvedUrls };

test('the validator passes a file the renderer produced from approved documents', () => {
  assert.deepEqual(validateOutputFiles(files), []);
});

test('the validator refuses run data, an unapproved document, a tenth document and prose', () => {
  const withRunData = { ...good, generatedAt: '2026-09-17T00:00:00Z' };
  assert.ok(validateOutputFiles({ ...files, jsonText: serialiseOutput(withRunData) })
    .some((p) => /generatedAt describes a run/.test(p)));

  const unapproved = buildOutput([{ ...record, documentUrl: approvedUrl.replace('report.htm', 'other.htm') }]);
  assert.ok(validateOutputFiles({ ...files, jsonText: serialiseOutput(unapproved), markdownText: renderMarkdown(unapproved) })
    .some((p) => /is not in the approved selection/.test(p)));

  const ten = buildOutput(Array.from({ length: 10 }, (_, i) => ({ ...record, accession: `a${i}` })));
  assert.ok(validateOutputFiles({ ...files, jsonText: serialiseOutput(ten), markdownText: renderMarkdown(ten) })
    .some((p) => /over the 9 approved/.test(p)));

  const prose = JSON.parse(serialiseOutput(good));
  prose.documents[0].text = 'We bought the shares because ...';
  assert.ok(validateOutputFiles({ ...files, jsonText: `${JSON.stringify(prose, null, 2)}\n` })
    .some((p) => /would carry document content/.test(p)));
});

// What the round-trip check does and does not catch. It compares the file
// with what the renderer would write from the file's own records, so it
// catches anything about the file's shape: a reordering, a stray top-level
// key, a difference in formatting. It cannot catch a changed value, because
// the rebuild reads the changed value too. The Markdown is what catches
// that: the two files are rendered from the same records, so editing a
// number in one and not the other shows up immediately.
test('the validator refuses a file that is not shaped as the renderer writes it', () => {
  const compact = `${JSON.stringify(good)}\n`;
  assert.ok(validateOutputFiles({ ...files, jsonText: compact })
    .some((p) => /not what the renderer produces/.test(p)), 'a reformatted file passed');

  const reordered = JSON.parse(serialiseOutput(good));
  reordered.documents = [{ ...record, manager: 'zzz-last', documentUrl: approvedUrl }, ...reordered.documents];
  assert.ok(validateOutputFiles({ ...files, jsonText: `${JSON.stringify(reordered, null, 2)}\n` })
    .some((p) => /not what the renderer produces/.test(p)), 'records out of order passed');

  const stray = { ...good, mode: 'ephemeral-sec' };
  assert.ok(validateOutputFiles({ ...files, jsonText: serialiseOutput(stray) })
    .some((p) => /mode describes a run/.test(p)), 'a stray top-level key passed');
});

test('a value edited in one file and not the other is caught by the two disagreeing', () => {
  const edited = serialiseOutput(good).replace('"sourceBytes": 4096', '"sourceBytes": 9999');
  const problems = validateOutputFiles({ ...files, jsonText: edited });
  assert.ok(problems.some((p) => /Markdown does not match the JSON/.test(p)), 'the edit went unnoticed');

  assert.ok(validateOutputFiles({ ...files, markdownText: `${files.markdownText}stray line\n` })
    .some((p) => /Markdown does not match the JSON/.test(p)));
});

test('the committed output passes the validator the workflow runs', () => {
  const urls = new Set(JSON.parse(readFileSync(join(REPO, 'data', 'letters.selection.json'), 'utf8')).selection.map((s) => s.documentUrl));
  assert.deepEqual(validateOutputFiles({
    jsonText: readFileSync(join(REPO, 'data', 'letters.parsed.json'), 'utf8'),
    markdownText: readFileSync(join(REPO, 'data', 'letters.parsed.md'), 'utf8'),
    approvedUrls: urls,
  }), []);
});

console.log(`${passed} passed`);
