/**
 * Reading-mode render path (Design.md §7.2).
 *
 * Two pieces, registered by the plugin:
 *
 *  1. {@link renderAnnoBlock} — body for
 *     `registerMarkdownCodeBlockProcessor('anno', …)`. Makes each machine
 *     `anno` block VANISH from reading mode (renders an optional tiny inert
 *     marker, never the YAML). This is the load-bearing must-have: without it,
 *     the raw machine record would render as a grey code box in every note.
 *     Ingesting into the store is NOT this processor's job — the store loads
 *     sidecars from disk directly.
 *
 *  2. {@link makeReadingHighlighter} — factory for a
 *     `registerMarkdownPostProcessor` callback that paints highlights over
 *     rendered text. This is **best-effort and approximate** — see the note on
 *     {@link makeReadingHighlighter} and `./project.ts`. The offset-accurate
 *     highlighter is the CM6 editor extension (§7.1); reading mode is a
 *     convenience layer.
 *
 * Both processors are resilient: a thrown error in a post-processor breaks
 * Obsidian's render pipeline, so all risky work is wrapped in try/catch and
 * fails silent.
 */
import type { MarkdownPostProcessorContext } from 'obsidian';

import type { AnnotationStore } from '@/store/store';
import type { Annotation } from '@/model/types';
import { renderColor } from '@/color';

import { projectQuoteToText, rangesOverlap, sectionSpan } from './project';

/** The fenced-code-block language this plugin owns: `` ```anno ``. */
export const ANNO_LANGUAGE = 'anno';

const HIGHLIGHT_CLASS = 'mrg-highlight';
const ANNO_MARKER_CLASS = 'mrg-anno-marker';

/**
 * Code-block processor body for `registerMarkdownCodeBlockProcessor('anno', …)`.
 *
 * Hides the machine `anno` block in reading mode. Renders an optional tiny inert
 * `span.mrg-anno-marker` (a small dot) as an unobtrusive affordance that an
 * annotation lives here — never the YAML. Never throws.
 *
 * The `source` (raw YAML) and `ctx` are intentionally unused: we deliberately do
 * not display the block's contents, and the store ingests sidecars from disk.
 */
export function renderAnnoBlock(
  _source: string,
  el: HTMLElement,
  _ctx: MarkdownPostProcessorContext,
): void {
  try {
    // Clear anything Obsidian may have placed (defensive) and emit only the
    // inert marker dot. The block's text is never shown.
    el.empty();
    const marker = el.createSpan({ cls: ANNO_MARKER_CLASS });
    marker.setAttr('aria-hidden', 'true');
  } catch {
    // A render failure here must never break the surrounding note. Worst case
    // the block is left as-is; we simply do nothing further.
  }
}

/**
 * Factory for a `registerMarkdownPostProcessor` callback that paints reading-mode
 * highlights for the active source's annotations.
 *
 * APPROXIMATE BY DESIGN. The resolver reports ranges as char offsets into the
 * *source Markdown*, but the rendered DOM has had Markdown markers stripped, so
 * those offsets do not map onto rendered text nodes. The offset-accurate path is
 * the CM6 editor extension (§7.1); this reading-mode painter is a convenience.
 *
 * Strategy, per rendered element:
 *  1. `store.getResolved(ctx.sourcePath)` — bail if empty.
 *  2. `ctx.getSectionInfo(el)` gives `{ text, lineStart, lineEnd }`. From the
 *     line numbers we compute the element's source char-span (`sectionSpan`),
 *     i.e. which slice of the source this element renders.
 *  3. For each *anchored* annotation whose resolved range overlaps that span,
 *     derive the quote's plain-text projection (`projectQuoteToText`: strip
 *     block/emphasis markers, collapse whitespace) and search the element's
 *     text nodes for that exact string. On a hit, split the text node and wrap
 *     the match in `span.mrg-highlight.mrg-color-<color>` with `data-anno-id`.
 *
 * Conservatism guarantees:
 *  - Orphaned annotations are skipped.
 *  - If the projection is not found verbatim, that annotation is left unpainted
 *    — never partially wrapped, never DOM-corrupting.
 *  - Text already inside a `.mrg-highlight` is never re-wrapped.
 *  - Any thrown error is swallowed; the note still renders.
 */
