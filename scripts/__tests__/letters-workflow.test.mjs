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
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildOutput, renderMarkdown, serialiseOutput, toPublicRecord } from '../../lib/letters-output.mjs';
import { validateOutputFiles } from '../letters-validate-output.mjs';

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
  assert.match(yaml, /needs\.parse\.outputs\.changed == 'true'/, 'the job does not depend on something having changed');
  assert.match(yaml, /git diff --quiet -- data\/letters\.parsed\.json data\/letters\.parsed\.md/);
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
