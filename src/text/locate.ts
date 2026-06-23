/**
 * Locate a reading-mode selection back in the note source (best-effort).
 *
 * Reading mode renders Markdown to HTML with the markers stripped, so a DOM
 * selection's text (e.g. "bold text") no longer matches the raw source
 * ("**bold** text"). To create a highlight from it we need *source* offsets, so
 * we project the source to the same plain text the renderer produces — keeping a
 * per-character map back to source offsets — and search that projection for the
 * selection's (equally projected) text.
 *
 * This mirrors the reading-mode painter's philosophy (see `@/reading/project`):
 * deliberately lossy, good for the common case (prose, emphasis), and honest
 * about giving up (returns `null`) when it can't find a verbatim match — the
 * caller then tells the user to highlight in Live Preview instead. The first
 * occurrence wins; reading mode can't disambiguate repeats by position.
 */
import type { Range } from '@/model/types';
import { projectQuoteToText } from '@/reading/project';
import { bodyStart } from '@/text/frontmatter';

interface Cell {
  ch: string;
  /** Offset of this character in the original source. */
  off: number;
}

const WS = /\s/;
const LEADING_MARKERS = /^\s*(?:>\s*)*(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)?/;

/**
 * Project raw `input` to the renderer's plain text while recording, for each
 * output character, the source offset it came from. The produced `text` equals
 * {@link projectQuoteToText}`(input)`, so a projected needle matches verbatim.
 */
export function projectSourceWithMap(input: string): { text: string; off: number[] } {
  const drop = leadingMarkerOffsets(input);

  // 1. Char cells, dropping per-line leading block markers (and indentation).
  let cells: Cell[] = [];
  for (let i = 0; i < input.length; i++) {
    if (!drop.has(i)) cells.push({ ch: input[i], off: i });
  }
  // 2. split('\n').join(' ') — newlines become spaces.
  for (const c of cells) if (c.ch === '\n') c.ch = ' ';
  // 3. Reduce links / images / wikilinks to the text the renderer actually shows.
  //    These mirror projectQuoteToText's replacements *in the same order*, kept in
  //    lock-step so this projection's text stays equal to projectQuoteToText's —
  //    the invariant findSourceRange relies on (a needle projected one way must be
  //    findable in the source projected the other). Missing them meant a selection
  //    spanning a link (the rendered "[Obsidian](url)" → "Obsidian") never matched
  //    the still-bracketed source and creation failed in reading mode (§7.2).
  cells = reduceCells(cells, /!\[[^\]]*\]\([^)]*\)/g, dropAll); // images → nothing
  cells = reduceCells(cells, /\[\[[^\]|]*\|([^\]]*)\]\]/g, keepAlias); // [[a|b]] → b
  cells = reduceCells(cells, /\[\[([^\]]*)\]\]/g, keepAfterDoubleBracket); // [[a]] → a
  cells = reduceCells(cells, /\[([^\]]*)\]\([^)]*\)/g, keepAfterBracket); // [t](url) → t
  // 4. Remove inline emphasis / inline-code markers (styling, not text).
  cells = cells.filter((c) => c.ch !== '*' && c.ch !== '_' && c.ch !== '`');
  // 5. Collapse every whitespace run to a single space (mapped to the run start).
  cells = collapseWhitespace(cells);
  // 6. Trim.
  while (cells.length > 0 && cells[0].ch === ' ') cells.shift();
  while (cells.length > 0 && cells[cells.length - 1].ch === ' ') cells.pop();

  return { text: cells.map((c) => c.ch).join(''), off: cells.map((c) => c.off) };
}

/**
 * For a regex match, the `[start, end)` slice of the matched text (in projection
 * index space) to KEEP — the rest of the match is dropped. `null` drops it all.
 */
type KeptSlice = (m: RegExpExecArray) => [number, number] | null;

const dropAll: KeptSlice = () => null;
/** `[text](url)` → keep `text`: the capture sits right after the opening `[`. */
const keepAfterBracket: KeptSlice = (m) => [m.index + 1, m.index + 1 + m[1].length];
/** `[[target]]` → keep `target`: the capture sits right after the opening `[[`. */
const keepAfterDoubleBracket: KeptSlice = (m) => [m.index + 2, m.index + 2 + m[1].length];
/** `[[target|alias]]` → keep `alias`: the capture sits right before the closing `]]`. */
const keepAlias: KeptSlice = (m) => {
  const end = m.index + m[0].length - 2; // before the trailing "]]"
  return [end - m[1].length, end];
};

/**
 * Apply one reduction to the cell stream, mirroring `String#replace(re, …)` with
 * a global `re`: cells outside any match pass through unchanged; inside each match
 * only the cells in `kept(m)` (a sub-slice of the match) survive, dragging their
 * source offsets along. `re` must carry the `g` flag. Locating the kept capture by
 * arithmetic on `m.index`/`m[0].length` avoids the ES2022 `d` (indices) flag,
 * which is outside this project's TS target.
 */
function reduceCells(cells: Cell[], re: RegExp, kept: KeptSlice): Cell[] {
  const s = cells.map((c) => c.ch).join('');
  const out: Cell[] = [];
  let last = 0;
  re.lastIndex = 0;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    const start = m.index;
    const end = start + m[0].length;
    for (let i = last; i < start; i++) out.push(cells[i]);
    const slice = kept(m);
    if (slice) for (let i = slice[0]; i < slice[1]; i++) out.push(cells[i]);
    last = end;
    if (m[0].length === 0) re.lastIndex++; // never spin on a zero-width match
  }
  for (let i = last; i < cells.length; i++) out.push(cells[i]);
  return out;
}

/**
 * Best-effort source range `[from, to)` for a (reading-mode) selection. Returns
 * `null` when the selection's projected text can't be found in the source.
 */
export function findSourceRange(sourceText: string, selected: string): Range | null {
  const needle = projectQuoteToText(selected);
  if (needle.length === 0) return null;

  // Search only the body: a leading YAML frontmatter block isn't annotatable, and
  // its title/description duplicate body text, so the first occurrence could
  // otherwise land in the frontmatter (Design.md §6.5). `base` maps offsets home.
  const base = bodyStart(sourceText);
  const proj = projectSourceWithMap(sourceText.slice(base));
  const i = proj.text.indexOf(needle);
  if (i === -1) return null;

  const from = base + proj.off[i];
  const to = base + proj.off[i + needle.length - 1] + 1;
  return { from, to };
}

/** Offsets in `input` that begin each line's leading block markers / indentation. */
function leadingMarkerOffsets(input: string): Set<number> {
  const drop = new Set<number>();
  let lineStart = 0;
  for (let i = 0; i <= input.length; i++) {
    if (i === input.length || input[i] === '\n') {
      const match = LEADING_MARKERS.exec(input.slice(lineStart, i));
      const len = match ? match[0].length : 0;
      for (let k = 0; k < len; k++) drop.add(lineStart + k);
      lineStart = i + 1;
    }
  }
  return drop;
}

/** Collapse maximal whitespace runs to a single space mapped to the run's start. */
function collapseWhitespace(cells: Cell[]): Cell[] {
  const out: Cell[] = [];
  let i = 0;
  while (i < cells.length) {
    if (WS.test(cells[i].ch)) {
      const start = cells[i].off;
      while (i < cells.length && WS.test(cells[i].ch)) i++;
      out.push({ ch: ' ', off: start });
    } else {
      out.push(cells[i]);
      i++;
    }
  }
  return out;
}
