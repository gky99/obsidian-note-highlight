/**
 * Floating selection toolbar (an editor creation *and* edit surface, §7.1): a
 * small palette that pops up next to text so the user can manage highlights in
 * one click — the preferred flow over the keyboard command.
 *
 * It serves two intents from one surface:
 *  - **create** — a non-empty selection over un-highlighted text shows color
 *    swatches; clicking one highlights the selection.
 *  - **edit** — clicking a painted highlight (or selecting over one) shows the
 *    same swatches (current color marked) plus a delete button, so the user can
 *    recolor or remove the highlight. Because a passage is highlighted at most
 *    once, a selection that overlaps an existing highlight always edits it rather
 *    than stacking a new one.
 *
 * It is intentionally NOT a CodeMirror plugin: reading mode has no editor, so a
 * CM6 view plugin could never serve both modes. Instead it watches the DOM
 * (`selectionchange` for selections, `mousedown` for highlight clicks) and
 * positions itself from a live rectangle, which exists in Live Preview, source,
 * AND reading mode.
 *
 * The source range it reports for *create* differs by mode:
 *  - source / Live Preview → exact offsets from the editor selection;
 *  - reading mode → only the selected text; the plugin re-locates it in the
 *    source (best-effort, see `@/text/locate`).
 */
import { MarkdownView, debounce, setIcon, type App, type TFile } from 'obsidian';

import { renderColor, colorLabel } from '@/color';

/** What the toolbar hands the plugin when a swatch is clicked to *create*. */
export interface HighlightRequest {
  view: MarkdownView;
  file: TFile;
  /** Exact source offsets (source / Live Preview); `null` in reading mode. */
  range: { from: number; to: number } | null;
  /** The selected text — used to locate the source range in reading mode. */
  text: string;
}

/** An existing highlight the toolbar can recolor, comment, or delete (edit mode). */
export interface ExistingHighlight {
  /** Source note the annotation belongs to (sidecar key). */
  sourcePath: string;
  /** Annotation id. */
  id: string;
  /** Current color (token or hex), so the toolbar can mark it selected. */
  color: string;
  /** Current comment prose, so the inline editor opens pre-filled. */
  comment: string;
}

export interface SelectionToolbarDeps {
  app: App;
  /** Palette colors to offer (read live, so settings edits take effect). */
  getColors: () => string[];
  /** A swatch was clicked over a fresh selection: create the highlight. */
  onHighlight: (req: HighlightRequest, color: string) => void;
  /** Resolve the highlight painted with `id` in `view` (a clicked highlight). */
  lookupById: (view: MarkdownView, id: string) => ExistingHighlight | null;
  /** Resolve an existing highlight overlapping exact source offsets (selection). */
  lookupByRange: (view: MarkdownView, from: number, to: number) => ExistingHighlight | null;
  /** A swatch was clicked over an existing highlight: recolor it. */
  onRecolor: (target: ExistingHighlight, color: string) => void;
  /** The inline comment editor committed a (changed) value: write it back. */
  onComment: (target: ExistingHighlight, comment: string) => void;
  /** The delete button was clicked: remove the highlight. */
  onDelete: (target: ExistingHighlight) => void;
}

/** Settle time after the last selection change before the toolbar appears (ms). */
const SHOW_DEBOUNCE_MS = 120;
/** Gap (px) between the toolbar and the rectangle it points at. */
const GAP = 6;

/** Where the toolbar reads its anchor rect from (selection or clicked element). */
type RectFn = () => DOMRect | null;

/**
 * The toolbar's current intent. `create` carries the captured selection request;
 * `edit` carries the existing highlight. `sticky` edits (opened by clicking a
 * highlight) survive the selection collapsing and are dismissed only by an
 * outside click / Escape; non-sticky edits (a selection over a highlight) clear
 * with the selection, like create.
 */
type ToolbarState =
  | { kind: 'create'; view: MarkdownView; req: HighlightRequest; rect: RectFn }
  | { kind: 'edit'; view: MarkdownView; target: ExistingHighlight; rect: RectFn; sticky: boolean };

