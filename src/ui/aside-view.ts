/**
 * The "aside" panel (Design.md §7.3): a right-sidebar {@link ItemView} that
 * lists one card per annotation for the active source note.
 *
 * The view is intentionally dumb about *which* file is active — the plugin
 * drives that by calling {@link MarginaliaAsideView.setSourceFile} on
 * `file-open`. The view re-renders from the store on demand and also subscribes
 * to `store.onChange` so edits made elsewhere (e.g. the editor) keep the cards
 * in sync (§4.6: orphans are always surfaced, never silently dropped).
 *
 * Rendering never throws: a single bad annotation must not blank the panel.
 */
import {
  ItemView,
  MarkdownRenderer,
  TFile,
  debounce,
  setIcon,
  type WorkspaceLeaf,
  type App,
} from 'obsidian';

import type { AnnotationStore, ResolvedAnnotation } from '@/store/store';
import type { MarginaliaSettings } from '@/settings';
import { renderColor, colorLabel, normalizeColorValue } from '@/color';
import { annotationsSignature, sortByPosition } from './aside-signature';
import { confirm } from './confirm';

/** Stable view type for `registerView` / `getViewType`. */
export const ASIDE_VIEW_TYPE = 'marginalia-aside';

/** How long the reverse-nav pulse stays lit before it fades (ms). */
const PULSE_MS = 1200;

/** Debounce window for comment writes so we don't write per keystroke (ms). */
const COMMENT_DEBOUNCE_MS = 600;

export interface AsideDeps {
  app: App;
  store: AnnotationStore;
  settings: MarginaliaSettings;
  /** Forward jump (navigation.jumpToAnnotation, already implemented in the plugin). */
  jumpTo: (sourcePath: string, id: string) => void | Promise<void>;
  /** Open the annotation in its sidecar (.md) at the quote's `^anno-<id>` block. */
  openSidecar: (sidecarPath: string, id: string) => void | Promise<void>;
  /** Copy a wikilink to the annotation's quote block to the clipboard. */
  copyReference: (sidecarPath: string, id: string) => void | Promise<void>;
}

export class MarginaliaAsideView extends ItemView {
  private readonly deps: AsideDeps;
  /** Source note whose annotations are currently shown (null = nothing). */
  private sourcePath: string | null = null;
  /** Unsubscribe handle for the store change listener (set in onOpen). */
  private unsubscribe: (() => void) | null = null;
  /** Pending pulse timers keyed by annotation id, so we can clear on re-render. */
  private pulseTimers = new Map<string, number>();
  /** The open color-picker popup (if any) and its teardown, so we can dismiss it. */
  private colorPopup: HTMLElement | null = null;
  private colorPopupCleanup: (() => void) | null = null;
  /**
   * Signature of the cards currently in the DOM, and the source they belong to.
   * `render()` skips the (destructive) rebuild when the signature is unchanged —
   * so a redundant same-file sync (e.g. the `active-leaf-change` fired by clicking
   * into the panel) never resets scroll or destroys the element being clicked.
   */
  private renderedSig: string | null = null;
  private renderedPath: string | null = null;

  constructor(leaf: WorkspaceLeaf, deps: AsideDeps) {
    super(leaf);
    this.deps = deps;
  }

  getViewType(): string {
    return ASIDE_VIEW_TYPE;
  }

  getDisplayText(): string {
    return 'Annotations';
  }

  getIcon(): string {
    return 'highlighter';
  }

  protected async onOpen(): Promise<void> {
    // Keep cards in sync when the active file's annotations change anywhere.
    this.unsubscribe = this.deps.store.onChange((changedPath) => {
      if (changedPath === this.sourcePath) this.refresh();
    });
    this.render();
  }

  protected async onClose(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.clearPulseTimers();
    this.closeColorPopup();
    // Obsidian empties the view on close; force a fresh render if it reopens.
    this.renderedSig = null;
    this.renderedPath = null;
  }

