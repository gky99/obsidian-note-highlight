/**
 * Floating selection toolbar (an editor creation surface, §7.1): a small palette
 * that pops up next to a non-empty text selection so the user can highlight in
 * one click — the preferred flow over the keyboard command.
 *
 * It is intentionally NOT a CodeMirror plugin: reading mode has no editor, so a
 * CM6 view plugin could never serve both modes. Instead it watches the DOM
 * `selectionchange` and positions itself from the live selection rectangle,
 * which exists in Live Preview, source, AND reading mode.
 *
 * The source range it reports differs by mode:
 *  - source / Live Preview → exact offsets from the editor selection;
 *  - reading mode → only the selected text; the plugin re-locates it in the
 *    source (best-effort, see `@/text/locate`).
 */
import { MarkdownView, debounce, type App, type TFile } from 'obsidian';

import { renderColor, colorLabel } from '@/color';

/** What the toolbar hands the plugin when a swatch is clicked. */
export interface HighlightRequest {
  view: MarkdownView;
  file: TFile;
  /** Exact source offsets (source / Live Preview); `null` in reading mode. */
  range: { from: number; to: number } | null;
  /** The selected text — used to locate the source range in reading mode. */
  text: string;
}

export interface SelectionToolbarDeps {
  app: App;
  /** Palette colors to offer (read live, so settings edits take effect). */
  getColors: () => string[];
  /** A swatch was clicked: create the highlight for `req` in `color`. */
  onHighlight: (req: HighlightRequest, color: string) => void;
}

/** Settle time after the last selection change before the toolbar appears (ms). */
const SHOW_DEBOUNCE_MS = 120;
/** Gap (px) between the toolbar and the selection it points at. */
const GAP = 6;

export class SelectionToolbar {
  private el: HTMLElement | null = null;
  /** Palette the mounted buttons were built from (rebuild only when it changes). */
  private builtSignature: string | null = null;
  /** The selection captured at show time, so a click is stable even if it clears. */
  private pending: HighlightRequest | null = null;
  private readonly doc: Document = document;
  // resetTimer=true → fire after the selection settles (e.g. on drag release),
  // not mid-drag.
  private readonly onSelectionChange = debounce(() => this.sync(), SHOW_DEBOUNCE_MS, true);
  private readonly onScroll = (): void => this.reposition();

  constructor(private readonly deps: SelectionToolbarDeps) {}

  /** Begin watching for selections. Call {@link destroy} to stop and clean up. */
  start(): void {
    this.doc.addEventListener('selectionchange', this.onSelectionChange);
    this.doc.addEventListener('scroll', this.onScroll, true); // capture inner scrollers
    window.addEventListener('resize', this.onScroll);
  }

  destroy(): void {
    this.doc.removeEventListener('selectionchange', this.onSelectionChange);
    this.doc.removeEventListener('scroll', this.onScroll, true);
    window.removeEventListener('resize', this.onScroll);
    this.onSelectionChange.cancel();
    this.hide();
  }

  /** Reconcile the toolbar with the current selection. */
  private sync(): void {
    const req = this.currentRequest();
    if (!req) {
      this.hide();
      return;
    }
    this.pending = req;
    const colors = this.deps.getColors();
    const signature = colors.join('|');
    if (!this.el || signature !== this.builtSignature) {
      this.build(colors);
      this.builtSignature = signature;
    }
    this.reposition();
  }

  /** Inspect the current selection and active view; null if no highlightable target. */
  private currentRequest(): HighlightRequest | null {
    const selection = this.doc.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
    const text = selection.toString();
    if (text.trim().length === 0) return null;

    const view = this.deps.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view || !view.file) return null;
    // The selection must live inside this view (not the aside, another pane, …).
    const anchor = selection.anchorNode;
    if (!anchor || !view.containerEl.contains(anchor)) return null;

    if (view.getMode() === 'source') {
      // Source / Live Preview: the editor selection gives exact source offsets.
      const editor = view.editor;
      const from = editor.posToOffset(editor.getCursor('from'));
      const to = editor.posToOffset(editor.getCursor('to'));
      if (from === to) return null;
      return { view, file: view.file, range: { from, to }, text };
    }
    // Reading mode: only the rendered text is known; the plugin re-locates it.
    return { view, file: view.file, range: null, text };
  }

  /** (Re)build the swatch row. */
  private build(colors: string[]): void {
    const el = this.ensure();
    el.replaceChildren();
    for (const color of colors) {
      const swatch = this.doc.createElement('button');
      swatch.type = 'button';
      swatch.className = 'mrg-toolbar-swatch';
      swatch.style.backgroundColor = renderColor(color).solid;
      const label = `Highlight ${colorLabel(color)}`;
      swatch.title = label;
      swatch.setAttribute('aria-label', label);
      swatch.addEventListener('click', (e) => {
        e.preventDefault();
        this.apply(color);
      });
      el.appendChild(swatch);
    }
  }

  /** Highlight the captured selection, then collapse it so the toolbar dismisses. */
  private apply(color: string): void {
    const req = this.pending;
    if (!req) return;
    this.deps.onHighlight(req, color);
    if (req.range) {
      const editor = req.view.editor;
      editor.setSelection(editor.getCursor('to')); // collapse the editor selection
    } else {
      this.doc.getSelection()?.removeAllRanges();
    }
    this.hide();
  }

  private ensure(): HTMLElement {
    if (this.el) return this.el;
    const el = this.doc.createElement('div');
    el.className = 'mrg-selection-toolbar';
    el.setAttribute('role', 'toolbar');
    el.setAttribute('aria-label', 'Highlight selection');
    // Don't steal focus or clear the selection when a swatch is pressed.
    el.addEventListener('mousedown', (e) => e.preventDefault());
    this.doc.body.appendChild(el);
    this.el = el;
    return el;
  }

  /** Place the toolbar above the selection, flipping below if it would clip. */
  private reposition(): void {
    const el = this.el;
    if (!el) return;
    const selection = this.doc.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      this.hide();
      return;
    }
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      this.hide();
      return;
    }
    const box = el.getBoundingClientRect();
    let left = (rect.left + rect.right) / 2 - box.width / 2;
    left = Math.max(GAP, Math.min(left, window.innerWidth - box.width - GAP));
    let top = rect.top - box.height - GAP;
    if (top < GAP) top = rect.bottom + GAP;
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(top)}px`;
  }

  private hide(): void {
    this.el?.remove();
    this.el = null;
    this.builtSignature = null;
    this.pending = null;
  }
}
