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
    this.clearPulseTimers();
    this.closeColorPopup(); // a stale popup would point at a destroyed card
    const root = this.contentEl;
    root.empty();
    const aside = root.createDiv({ cls: 'mrg-aside' });

    const path = this.sourcePath;
    // Order cards by where they sit in the source (top → bottom), not by sidecar
    // file order — the sidecar collects records by id, which need not track the
    // document. Orphans (no live range) sink to the end.
    const resolved = path ? sortByPosition(this.deps.store.getResolved(path)) : [];

    if (!path || resolved.length === 0) {
      aside.createDiv({
        cls: 'mrg-aside-empty',
        text: 'No annotations for this note.',
      });
      return;
    }

    for (const item of resolved) {
      try {
        this.renderCard(aside, path, item);
      } catch {
        // A single malformed annotation must not blank the whole panel.
      }
    }
  }

  private renderCard(parent: HTMLElement, sourcePath: string, item: ResolvedAnnotation): void {
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

    // Quote — newlines preserved (CSS: white-space: pre-wrap).
    card.createDiv({ cls: 'mrg-card-quote', text: annotation.quote });

    // Comment — rendered markdown that swaps to a textarea on click.
    this.renderComment(card, sourcePath, annotation.id, annotation.comment);

    // Footer: color button · status · copy-ref · open-in-sidecar · delete.
    // The copy/open buttons target the record in the sidecar by its `^anno-<id>`
    // block, so they work even when the annotation is orphaned in the source.
    const footer = card.createDiv({ cls: 'mrg-card-footer' });
    this.renderColorControl(footer, sourcePath, annotation.id, color);
    this.renderStatus(footer, result);
    this.renderCopyRefButton(footer, item.sidecarPath, annotation.id);
    this.renderOpenSidecarButton(footer, item.sidecarPath, annotation.id);
    this.renderDeleteButton(footer, sourcePath, annotation.id);
  }

  /** A button that copies a wikilink to this annotation's block in the sidecar. */
  private renderCopyRefButton(footer: HTMLElement, sidecarPath: string, id: string): void {
    const button = footer.createEl('button', {
      cls: 'mrg-icon-button',
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
      cls: 'mrg-icon-button',
      attr: { type: 'button', 'aria-label': 'Open in annotations file' },
      title: 'Open in annotations file',
    });
    setIcon(button, 'external-link');
    button.addEventListener('click', (e) => {
      e.stopPropagation(); // don't trigger the card's jump handler
      void this.deps.openSidecar(sidecarPath, id);
    });
  }

  private renderComment(
    card: HTMLElement,
    sourcePath: string,
    id: string,
    comment: string,
  ): void {
    const view = card.createDiv({ cls: 'mrg-card-comment' });
    view.setAttribute('role', 'textbox');
    view.setAttribute('tabindex', '0');
    this.paintComment(view, sourcePath, comment);

    const beginEdit = (): void => {
      view.empty();
      const ta = view.createEl('textarea', { cls: 'mrg-card-comment-input' });
      ta.value = comment;
      ta.rows = Math.max(2, comment.split('\n').length);
      ta.focus();

      // Debounced live write; flush on blur. Both go through the store, which
      // reloads + emits — the resulting onChange triggers a re-render.
      const write = debounce(
        (value: string) => {
          void this.deps.store.updateComment(sourcePath, id, value);
        },
        COMMENT_DEBOUNCE_MS,
        true,
      );
      ta.addEventListener('input', () => write(ta.value));
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

    view.addEventListener('click', () => {
      // Don't restart an edit if a textarea is already mounted.
      if (!view.querySelector('textarea')) beginEdit();
    });
  }

  /** Render the comment as markdown (or the empty placeholder via CSS :empty). */
  private paintComment(view: HTMLElement, sourcePath: string, comment: string): void {
    view.empty();
    if (comment.trim().length === 0) return; // CSS :empty shows the placeholder.
    void MarkdownRenderer.render(this.deps.app, comment, view, sourcePath, this);
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
      cls: 'mrg-delete-button',
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

/**
 * Order resolved annotations by their live document position (start offset),
 * ascending. Orphaned annotations have no range and sink to the end. Ties and
 * orphans keep their relative sidecar order (Array#sort is stable, ES2019+), so
 * one-highlight-per-passage means anchored ties don't actually occur.
 */
function sortByPosition(resolved: ResolvedAnnotation[]): ResolvedAnnotation[] {
  const start = (r: ResolvedAnnotation): number =>
    r.result.status === 'anchored' ? r.result.range.from : Number.POSITIVE_INFINITY;
  return [...resolved].sort((a, b) => start(a) - start(b));
}

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