  /** Point the panel at a source file (path) and re-render its cards; null clears. */
  async setSourceFile(path: string | null): Promise<void> {
    const sameFile = path === this.sourcePath;
    this.sourcePath = path;
    if (path) {
      const file = this.deps.app.vault.getAbstractFileByPath(path);
      // Lazy-load: the store re-resolves and emits, but render from the result.
      if (file instanceof TFile) {
        try {
          await this.deps.store.load(file);
        } catch {
          // Render whatever is cached; load failures are surfaced via Notice in the store.
        }
      }
    }
    // Re-render on a real file switch. On a *redundant* same-file sync — e.g. the
    // active-leaf-change that fires when you click from the editor into the panel,
    // which routes through syncActiveFile → setSourceFile(samePath) — skip the
    // render while the user is mid-interaction: a render tears down an open color
    // popup (the reported "popup closes itself" bug) or a focused comment editor.
    // The store.load above still emits onChange → refresh(), guarded the same way.
    if (!sameFile || !this.isBusy()) this.render();
  }

  /** Re-render from the store (call on store onChange for the active file). */
  refresh(): void {
    // Don't tear down an in-progress interaction. The debounced comment write and
    // any store reload emit onChange → refresh; re-rendering mid-interaction would
    // destroy the focused comment textarea (losing the caret) or the open color
    // popup. The committing action repaints, so we lose nothing.
    if (this.isBusy()) return;
    this.render();
  }

  /** Is the user mid-interaction — editing a comment, or with a color popup open? */
  private isBusy(): boolean {
    return this.isEditing() || this.colorPopup !== null;
  }

  /** Is a comment textarea currently focused inside this panel? */
  private isEditing(): boolean {
    const active = this.contentEl.ownerDocument.activeElement;
    return active instanceof HTMLTextAreaElement && this.contentEl.contains(active);
  }

  /** The source note the panel is currently showing (null = none). */
  getSourcePath(): string | null {
    return this.sourcePath;
  }

  // --- scroll sync --------------------------------------------------------

  /**
   * Scroll-sync target ({@link ScrollSync}): bring the card for `id` into view
   * and mark it the "current" card — the highlight nearest the top of the
   * document viewport as the reader scrolls. Skipped while the user is
   * mid-interaction (editing a comment, color popup open) so the panel is never
   * yanked out from under them; `block: 'nearest'` keeps the movement minimal so
   * a card already on screen doesn't jump.
   */
  syncScrollTo(id: string): void {
    if (this.isBusy()) return;
    const card = this.cardEl(id);
    if (!card) return;
    const prev = this.contentEl.querySelector('.mrg-card.mrg-current');
    if (prev && prev !== card) prev.removeClass('mrg-current');
    card.addClass('mrg-current');
    card.scrollIntoView({ block: 'nearest' });
  }

  // --- reverse navigation -------------------------------------------------

  /** Scroll the card into view and focus it (e.g. when its highlight is clicked). */
  revealCard(id: string): void {
    const card = this.cardEl(id);
    if (!card) return;
    card.scrollIntoView({ block: 'nearest' });
    card.addClass('mrg-active');
  }

  /** Reverse-nav: briefly emphasize the card for an annotation. */
  pulseCard(id: string): void {
    const card = this.cardEl(id);
    if (!card) return;
    card.scrollIntoView({ block: 'nearest' });
    card.addClass('mrg-active');
    const existing = this.pulseTimers.get(id);
    if (existing !== undefined) window.clearTimeout(existing);
    const timer = window.setTimeout(() => {
      this.pulseTimers.delete(id);
      this.cardEl(id)?.removeClass('mrg-active');
    }, PULSE_MS);
    this.pulseTimers.set(id, timer);
  }

  // --- rendering ----------------------------------------------------------

  private cardEl(id: string): HTMLElement | null {
    return this.contentEl.querySelector<HTMLElement>(`[data-anno-id="${cssEscape(id)}"]`);
  }

  private clearPulseTimers(): void {
    for (const timer of this.pulseTimers.values()) window.clearTimeout(timer);
    this.pulseTimers.clear();
  }