export function makeReadingHighlighter(
  store: AnnotationStore,
): (el: HTMLElement, ctx: MarkdownPostProcessorContext) => void {
  return (el: HTMLElement, ctx: MarkdownPostProcessorContext): void => {
    try {
      const resolved = store.getResolved(ctx.sourcePath);
      if (resolved.length === 0) return;

      // Section info lets us scope each annotation to the element it belongs in
      // (avoids matching the same phrase in another paragraph). It is not always
      // available, though — when it's missing we still paint, falling back to a
      // verbatim text search within this element. The wrap is conservative
      // (single text node, never re-wrapping), so an over-match is the worst case.
      const info = ctx.getSectionInfo(el);
      const span = info ? sectionSpan(info.text, info.lineStart, info.lineEnd) : null;

      for (const { annotation, result } of resolved) {
        if (result.status !== 'anchored') continue; // skip orphans
        if (span && !rangesOverlap(result.range.from, result.range.to, span.from, span.to)) {
          continue;
        }
        const needle = projectQuoteToText(annotation.quote);
        if (needle.length === 0) continue;
        // Best-effort wrap; failure for one annotation must not affect others.
        try {
          highlightFirstMatch(el, needle, annotation);
        } catch {
          // leave the DOM as-is for this annotation
        }
      }
    } catch {
      // Never break Obsidian's render pipeline.
    }
  };
}

/**
 * Find the first text-node occurrence of `needle` inside `root` (skipping text
 * already inside a `.mrg-highlight`) and wrap it in a highlight span. Returns
 * `true` if a wrap happened.
 *
 * The needle is matched against a single text node's content. This intentionally
 * does NOT span across element boundaries (e.g. a phrase broken by a `<strong>`):
 * such cases are left unpainted rather than risk a wrong or partial wrap.
 */
function highlightFirstMatch(root: HTMLElement, needle: string, annotation: Annotation): boolean {
  const doc = root.ownerDocument;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node: Node): number {
      if (isInsideHighlight(node)) return NodeFilter.FILTER_REJECT;
      return node.nodeValue && node.nodeValue.includes(needle)
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_SKIP;
    },
  });

  const textNode = walker.nextNode() as Text | null;
  if (!textNode || !textNode.nodeValue) return false;

  const idx = textNode.nodeValue.indexOf(needle);
  if (idx === -1) return false;

  wrapRange(textNode, idx, idx + needle.length, annotation, doc);
  return true;
}

/** Is `node` (or an ancestor up to nothing) already inside a `.mrg-highlight`? */
function isInsideHighlight(node: Node): boolean {
  let cur: Node | null = node.parentNode;
  while (cur && cur.nodeType === Node.ELEMENT_NODE) {
    if ((cur as Element).classList?.contains(HIGHLIGHT_CLASS)) return true;
    cur = cur.parentNode;
  }
  return false;
}

/**
 * Split `textNode` so that `[start, end)` becomes its own text node, then wrap
 * that node in a `span.mrg-highlight.mrg-color-<color>` carrying `data-anno-id`.
 */
function wrapRange(
  textNode: Text,
  start: number,
  end: number,
  annotation: Annotation,
  doc: Document,
): void {
  // splitText leaves `textNode` = [0,start), returns the remainder.
  const matchNode = start > 0 ? textNode.splitText(start) : textNode;
  // After the first split, the match begins at 0 of `matchNode`.
  if (end - start < matchNode.length) {
    matchNode.splitText(end - start);
  }

  const span = doc.createElement('span');
  const render = renderColor(annotation.record.color);
  span.className = render.className ? `${HIGHLIGHT_CLASS} ${render.className}` : HIGHLIGHT_CLASS;
  if (render.background) span.style.backgroundColor = render.background;
  span.setAttribute('data-anno-id', annotation.id);

  const parent = matchNode.parentNode;
  if (!parent) return;
  parent.replaceChild(span, matchNode);
  span.appendChild(matchNode);
}
