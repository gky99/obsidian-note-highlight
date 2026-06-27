/**
 * Keep a highlight's source range from cutting a Markdown emphasis delimiter in
 * half, so the stored quote stays well-formed Markdown.
 *
 * Both highlight-creation paths bound a range by the first/last *rendered*
 * (non-marker) characters: the Web Highlights importer ({@link import('@/import/locate').locateMark})
 * matches on a marker-stripped projection, and the manual selection toolbar takes
 * the editor's selection offsets — which, in Live Preview, start at the bold
 * *content* because the `**` markers are concealed. Either way a delimiter that
 * opens or closes exactly at a boundary lands just outside the range while its
 * partner sits inside it — e.g. a highlight beginning at `**bold**` keeps the
 * closing `**` (interior) but drops the opening one, yielding the broken
 * `bold** …`. {@link balanceEmphasisRange} grows the range over the wrapping
 * delimiters so import and select-and-mark agree and the quote renders.
 *
 * Pure: no `obsidian`, no DOM. Shared by `import/locate.ts` and `store.ts`.
 */
import type { Range } from '@/model/types';

/**
 * Inline emphasis delimiters (bold/italic/code/strikethrough) — the markers that
 * *wrap* a span of text with no gap. Block markers (`#`, `>`, `|`, list bullets)
 * are excluded: they sit at a line start separated from text by whitespace, so a
 * boundary scan never reaches them.
 */
const EMPHASIS_MARKERS = new Set(['*', '_', '`', '~']);

/** Number of maximal runs of `ch` in `s` (e.g. `**a**` has two runs of `*`). */
function runCount(s: string, ch: string): number {
  let runs = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === ch && (i === 0 || s[i - 1] !== ch)) runs++;
  }
  return runs;
}

/**
 * Grow a raw range `[from, to)` outward over the emphasis delimiters that *wrap*
 * the covered text. We consider the marker runs immediately before `from` / after
 * `to` and pick the boundary combination whose quote is *balanced* (an even
 * number of runs for every delimiter char we would pull in). Including a marker
 * only when it balances avoids grabbing the opening delimiter of a *following*
 * span (`word*italic*` → keep `word`, not `word*`). When nothing balances we
 * return the raw range unchanged — matching is unaffected regardless (the
 * resolver strips all markers); this only keeps the rendered quote intact.
 *
 * `base` (default 0) is a lower bound `from` must not cross — callers pass
 * `text/frontmatter#bodyStart` so a leading delimiter can't pull the range into
 * the YAML frontmatter.
 */
export function balanceEmphasisRange(source: string, from: number, to: number, base = 0): Range {
  let leadStart = from;
  while (leadStart > base && EMPHASIS_MARKERS.has(source[leadStart - 1])) leadStart--;
  let trailEnd = to;
  while (trailEnd < source.length && EMPHASIS_MARKERS.has(source[trailEnd])) trailEnd++;
  if (leadStart === from && trailEnd === to) return { from, to }; // no adjacent markers

  // Only the delimiter chars we might add gate the choice — interior markers a
  // span happens to contain (e.g. `snake_case`, a URL) never block the fix.
  const boundaryChars = new Set<string>();
  for (let k = leadStart; k < from; k++) boundaryChars.add(source[k]);
  for (let k = to; k < trailEnd; k++) boundaryChars.add(source[k]);
  const balanced = (f: number, t: number): boolean => {
    const span = source.slice(f, t);
    for (const ch of boundaryChars) if (runCount(span, ch) % 2 !== 0) return false;
    return true;
  };

  // Prefer the most-wrapped balanced range: both delimiters, then one side, else raw.
  const candidates: Range[] = [
    { from: leadStart, to: trailEnd },
    { from: leadStart, to },
    { from, to: trailEnd },
  ];
  for (const c of candidates) if (balanced(c.from, c.to)) return c;
  return { from, to };
}
