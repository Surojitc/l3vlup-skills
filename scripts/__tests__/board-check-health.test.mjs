/**
 * The Hiring Pulse's record is whole, and the check that says so says the
 * right thing.
 *
 *   node scripts/__tests__/board-check-health.test.mjs
 *
 * Pure: lib/board-check-health.mjs over invented days, then over the real
 * history on file, where the one collapse (14 November 2026) must be the only
 * day the coverage rule flags and every gap must be acknowledged.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { KNOWN_GAPS, STALE_HOURS, boardCheckHealth, coverageVerdict, healthSummary, median } from '../../lib/board-check-health.mjs';
import { readRecord, resolveThrough } from '../check-board-checks.mjs';

let pass = 0;
let fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
  ok ? (pass += 1) : (fail += 1);
};

const registry = { current: 'm2', fingerprints: { aaaaaaaaaaaaaaaa: { method: 'm1' }, bbbbbbbbbbbbbbbb: { method: 'm2' } } };
const day = (date, ok = 100, fingerprint = 'bbbbbbbbbbbbbbbb') => ({ date, file: { date, fingerprint, checkedAt: `${date}T12:00:00Z`, counts: { ok, partial: 2, failed: 2 } } });
const run = (days, extra = {}) => boardCheckHealth({ days, registry, through: '2026-11-10', now: new Date('2026-11-10T18:00:00Z'), gaps: {}, ...extra });
const codes = (r) => r.problems.map((p) => p.code);
const tenDays = Array.from({ length: 10 }, (_, i) => day(`2026-11-${String(i + 1).padStart(2, '0')}`));

eq('ten whole days have no problems', codes(run(tenDays)), []);
eq('a missing day is flagged', codes(run(tenDays.filter((d) => d.date !== '2026-11-05'))), ['missing-day']);
eq('...unless it is acknowledged with a reason', codes(run(tenDays.filter((d) => d.date !== '2026-11-05'), { gaps: { '2026-11-05': 'why' } })), []);
eq('...and an acknowledged gap is still named', run(tenDays.filter((d) => d.date !== '2026-11-05'), { gaps: { '2026-11-05': 'why' } }).gapsAcknowledged, ['2026-11-05']);
eq('the day due last is missing: flagged', codes(run(tenDays.slice(0, 9), { now: new Date('2026-11-10T18:00:00Z') })), ['missing-day']);
eq('nothing on file at all is flagged', codes(run([])), ['missing-day']);
eq('an unreadable day file is flagged', codes(run([...tenDays.slice(0, 9), { date: '2026-11-10', file: null }])), ['unreadable-day']);
eq('a day without a fingerprint is flagged', codes(run([...tenDays.slice(0, 9), { date: '2026-11-10', file: { ...day('2026-11-10').file, fingerprint: undefined } }])), ['no-fingerprint']);
eq('a day collected by an unlabelled fingerprint is flagged', codes(run([...tenDays.slice(0, 9), day('2026-11-10', 100, 'cccccccccccccccc')])), ['unlabelled-fingerprint']);
eq('a day labelled later is fine: the registry, not the file, decides', codes(run([...tenDays.slice(0, 9), day('2026-11-10', 100, 'aaaaaaaaaaaaaaaa')])), []);
eq('the code on disk unlabelled is flagged when the caller ran it', codes(run(tenDays, { currentFingerprint: 'dddddddddddddddd' })), ['unlabelled-fingerprint']);
eq('...and not when it is labelled', codes(run(tenDays, { currentFingerprint: 'bbbbbbbbbbbbbbbb' })), []);
eq('an unpublished registry is flagged', codes(run(tenDays, { publishedMatches: false })), ['registry-unpublished']);
eq(`a record older than ${STALE_HOURS}h is stale`, codes(run(tenDays, { now: new Date('2026-11-12T13:00:00Z'), through: '2026-11-10' })), ['stale']);
eq(`...and one ${STALE_HOURS}h old is not`, codes(run(tenDays, { now: new Date('2026-11-12T12:00:00Z'), through: '2026-11-10' })), []);

const dropTo = (ok) => [...tenDays.slice(0, 9), day('2026-11-10', ok)];
eq('a collapse in boards read completely is flagged', codes(run(dropTo(70))), ['coverage-drop']);
eq('a drop of a few boards is not', codes(run(dropTo(96))), []);
eq('a drop under 15% is not', codes(run(dropTo(86))), []);
eq('on a small registry a big share of a few boards is not', coverageVerdict([...Array.from({ length: 9 }, (_, i) => day(`2026-11-0${i + 1}`, 20)), day('2026-11-10', 14)]).flagged, false);
eq('with fewer than five earlier days nothing is said', coverageVerdict([day('2026-11-01'), day('2026-11-02'), day('2026-11-03', 10)]).flagged, false);
eq('growth is never a drop', codes(run(dropTo(160))), []);
eq('median of an even list', median([1, 2, 3, 10]), 2.5);
eq('the summary names each problem', /\*\*coverage-drop\*\*/.test(healthSummary(run(dropTo(70)))), true);
eq('--through today', resolveThrough('today', new Date('2026-11-10T01:00:00Z')), '2026-11-10');
eq('--through yesterday', resolveThrough('yesterday', new Date('2026-11-10T01:00:00Z')), '2026-11-09');
eq('--through rubbish is refused', resolveThrough('soon'), null);

// ── the real record ──────────────────────────────────────────────────────
{
  const record = readRecord();
  const files = readdirSync('data/board-checks').filter((f) => f.endsWith('.json')).sort();
  const last = files.at(-1).slice(0, 10);
  const r = boardCheckHealth({ ...record, through: last, now: new Date(`${last}T23:00:00Z`) });
  eq('the record on file has no unexplained gap, no unlabelled fingerprint and a published registry', r.problems.filter((p) => p.code !== 'coverage-drop').map((p) => p.detail), []);
  eq('every acknowledged gap is a day with no file', Object.keys(KNOWN_GAPS).filter((d) => files.includes(`${d}.json`)), []);
  eq('every acknowledged gap says why', Object.values(KNOWN_GAPS).every((why) => why.length > 40), true);
  const days = files.map((f) => ({ date: f.slice(0, 10), file: JSON.parse(readFileSync(`data/board-checks/${f}`, 'utf8')) }));
  const flagged = [];
  for (let i = 1; i <= days.length; i += 1) {
    const v = coverageVerdict(days.slice(0, i));
    if (v?.flagged) flagged.push(v.date);
  }
  eq('over the real history the coverage rule flags 14 November 2026 and nothing else', flagged, ['2026-11-14']);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
