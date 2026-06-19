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
  // 3. Remove inline emphasis / inline-code markers (styling, not text).
  cells = cells.filter((c) => c.ch !== '*' && c.ch !== '_' && c.ch !== '`');
  // 4. Collapse every whitespace run to a single space (mapped to the run start).
  cells = collapseWhitespace(cells);
  // 5. Trim.
  while (cells.length > 0 && cells[0].ch === ' ') cells.shift();
  while (cells.length > 0 && cells[cells.length - 1].ch === ' ') cells.pop();

  return { text: cells.map((c) => c.ch).join(''), off: cells.map((c) => c.off) };
}

/**
 * Best-effort source range `[from, to)` for a (reading-mode) selection. Returns
 * `null` when the selection's projected text can't be found in the source.
 */
export function findSourceRange(sourceText: string, selected: string): Range | null {
  const needle = projectQuoteToText(selected);
  if (needle.length === 0) return null;

  const proj = projectSourceWithMap(sourceText);
  const i = proj.text.indexOf(needle);
  if (i === -1) return null;

  const from = proj.off[i];
  const to = proj.off[i + needle.length - 1] + 1;
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