  /** Full re-render of the panel. Never throws. */
  private render(): void {
    const path = this.sourcePath;
    // Order cards by where they sit in the source (top → bottom), not by sidecar
    // file order — the sidecar collects records by id, which need not track the
    // document. Orphans (no live range) sink to the end.
    const resolved = path ? sortByPosition(this.deps.store.getResolved(path)) : [];

    // Skip the destructive rebuild when the cards would be identical. A redundant
    // rebuild resets scroll and destroys the element under an in-progress click —
    // the "first click does nothing" + "scroll jumps to top" bugs — and the
    // same-file `active-leaf-change` from clicking into the panel lands here.
    const sig = `${path ?? ''}\n${annotationsSignature(resolved)}`;
    if (sig === this.renderedSig) return;

    // Preserve the panel's scroll across a *same-file* rebuild (a recolor, delete,
    // or comment edit) so the list isn't yanked back to the top. A real file switch
    // (different path) intentionally starts at the top.
    const samePath = path === this.renderedPath;
    const prevScroll = this.contentEl.querySelector<HTMLElement>('.mrg-aside')?.scrollTop ?? 0;

    this.clearPulseTimers();
    this.closeColorPopup(); // a stale popup would point at a destroyed card
    const root = this.contentEl;
    root.empty();
    const aside = root.createDiv({ cls: 'mrg-aside' });
    this.renderedSig = sig;
    this.renderedPath = path;

    if (!path || resolved.length === 0) {
      aside.createDiv({
        cls: 'mrg-aside-empty',
        text: 'No annotations for this note.',
      });
      return;
    }

    // Collect the async markdown renders so scroll is restored after heights settle.
    const pending: Promise<unknown>[] = [];
    for (const item of resolved) {
      try {
        this.renderCard(aside, path, item, pending);
      } catch {
        // A single malformed annotation must not blank the whole panel.
      }
    }

    if (samePath && prevScroll > 0) this.restoreScroll(aside, prevScroll, pending);
  }

  /**
   * Restore the panel's scroll offset after a same-file rebuild. The card quotes
   * and comments render markdown asynchronously and grow the panel, so a single
   * synchronous assignment would be clamped to the not-yet-grown height — set it
   * again once every markdown render has settled.
   */
  private restoreScroll(aside: HTMLElement, top: number, pending: Promise<unknown>[]): void {
    aside.scrollTop = top;
    void Promise.all(pending).then(() => {
      aside.scrollTop = top;
    });
  }

  private renderCard(
    parent: HTMLElement,
    sourcePath: string,
    item: ResolvedAnnotation,
    pending?: Promise<unknown>[],
  ): void {
    const { annotation, result } = item;
    const orphaned = result.status === 'orphaned';
    const color = normalizeColorValue(annotation.record.color);

    const card = parent.createDiv({ cls: 'mrg-card' });
    paintCardColor(card, color);
    card.dataset.annoId = annotation.id;
    if (orphaned) card.addClass('mrg-orphaned');

    // Clicking the card jumps to the highlight — except on the interactive
    // controls (comment editor, color dropdown), which handle their own clicks.
    card.addEventListener('click', (e) => {
      const target = e.target;
      if (target instanceof Element && target.closest('.mrg-card-comment, .mrg-card-footer')) {
        return;
      }
      void this.deps.jumpTo(sourcePath, annotation.id);
    });

    // Quote — rendered as Markdown so bold/italic/links/code show styled.
    // Display-only (links are inert via CSS) so a click anywhere still jumps.
    const quoteEl = card.createDiv({ cls: 'mrg-card-quote' });
    this.paintQuote(quoteEl, annotation.quote, pending);

    // Comment — a slot that holds the rendered note (and the inline editor). It
    // collapses entirely when empty (CSS `:empty`); the footer comment button
    // opens the editor. `beginEdit` is shared by the slot click and that button.
    const hasComment = annotation.comment.trim().length > 0;
    const beginCommentEdit = this.renderComment(
      card,
      sourcePath,
      annotation.id,
      annotation.comment,
      pending,
    );

    // Footer (left → right): [color · comment] │ [copy · open · delete] … status.
    // The editing controls (color, comment) group on the left, a vertical bar
    // divides them from the sidecar-record actions (copy/open/delete — which work
    // even when orphaned), and the status mark sits alone on the right.
    const footer = card.createDiv({ cls: 'mrg-card-footer' });
    this.renderColorControl(footer, sourcePath, annotation.id, color);
    this.renderCommentButton(footer, beginCommentEdit, hasComment);
    footer.createDiv({ cls: 'mrg-sep' });
    this.renderCopyRefButton(footer, item.sidecarPath, annotation.id);
    this.renderOpenSidecarButton(footer, item.sidecarPath, annotation.id);
    this.renderDeleteButton(footer, sourcePath, annotation.id);
    this.renderStatus(footer, result); // margin-left:auto pins it to the right
  }

