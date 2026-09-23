// Cutting a document into pieces a model can be asked about.
//
// Two things matter and they pull against each other. A chunk has to be
// small enough to send and large enough that a claim is not cut in half. And
// every chunk has to carry its offset in the whole document, because an
// evidence span is verified against the whole document later: a model given
// a chunk reports offsets within that chunk, and the runner translates them
// before anything is checked. Getting that translation wrong would make
// every span fail, which is the safe direction, but it would also make the
// pipeline useless.
//
// Chunking is deterministic: the same text always cuts the same way, so a
// rerun asks the same questions.

export const CHUNK_VERSION = 1;
export const DEFAULT_CHUNK_CHARS = 8_000;
export const DEFAULT_OVERLAP_CHARS = 400;

/** A rough token count. Deliberately generous, since it feeds a budget. */
export const estimateTokens = (text) => Math.ceil(String(text).length / 3.5);

/**
 * Cut on paragraph boundaries where one is near enough, on a character
 * boundary otherwise, with a small overlap so a sentence spanning a cut is
 * still whole in one of the two.
 */
export function chunkDocument(text, { documentId, chunkChars = DEFAULT_CHUNK_CHARS, overlapChars = DEFAULT_OVERLAP_CHARS, maxChunks = Infinity } = {}) {
  const chunks = [];
  let start = 0;
  let index = 0;
  while (start < text.length) {
    if (chunks.length >= maxChunks) {
      return { chunks, truncated: true, reason: `the document needs more than the ${maxChunks} chunk ceiling` };
    }
    let end = Math.min(start + chunkChars, text.length);
    if (end < text.length) {
      const window = text.slice(start, end);
      const breakAt = Math.max(window.lastIndexOf('\n\n'), window.lastIndexOf('\n'));
      if (breakAt > chunkChars * 0.5) end = start + breakAt + 1;
    }
    chunks.push({
      chunkId: `${documentId}#${index}`,
      documentId,
      index,
      startOffset: start,
      endOffset: end,
      text: text.slice(start, end),
      estimatedInputTokens: estimateTokens(text.slice(start, end)),
    });
    index += 1;
    if (end >= text.length) break;
    start = Math.max(end - overlapChars, start + 1);
  }
  return { chunks, truncated: false, reason: null };
}

/**
 * A model reports offsets inside its chunk. This puts them back where they
 * belong, and refuses a span that does not sit inside the chunk it came
 * from — which is what a fabricated offset usually looks like.
 */
/**
 * Find where an excerpt sits, rather than asking the model where it sits.
 *
 * The first pilot lost eight of eleven proposals to "the excerpt occurs in the
 * source but not at the stated offsets": the model quoted the letter correctly
 * and then miscounted the character positions. That was a design mistake on
 * our side. Counting characters in a two-thousand-token passage is arithmetic,
 * and a language model is not the right instrument for it, so the model is no
 * longer asked. It returns the words; the position is ours to compute.
 *
 * This is strictly stronger than verifying an offset it supplied. An excerpt
 * that does not occur at all still fails, because a search returns nothing,
 * which is the same refusal of invented text as before. What changes is that a
 * true quotation is no longer thrown away over an index.
 *
 * Exactly one occurrence is required. Two identical runs of text in one
 * passage are two different places in the letter, and there is no honest way
 * to choose between them, so an ambiguous excerpt is dropped rather than
 * resolved by picking the first. Nothing is sent back to the model to be
 * disambiguated: the pipeline drops and moves on, as it does everywhere else.
 */
export function locateExcerpt(chunk, excerpt) {
  if (typeof excerpt !== 'string' || !excerpt) {
    return { start: null, end: null, problem: 'the excerpt is missing or is not a string' };
  }
  if (excerpt.length > chunk.text.length) {
    return { start: null, end: null, problem: `the excerpt is longer than chunk ${chunk.chunkId}` };
  }

  // Counted by scanning rather than by splitting, so an excerpt that overlaps
  // itself ("aa" inside "aaa") is counted the way a reader would count it.
  const hits = [];
  for (let i = chunk.text.indexOf(excerpt); i !== -1; i = chunk.text.indexOf(excerpt, i + 1)) {
    hits.push(i);
    if (hits.length > 1) break;
  }

  if (!hits.length) return { start: null, end: null, problem: `the excerpt does not occur in chunk ${chunk.chunkId}` };
  if (hits.length > 1) {
    return { start: null, end: null, problem: `the excerpt occurs more than once in chunk ${chunk.chunkId}, so which one is meant is ambiguous` };
  }

  return toDocumentOffsets(chunk, hits[0], hits[0] + excerpt.length);
}

export function toDocumentOffsets(chunk, startInChunk, endInChunk) {
  if (!Number.isInteger(startInChunk) || !Number.isInteger(endInChunk)) {
    return { start: null, end: null, problem: 'the offsets are not integers' };
  }
  if (startInChunk < 0 || endInChunk > chunk.text.length || endInChunk <= startInChunk) {
    return { start: null, end: null, problem: `the span [${startInChunk}, ${endInChunk}) does not sit inside chunk ${chunk.chunkId}` };
  }
  return { start: chunk.startOffset + startInChunk, end: chunk.startOffset + endInChunk, problem: null };
}

/**
 * Company mentions worth asking about, found without a model.
 *
 * Capitalised runs with a corporate suffix, plus any confirmed alias that
 * appears verbatim. This is a candidate list, not a resolution: it decides
 * what to ask about, never what the answer is.
 */
const SUFFIX = /\b(Inc|Incorporated|Corp|Corporation|Company|Co|Ltd|Limited|PLC|LLC|LP|Holdings|Group|Industries|Components|Partners|Technologies|Systems)\b\.?/;

export function mentionCandidates(text, { aliases = [] } = {}) {
  const found = new Map();
  const add = (name, offset) => {
    const key = name.trim();
    if (key.length < 3) return;
    if (!found.has(key)) found.set(key, { mention: key, firstOffset: offset, occurrences: 0 });
    found.get(key).occurrences += 1;
  };
  for (const m of text.matchAll(/\b([A-Z][\w&.'-]*(?:\s+(?:[A-Z][\w&.'-]*|of|and|the))*)\b/g)) {
    if (SUFFIX.test(m[1])) add(m[1], m.index);
  }
  for (const a of aliases) {
    let from = 0;
    for (;;) {
      const at = text.indexOf(a.alias, from);
      if (at === -1) break;
      add(a.alias, at);
      from = at + a.alias.length;
    }
  }
  return [...found.values()].sort((a, b) => a.firstOffset - b.firstOffset || a.mention.localeCompare(b.mention));
}
