// The Words × Actions pilot's own rules, offline: document text never lands in
// the repository, the session's model is priced at nothing on its own list
// without touching the API allowlist, and the gold-set scorer counts what it
// says it counts.
//
//   node scripts/__tests__/thesis-wxa.test.mjs

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { outsideRepo, proseOnly, SESSION_ALLOWLIST, SESSION_MODEL } from '../thesis-session.mjs';
import { covers, sameCompany, scoreDocument } from '../thesis-wxa-eval.mjs';
import { MODEL_ALLOWLIST, checkBudget, emptyCostLedger } from '../../lib/thesis-cost.mjs';
import { buildReviewedFeed, decisionsTemplate } from '../../lib/thesis-reviewed.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : ` — ${JSON.stringify(detail)}`}`);
  cond ? pass++ : fail++;
};

ok('text: a directory inside the repository is refused', !outsideRepo(join(ROOT, 'data', 'x'), ROOT) && !outsideRepo(ROOT, ROOT));
ok('text: a temporary directory is accepted', outsideRepo(join(tmpdir(), 'wxa'), ROOT));
ok('model: the session is not on the API allowlist', !(SESSION_MODEL in MODEL_ALLOWLIST));
ok('model: the session is priced at nothing on its own list', SESSION_ALLOWLIST[SESSION_MODEL].inputPerMTok === 0 && SESSION_ALLOWLIST[SESSION_MODEL].outputPerMTok === 0);
const call = { model: SESSION_MODEL, inputTokens: 1000, outputTokens: 100, documentId: 'd' };
ok('model: the runner accepts it on the session list', checkBudget(emptyCostLedger({ budgetUsd: 0 }), call, SESSION_ALLOWLIST).allowed);
ok('model: and refuses it on the API list', !checkBudget(emptyCostLedger({ budgetUsd: 0 }), call).allowed);

ok('company: a mention of the company counts', sameCompany('CDK', 'CDK Global, Inc.'));
ok('company: "the Company" counts in a one-company letter', sameCompany('the Company', 'US Foods Holding Corp.'));
ok('company: a peer does not', !sameCompany('Sysco', 'US Foods Holding Corp.'));
ok('covers: key words of a phrase found in claim text', covers('board seat for Nelson Peltz', ['Trian seeks a board seat so Peltz can push change']));
ok('covers: unrelated text is not coverage', !covers('pension deficit', ['margins should rise to 45%']));
const s = scoreDocument(
  { company: 'Acme Corp', stance: 'long', catalysts: ['annual meeting vote'], risks: [], figures: [{ numbers: ['45%'] }, { numbers: ['$3.2bn'] }] },
  [{ issuerMention: 'Acme', stance: 'long', paraphrase: 'Margins can reach 45% by 2028.', excerpt: null, evidenceState: 'verified', catalysts: [{ description: 'the annual meeting vote' }] }],
);
ok('score: counts by axis, n.a. where gold has nothing', JSON.stringify(s) === JSON.stringify({ claims: 1, company: 100, stance: 100, catalysts: 100, risks: null, figures: 50, passages: 100 }), s);

const gold = JSON.parse(readFileSync(join(ROOT, 'data', 'thesis', 'wxa', 'gold.json'), 'utf8'));
ok('gold: every document confirmed, with who and when', Object.values(gold.documents).every((g) => g.status === 'confirmed') && gold.reviewedBy && gold.reviewedOn);
ok('gold: Phillips 66 keeps only the $10 million, and no stated ownership', JSON.stringify(gold.documents['elliott-phillips66-2025-04'].figures.map((f) => f.numbers)) === JSON.stringify([['$10 million']]) && gold.documents['elliott-phillips66-2025-04'].ownershipStated === null);
ok('gold: Disney carries no risk Trian did not state', gold.documents['trian-disney-2024-03'].risks.length === 0);
ok('gold: no passage is stored, only the numbers', Object.values(gold.documents).every((g) => (g.figures ?? []).every((f) => !('excerpt' in f) && Array.isArray(f.numbers))));
const pending = JSON.parse(readFileSync(join(ROOT, 'data', 'thesis', 'wxa', 'claims.pending.json'), 'utf8'));
ok('pending: no session claim is accepted or published', pending.claims.every((c) => !['accepted', 'edited'].includes(c.reviewStatus) && !['accepted', 'edited'].includes(c.publicationState)));
ok('pending: no source text', !JSON.stringify(pending).match(/"(text|fullText|rawResponse)"\s*:/));

// A reviewer's CUSIP, copied from the filing, rides into the reviewed feed; a malformed one is refused.
const taxonomy = JSON.parse(readFileSync(join(ROOT, 'data', 'letters.taxonomy.json'), 'utf8'));
const one = { ...pending, claims: pending.claims.slice(0, 1) };
const tpl = decisionsTemplate(one);
ok('cusip: the decisions template offers it empty', tpl.decisions[0].cusip === null && /CUSIP/.test(tpl.instructions));
const base = { ...tpl, reviewedBy: 'test', reviewedOn: '2026-10-09' };
const good = buildReviewedFeed(one, { ...base, decisions: [{ ...tpl.decisions[0], decision: 'accept', issuerName: 'CDK Global, Inc.', ticker: 'CDK', cusip: '12508e101' }] }, taxonomy);
ok('cusip: carried into the feed, upper-cased', good.problems.length === 0 && good.feed.claims[0].cusip === '12508E101', good.problems);
const bad = buildReviewedFeed(one, { ...base, decisions: [{ ...tpl.decisions[0], decision: 'accept', issuerName: 'X', ticker: 'X', cusip: 'CDK' }] }, taxonomy);
ok('cusip: a malformed one is a problem, not a guess', bad.problems.some((x) => /not a nine-character CUSIP/.test(x)));
const none = buildReviewedFeed(one, { ...base, decisions: [{ ...tpl.decisions[0], decision: 'accept', issuerName: 'X', ticker: 'X' }] }, taxonomy);
ok('cusip: absent where the reviewer gave none', none.problems.length === 0 && !('cusip' in none.feed.claims[0]));

// ── The cross-manager pass: what a session reads from a shareholder report ───
const para = (s) => s.padEnd(200, ' x');
const report = [
  'Short heading',
  'Capital One Financial Corp.\t1,215,525\t132,941,969\t4.2%',
  para('Capital One has a terrific track record of both growth and risk management under its founder.'),
  '(e)(1) ' + para('Audit Committee Pre-Approval Policies under the Charter of the Funds'),
  para('Charter remains the dominant broadband provider in 60% of its footprint.'),
  para('Capital One has a terrific track record of both growth and risk management under its founder.'),
  para('Glencore led the positive contributors this quarter.'),
].join('\n\n');
const prose = proseOnly(report);
ok('prose: table rows, headings and lettered notes are not read', !prose.includes('\t') && !prose.includes('Short heading') && !prose.includes('Audit Committee'));
ok('prose: every kept paragraph is exactly as extracted', prose.split('\n\n').every((x) => report.includes(x)));
ok('prose: a commentary repeated under two funds is read once', prose.split('Capital One has a terrific').length === 2);
const about = proseOnly(report, ['Capital One', 'Charter']);
ok('prose about: only paragraphs naming a company read for', about.includes('Charter remains') && about.includes('Capital One') && !about.includes('Glencore'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