  /**
   * Render the highlighted quote as Markdown (display-only; clicks jump). The
   * sourcePath is intentionally empty: `MarkdownRenderer.render` runs the whole
   * markdown post-processor pipeline, including our own reading-mode highlighter,
   * and the quote's text *is* an annotation — so a real sourcePath would make the
   * painter re-wrap it in its highlight color here. The color already shows via
   * the card border + swatch, and quote links are inert (CSS), so '' is safe.
   */
  private paintQuote(el: HTMLElement, quote: string, pending?: Promise<unknown>[]): void {
    const p = MarkdownRenderer.render(this.deps.app, quote, el, '', this);
    if (pending) pending.push(p);
    else void p;
  }

  /** Footer button that opens the inline comment editor; tinted when a note exists. */
  private renderCommentButton(
    footer: HTMLElement,
    beginEdit: () => void,
    hasComment: boolean,
  ): void {
    const button = footer.createEl('button', {
      cls: hasComment
        ? 'mrg-icon-button mrg-has-comment clickable-icon'
        : 'mrg-icon-button clickable-icon',
      attr: { type: 'button', 'aria-label': hasComment ? 'Edit comment' : 'Add comment' },
      title: hasComment ? 'Edit comment' : 'Add comment',
    });
    setIcon(button, 'message-square');
    button.addEventListener('click', (e) => {
      e.stopPropagation(); // don't trigger the card's jump handler
      beginEdit();
    });
  }

  /** A button that copies a wikilink to this annotation's block in the sidecar. */
  private renderCopyRefButton(footer: HTMLElement, sidecarPath: string, id: string): void {
    const button = footer.createEl('button', {
      cls: 'mrg-icon-button clickable-icon',
      attr: { type: 'button', 'aria-label': 'Copy reference to annotation' },
      title: 'Copy reference (wikilink to this annotation)',
    });
    setIcon(button, 'copy');
    button.addEventListener('click', (e) => {
      e.stopPropagation(); // don't trigger the card's jump handler
      void this.deps.copyReference(sidecarPath, id);
    });
  }

  /** A button that opens this annotation in its annotations file, at the block. */
  private renderOpenSidecarButton(footer: HTMLElement, sidecarPath: string, id: string): void {
    const button = footer.createEl('button', {
      cls: 'mrg-icon-button clickable-icon',
      attr: { type: 'button', 'aria-label': 'Open in annotations file' },
      title: 'Open in annotations file',
    });
    setIcon(button, 'external-link');
    button.addEventListener('click', (e) => {
      e.stopPropagation(); // don't trigger the card's jump handler
      void this.deps.openSidecar(sidecarPath, id);
    });
  }

