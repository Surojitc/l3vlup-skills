// SEC HTML and inline XBRL, reduced to the text a person would read.
//
// A shareholder report on EDGAR is a 16 MB inline-XBRL document: the letter
// a candidate wants is a few thousand words of it, wrapped in tagging that
// exists for machines. Regular expressions are the wrong tool at that size
// and shape, so this walks a real parse tree (parse5, the WHATWG parser,
// MIT, one runtime dependency) and keeps block elements in document order.
//
// Three rules decide what survives. Script, style and the rest of the page
// furniture go entirely. The inline-XBRL metadata containers go entirely:
// ix:header, ix:hidden, ix:references and ix:resources hold facts and
// context, not prose, and ix:hidden in particular holds text that is
// deliberately not displayed. Every other ix: element is unwrapped, because
// the visible sentence sits inside one. Nothing is fetched: links are text,
// not instructions.

import { parse } from 'parse5';

export const PARSER = 'parse5';
export const PARSER_VERSION = '8.0.1';

/** Gone with their contents. */
const DROP = new Set(['script', 'style', 'noscript', 'svg', 'math', 'iframe', 'object', 'embed', 'template', 'head', 'link', 'meta', 'base', 'form', 'button', 'input', 'select', 'textarea']);
/** Inline-XBRL containers that hold tagging rather than prose. */
const DROP_IX = new Set(['ix:header', 'ix:hidden', 'ix:references', 'ix:resources', 'ix:footnote', 'ix:exclude']);
/** Each of these starts a section of its own. */
const BLOCK = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'li', 'blockquote', 'pre', 'dd', 'dt', 'figcaption', 'caption']);
const HEADING = /^h([1-6])$/;

const textOf = (node) => {
  let out = '';
  const walk = (n) => {
    if (n.nodeName === '#text') { out += n.value; return; }
    const tag = (n.tagName || '').toLowerCase();
    if (DROP.has(tag) || DROP_IX.has(tag)) return;
    for (const c of n.childNodes || []) walk(c);
  };
  walk(node);
  return out;
};

const clean = (s) => s.replace(/ /g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Sections in document order, each with the tag that produced it.
 *
 * A table becomes one section per row, cells joined by a tab, which keeps a
 * figure beside its label without pretending to reconstruct a layout.
 */
export function extractSections(html, { minChars = 1 } = {}) {
  const doc = parse(String(html || ''));
  const sections = [];
  const warnings = [];
  let dropped = 0;
  let tables = 0;
  let rows = 0;

  const push = (tag, text, level = null, { preformatted = false } = {}) => {
    // A table row keeps the tab between its cells: cleaning it away would
    // put a figure and its label into one undifferentiated string.
    const t = preformatted ? text.trim() : clean(text);
    if (t.length >= minChars) sections.push({ index: sections.length, tag, level, text: t, chars: t.length });
  };

  const walk = (node) => {
    const tag = (node.tagName || '').toLowerCase();
    if (DROP.has(tag) || DROP_IX.has(tag)) { dropped += 1; return; }
    if (tag === 'table') {
      tables += 1;
      const trs = [];
      const findRows = (n) => {
        if ((n.tagName || '').toLowerCase() === 'tr') { trs.push(n); return; }
        for (const c of n.childNodes || []) findRows(c);
      };
      findRows(node);
      for (const tr of trs) {
        const cells = [];
        const findCells = (n) => {
          const t = (n.tagName || '').toLowerCase();
          if (t === 'td' || t === 'th') { cells.push(clean(textOf(n))); return; }
          for (const c of n.childNodes || []) findCells(c);
        };
        findCells(tr);
        const line = cells.filter(Boolean).join('\t');
        if (line) { push('tr', line, null, { preformatted: true }); rows += 1; }
      }
      return;
    }
    if (BLOCK.has(tag)) {
      const m = HEADING.exec(tag);
      push(tag, textOf(node), m ? Number(m[1]) : null);
      return; // a block's children belong to it
    }
    for (const c of node.childNodes || []) walk(c);
  };

  walk(doc);
  if (!sections.length) warnings.push('no sections survived: the document may be a frameset, an image or entirely tagging');
  const chars = sections.reduce((n, s) => n + s.chars, 0);
  if (chars && tables && rows / Math.max(sections.length, 1) > 0.9) warnings.push('almost every section is a table row: check that the prose was found');
  return {
    parser: PARSER,
    parserVersion: PARSER_VERSION,
    units: 'sections',
    sections,
    stats: { sections: sections.length, tables, tableRows: rows, droppedElements: dropped, characters: chars },
    warnings,
  };
}
