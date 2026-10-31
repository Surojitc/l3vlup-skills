/**
 * The exchange-rate refresh: what it reads, what it refuses, and that a
 * refusal changes nothing.
 *
 *   node scripts/__tests__/fx-rates.test.mjs
 *
 * Offline except for a throwaway server on localhost. The ECB's file is a
 * fixture (scripts/__tests__/fixtures/ecb-eurofxref-daily.xml, the real
 * response of 30 October 2026 cut to four currencies), and every expected
 * number below is worked by hand:
 *
 *   EUR per dollar = 1 / 1.1172          = 0.895095 (0.8950949...)
 *   GBP per dollar = 0.83380 / 1.1172    = 0.746330 (0.7463301...)
 *
 * The rules (lib/fx-rates.mjs): both currencies, positive finite rates, a real
 * date no later than today and no more than 10 days old, nothing older than
 * the published date, no rate more than 20% from the published one; and on any
 * failure the CLI writes nothing and exits 1.
 */

import { readFileSync, writeFileSync, mkdtempSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { spawnSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isCalendarDate, parseEcbXml, refresh, round6, validateFx, usablePrevious, MAX_AGE_DAYS, MAX_MOVE } from '../../lib/fx-rates.mjs';
import { CONTRACTS, contractProblems, fileFreshness, unexpectedPaths } from '../publication-contracts.mjs';

let pass = 0;
let fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass += 1; console.log(`PASS  ${name}`); }
  else { fail += 1; console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const refuses = (name, verdict, needle) => check(name, verdict.ok === false && verdict.problems.some((p) => p.includes(needle)), JSON.stringify(verdict.problems ?? verdict));

const FIXTURE = join('scripts', '__tests__', 'fixtures', 'ecb-eurofxref-daily.xml');
const xmlText = readFileSync(FIXTURE, 'utf8');
const NOW = new Date('2026-11-02T17:17:00Z'); // a Monday, the day after the fixture's Friday would be 'asOf' + 3

/** A response in the ECB's shape, with the date and the two rates chosen. */
const ecb = (date, usd, gbp, extra = '') => `<?xml version="1.0" encoding="UTF-8"?>
<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref">
<Cube><Cube time='${date}'>${usd === null ? '' : `<Cube currency='USD' rate='${usd}'/>`}${gbp === null ? '' : `<Cube currency='GBP' rate='${gbp}'/>`}${extra}</Cube></Cube></gesmes:Envelope>`;

// ── 1. reading the ECB's file ─────────────────────────────────────────────
{
  const p = parseEcbXml(xmlText);
  eq('the fixture is dated 30 October 2026', p.asOf, '2026-10-30');
  eq('and carries the raw dollar rate per euro', p.eurPer.USD, 1.1172);
  eq('and the raw pound rate per euro', p.eurPer.GBP, 0.8338);
  eq('and the other currencies are read but not published', Object.keys(p.eurPer).sort(), ['CHF', 'GBP', 'JPY', 'USD']);
  eq('an empty response is refused', parseEcbXml('').problems, ['the ECB response was empty']);
  check('a response with no dated block is refused', parseEcbXml('<a/>').problems?.[0].includes('no dated rates block'));
  check('two dated blocks are refused, not merged', parseEcbXml(ecb('2026-10-30', '1.1', '0.8').replace('</Cube></Cube>', "</Cube><Cube time='2026-10-29'></Cube></Cube>")).problems?.[0].includes('2 dated blocks'));
  check('a currency given twice is refused', parseEcbXml(ecb('2026-10-30', '1.1', '0.8', "<Cube currency='USD' rate='1.2'/>")).problems?.[0].includes('USD appears twice'));
  eq('a rate that is not a plain decimal is kept as text for the validator', parseEcbXml(ecb('2026-10-30', '1e3', '0.8')).eurPer.USD, '1e3');
}

// ── 2. the table it builds, worked by hand ────────────────────────────────
{
  const r = refresh({ xml: xmlText, now: NOW, prev: null });
  check('the fixture on its Monday is accepted', r.ok === true, JSON.stringify(r));
  eq('USD is exactly 1', r.fx.perUsd.USD, 1);
  eq('EUR per dollar is 1 / 1.1172, six decimals', r.fx.perUsd.EUR, 0.895095);
  eq('GBP per dollar is 0.8338 / 1.1172, six decimals', r.fx.perUsd.GBP, 0.74633);
  eq('the date is the ECB\'s, not the run\'s', r.fx.asOf, '2026-10-30');
  eq('the source is named', r.fx.source, 'European Central Bank euro reference rates');
  eq('the fetch time is the clock', r.fx.fetchedAt, '2026-11-02T17:17:00.000Z');
  eq('the file has exactly these four keys', Object.keys(r.fx), ['asOf', 'source', 'fetchedAt', 'perUsd']);
  eq('six-decimal rounding', round6(1 / 3), 0.333333);
  eq('and rounds half up', round6(0.1234565), 0.123457);
  // The round trip the site relies on: a pound through the dollar to euros
  // equals 0.83380 pounds per euro, to the six decimals published.
  check('a euro is 0.8338 pounds through the published table', Math.abs(r.fx.perUsd.GBP / r.fx.perUsd.EUR - 0.8338) < 1e-5);
}

// ── 3. each rule on its own ───────────────────────────────────────────────
// Currencies present.
refuses('GBP missing is refused by name', refresh({ xml: ecb('2026-10-30', '1.1172', null), now: NOW, prev: null }), 'GBP is missing');
refuses('USD missing is refused by name', refresh({ xml: ecb('2026-10-30', null, '0.8338'), now: NOW, prev: null }), 'USD is missing');
{
  const both = refresh({ xml: ecb('2026-10-30', null, null), now: NOW, prev: null });
  eq('both missing names both', both.problems, ['USD is missing from the ECB response', 'GBP is missing from the ECB response']);
}
// Positive, finite, a number.
for (const [label, v] of [['zero', '0'], ['zero with decimals', '0.0000'], ['negative', '-1.1172'], ['not a number', 'NaN'], ['infinity', 'Infinity'], ['scientific notation', '1e3'], ['empty', ''], ['text', 'n/a'], ['a comma decimal', '1,1172']]) {
  refuses(`a ${label} dollar rate is refused`, refresh({ xml: ecb('2026-10-30', v, '0.8338'), now: NOW, prev: null }), 'USD is not a positive number');
  refuses(`a ${label} pound rate is refused`, refresh({ xml: ecb('2026-10-30', '1.1172', v), now: NOW, prev: null }), 'GBP is not a positive number');
}
// A rate positive per euro that rounds to nothing per dollar.
refuses('a derived rate that rounds to zero is refused', refresh({ xml: ecb('2026-10-30', '9999999999', '0.8338'), now: NOW, prev: null }), 'the EUR rate per dollar is not a positive number');
// The date.
for (const bad of ['2026-02-30', '2026-13-01', '2026-10-3', '30-10-2026', '2026/10/30', 'garbage', '']) {
  refuses(`the date ${JSON.stringify(bad)} is not a calendar date`, refresh({ xml: ecb(bad, '1.1172', '0.8338'), now: NOW, prev: null }), 'is not a calendar date');
}
eq('isCalendarDate accepts a leap day', isCalendarDate('2028-02-29'), true);
eq('and refuses 29 February in a common year', isCalendarDate('2026-02-29'), false);
refuses('a date after today is refused', refresh({ xml: ecb('2026-11-03', '1.1172', '0.8338'), now: NOW, prev: null }), 'is in the future');
check('today itself is accepted', refresh({ xml: ecb('2026-11-02', '1.1172', '0.8338'), now: NOW, prev: null }).ok);
// Ten days: 2026-10-23 is ten days before 2026-11-02 (accepted), 22nd is eleven (refused).
eq('the age limit is ten days', MAX_AGE_DAYS, 10);
check('a rate exactly ten days old is accepted', refresh({ xml: ecb('2026-10-23', '1.1172', '0.8338'), now: NOW, prev: null }).ok);
refuses('a rate eleven days old is refused', refresh({ xml: ecb('2026-10-22', '1.1172', '0.8338'), now: NOW, prev: null }), 'is 11 days old');
check('age is by calendar day: 23:59 UTC on day ten is still accepted', refresh({ xml: ecb('2026-10-23', '1.1172', '0.8338'), now: new Date('2026-11-02T23:59:59Z'), prev: null }).ok);
check('and 00:00 UTC on day eleven is not', !refresh({ xml: ecb('2026-10-23', '1.1172', '0.8338'), now: new Date('2026-11-03T00:00:00Z'), prev: null }).ok);

// ── 4. against the published file ─────────────────────────────────────────
// Round numbers: published EUR 1.0 and GBP 0.8 per dollar, so a rate of
// u euros-per-... is read directly. With USD = 1 per euro, EUR = 1 / 1 = 1.0 and
// GBP = gbp / 1. The date is the same day so only the size of the move is tested.
const PREV = { asOf: '2026-10-30', source: 'x', fetchedAt: '2026-10-31T00:00:00Z', perUsd: { USD: 1, EUR: 1, GBP: 0.8 } };
const day = '2026-10-30';
eq('the limit is twenty per cent', MAX_MOVE, 0.2);
check('a pound rate 19% up is accepted', refresh({ xml: ecb(day, '1', '0.952'), now: NOW, prev: PREV }).ok);
check('a pound rate exactly 20% up is accepted (inclusive)', refresh({ xml: ecb(day, '1', '0.96'), now: NOW, prev: PREV }).ok);
refuses('a pound rate 21% up is refused', refresh({ xml: ecb(day, '1', '0.968'), now: NOW, prev: PREV }), 'GBP moved 21.0%');
check('a pound rate exactly 20% down is accepted', refresh({ xml: ecb(day, '1', '0.64'), now: NOW, prev: PREV }).ok);
refuses('a pound rate 21% down is refused', refresh({ xml: ecb(day, '1', '0.632'), now: NOW, prev: PREV }), 'GBP moved 21.0%');
check('a euro rate 19% up is accepted (USD rate 1/1.19 per euro)', refresh({ xml: ecb(day, String(1 / 1.19), String(0.8 / 1.19)), now: NOW, prev: PREV }).ok);
refuses('a euro rate 25% up (dollar fell to 0.8 per euro) is refused', refresh({ xml: ecb(day, '0.8', '0.64'), now: NOW, prev: PREV }), 'EUR moved 25.0%');
refuses('an inverted rate (the classic mis-parse) is refused', refresh({ xml: ecb(day, String(1 / 1.1172), '0.8338'), now: new Date('2026-11-02T00:00:00Z'), prev: { ...PREV, perUsd: { USD: 1, EUR: 0.895095, GBP: 0.74633 } } }), 'moved');
check('with no published file there is nothing to compare against', refresh({ xml: ecb(day, '0.5', '0.9'), now: NOW, prev: null }).ok);
refuses('a date older than the published one is refused (no rolling back)', refresh({ xml: ecb('2026-10-29', '1', '0.8'), now: NOW, prev: PREV }), 'older than the published 2026-10-30');
check('the same date is not a rollback', refresh({ xml: ecb('2026-10-30', '1', '0.8'), now: NOW, prev: PREV }).ok);
check('an identical day is reported unchanged so nothing is rewritten', refresh({ xml: ecb('2026-10-30', '1', '0.8'), now: NOW, prev: PREV }).unchanged === true);
check('a new day is not unchanged', refresh({ xml: ecb('2026-10-31', '1', '0.8'), now: NOW, prev: PREV }).unchanged === false);
// A damaged published file is not a baseline; it must not lock the table out.
for (const [label, bad] of [['an empty object', {}], ['a bad date', { ...PREV, asOf: 'x' }], ['a negative rate', { ...PREV, perUsd: { ...PREV.perUsd, GBP: -1 } }], ['a missing rate', { asOf: PREV.asOf, perUsd: { USD: 1, EUR: 1 } }], ['a string', 'text']]) {
  eq(`${label} is not a usable baseline`, usablePrevious(bad), null);
  const r = refresh({ xml: xmlText, now: NOW, prev: bad });
  check(`${label} is ignored and the day is written, with a warning`, r.ok === true && r.warnings.length === 1, JSON.stringify(r));
}
eq('validateFx with no problems returns an empty list', validateFx({ fx: refresh({ xml: xmlText, now: NOW, prev: null }).fx, prev: null }, NOW), []);

// ── 5. the command: writes on success, writes nothing on failure ──────────
const work = mkdtempSync(join(tmpdir(), 'fx-rates-'));
const out = join(work, 'data', 'fx.auto.json');
const run = (args, opts = {}) => spawnSync(process.execPath, ['scripts/fx-rates.mjs', '--out', out, '--now', NOW.toISOString(), '--retry-ms', '1', ...args], { encoding: 'utf8', ...opts });
const dirListing = () => (existsSync(join(work, 'data')) ? readdirSync(join(work, 'data')).sort() : []);
const bad = (name, xml) => { const f = join(work, name); writeFileSync(f, xml); return f; };

{
  const first = run(['--xml', FIXTURE]);
  eq('a good response exits 0', first.status, 0);
  eq('and writes exactly the table', JSON.parse(readFileSync(out, 'utf8')), { asOf: '2026-10-30', source: 'European Central Bank euro reference rates', fetchedAt: '2026-11-02T17:17:00.000Z', perUsd: { USD: 1, EUR: 0.895095, GBP: 0.74633 } });
  eq('and leaves no temporary file behind', dirListing(), ['fx.auto.json']);
  check('the file ends with a newline', readFileSync(out, 'utf8').endsWith('}\n'));
  const before = readFileSync(out, 'utf8');
  const again = spawnSync(process.execPath, ['scripts/fx-rates.mjs', '--out', out, '--now', '2026-11-03T09:00:00Z', '--xml', FIXTURE], { encoding: 'utf8' });
  eq('the same day again exits 0', again.status, 0);
  eq('and rewrites nothing, not even the fetch time', readFileSync(out, 'utf8'), before);
}

// Every failure: exit 1, a reason on stderr, the last valid file byte for byte.
const lastValid = readFileSync(out, 'utf8');
const failures = [
  ['GBP missing', bad('a.xml', ecb('2026-10-30', '1.1172', null)), 'GBP is missing'],
  ['USD missing', bad('b.xml', ecb('2026-10-30', null, '0.8338')), 'USD is missing'],
  ['a negative rate', bad('c.xml', ecb('2026-10-30', '1.1172', '-0.8338')), 'GBP is not a positive number'],
  ['a zero rate', bad('d.xml', ecb('2026-10-30', '0', '0.8338')), 'USD is not a positive number'],
  ['a future date', bad('e.xml', ecb('2026-11-09', '1.1172', '0.8338')), 'in the future'],
  ['a stale date', bad('f.xml', ecb('2026-10-01', '1.1172', '0.8338')), 'days old'],
  ['an impossible date', bad('g.xml', ecb('2026-02-30', '1.1172', '0.8338')), 'not a calendar date'],
  ['a rate 25% from the published one', bad('h.xml', ecb('2026-10-30', '1.1172', '1.1')), 'GBP moved'],
  ['an older date than the published one', bad('i.xml', ecb('2026-10-29', '1.1172', '0.8338')), 'older than the published'],
  ['garbage', bad('j.xml', 'this is not xml at all'), 'no dated rates block'],
  ['an empty body', bad('k.xml', ''), 'was empty'],
  ['an HTML error page', bad('l.xml', '<html><body>503 Service Unavailable</body></html>'), 'no dated rates block'],
];
for (const [label, file, reason] of failures) {
  const r = run(['--xml', file]);
  check(`${label}: exits 1`, r.status === 1, `status ${r.status}\n${r.stderr}`);
  check(`${label}: says why on stderr`, r.stderr.includes(reason), r.stderr);
  check(`${label}: says nothing was written`, r.stderr.includes('nothing was written'));
  check(`${label}: the last valid file is byte for byte as it was`, readFileSync(out, 'utf8') === lastValid);
  check(`${label}: and nothing else appeared beside it`, JSON.stringify(dirListing()) === JSON.stringify(['fx.auto.json']), dirListing().join(','));
}

// With no file yet, a refusal creates none (not an empty one, not a directory's worth of tmp).
{
  const fresh = join(mkdtempSync(join(tmpdir(), 'fx-rates-empty-')), 'data', 'fx.auto.json');
  const r = spawnSync(process.execPath, ['scripts/fx-rates.mjs', '--out', fresh, '--now', NOW.toISOString(), '--xml', failures[0][1]], { encoding: 'utf8' });
  eq('a refusal with no published table exits 1', r.status, 1);
  eq('and creates no file', existsSync(fresh), false);
  check('and says there is no published table yet', r.stderr.includes('no published table yet'), r.stderr);
}
// A damaged published file is replaced by a good day rather than blocking it.
{
  const dir = mkdtempSync(join(tmpdir(), 'fx-rates-damaged-'));
  const target = join(dir, 'fx.auto.json');
  writeFileSync(target, '{ not json');
  const r = spawnSync(process.execPath, ['scripts/fx-rates.mjs', '--out', target, '--now', NOW.toISOString(), '--xml', FIXTURE], { encoding: 'utf8' });
  eq('a damaged published file does not stop a good day', r.status, 0);
  eq('and the table is written', JSON.parse(readFileSync(target, 'utf8')).asOf, '2026-10-30');
  check('with a warning that the old file was ignored', r.stderr.includes('not a usable baseline'), r.stderr);
}
// The clock arguments.
{
  const r = spawnSync(process.execPath, ['scripts/fx-rates.mjs', '--out', out, '--xml', FIXTURE, '--now', 'tomorrow'], { encoding: 'utf8' });
  eq('a --now that is not a timestamp exits 2 and writes nothing', [r.status, readFileSync(out, 'utf8') === lastValid], [2, true]);
}

// ── 6. the network: a throwaway server standing in for the ECB ────────────
{
  let mode = 'ok';
  let hits = 0;
  const server = createServer((req, res) => {
    hits += 1;
    if (mode === 'ok') { res.writeHead(200, { 'content-type': 'text/xml' }); res.end(xmlText); }
    else if (mode === '500') { res.writeHead(500); res.end('boom'); }
    else if (mode === '404') { res.writeHead(404); res.end('no'); }
    else { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html>maintenance</html>'); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/eurofxref-daily.xml`;
  const net = (target) => new Promise((resolve) => {
    const child = spawn(process.execPath, ['scripts/fx-rates.mjs', '--out', target, '--now', NOW.toISOString(), '--retry-ms', '1', '--url', url]);
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stderr }));
  });
  const dir = mkdtempSync(join(tmpdir(), 'fx-rates-net-'));
  const target = join(dir, 'fx.auto.json');

  mode = 'ok';
  const ok = await net(target);
  eq('fetching a good response exits 0', ok.status, 0);
  eq('and writes the table', JSON.parse(readFileSync(target, 'utf8')).perUsd.EUR, 0.895095);
  const kept = readFileSync(target, 'utf8');

  mode = '500'; hits = 0;
  const five = await net(target);
  eq('a server error exits 1', five.status, 1);
  eq('after three attempts', hits, 3);
  check('naming the status', five.stderr.includes('HTTP 500'), five.stderr);
  mode = '404'; hits = 0;
  const four = await net(target);
  eq('a not-found exits 1 without retrying', [four.status, hits], [1, 1]);
  mode = 'html';
  const html = await net(target);
  eq('a 200 that is a maintenance page exits 1', html.status, 1);
  check('and the table is untouched through all of it', readFileSync(target, 'utf8') === kept);
  server.close();
  const refused = await net(target); // nothing listening now
  eq('a refused connection exits 1', refused.status, 1);
  check('and the table is still untouched', readFileSync(target, 'utf8') === kept);
}

// ── 7. the publication contract and the committed file ────────────────────
{
  const spec = CONTRACTS['fx-rates'].files[0];
  const good = JSON.parse(readFileSync('data/fx.auto.json', 'utf8'));
  const stamped = { ...good, fetchedAt: '2026-11-02T17:17:00.000Z' };
  const verdict = (file, staged = ['data/fx.auto.json'], at = new Date('2026-11-02T17:30:00Z')) =>
    contractProblems('fx-rates', { staged, read: (p) => (p === 'data/fx.auto.json' ? file : undefined), readPrev: () => null }, at);
  eq('the producer owns exactly one file', CONTRACTS['fx-rates'].files.map((f) => f.path), ['data/fx.auto.json']);
  eq('it publishes on its own branch', CONTRACTS['fx-rates'].branch, 'automation/fx-rates');
  eq('the committed baseline passes the gate when stamped within the hour', verdict({ ...good, fetchedAt: '2026-11-02T17:17:00.000Z' }).problems, []);
  check('the committed baseline is a table the rules accept', validateFx({ fx: { ...good, asOf: good.asOf }, prev: null }, new Date(`${good.asOf}T12:00:00Z`)).length === 0);
  check('a file with no perUsd is refused', verdict({ asOf: '2026-10-30', fetchedAt: stamped.fetchedAt }).problems.some((p) => p.includes('no perUsd object')));
  check('a file missing a currency is refused (floor of three)', verdict({ ...stamped, perUsd: { USD: 1, EUR: 0.9 } }).problems.some((p) => p.includes('below its floor of 3')));
  check('a leftover stamped three days ago is refused', verdict({ ...stamped, fetchedAt: '2026-10-30T17:17:00.000Z' }).problems.some((p) => p.includes('may have failed quietly')));
  check('a file with no fetch time is refused', verdict({ asOf: stamped.asOf, perUsd: stamped.perUsd, source: 'x' }).problems.some((p) => p.includes('no readable fetchedAt')));
  check('unreadable JSON is refused', verdict(null).problems.some((p) => p.includes('not readable JSON')));
  eq('any other path is outside the allowlist', unexpectedPaths('fx-rates', ['data/fx.auto.json', 'data/macro.auto.json', '.github/workflows/fx-rates.yml']), ['data/macro.auto.json', '.github/workflows/fx-rates.yml']);
  check('and no other producer may publish this file', Object.entries(CONTRACTS).every(([id, c]) => id === 'fx-rates' || !c.files.some((f) => f.path === 'data/fx.auto.json')));
  // Freshness is weekly, read from the rate's own date.
  eq('freshness is weekly', spec.freshness.cadence, 'weekly');
  eq('read from asOf', spec.freshness.from, 'asOf');
  const stateAt = (asOf, now) => fileFreshness(spec, { asOf }, null, new Date(now)).state;
  eq('Monday evening, Friday\'s rate three days old: not due, not late', stateAt('2026-10-30', '2026-11-02T17:17:00Z'), 'not-due');
  eq('a week later, the Friday still on file after a Monday holiday: still inside the horizon', stateAt('2026-10-30', '2026-11-09T17:17:00Z'), 'not-due');
  eq('eleven days and a bit with no refresh: stale (two Mondays missed)', stateAt('2026-10-30', '2026-11-11T12:00:00Z'), 'stale');
  eq('a missing file is stale, because it is required', fileFreshness(spec, undefined, null, NOW).state, 'stale');
}

// ── 8. the workflow ───────────────────────────────────────────────────────
{
  const wf = readFileSync('.github/workflows/fx-rates.yml', 'utf8');
  const cron = /^\s+- cron: '(\d+) (\d+) \* \* (\d)'/m.exec(wf);
  check('it runs on a weekly schedule on Mondays', Boolean(cron) && cron[3] === '1', cron?.[0]);
  check('at a minute that is not :00', Boolean(cron) && cron[1] !== '0');
  check('and a person can run it by hand', /^\s+workflow_dispatch:/m.test(wf));
  check('it states a read-only floor at the top', /^permissions:\n  contents: read\n/m.test(wf));
  check('the collecting job states the same, and no more', /collect:[\s\S]*?permissions:\n      contents: read\n    outputs:/.test(wf));
  check('it holds no secret and no variable', !/secrets\.(?!GITHUB_TOKEN)|\bvars\./.test(wf) && !/ANTHROPIC|API_KEY|TOKEN:/.test(wf.replace(/#.*$/gm, '')));
  check('it runs the refresh script', /run: node scripts\/fx-rates\.mjs\s*$/m.test(wf));
  check('it runs the three guards before it reads anything', /fx-rates\.test\.mjs[\s\S]*publication-contracts\.test\.mjs[\s\S]*workflow-permissions\.test\.mjs[\s\S]*node scripts\/fx-rates\.mjs/.test(wf));
  check('it stages only the one file', /git add -A data\/fx\.auto\.json/.test(wf) && !/git add -A\s*$/m.test(wf));
  check('it passes the publication gate for its own producer', /validate-data-publication\.mjs[\s\\]*--producer fx-rates/.test(wf));
  check('it publishes through the shared workflow', /uses: \.\/\.github\/workflows\/publish-data\.yml/.test(wf) && /producer: fx-rates/.test(wf) && /artifact: fx-rates-refresh/.test(wf));
  check('and merges what the gate passed', /merge: true/.test(wf));
  check('no run overrides the clock the gate or the script judge by', !/--now/.test(wf));
}

rmSync(work, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
