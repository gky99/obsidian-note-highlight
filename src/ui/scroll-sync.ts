/**
 * Scroll sync (Design.md §7.3): keep the aside panel scrolled to the highlight
 * the reader is currently looking at, so the margin notes track the document.
 *
 * Direction is one-way — *document → panel*. Scrolling the source (Live Preview,
 * source, or reading mode) brings the card for the topmost on-screen highlight
 * into view in the panel and marks it "current". Scrolling the panel itself does
 * nothing back (no feedback loop, and the user can browse cards freely).
 *
 * Like {@link SelectionToolbar}, this is a DOM-level controller rather than a CM6
 * view plugin: reading mode has no editor, and a single surface must serve both
 * modes. It listens for scrolls anywhere (capture phase, since `scroll` doesn't
 * bubble) and reacts only to the markdown view showing the panel's source. The
 * highlight geometry is read straight from the painted `.mrg-highlight` elements,
 * which exist with a `data-anno-id` in *both* modes — so no offset model or
 * mode-specific scroller lookup is needed.
 */
import { MarkdownView, type App } from 'obsidian';

import type { MarginaliaAsideView } from './aside-view';

export interface ScrollSyncDeps {
  app: App;
  /** The live aside panel, or null if it isn't open. */
  getAside: () => MarginaliaAsideView | null;
  /** Map an open file's path to the source note it annotates (sidecar → source). */
  resolveSourcePath: (path: string) => string;
}

/** A painted highlight's vertical extent, relative to the scroll viewport's top. */
export interface HighlightBox {
  id: string;
  top: number;
  bottom: number;
}

/**
 * Pure pick (unit-tested): of the highlights intersecting the viewport
 * `[viewTop, viewBottom]`, return the id of the topmost one (smallest `top`), or
 * `null` if none are on screen. Boxes entirely above or below the viewport are
 * ignored, so the panel only tracks highlights the reader can actually see.
 */
export function pickTopmostVisible(
  boxes: readonly HighlightBox[],
  viewTop: number,
  viewBottom: number,
): string | null {
  let best: HighlightBox | null = null;
  for (const box of boxes) {
    const visible = box.bottom > viewTop && box.top < viewBottom;
    if (!visible) continue;
    if (best === null || box.top < best.top) best = box;
  }
  return best ? best.id : null;
}

/**
 * How long to ignore scrolls after a plugin-initiated jump (ms). A card click
 * scrolls the document programmatically; without this the panel would chase its
 * own jump. The window only needs to outlast that one (non-animated) scroll, and
 * is short enough that a genuine user scroll right after is still honored.
 */
const JUMP_SUPPRESS_MS = 400;

export class ScrollSync {
  private readonly doc: Document = document;
  /** Pending rAF handle, so bursts of scroll events coalesce to one update. */
  private frame: number | null = null;
  /** The most recent scrolled element awaiting the next frame. */
  private pending: HTMLElement | null = null;
  /** Epoch ms until which document scrolls are ignored (set around our jumps). */
  private suppressUntil = 0;
  private readonly onScroll = (e: Event): void => {
    const target = e.target;
    if (target instanceof HTMLElement) this.schedule(target);
  };

  constructor(private readonly deps: ScrollSyncDeps) {}

  /** Begin watching for document scrolls. Call {@link destroy} to stop. */
  start(): void {
    // Capture phase: `scroll` doesn't bubble, but capture still reaches us for
    // any inner scroller (the `.cm-scroller` / `.markdown-preview-view`).
    this.doc.addEventListener('scroll', this.onScroll, true);
  }

  destroy(): void {
    this.doc.removeEventListener('scroll', this.onScroll, true);
    if (this.frame !== null) window.cancelAnimationFrame(this.frame);
    this.frame = null;
    this.pending = null;
  }

  /**
   * Ignore document scrolls for a short window — called right before a
   * plugin-initiated jump (e.g. a card click) so the panel doesn't chase the
   * scroll it just caused. A genuine user scroll after the window still syncs.
   */
  suppress(ms: number = JUMP_SUPPRESS_MS): void {
    this.suppressUntil = Date.now() + ms;
  }

  /** Coalesce a burst of scroll events into one update on the next frame. */
  private schedule(scroller: HTMLElement): void {
    this.pending = scroller;
    if (this.frame !== null) return;
    this.frame = window.requestAnimationFrame(() => {
      this.frame = null;
      const scroller = this.pending;
      this.pending = null;
      if (scroller) this.sync(scroller);
    });
  }

  /** Align the panel to the topmost highlight visible in `scroller`. */
  private sync(scroller: HTMLElement): void {
    if (Date.now() < this.suppressUntil) return; // our own jump scroll — ignore.

    const aside = this.deps.getAside();
    const source = aside?.getSourcePath();
    if (!aside || !source) return;

    // Only react to a scroll in the markdown view that shows the panel's note —
    // a different split (or the panel itself) must not move the cards.
    const view = this.markdownViewFor(scroller);
    const file = view?.file;
    if (!file || this.deps.resolveSourcePath(file.path) !== source) return;

    const id = topmostHighlightId(scroller);
    if (id) aside.syncScrollTo(id);
  }

  /** The open MarkdownView whose container holds `scroller`, if any. */
  private markdownViewFor(scroller: HTMLElement): MarkdownView | null {
    for (const leaf of this.deps.app.workspace.getLeavesOfType('markdown')) {
      const view = leaf.view;
      if (view instanceof MarkdownView && view.containerEl.contains(scroller)) return view;
    }
    return null;
  }
}

/**
 * Read the painted highlights inside a scroll container and return the id of the
 * one nearest the top of its viewport (or null). Geometry comes from live client
 * rects, made relative to the scroller's own rect so it works the same whether
 * the scroller is a `.cm-scroller` or a reading-mode preview.
 */
function topmostHighlightId(scroller: HTMLElement): string | null {
  const viewport = scroller.getBoundingClientRect();
  const boxes: HighlightBox[] = [];
  for (const el of scroller.querySelectorAll<HTMLElement>('.mrg-highlight[data-anno-id]')) {
    const id = el.dataset.annoId;
    if (!id) continue;
    const rect = el.getBoundingClientRect();
    boxes.push({ id, top: rect.top - viewport.top, bottom: rect.bottom - viewport.top });
  }
  return pickTopmostVisible(boxes, 0, viewport.height);
}
