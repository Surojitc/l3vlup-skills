#!/usr/bin/env node
/**
 * Where one run of a producer publishes, printed as GitHub Actions step outputs.
 *
 *   node scripts/publication-target.mjs open-data \
 *        --ref "$GITHUB_REF" --run-id "$GITHUB_RUN_ID" [--review true|false]
 *
 * The publisher workflow takes a producer id and nothing else that names a
 * place, and looks the branch and the title up here. A caller therefore
 * cannot choose where its data lands, and neither can anything a collector
 * read: an id that is not in the contract table fails the run rather than
 * defaulting to something.
 *
 * The ref and the run id are GitHub's (`github.ref`, `github.run_id`), not
 * the caller's. A run collected by main and not marked review-only publishes
 * to the contract's branch, as it always has; every other run publishes to
 * `<contract branch>-review-<run id>`, a branch of its own that the scheduled
 * run never touches and that is never merged automatically. The rule is
 * publicationTarget() in scripts/publication-contracts.mjs, beside the table.
 *
 * Both are required. A caller whose workflow predates review branches calls
 * this with the producer alone, and that call fails here rather than guessing:
 * guessing "scheduled" is how a controlled run lands on the scheduled branch,
 * which is the incident of 20 October 2026 this rule exists to end.
 */
import { publicationTarget } from './publication-contracts.mjs';

const args = process.argv.slice(2);
const id = args[0] && !args[0].startsWith('--') ? args[0] : undefined;
function arg(name) {
  const i = args.indexOf(`--${name}`);
  return i > -1 ? args[i + 1] : undefined;
}

const target = publicationTarget(id, { ref: arg('ref'), runId: arg('run-id'), review: arg('review') });
if (target.problems.length) {
  for (const p of target.problems) console.error(`::error::${p}`);
  console.error('nothing has been published: a run that cannot be placed is published nowhere');
  process.exit(1);
}

// No value may carry a newline, or it would inject a second output. The
// contract's values are checked in publicationTarget; these are checked
// again here, where they are written, because this is where it would matter.
for (const [key, value] of [
  ['branch', target.branch],
  ['title', target.title],
  ['label', target.label],
  ['review', String(target.review)],
  ['kind', target.kind],
  ['collected_by', target.collectedBy],
  ['run_id', target.runId],
]) {
  if (typeof value !== 'string' || !value || /[\r\n]/.test(value)) {
    console.error(`::error::${id}'s ${key} is not a single-line string`);
    process.exit(1);
  }
  console.log(`${key}=${value}`);
}
