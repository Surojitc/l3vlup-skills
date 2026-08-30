/**
 * The deadline ledger.
 *
 * The cases here are the ones that actually went wrong in production, not
 * invented ones: a role that falls out of the collated set for a day, a
 * deadline that expires while the role stays open, and a posting page that
 * never carries a date and should stop being asked.
 */
import {
  LEDGER_VERSION,
  enrichmentRank,
  ledgerDeadline,
  loadLedger,
  needsCheck,
  orderForEnrichment,
  pruneLedger,
  recheckDelayDays,
  recordHit,
  recordMiss,
  serialiseLedger,
} from '../../lib/deadline-ledger.mjs';

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
};

const TODAY = '2026-08-30';

// --- loading is defensive -------------------------------------------------
eq('an absent ledger loads empty', loadLedger(null),
   { version: LEDGER_VERSION, updatedAt: null, entries: {}, misses: {} });
eq('a junk ledger loads empty', loadLedger('nonsense'),
   { version: LEDGER_VERSION, updatedAt: null, entries: {}, misses: {} });
eq('an entry with no valid date is discarded',
   loadLedger({ entries: { a: { closingDate: 'soon' }, b: { closingDate: '2026-11-27' } } }).entries,
   { b: { closingDate: '2026-11-27', source: 'unknown', firstSeen: null, lastConfirmed: null } });
eq('a miss with no valid checkedAt is discarded',
   Object.keys(loadLedger({ misses: { a: { checkedAt: 'x' }, b: { checkedAt: '2026-08-01' } } }).misses), ['b']);

// --- the case this module exists for --------------------------------------
// Citi: found on Monday, absent from the collated set on Tuesday, still open.
{
  const l = loadLedger(null);
  recordHit(l, 'workday-citi-26985504', '2026-11-27', 'jsonld', '2026-08-28');
  // Tuesday: the role is not in `all` at all, so nothing overwrites it.
  eq('a deadline survives a run that never saw the role',
     ledgerDeadline(l, 'workday-citi-26985504', TODAY), { closingDate: '2026-11-27', source: 'jsonld' });
  // Wednesday: it is back, and still carries the date.
  pruneLedger(l, ['workday-citi-26985504'], TODAY);
  eq('and survives a prune while the role is live',
     ledgerDeadline(l, 'workday-citi-26985504', TODAY)?.closingDate, '2026-11-27');
}

// --- expiry ---------------------------------------------------------------
{
  const l = loadLedger({ entries: { x: { closingDate: '2026-08-29', source: 'jsonld' } } });
  eq('a deadline that has passed is not returned', ledgerDeadline(l, 'x', TODAY), undefined);
  eq('a deadline falling today is still returned', ledgerDeadline(l, 'x', '2026-08-29')?.closingDate, '2026-08-29');
  pruneLedger(l, ['x'], TODAY);
  eq('and is pruned even though the role is still live', Object.keys(l.entries), []);
}

// --- misses and backoff ---------------------------------------------------
eq('backoff widens with attempts', [1, 2, 3, 4, 5, 9].map(recheckDelayDays), [3, 6, 12, 21, 21, 21]);
{
  const l = loadLedger(null);
  eq('a role never checked is always checked', needsCheck(l, 'new', TODAY, 'jsonld'), true);
  recordMiss(l, 'new', TODAY, 'jsonld');
  eq('and not again the same day', needsCheck(l, 'new', TODAY, 'jsonld'), false);
  eq('nor two days later', needsCheck(l, 'new', '2026-09-01', 'jsonld'), false);
  eq('but yes after the backoff', needsCheck(l, 'new', '2026-09-02', 'jsonld'), true);
  recordMiss(l, 'new', '2026-09-02', 'jsonld');
  eq('second miss widens the gap to six days', needsCheck(l, 'new', '2026-09-05', 'jsonld'), false);
  eq('  …and fires on the sixth', needsCheck(l, 'new', '2026-09-08', 'jsonld'), true);
}
{
  const l = loadLedger(null);
  recordMiss(l, 'r', TODAY, 'jsonld');
  recordHit(l, 'r', '2026-12-01', 'workday-detail', TODAY);
  eq('a hit clears the miss for every source', Object.keys(l.misses), []);
  eq('a known deadline is not re-checked while it stands', needsCheck(l, 'r', '2026-09-01', 'jsonld'), false);
  // Once the date passes the role is genuinely undated again, so it goes back
  // into the queue rather than sitting on a stale answer forever.
  eq('but is re-checked once it has expired', needsCheck(l, 'r', '2027-01-01', 'jsonld'), true);
  recordHit(l, 'r', '2026-12-02', 'jsonld', '2026-09-01');
  eq('re-confirming keeps the original firstSeen', l.entries.r.firstSeen, TODAY);
  eq('and moves lastConfirmed', l.entries.r.lastConfirmed, '2026-09-01');
}

// --- the bug this refactor fixed -----------------------------------------
// The Workday detail pass asking and getting nothing must NOT stop the JSON-LD
// pass asking about the same role. They read different things.
{
  const l = loadLedger(null);
  recordMiss(l, 'workday-citi-1', TODAY, 'workday-detail');
  eq('workday saying no does not silence the workday pass',
     needsCheck(l, 'workday-citi-1', TODAY, 'workday-detail'), false);
  eq('but the JSON-LD pass may still ask',
     needsCheck(l, 'workday-citi-1', TODAY, 'jsonld'), true);
}

// --- forgetting -----------------------------------------------------------
{
  const l = loadLedger({
    entries: { gone: { closingDate: '2026-12-01', source: 'jsonld', lastConfirmed: '2026-06-01' } },
  });
  pruneLedger(l, [], TODAY);
  eq('a role off the boards for 90 days is forgotten', Object.keys(l.entries), []);
}
{
  const l = loadLedger({
    entries: { blip: { closingDate: '2026-12-01', source: 'jsonld', lastConfirmed: '2026-08-29' } },
  });
  pruneLedger(l, [], TODAY);
  eq('a role missing for one run is NOT forgotten', Object.keys(l.entries), ['blip']);
}

// --- serialisation is stable ---------------------------------------------
{
  const l = loadLedger(null);
  recordHit(l, 'z', '2026-12-01', 'jsonld', TODAY);
  recordHit(l, 'a', '2026-12-01', 'jsonld', TODAY);
  eq('entries serialise in key order', Object.keys(serialiseLedger(l, TODAY).entries), ['a', 'z']);
  eq('and carry the run date', serialiseLedger(l, TODAY).updatedAt, TODAY);
}

// --- enrichment ordering --------------------------------------------------
eq('a bulge bracket IB role outranks everything',
   enrichmentRank({ vertical: 'Investment Banking', tier: 'Bulge Bracket' }), 0);
eq('an unclassified big-tech role ranks last',
   enrichmentRank({ vertical: 'Other', tier: 'Big Tech' }), 5);
{
  const ordered = orderForEnrichment([
    { id: 'c', vertical: 'Software Engineering', tier: 'Big Tech', openingDate: '2026-08-29' },
    { id: 'a', vertical: 'Investment Banking', tier: 'Bulge Bracket', openingDate: '2026-08-01' },
    { id: 'b', vertical: 'Investment Banking', tier: 'Bulge Bracket', openingDate: '2026-08-28' },
  ]).map((r) => r.id);
  eq('finance first, newest first within a rank', ordered, ['b', 'a', 'c']);
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