  /**
   * Build the comment slot below the quote and return a `beginEdit` callback that
   * mounts the inline textarea — shared by clicking the (rendered) note and by the
   * footer comment button. The slot is empty (and CSS-collapsed) when there's no
   * note, so the card stays compact until a comment is added.
   */
  private renderComment(
    card: HTMLElement,
    sourcePath: string,
    id: string,
    comment: string,
    pending?: Promise<unknown>[],
  ): () => void {
    const view = card.createDiv({ cls: 'mrg-card-comment' });
    view.setAttribute('role', 'textbox');
    view.setAttribute('tabindex', '0');
    this.paintComment(view, sourcePath, comment, pending);

    const beginEdit = (): void => {
      const open = view.querySelector('textarea');
      if (open instanceof HTMLTextAreaElement) {
        open.focus(); // already editing (e.g. button pressed twice) — don't remount
        return;
      }
      view.empty();
      const ta = view.createEl('textarea', { cls: 'mrg-card-comment-input' });
      ta.value = comment;

      // Grow the field to fit its content (height follows the text, with a CSS
      // min-height floor) instead of a fixed row count. Run on mount + each edit.
      const autosize = (): void => {
        ta.style.height = 'auto';
        ta.style.height = `${ta.scrollHeight}px`;
      };

      // Debounced live write; flush on blur. Both go through the store, which
      // reloads + emits — the resulting onChange triggers a re-render.
      const write = debounce(
        (value: string) => {
          void this.deps.store.updateComment(sourcePath, id, value);
        },
        COMMENT_DEBOUNCE_MS,
        true,
      );
      ta.addEventListener('input', () => {
        autosize();
        write(ta.value);
      });
      autosize();
      ta.focus();
      ta.addEventListener('blur', () => {
        write.cancel();
        const next = ta.value;
        if (next !== comment) {
          comment = next;
          void this.deps.store.updateComment(sourcePath, id, next);
        }
        this.paintComment(view, sourcePath, next);
      });
      // Cmd/Ctrl+Enter commits (blurs) the edit.
      ta.addEventListener('keydown', (e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
          e.preventDefault();
          ta.blur();
        }
      });
    };

