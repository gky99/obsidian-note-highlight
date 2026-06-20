/**
 * Pure string helpers for the reading-mode highlighter (no DOM, no `obsidian`).
 *
 * The reading-mode render path is a *best-effort convenience*, not the
 * offset-accurate anchor path. Markdown markers (`#`, `>`, `*`, `_`, backticks)
 * are stripped from the rendered DOM, so the source-offset range an annotation
 * resolves to cannot be mapped onto rendered text nodes exactly. Instead we
 * derive the annotation's *plain-text projection* — what its quote looks like
 * once Markdown markers are removed and whitespace is collapsed — and search the
 * rendered text for that string (see {@link projectQuoteToText}).
 *
 * The authoritative, offset-accurate highlighting is the CM6 editor extension
 * (Design.md §7.1). Everything here is approximate and must never corrupt the
 * DOM: if the projection cannot be found verbatim, the annotation is simply not
 * painted in reading mode.
 */

/**
 * Project an annotation's `quote` into the plain text the Markdown renderer is
 * expected to produce, so it can be matched against rendered DOM text:
 *
 *  - strip leading block markers per line: heading `#`s and blockquote `>`s
 *    (handles heading-spanning quotes, §6.4);
 *  - remove inline emphasis / code markers (`*`, `_`, backticks) — these are
 *    rendered as styling, not text;
 *  - collapse every run of whitespace (including the newlines that joined
 *    multi-line quotes) to a single space, and trim.
 *
 * This is deliberately lossy. It is good enough to locate the *common case*
 * (a phrase or sentence inside a paragraph) and quietly gives up otherwise.
 */
export function projectQuoteToText(quote: string): string {
  return (
    quote
      .split('\n')
      // Drop leading blockquote markers (`>`), then leading heading markers
      // (`#`) and any list-marker noise, per line.
      .map((line) => stripLeadingBlockMarkers(line))
      .join(' ')
      // Reduce link/image syntax to the text the renderer actually shows, so a
      // quote spanning a link still matches the rendered DOM (the renderer drops
      // the URL and the brackets). Images contribute no text → removed.
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[\[[^\]|]*\|([^\]]*)\]\]/g, '$1') // [[target|alias]] → alias
      .replace(/\[\[([^\]]*)\]\]/g, '$1') // [[target]] → target
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // [text](url) → text
      // Remove inline emphasis / inline-code markers. These never contribute
      // characters to the rendered text, only styling.
      .replace(/[*_`]+/g, '')
      // Collapse all whitespace to single spaces.
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/**
 * Strip leading blockquote (`>`), heading (`#`), and simple list markers from
 * the start of a single line. Repeated/nested markers (`> > ##`) are all
 * removed. Anything after the markers is returned untouched (apart from one
 * leading space).
 */
function stripLeadingBlockMarkers(line: string): string {
  // `>`-quoting (optionally repeated/nested), heading `#`s, and bullet/number
  // list markers, all only at the very start of the line.
  return line.replace(/^\s*(?:>\s*)*(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)?/, '');
}

/**
 * Do two half-open ranges `[aFrom, aTo)` and `[bFrom, bTo)` overlap at all?
 * Touching-but-not-crossing (e.g. `[0,5)` and `[5,9)`) does not count.
 */
export function rangesOverlap(
  aFrom: number,
  aTo: number,
  bFrom: number,
  bTo: number,
): boolean {
  return aFrom < bTo && bFrom < aTo;
}

/**
 * The source-text char span `[from, to)` covered by a rendered element, derived
 * from `getSectionInfo`. `text` is the *whole document* source; `lineStart` /
 * `lineEnd` are inclusive 0-based line numbers of the element's section. Returns
 * `null` if the line numbers are out of range / inconsistent.
 *
 * The span runs from the first character of `lineStart` to the end of `lineEnd`
 * (exclusive of the trailing newline), in the same offset space the resolver
 * reports ranges in.
 */
export function sectionSpan(
  text: string,
  lineStart: number,
  lineEnd: number,
): { from: number; to: number } | null {
  if (lineStart < 0 || lineEnd < lineStart) return null;

  // Offset of the first char of each line. lineStarts[i] = offset of line i.
  let offset = 0;
  let line = 0;
  let from = -1;
  const n = text.length;

  // Walk lines until we have both boundaries.
  while (line <= lineEnd) {
    if (line === lineStart) from = offset;
    // Advance `offset` to the start of the next line.
    const nl = text.indexOf('\n', offset);
    if (nl === -1) {
      // Last line of the document (no trailing newline).
      if (line === lineStart && from === -1) from = offset;
      if (line === lineEnd) {
        if (from === -1) return null;
        return { from, to: n };
      }
      // lineEnd is past the end of the document.
      return null;
    }
    if (line === lineEnd) {
      if (from === -1) return null;
      return { from, to: nl };
    }
    offset = nl + 1;
    line++;
  }
  return null;
}
