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

import type { AnnotationStore, ResolvedAnnotation } from '@/store/store';
import type { Annotation } from '@/model/types';
import { renderColor } from '@/color';

import { projectQuoteToText, rangesOverlap, sectionSpan } from './project';

/** The fenced-code-block language this plugin owns: `` ```anno ``. */
export const ANNO_LANGUAGE = 'anno';

const HIGHLIGHT_CLASS = 'mrg-highlight';
const ANNO_MARKER_CLASS = 'mrg-anno-marker';

/**
 * Class-name prefix the Immersive Translate plugin stamps on the elements that
 * hold the *translated* text it injects into reading mode (e.g.
 * `immersive-translate-target-wrapper`, `immersive-translate-target-translation-
 * block-wrapper`). That text is a foreign overlay, not part of the source note:
 * with the plugin's `selectors: [".markdown-reading-view *"]` config it injects a
 * translation right after each original chunk — including *inside* inline
 * elements — so a translation can land between the text nodes a quote spans. The
 * painter matches a quote against the concatenation of an element's text nodes
 * ({@link highlightFirstMatch}); if translated text is interleaved there, the
 * quote is no longer contiguous and nothing paints. So we treat translation nodes
 * exactly like an existing highlight — skipped — and only ever match the note's
 * own rendered content. (Original text nodes never carry this class; the plugin
 * wraps them in a bare `<font>`.)
 */
const TRANSLATION_TARGET_PREFIX = 'immersive-translate-target';

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
 *     project the plain text of the *intersection* of the element's span with the
 *     resolved range (`projectQuoteToText`: strip block/emphasis markers, reduce
 *     links to their text, collapse whitespace) and search the *concatenation* of
 *     the element's text nodes for that string. On a hit, wrap the matched run in
 *     `span.mrg-highlight.mrg-color-<color>` with `data-anno-id` — splitting across
 *     inline elements into one span per contributing text node when the match
 *     straddles a boundary. Projecting the per-element slice (not the whole quote)
 *     is what lets a quote spanning multiple block elements paint: each block
 *     paints its own portion. When `getSectionInfo` returns null we can't slice,
 *     so we fall back to searching the whole quote within the element.
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

        // Choose what to search for in THIS element:
        //  - with section info, project only the slice of source that this
        //    element renders *and* the highlight covers (the intersection of the
        //    element's span with the resolved range). This is what makes a quote
        //    spanning several block elements paint: the post-processor only ever
        //    sees one block at a time, so each contributing block paints its own
        //    portion (§7.2). For a single-block highlight the slice is the whole
        //    quote, so behavior is unchanged.
        //  - without section info, fall back to projecting the whole quote.
        let needle: string;
        if (info && span) {
          if (!rangesOverlap(result.range.from, result.range.to, span.from, span.to)) continue;
          const from = Math.max(result.range.from, span.from);
          const to = Math.min(result.range.to, span.to);
          needle = projectQuoteToText(info.text.slice(from, to));
        } else {
          needle = projectQuoteToText(annotation.quote);
        }
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
 * Self-heal an *already-rendered* reading-mode preview: paint any anchored
 * highlight that has **no** `.mrg-highlight` span yet.
 *
 * The per-section post-processor ({@link makeReadingHighlighter}) is the primary
 * painter, but reading mode re-renders and re-attaches cached sections on mode
 * switches / scroll without always re-running post-processors, so a highlight can
 * end up rendered-but-unpainted (anchored, text in the DOM, zero spans —
 * intermittent, the 2026-06-27 report). This pass runs over the *whole* preview
 * container (not one section), so it has no `getSectionInfo` to slice with — it
 * matches the entire projected quote across the container's text nodes (which
 * already paints across blocks, since `highlightFirstMatch` spans inline/element
 * boundaries) and is **idempotent**: highlights that already have a span are
 * skipped, and painted text is never re-wrapped. The caller re-runs it after
 * render-affecting events (layout change, store change).
 */
export function paintMissingHighlights(container: HTMLElement, items: ResolvedAnnotation[]): void {
  for (const { annotation, result } of items) {
    if (result.status !== 'anchored') continue;
    // Already painted somewhere in this preview → nothing to heal (ids are short
    // base36, so they need no attribute-selector escaping).
    if (container.querySelector(`.${HIGHLIGHT_CLASS}[data-anno-id="${annotation.id}"]`)) continue;
    const needle = projectQuoteToText(annotation.quote);
    if (needle.length === 0) continue;
    try {
      highlightFirstMatch(container, needle, annotation);
    } catch {
      // A failure for one highlight must never break the others / the note.
    }
  }
}