    view.addEventListener('click', (e) => {
      // Editing the comment must NOT also trigger the card's jump-to-source. The
      // card's click listener runs on bubble and decides by `target.closest(
      // '.mrg-card-comment')`; but `beginEdit()` empties this view first, which
      // detaches the original click target — so that ancestor check would miss
      // and the card would jump (stealing focus to the editor). Stop the event so
      // the card never sees it.
      e.stopPropagation();
      // Don't restart an edit if a textarea is already mounted.
      if (!view.querySelector('textarea')) beginEdit();
    });
    return beginEdit;
  }

  /** Render the comment as markdown; leaves the slot empty (CSS-collapsed) if none. */
  private paintComment(
    view: HTMLElement,
    sourcePath: string,
    comment: string,
    pending?: Promise<unknown>[],
  ): void {
    view.empty();
    if (comment.trim().length === 0) return; // empty slot collapses via CSS `:empty`.
    const p = MarkdownRenderer.render(this.deps.app, comment, view, sourcePath, this);
    if (pending) pending.push(p);
    else void p;
  }

  /**
   * A single swatch button showing the current color; clicking it opens a popup
   * of palette swatches to pick from (no separate icon or native dropdown).
   */
  private renderColorControl(
    footer: HTMLElement,
    sourcePath: string,
    id: string,
    current: string,
  ): void {
    const button = footer.createEl('button', {
      cls: 'mrg-color-button',
      attr: { type: 'button', 'aria-label': `Highlight color: ${colorLabel(current)}` },
      title: `Color: ${colorLabel(current)}`,
    });
    button.style.backgroundColor = renderColor(current).solid;
    button.addEventListener('click', (e) => {
      e.stopPropagation(); // don't trigger the card's jump handler
      this.openColorPopup(button, sourcePath, id, current);
    });
  }

  /** Float a palette of swatches under the color button; pick one to recolor. */
  private openColorPopup(
    anchor: HTMLElement,
    sourcePath: string,
    id: string,
    current: string,
  ): void {
    this.closeColorPopup();
    const doc = this.contentEl.ownerDocument;
    const popup = doc.body.createDiv({ cls: 'mrg-color-popup' });
    popup.setAttribute('role', 'listbox');

    for (const color of this.colorOptions(current)) {
      const option = popup.createEl('button', {
        cls: 'mrg-color-option',
        attr: { type: 'button', 'aria-label': colorLabel(color) },
        title: colorLabel(color),
      });
      option.style.backgroundColor = renderColor(color).solid;
      if (color === current) option.addClass('mrg-selected');
      option.addEventListener('click', () => {
        this.closeColorPopup();
        if (color !== current) void this.deps.store.updateColor(sourcePath, id, color);
      });
    }

    positionPopup(popup, anchor);

    const onPointerDown = (e: MouseEvent): void => {
      const t = e.target;
      if (t instanceof Node && (popup.contains(t) || anchor.contains(t))) return;
      this.closeColorPopup();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') this.closeColorPopup();
    };
    doc.addEventListener('mousedown', onPointerDown);
    doc.addEventListener('keydown', onKey);

    this.colorPopup = popup;
    this.colorPopupCleanup = (): void => {
      doc.removeEventListener('mousedown', onPointerDown);
      doc.removeEventListener('keydown', onKey);
    };
  }

  private closeColorPopup(): void {
    this.colorPopupCleanup?.();
    this.colorPopupCleanup = null;
    this.colorPopup?.remove();
    this.colorPopup = null;
  }

  /** Palette colors to offer, with the current value guaranteed present. */
  private colorOptions(current: string): string[] {
    const palette = this.deps.settings.palette;
    return palette.includes(current) ? palette : [current, ...palette];
  }

  private renderStatus(footer: HTMLElement, result: ResolvedAnnotation['result']): void {
    const text = result.status === 'anchored' ? result.method : 'orphaned';
    footer.createSpan({ cls: 'mrg-card-status', text });
  }

  /** A trash-icon button that deletes the annotation from the sidecar. */
  private renderDeleteButton(footer: HTMLElement, sourcePath: string, id: string): void {
    const button = footer.createEl('button', {
      cls: 'mrg-delete-button clickable-icon',
      attr: { type: 'button', 'aria-label': 'Delete annotation' },
      title: 'Delete annotation',
    });
    setIcon(button, 'trash-2');
    button.addEventListener('click', (e) => {
      e.stopPropagation(); // don't trigger the card's jump handler
      void this.confirmThenDelete(sourcePath, id);
    });
  }

  /** Delete an annotation, asking first when the `confirmDelete` setting is on. */
  private async confirmThenDelete(sourcePath: string, id: string): Promise<void> {
    if (this.deps.settings.confirmDelete && !(await confirm(this.deps.app, DELETE_PROMPT))) {
      return;
    }
    await this.deps.store.deleteAnnotation(sourcePath, id);
  }
}

/** Shared copy for the "really delete?" dialog (aside + toolbar). */
export const DELETE_PROMPT = {
  title: 'Delete annotation',
  message: 'Delete this highlight and its comment? This cannot be undone.',
  confirmText: 'Delete',
  warning: true,
};

// --- pure helpers (no obsidian runtime) -----------------------------------

/** Apply a color (built-in token or hex) to a card's left border. */
function paintCardColor(card: HTMLElement, color: string): void {
  const render = renderColor(color);
  if (render.className) card.addClass(render.className);
  else card.style.borderLeftColor = render.solid;
}

/** Place a fixed-position popup just below `anchor`, clamped to the viewport. */
function positionPopup(popup: HTMLElement, anchor: HTMLElement): void {
  const GAP = 4;
  const a = anchor.getBoundingClientRect();
  const p = popup.getBoundingClientRect();
  const left = Math.max(GAP, Math.min(a.left, window.innerWidth - p.width - GAP));
  let top = a.bottom + GAP;
  if (top + p.height > window.innerHeight - GAP) top = a.top - p.height - GAP;
  popup.style.left = `${Math.round(left)}px`;
  popup.style.top = `${Math.round(Math.max(GAP, top))}px`;
}

/** Escape a string for safe use inside an attribute-selector `[..="x"]`. */
function cssEscape(value: string): string {
  const esc = (globalThis as { CSS?: { escape?: (s: string) => string } }).CSS?.escape;
  return esc ? esc(value) : value.replace(/["\\]/g, '\\$&');
}
