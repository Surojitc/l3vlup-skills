#!/usr/bin/env node
// One-time historical correction of adviser credits in the deck index.
//
// The collector credits a deck to the bank that wrote it, on evidence in the
// deck's own text (lib/decks.mjs, detectAdvisers). Decks indexed before that
// rule were credited to any bank named twice in their opening pages, so the
// index carries credits to banks a deck only names: the other side's adviser,
// quoted research, price-target and estimate sources, lenders, league tables,
// conferences and data sources. The collector does not re-read filings it
// already holds, so those credits stay unless they are corrected here.
//
// data/decks.adviser-cleanup-2026-10.json is the reviewed list: each removal
// with its reason and the deck text behind it, and the cases left for a person
// to decide. This script applies the removals and nothing else:
//
//   - a listed bank comes off the listed exhibit, in transactions[].decks and
//     filings[].decks alike;
//   - each filing's and transaction's adviser list is rebuilt as the banks
//     still credited on its decks, keeping the list's order, which is how the
//     collector builds it (a list can only lose a bank, never gain one);
//   - every other field, review cases included, is left as it is.
//
// It is idempotent: a removal already applied is skipped. It refuses to write
// when a listed exhibit is missing from the index.
//
//   node scripts/decks-adviser-cleanup.mjs           apply and write
//   node scripts/decks-adviser-cleanup.mjs --check   report only, exit 1 if anything is left to apply

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const INDEX = join(ROOT, 'data/decks.auto.json');
const RECORD = join(ROOT, 'data/decks.adviser-cleanup-2026-10.json');

/** Apply the record's removals to a parsed index, in place. Returns what changed. */
export function applyCleanup(index, record) {
  const drop = new Map();
  for (const r of record.removals) {
    if (!drop.has(r.url)) drop.set(r.url, new Set());
    drop.get(r.url).add(r.bank);
  }
  const seen = new Set();
  let decksChanged = 0;
  let creditsRemoved = 0;
  const visit = (deck, count) => {
    const banks = drop.get(deck.url);
    if (!banks) return;
    seen.add(deck.url);
    const before = deck.advisers ?? [];
    const after = before.filter((b) => !banks.has(b));
    if (after.length === before.length) return;
    deck.advisers = after;
    if (count) {
      decksChanged += 1;
      creditsRemoved += before.length - after.length;
    }
  };
  // The transactions' decks are the canonical list; the filings repeat them.
  for (const t of index.transactions) for (const d of t.decks) visit(d, true);
  for (const f of index.filings) for (const d of f.decks) visit(d, false);

  const missing = [...drop.keys()].filter((u) => !seen.has(u));
  if (missing.length) throw new Error(`${missing.length} listed exhibit(s) not in the index, e.g. ${missing[0]}`);

  const rebuild = (row) => {
    const credited = new Set(row.decks.flatMap((d) => d.advisers ?? []));
    const kept = (row.advisers ?? []).filter((b) => credited.has(b));
    if (kept.length === (row.advisers ?? []).length) return false;
    row.advisers = kept;
    return true;
  };
  const filingsChanged = index.filings.filter(rebuild).length;
  const transactionsChanged = index.transactions.filter(rebuild).length;
  return { decksChanged, creditsRemoved, filingsChanged, transactionsChanged };
}

function main() {
  const check = process.argv.includes('--check');
  const raw = readFileSync(INDEX, 'utf8');
  const index = JSON.parse(raw);
  const record = JSON.parse(readFileSync(RECORD, 'utf8'));
  const result = applyCleanup(index, record);
  const pending = result.decksChanged + result.filingsChanged + result.transactionsChanged;
  console.log(`${record.removals.length} listed removals · ${result.creditsRemoved} credits removed on ${result.decksChanged} exhibits · ${result.filingsChanged} filing and ${result.transactionsChanged} transaction adviser lists rebuilt · ${record.review.length} review cases left as they are`);
  if (check) {
    if (pending) {
      console.log('Not yet applied.');
      process.exit(1);
    }
    console.log('Already applied.');
    return;
  }
  if (!pending) return;
  // The collector writes the index as one line with a trailing newline; keep that.
  writeFileSync(INDEX, `${JSON.stringify(index)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