export class SelectionToolbar {
  private el: HTMLElement | null = null;
  /** Signature the mounted buttons were built from (rebuild only when it changes). */
  private builtSignature: string | null = null;
  /** The intent captured at show time, so a click is stable even if the selection clears. */
  private state: ToolbarState | null = null;
  /** Flush for an open inline comment editor, so a dismiss-by-hide still saves. */
  private commitComment: (() => void) | null = null;
  private readonly doc: Document = document;
  // resetTimer=true → fire after the selection settles (e.g. on drag release),
  // not mid-drag.
  private readonly onSelectionChange = debounce(() => this.sync(), SHOW_DEBOUNCE_MS, true);
  private readonly onScroll = (): void => this.reposition();
  private readonly onPointerDown = (e: MouseEvent): void => this.handlePointerDown(e);
  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && this.state) this.hide();
  };

  constructor(private readonly deps: SelectionToolbarDeps) {}

  /** Begin watching for selections and highlight clicks. Call {@link destroy} to stop. */
  start(): void {
    this.doc.addEventListener('selectionchange', this.onSelectionChange);
    this.doc.addEventListener('mousedown', this.onPointerDown);
    this.doc.addEventListener('keydown', this.onKeyDown);
    this.doc.addEventListener('scroll', this.onScroll, true); // capture inner scrollers
    window.addEventListener('resize', this.onScroll);
  }

  destroy(): void {
    this.doc.removeEventListener('selectionchange', this.onSelectionChange);
    this.doc.removeEventListener('mousedown', this.onPointerDown);
    this.doc.removeEventListener('keydown', this.onKeyDown);
    this.doc.removeEventListener('scroll', this.onScroll, true);
    window.removeEventListener('resize', this.onScroll);
    this.onSelectionChange.cancel();
    this.hide();
  }

  /** Reconcile the toolbar with the current selection. */
  private sync(): void {
    const next = this.selectionState();
    if (next) {
      this.state = next;
      this.show();
      return;
    }
    // No usable selection. A click-opened edit toolbar stays until an outside
    // click / Escape dismisses it; everything else clears with the selection.
    if (this.state?.kind === 'edit' && this.state.sticky) return;
    this.hide();
  }

  /** Derive a (non-sticky) create/edit state from the current DOM selection; null if none. */
  private selectionState(): ToolbarState | null {
    const selection = this.doc.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
    const text = selection.toString();
    if (text.trim().length === 0) return null;

    const view = this.deps.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view || !view.file) return null;
    // The selection must live inside this view (not the aside, another pane, …).
    const anchor = selection.anchorNode;
    if (!anchor || !view.containerEl.contains(anchor)) return null;

    const rect: RectFn = () => selectionRect(selection);

    if (view.getMode() === 'source') {
      // Source / Live Preview: the editor selection gives exact source offsets.
      const editor = view.editor;
      const from = editor.posToOffset(editor.getCursor('from'));
      const to = editor.posToOffset(editor.getCursor('to'));
      if (from === to) return null;
      // A selection over an existing highlight edits it (no stacking).
      const existing = this.deps.lookupByRange(view, from, to);
      if (existing) return { kind: 'edit', view, target: existing, rect, sticky: false };
      return {
        kind: 'create',
        view,
        req: { view, file: view.file, range: { from, to }, text },
        rect,
      };
    }

    // Reading mode: offsets aren't known, but if the selection sits inside a
    // painted highlight we can edit it by its id; otherwise create (text-only).
    const id = closestHighlightId(anchor);
    if (id) {
      const existing = this.deps.lookupById(view, id);
      if (existing) return { kind: 'edit', view, target: existing, rect, sticky: false };
    }
    return { kind: 'create', view, req: { view, file: view.file, range: null, text }, rect };
  }

  /** Open the edit toolbar for a clicked highlight, or dismiss a sticky one. */
  private handlePointerDown(e: MouseEvent): void {
    const target = e.target;
    if (!(target instanceof Element)) return;
    if (this.el?.contains(target)) return; // a click on our own buttons

    const view = this.deps.app.workspace.getActiveViewOfType(MarkdownView);
    if (view?.file && view.containerEl.contains(target)) {
      const hl = target.closest('.mrg-highlight');
      const id = hl?.getAttribute('data-anno-id') ?? null;
      if (hl && id) {
        const existing = this.deps.lookupById(view, id);
        if (existing) {
          this.state = {
            kind: 'edit',
            view,
            target: existing,
            sticky: true,
            rect: () => (hl.isConnected ? hl.getBoundingClientRect() : null),
          };
          this.show();
          return;
        }
      }
    }
    // A click anywhere else dismisses a click-opened (sticky) edit toolbar.
    if (this.state?.kind === 'edit' && this.state.sticky) this.hide();
  }

  /** Build (if the layout changed) and position the toolbar for the current state. */
  private show(): void {
    if (!this.state) return;
    const signature = this.signature();
    if (!this.el || signature !== this.builtSignature) {
      this.build();
      this.builtSignature = signature;
    }
    this.reposition();
  }

  /** What the mounted buttons depend on: palette + mode + (edit) selected color. */
  private signature(): string {
    const colors = this.deps.getColors().join('|');
    const state = this.state;
    if (!state) return colors;
    return state.kind === 'edit' ? `edit|${state.target.color}|${colors}` : `create|${colors}`;
  }

  /** (Re)build the swatch row, plus a delete button when editing. */
  private build(): void {
    this.commitComment?.(); // flush an open comment editor before we tear it down
    const el = this.ensure();
    el.replaceChildren();
    el.classList.remove('mrg-toolbar-commenting');
    const state = this.state;
    if (!state) return;
    const current = state.kind === 'edit' ? state.target.color : null;

    for (const color of withCurrent(this.deps.getColors(), current)) {
      const swatch = this.doc.createElement('button');
      swatch.type = 'button';
      swatch.className = 'mrg-toolbar-swatch';
      if (color === current) swatch.classList.add('mrg-selected');
      swatch.style.backgroundColor = renderColor(color).solid;
      const label = current ? `Recolor ${colorLabel(color)}` : `Highlight ${colorLabel(color)}`;
      swatch.title = label;
      swatch.setAttribute('aria-label', label);
      swatch.addEventListener('click', (e) => {
        e.preventDefault();
        this.applyColor(color);
      });
      el.appendChild(swatch);
    }

    if (state.kind === 'edit') {
      const comment = this.doc.createElement('button');
      comment.type = 'button';
      comment.className = 'mrg-toolbar-comment';
      const label = state.target.comment.trim().length > 0 ? 'Edit comment' : 'Add comment';
      comment.title = label;
      comment.setAttribute('aria-label', label);
      setIcon(comment, 'message-square');
      comment.addEventListener('click', (e) => {
        e.preventDefault();
        this.enterComment();
      });
      el.appendChild(comment);

      const del = this.doc.createElement('button');
      del.type = 'button';
      del.className = 'mrg-toolbar-delete';
      del.title = 'Delete highlight';
      del.setAttribute('aria-label', 'Delete highlight');
      setIcon(del, 'trash-2');
      del.addEventListener('click', (e) => {
        e.preventDefault();
        this.applyDelete();
      });
      el.appendChild(del);
    }
  }

  /**
   * Swap the swatch row for an inline comment editor at the highlight, so a
   * comment can be added without leaving for the aside panel. Commits the
   * (changed) text on blur — clicking away, Escape, or Cmd/Ctrl+Enter — then
   * closes; there is no live per-keystroke write, so the store never churns
   * (and re-paints the highlight DOM out from under us) mid-edit.
   */
  private enterComment(): void {
    const state = this.state;
    if (state?.kind !== 'edit') return;
    // Pin the toolbar open while the textarea has focus (a non-sticky edit would
    // otherwise tear down when the selection clears).
    state.sticky = true;
    const target = state.target;

    const el = this.ensure();
    el.replaceChildren();
    el.classList.add('mrg-toolbar-commenting');

    const ta = this.doc.createElement('textarea');
    ta.className = 'mrg-toolbar-comment-input';
    ta.value = target.comment;
    ta.rows = Math.max(2, target.comment.split('\n').length);
    ta.placeholder = 'Add a comment…';

    let done = false;
    const commit = (): void => {
      if (done) return;
      done = true;
      this.commitComment = null;
      if (ta.value !== target.comment) this.deps.onComment(target, ta.value);
    };
    // So a dismiss that removes the element before `blur` fires still saves.
    this.commitComment = commit;
    ta.addEventListener('blur', () => {
      commit();
      this.hide();
    });
    ta.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        ta.blur();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation(); // don't let the toolbar's global Escape double-fire
        ta.blur();
      }
    });

    el.appendChild(ta);
    this.builtSignature = null; // force a fresh swatch build if we ever reopen
    this.reposition();
    ta.focus();
  }

  /** A swatch was clicked: create (fresh selection) or recolor (existing). */
  private applyColor(color: string): void {
    const state = this.state;
    if (!state) return;
    if (state.kind === 'create') {
      this.deps.onHighlight(state.req, color);
    } else if (color !== state.target.color) {
      this.deps.onRecolor(state.target, color);
    }
    this.collapse(state.view);
    this.hide();
  }

  /** The delete button was clicked: remove the highlight. */
  private applyDelete(): void {
    const state = this.state;
    if (state?.kind !== 'edit') return;
    this.deps.onDelete(state.target);
    this.collapse(state.view);
    this.hide();
  }

  /** Collapse the selection so a follow-up `selectionchange` dismisses the toolbar. */
  private collapse(view: MarkdownView): void {
    if (view.getMode() === 'source') {
      const editor = view.editor;
      editor.setSelection(editor.getCursor('to'));
    } else {
      this.doc.getSelection()?.removeAllRanges();
    }
  }

  private ensure(): HTMLElement {
    if (this.el) return this.el;
    const el = this.doc.createElement('div');
    el.className = 'mrg-selection-toolbar';
    el.setAttribute('role', 'toolbar');
    el.setAttribute('aria-label', 'Highlight');
    // Don't steal focus or clear the selection when a button is pressed — but
    // the inline comment textarea MUST take focus (and place its caret) on click.
    el.addEventListener('mousedown', (e) => {
      if (e.target instanceof HTMLTextAreaElement) return;
      e.preventDefault();
    });
    this.doc.body.appendChild(el);
    this.el = el;
    return el;
  }

  /** Place the toolbar above its anchor rect, flipping below if it would clip. */
  private reposition(): void {
    const el = this.el;
    const state = this.state;
    if (!el || !state) return;
    const rect = state.rect();
    if (!rect || (rect.width === 0 && rect.height === 0)) {
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
    this.commitComment?.(); // save an in-progress comment even if blur never fired
    this.commitComment = null;
    this.el?.remove();
    this.el = null;
    this.builtSignature = null;
    this.state = null;
  }
}

// --- pure helpers ----------------------------------------------------------

/** The bounding rect of a non-empty selection, or null if collapsed/zero-size. */
function selectionRect(selection: Selection): DOMRect | null {
  if (selection.isCollapsed || selection.rangeCount === 0) return null;
  const rect = selection.getRangeAt(0).getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return null;
  return rect;
}

/** The `data-anno-id` of the nearest enclosing `.mrg-highlight`, if any. */
function closestHighlightId(node: Node | null): string | null {
  const el = node instanceof Element ? node : (node?.parentElement ?? null);
  const hl = el?.closest('.mrg-highlight') ?? null;
  return hl?.getAttribute('data-anno-id') ?? null;
}

/** Palette with `current` guaranteed present (so the selected swatch always shows). */
function withCurrent(colors: string[], current: string | null): string[] {
  if (current && !colors.includes(current)) return [current, ...colors];
  return colors;
}
