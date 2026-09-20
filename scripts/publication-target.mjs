#!/usr/bin/env node
/**
 * Where a producer publishes, printed as GitHub Actions step outputs.
 *
 *   node scripts/publication-target.mjs open-data
 *
 * The publisher workflow takes a producer id and nothing else, and looks the
 * branch and the title up here. A caller therefore cannot choose where its
 * data lands, and neither can anything a collector read: an id that is not in
 * the contract table fails the run rather than defaulting to something.
 */
import { CONTRACTS } from './publication-contracts.mjs';

const id = process.argv[2];
const contract = CONTRACTS[id];
if (!contract) {
  console.error(`::error::no publication contract named ${id ?? '(none)'}`);
  process.exit(1);
}
// Neither value may carry a newline, or it would inject a second output.
for (const [key, value] of [['branch', contract.branch], ['title', contract.title], ['label', contract.label]]) {
  if (typeof value !== 'string' || /[\r\n]/.test(value)) {
    console.error(`::error::${id}'s ${key} is not a single-line string`);
    process.exit(1);
  }
  console.log(`${key}=${value}`);
}