/**
 * Reconcile an already-rendered reading preview to the resolved highlight set,
 * **in place** — without `previewMode.rerender(true)`. For every painted
 * `.mrg-highlight[data-anno-id]` span: unwrap it when its highlight is gone
 * (deleted) or no longer anchored (orphaned), else update its color when it
 * changed; then paint any newly-anchored highlight that has no span yet
 * ({@link paintMissingHighlights}).
 *
 * This is what lets a recolor / create / delete update reading mode **without a
 * full re-render** — so the document neither flashes nor jumps (a `rerender(true)`
 * briefly repaints the whole preview at Obsidian's *remembered* scroll position,
 * which is the visible flash-to-top the user reported). Non-destructive: it only
 * ever touches our own overlay spans, never the note (unlike marker-injecting
 * highlighters). Idempotent — a no-op when the DOM already matches.
 */
export function syncReadingHighlights(container: HTMLElement, items: ResolvedAnnotation[]): void {
  // id → desired color (a color of `undefined` is a legit "default color", so the
  // unwrap decision is keyed on *membership*, not the value).
  const wanted = new Map<string, string | undefined>();
  for (const { annotation, result } of items) {
    if (result.status === 'anchored') wanted.set(annotation.id, annotation.record.color);
  }

  for (const span of Array.from(
    container.querySelectorAll<HTMLElement>(`.${HIGHLIGHT_CLASS}[data-anno-id]`),
  )) {
    const id = span.getAttribute('data-anno-id');
    if (id && wanted.has(id)) colorHighlightSpan(span, wanted.get(id)); // recolor in place
    else unwrapHighlight(span); // deleted / orphaned → remove the mark
  }

  paintMissingHighlights(container, items); // paint newly-anchored highlights
}

/** Paint a highlight span's color (className + inline `#hex` bg) — mirrors {@link wrapRange}. */
function colorHighlightSpan(span: HTMLElement, color: string | undefined): void {
  const render = renderColor(color);
  span.className = render.className ? `${HIGHLIGHT_CLASS} ${render.className}` : HIGHLIGHT_CLASS;
  // A built-in token carries no inline background; an arbitrary `#hex` does. Setting
  // '' clears a stale hex when recoloring from a hex to a token.
  span.style.backgroundColor = render.background ?? '';
}

/**
 * Replace a highlight span with its own contents, rejoining the text so a later
 * match can run across the former span boundary. Splitting on wrap + this merge on
 * unwrap keep the text-node structure stable across edits.
 */
function unwrapHighlight(span: HTMLElement): void {
  const parent = span.parentNode;
  if (!parent) return;
  while (span.firstChild) parent.insertBefore(span.firstChild, span);
  parent.removeChild(span);
  parent.normalize(); // merge adjacent text nodes
}

/**
 * Find the first occurrence of `needle` in the rendered text of `root` (skipping
 * text already inside a `.mrg-highlight`) and wrap it in highlight span(s).
 * Returns `true` if a wrap happened.
 *
 * The needle is matched against the *concatenation* of `root`'s text nodes in
 * document order, so a phrase broken across inline elements (`<strong>`, `<a>`,
 * `<code>`, …) still matches — the #1 reason real-note highlights failed to paint
 * in reading mode. When the match straddles element boundaries, each contributing
 * text node gets its own `.mrg-highlight` span (sharing the same `data-anno-id`),
 * which renders as one contiguous highlight without restructuring the DOM.
 *
 * Matching is **whitespace-insensitive**: the needle is already whitespace-
 * collapsed by {@link projectQuoteToText}, but the rendered text nodes are not —
 * a quote spanning a *soft* line break (a single source newline inside one
 * paragraph) renders with a literal "\n" between the nodes, so a raw `indexOf`
 * of `"… notepad and …"` (space) in `"… notepad\nand …"` (newline) fails and the
 * highlight silently vanished in reading mode while Live Preview (CM6 source
 * offsets) painted it fine (fixed 2026-06-26). We therefore match against a
 * whitespace-collapsed projection of the concatenation, keeping an index map
 * back to the raw offsets the wrap needs.
 */
