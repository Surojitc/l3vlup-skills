// What a person needs to know about an extraction before trusting it.
//
// Every measure here is a count or a ratio over the extracted units, and
// each exists because it catches a specific way extraction goes wrong: a
// document that parsed but is mostly blank, a running header repeated on
// every page and counted as content, a mis-decoded encoding, a report that
// turned out to be all table and no prose. Where a measure crosses a
// threshold it becomes a warning naming what to look at, not a failure:
// the person decides.

const REPLACEMENT = /�/g;
/** Words a manager writing about a holding uses and a filing cover does not. */
const DISCUSSION = ['we believe', 'we think', 'our view', 'in our opinion', 'we bought', 'we sold', 'we added', 'we own', 'our position', 'we expect', 'portfolio', 'shareholders', 'stockholders', 'valuation', 'earnings', 'management'];

const ratio = (a, b) => (b ? Number((a / b).toFixed(4)) : 0);

/** The first and last line of a unit, which is where a running header sits. */
function edges(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  return { head: lines[0] || '', foot: lines.at(-1) || '' };
}

export function assess({ units, items, rawCharacters }) {
  const texts = items.map((i) => i.text || '');
  const normalised = texts.join('\n').length;
  const empty = texts.filter((t) => !t.trim()).length;

  const heads = new Map();
  const foots = new Map();
  for (const t of texts) {
    const { head, foot } = edges(t);
    if (head) heads.set(head, (heads.get(head) || 0) + 1);
    if (foot) foots.set(foot, (foots.get(foot) || 0) + 1);
  }
  const repeated = (m) => Math.max(0, ...Array.from(m.values()));
  const repeatedEdge = items.length > 2 ? ratio(Math.max(repeated(heads), repeated(foots)), items.length) : 0;

  const all = texts.join(' ').toLowerCase();
  const replacements = (all.match(REPLACEMENT) || []).length;
  const discussion = DISCUSSION.filter((w) => all.includes(w));

  const warnings = [];
  if (!items.length) warnings.push('nothing was extracted');
  if (ratio(empty, items.length) > 0.3) warnings.push(`${empty} of ${items.length} ${units} are empty: check for an image-only document`);
  if (repeatedEdge > 0.6) warnings.push(`the same line opens or closes ${Math.round(repeatedEdge * 100)}% of ${units}: a running header is being counted as content`);
  if (ratio(replacements, normalised) > 0.001) warnings.push(`${replacements} replacement characters: the encoding may be wrong`);
  if (discussion.length < 3) warnings.push('little sign of manager discussion in the text: check that the right document was retrieved');
  if (normalised < 2000) warnings.push(`only ${normalised} characters of text: short for a letter or a report`);

  return {
    units,
    unitCount: items.length,
    rawCharacters: rawCharacters ?? null,
    normalisedCharacters: normalised,
    emptyUnitRatio: ratio(empty, items.length),
    repeatedEdgeRatio: repeatedEdge,
    replacementCharacters: replacements,
    replacementRate: ratio(replacements, normalised),
    tableRows: items.filter((i) => i.tag === 'tr').length,
    managerDiscussionPresent: discussion.length >= 3,
    managerDiscussionMarkers: discussion.length,
    warnings,
  };
}