function highlightFirstMatch(root: HTMLElement, needle: string, annotation: Annotation): boolean {
  const doc = root.ownerDocument;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node: Node): number {
      if (isSkippedContext(node)) return NodeFilter.FILTER_REJECT;
      return node.nodeValue ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
    },
  });

  // Snapshot every eligible text node with its [start, end) span in the
  // concatenated text. We collect first, then wrap: wrapping splits only the
  // node being wrapped, so the other snapshots stay valid.
  //
  // A *block* boundary between two text nodes (separate paragraphs / list items)
  // contributes no character to the DOM text, but the rendered text reads as a
  // space and the projected quote has one there (a newline collapsed to a space).
  // So insert a synthetic space (no segment → never wrapped) when the nearest
  // block ancestor changes, or a quote spanning a paragraph break can't match
  // when matching across the whole preview (the self-heal path). Per-section
  // painting passes a single block as `root`, so this is a no-op there.
  const segments: { node: Text; start: number; end: number }[] = [];
  let concat = '';
  let prevBlock: Element | null = null;
  let first = true;
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    if (!n.nodeValue) continue;
    const block = nearestBlock(n, root);
    if (!first && block !== prevBlock) concat += ' ';
    first = false;
    prevBlock = block;
    const start = concat.length;
    concat += n.nodeValue;
    segments.push({ node: n, start, end: concat.length });
  }

  // Collapse whitespace to match the projected needle, mapping each collapsed
  // char back to its raw offset in `concat` (which `segments` is indexed in).
  const { norm, rawIndex } = collapseWhitespace(concat);
  const normStart = norm.indexOf(needle);
  if (normStart === -1) return false;
  // The needle is trimmed, so its first/last chars are non-whitespace and each
  // maps to exactly one raw char — hence `+ 1` for the exclusive end.
  const matchStart = rawIndex[normStart];
  const matchEnd = rawIndex[normStart + needle.length - 1] + 1;

  let wrapped = false;
  for (const { node, start, end } of segments) {
    const from = Math.max(start, matchStart);
    const to = Math.min(end, matchEnd);
    if (from >= to) continue; // this node contributes nothing to the match
    wrapRange(node, from - start, to - start, annotation, doc);
    wrapped = true;
  }
  return wrapped;
}

/** Block-level tags whose boundary reads as whitespace between rendered text. */
const BLOCK_TAGS = new Set([
  'P', 'DIV', 'LI', 'UL', 'OL', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'BLOCKQUOTE', 'PRE', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH',
  'SECTION', 'ARTICLE', 'FIGURE', 'HR',
]);

/**
 * The nearest block-level ancestor element of `node` within `root` (used to tell
 * when two text nodes sit in different blocks). Falls back to `root` itself, so
 * text directly under `root` — or under inline elements only — all shares one
 * "block" and gets no synthetic separators.
 */
function nearestBlock(node: Node, root: HTMLElement): Element {
  let cur: Element | null = node.parentElement;
  while (cur && cur !== root) {
    if (BLOCK_TAGS.has(cur.tagName)) return cur;
    cur = cur.parentElement;
  }
  return root;
}

/**
 * Collapse every run of whitespace in `s` to a single space, returning the
 * collapsed string plus `rawIndex`, where `rawIndex[k]` is the offset in `s` of
 * the k-th collapsed char (a whitespace run maps to the offset of its first
 * char). Mirrors {@link projectQuoteToText}'s `\s+`→`' '` so a needle projected
 * by it can be located in raw rendered text and mapped back for wrapping.
 */
function collapseWhitespace(s: string): { norm: string; rawIndex: number[] } {
  let norm = '';
  const rawIndex: number[] = [];
  let i = 0;
  while (i < s.length) {
    if (/\s/.test(s[i])) {
      norm += ' ';
      rawIndex.push(i);
      while (i < s.length && /\s/.test(s[i])) i++;
    } else {
      norm += s[i];
      rawIndex.push(i);
      i++;
    }
  }
  return { norm, rawIndex };
}

/**
 * Is `node` inside an element the painter must not match against — an existing
 * `.mrg-highlight` (never re-wrap) or a foreign translation overlay (Immersive
 * Translate; see {@link TRANSLATION_TARGET_PREFIX})? Walks ancestors once.
 */
function isSkippedContext(node: Node): boolean {
  let cur: Node | null = node.parentNode;
  while (cur && cur.nodeType === Node.ELEMENT_NODE) {
    const classList = (cur as Element).classList;
    if (classList) {
      if (classList.contains(HIGHLIGHT_CLASS)) return true;
      for (let i = 0; i < classList.length; i++) {
        if (classList[i].startsWith(TRANSLATION_TARGET_PREFIX)) return true;
      }
    }
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
