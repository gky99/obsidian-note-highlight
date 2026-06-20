/**
 * Marginalia — plugin entry point and wiring.
 *
 * This module owns no annotation logic; it composes the already-built layers:
 *  - the {@link AnnotationStore} (sidecar I/O + live re-resolution),
 *  - the CM6 editor extension (highlight painting, anno-block hiding, reverse nav),
 *  - the reading-mode processors (anno hiding + best-effort highlights),
 *  - the aside panel (card list + comment/color write-back),
 *  - and navigation (forward jump).
 *
 * Its job is the plumbing between Obsidian's workspace events and those layers:
 * load+re-resolve on file-open / source-or-sidecar change, repaint the relevant
 * editors, and keep the aside pointed at the active source (Design.md §9).
 */
import {
  Plugin,
  MarkdownView,
  Notice,
  TFile,
  type Editor,
  type WorkspaceLeaf,
} from 'obsidian';
import type { EditorView } from '@codemirror/view';

import { DEFAULT_SETTINGS, type MarginaliaSettings } from '@/settings';
import { AnnotationStore, type ResolvedAnnotation } from '@/store/store';
import { jumpToAnnotation } from '@/navigation';
import { isSidecarPath, sourcePathForSidecar } from '@/obsidian/sidecar-path';
import {
  marginaliaEditorExtension,
  setHighlights,
  flashRange,
  type HighlightSpec,
} from '@/editor';
import { renderAnnoBlock, makeReadingHighlighter, ANNO_LANGUAGE } from '@/reading';
import { findSourceRange } from '@/text/locate';
import { normalizeColorValue } from '@/color';
import { WebHighlightsImporter } from '@/import';
import {
  ASIDE_VIEW_TYPE,
  MarginaliaAsideView,
  MarginaliaSettingTab,
  SelectionToolbar,
  ScrollSync,
  SidecarCollisionModal,
  confirm,
  DELETE_PROMPT,
  type SettingsHost,
  type HighlightRequest,
  type ExistingHighlight,
} from '@/ui';

const MARKDOWN_VIEW_TYPE = 'markdown';

export default class MarginaliaPlugin extends Plugin implements SettingsHost {
  settings: MarginaliaSettings = { ...DEFAULT_SETTINGS };
  store!: AnnotationStore;
  private importer!: WebHighlightsImporter;
  /** Last painted highlight signature per source, to re-render reading mode only when it changes. */
  private readingSig = new Map<string, string>();
  /**
   * Last seen render mode per open view, so we can repaint exactly once when a
   * pane toggles Reading ↔ Editing. Neither `file-open` nor `active-leaf-change`
   * fires on a same-leaf mode switch, so without this the freshly-shown editor
   * (or reading view) keeps no highlights until the next store change.
   */
  private lastModes = new WeakMap<MarkdownView, string>();

  async onload(): Promise<void> {
    await this.loadSettings();
    this.store = new AnnotationStore(this.app, this.settings);
    // Prompt on a flat-folder sidecar name collision (Design.md §4.1).
    this.store.onCollision = (collision) => new SidecarCollisionModal(this.app, collision).choose();
    this.importer = new WebHighlightsImporter(this.app, this.store, this.settings);

    // --- CM6 editor extension: highlights + anno hiding + reverse nav -----
    this.registerEditorExtension(
      marginaliaEditorExtension({
        revealAnnoBlocks: this.settings.revealAnnoOnCursor,
        onHighlightClick: (id) => this.getAside()?.revealCard(id),
        onActiveHighlightsChange: (ids) => {
          if (ids.length > 0) this.getAside()?.pulseCard(ids[0]);
        },
      }),
    );

    // --- Floating selection toolbar (works in Live Preview AND reading mode) --
    const toolbar = new SelectionToolbar({
      app: this.app,
      getColors: () => this.settings.palette,
      onHighlight: (req, color) => void this.highlightRequest(req, color),
      lookupById: (view, id) =>
        this.existingHighlight(view, (sourcePath) => this.store.getById(sourcePath, id)),
      lookupByRange: (view, from, to) =>
        this.existingHighlight(view, (sourcePath) => this.store.annotationAt(sourcePath, from, to)),
      onRecolor: (t, color) => void this.store.updateColor(t.sourcePath, t.id, color),
      onComment: (t, comment) => void this.store.updateComment(t.sourcePath, t.id, comment),
      onDelete: (t) => void this.confirmThenDelete(t.sourcePath, t.id),
    });
    toolbar.start();
    this.register(() => toolbar.destroy());

    // --- Scroll sync: keep the aside aligned with the document as it scrolls --
    const scrollSync = new ScrollSync({
      app: this.app,
      getAside: () => this.getAside(),
      resolveSourcePath: (path) => this.resolveSourcePath(path),
    });
    scrollSync.start();
    this.register(() => scrollSync.destroy());

    // --- Reading mode -----------------------------------------------------
    this.registerMarkdownCodeBlockProcessor(ANNO_LANGUAGE, (src, el, ctx) =>
      renderAnnoBlock(src, el, ctx),
    );
    this.registerMarkdownPostProcessor(makeReadingHighlighter(this.store));

    // --- Aside panel ------------------------------------------------------
    this.registerView(
      ASIDE_VIEW_TYPE,
      (leaf) =>
        new MarginaliaAsideView(leaf, {
          app: this.app,
          store: this.store,
          settings: this.settings,
          jumpTo: (sourcePath, id) =>
            jumpToAnnotation(this.app, this.store, sourcePath, id, flashRange, () =>
              scrollSync.suppress(),
            ),
        }),
    );

    this.addSettingTab(new MarginaliaSettingTab(this.app, this));

    // --- Commands & ribbon ------------------------------------------------
    this.addCommand({
      id: 'highlight-selection',
      name: 'Highlight selection',
      editorCallback: (editor, ctx) => {
        if (ctx instanceof MarkdownView) void this.highlightSelection(editor, ctx);
      },
    });
    this.addCommand({
      id: 'open-annotations-panel',
      name: 'Open annotations panel',
      callback: () => void this.activateAside(true),
    });
    this.addCommand({
      id: 'import-web-highlights-current',
      name: 'Import Web Highlights into current note',
      callback: () => void this.importer.importCurrent(),
    });
    this.addCommand({
      id: 'import-web-highlights-all',
      name: 'Import Web Highlights into all clips',
      callback: () => void this.importer.importAll(),
    });
    this.addRibbonIcon('highlighter', 'Marginalia: import highlights into current note', () =>
      void this.importer.importCurrent(),
    );

    // --- Reactivity -------------------------------------------------------
    // Our own store emitter: repaint editors when a file's annotations change.
    this.register(this.store.onChange((sourcePath) => this.repaint(sourcePath)));

    this.registerEvent(this.app.workspace.on('file-open', () => void this.syncActiveFile()));
    this.registerEvent(
      this.app.workspace.on('active-leaf-change', () => void this.syncActiveFile()),
    );
    // Repaint a pane when it toggles Reading ↔ Editing (no file/leaf event fires).
    this.registerEvent(this.app.workspace.on('layout-change', () => this.onLayoutChange()));
    this.registerEvent(this.app.metadataCache.on('changed', (file) => this.maybeReload(file)));
    this.registerEvent(
      this.app.vault.on('modify', (file) => {
        if (file instanceof TFile) this.maybeReload(file);
      }),
    );
    this.registerEvent(
      this.app.vault.on('delete', (file) => {
        if (file instanceof TFile) this.store.forget(file.path);
      }),
    );

    // Initial sync once the workspace is ready (the active file is reliable then).
    this.app.workspace.onLayoutReady(() => {
      void this.syncActiveFile();
      if (this.settings.autoOpenAside) void this.activateAside(false);
    });
  }

  // --- settings -----------------------------------------------------------

  async loadSettings(): Promise<void> {
    Object.assign(this.settings, DEFAULT_SETTINGS, await this.loadData());
    // Own a private copy of the palette so edits never alias DEFAULT_SETTINGS,
    // and never let a hand-edited empty list leave us with no colors to offer.
    this.settings.palette =
      Array.isArray(this.settings.palette) && this.settings.palette.length > 0
        ? [...this.settings.palette]
        : [...DEFAULT_SETTINGS.palette];
    // Own a fresh, coerced copy of the frontmatter field list so edits never alias
    // DEFAULT_SETTINGS and a malformed persisted value can't crash the settings tab.
    this.settings.sidecarFrontmatter = Array.isArray(this.settings.sidecarFrontmatter)
      ? this.settings.sidecarFrontmatter.map((f) => ({
          key: String(f?.key ?? ''),
          value: String(f?.value ?? ''),
        }))
      : [];
  }

  /** Distinct colors in the newest Web Highlights export (for palette autocomplete). */
  exportColors(): Promise<string[]> {
    return this.importer.exportColors();
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    // The store, aside, and navigation share this.settings by reference, so
    // changes take effect on the next load. (The editor extension captured
    // revealAnnoBlocks at registration; that one needs a reload to change.)
    void this.syncActiveFile();
  }

  // --- active-file plumbing ----------------------------------------------

  /** The source note an open file is "about" (a sidecar maps back to its source). */
  private resolveSourcePath(path: string): string {
    if (!isSidecarPath(path, this.settings.sidecarSuffix)) return path;
    // Prefer the sidecar's own `annotates` record: it is the authoritative link
    // and survives a custom sidecar folder, which flattens sidecars by basename
    // so the name-based inverse below can no longer recover the source directory.
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      const annotates = this.app.metadataCache.getFileCache(file)?.frontmatter?.annotates;
      if (typeof annotates === 'string' && annotates) return annotates;
    }
    return (
      sourcePathForSidecar(path, this.settings.sidecarSuffix, this.settings.sidecarFolder) ?? path
    );
  }

  /**
   * Build a toolbar edit target from a store lookup against the active view's
   * source note. Used by the selection toolbar to recolor/delete the highlight
   * the user clicked (by id) or selected over (by overlapping range).
   */
  private existingHighlight(
    view: MarkdownView,
    lookup: (sourcePath: string) => ResolvedAnnotation | undefined,
  ): ExistingHighlight | null {
    const file = view.file;
    if (!file) return null;
    const sourcePath = this.resolveSourcePath(file.path);
    const res = lookup(sourcePath);
    if (!res) return null;
    return {
      sourcePath,
      id: res.annotation.id,
      color: normalizeColorValue(res.annotation.record.color),
      comment: res.annotation.comment,
    };
  }

  private getAside(): MarginaliaAsideView | null {
    const leaf = this.app.workspace.getLeavesOfType(ASIDE_VIEW_TYPE)[0];
    return leaf && leaf.view instanceof MarginaliaAsideView ? leaf.view : null;
  }

  /** Load + re-resolve the active file's source and point the aside at it. */
  private async syncActiveFile(): Promise<void> {
    const active = this.app.workspace.getActiveFile();
    if (!active || active.extension !== 'md') {
      this.getAside()?.setSourceFile(null);
      return;
    }
    const sourcePath = this.resolveSourcePath(active.path);
    const sourceFile = this.app.vault.getAbstractFileByPath(sourcePath);
    if (sourceFile instanceof TFile) {
      this.getAside()?.setSourceFile(sourcePath);
      await this.store.load(sourceFile); // emits → repaint() + aside refresh
    } else {
      this.getAside()?.setSourceFile(null);
    }
  }

  /** Reload when the active source — or its sidecar — changes underneath us. */
  private maybeReload(file: TFile): void {
    const activePath = this.app.workspace.getActiveFile()?.path;
    if (!activePath) return;
    const sourcePath = this.resolveSourcePath(activePath);
    // The change is relevant if it's the source itself, the canonical sidecar name
    // (covers a not-yet-loaded create / a shared sidecar), or any sidecar whose
    // `annotates` points at this source (covers a disambiguated collision sidecar).
    const isSidecar = isSidecarPath(file.path, this.settings.sidecarSuffix);
    const relevant =
      file.path === sourcePath ||
      file.path === this.store.sidecarPathFor(sourcePath) ||
      (isSidecar && this.resolveSourcePath(file.path) === sourcePath);
    if (!relevant) return;
    const sourceFile = this.app.vault.getAbstractFileByPath(sourcePath);
    if (sourceFile instanceof TFile) void this.store.load(sourceFile);
  }

  /**
   * Repaint every open view of `sourcePath`. CM editors (source / Live Preview)
   * get the highlight specs pushed directly; reading-mode views paint via the
   * post-processor, so they need a re-render — but only when the highlight set
   * actually changed (a comment edit must not flash the preview).
   */
  private repaint(sourcePath: string): void {
    const specs = this.specsFor(sourcePath);
    const signature = specSignature(specs);
    const readingStale = this.readingSig.get(sourcePath) !== signature;
    this.readingSig.set(sourcePath, signature);

    for (const leaf of this.app.workspace.getLeavesOfType(MARKDOWN_VIEW_TYPE)) {
      const view = leaf.view;
      if (!(view instanceof MarkdownView) || view.file?.path !== sourcePath) continue;
      this.lastModes.set(view, view.getMode());
      if (view.getMode() === 'preview') {
        if (readingStale) view.previewMode.rerender(true);
      } else {
        const cm = editorView(view.editor);
        if (cm) setHighlights(cm, specs);
      }
    }
  }

  /** The anchored highlight specs for a source (empty if none/orphaned). */
  private specsFor(sourcePath: string): HighlightSpec[] {
    const specs: HighlightSpec[] = [];
    for (const r of this.store.getResolved(sourcePath)) {
      if (r.result.status === 'anchored') {
        specs.push({
          id: r.annotation.id,
          from: r.result.range.from,
          to: r.result.range.to,
          color: r.annotation.record.color,
        });
      }
    }
    return specs;
  }

  /**
   * On any layout change, repaint each open markdown view whose render mode just
   * flipped (Reading ↔ Editing). The per-view {@link lastModes} guard means a
   * transition repaints exactly once, so resizes/other layout churn are ignored
   * and reading mode never re-renders in a loop.
   */
  private onLayoutChange(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(MARKDOWN_VIEW_TYPE)) {
      const view = leaf.view;
      if (!(view instanceof MarkdownView) || !view.file) continue;
      const mode = view.getMode();
      if (this.lastModes.get(view) === mode) continue;
      this.lastModes.set(view, mode);
      this.repaintView(view);
    }
  }

  /** Push the current highlights into one view (used when its mode flips). */
  private repaintView(view: MarkdownView): void {
    const file = view.file;
    if (!file) return;
    const sourcePath = this.resolveSourcePath(file.path);
    const specs = this.specsFor(sourcePath);
    if (view.getMode() === 'preview') {
      // Entering reading mode: force the post-processor to re-run so highlights
      // paint over the (possibly cached, un-highlighted) preview DOM.
      this.readingSig.set(sourcePath, specSignature(specs));
      if (specs.length > 0) view.previewMode.rerender(true);
    } else {
      // Entering editing mode: the CM editor starts with no decorations.
      const cm = editorView(view.editor);
      if (cm) setHighlights(cm, specs);
    }
  }

  // --- actions ------------------------------------------------------------

  private async highlightSelection(editor: Editor, view: MarkdownView): Promise<void> {
    const file = view.file;
    if (!file) return;
    const from = editor.posToOffset(editor.getCursor('from'));
    const to = editor.posToOffset(editor.getCursor('to'));
    if (from === to) {
      new Notice('Marginalia: select some text first.');
      return;
    }
    await this.highlightRange(file, from, to);
  }

  /**
   * Handle a toolbar highlight request. In source / Live Preview the range is
   * exact; in reading mode only the selected text is known, so re-locate it in
   * the source (best-effort) before highlighting.
   */
  private async highlightRequest(req: HighlightRequest, color: string): Promise<void> {
    if (req.range) {
      await this.highlightRange(req.file, req.range.from, req.range.to, color);
      return;
    }
    const sourceText = await this.app.vault.cachedRead(req.file);
    const range = findSourceRange(sourceText, req.text);
    if (!range) {
      new Notice('Marginalia: couldn’t locate that selection in the note source. Try Live Preview.');
      return;
    }
    await this.highlightRange(req.file, range.from, range.to, color);
  }

  /**
   * Create a highlight over source range `[from, to)` (used by the command and
   * the floating selection toolbar), then surface its card in the aside.
   */
  private async highlightRange(
    file: TFile,
    from: number,
    to: number,
    color?: string,
  ): Promise<void> {
    if (from === to) return;
    const anno = await this.store.createHighlight(file, from, to, color);
    if (!anno) return;
    await this.activateAside(false);
    const aside = this.getAside();
    aside?.setSourceFile(file.path);
    aside?.revealCard(anno.id);
  }

  /** Delete an annotation, asking first when the `confirmDelete` setting is on. */
  private async confirmThenDelete(sourcePath: string, id: string): Promise<void> {
    if (this.settings.confirmDelete && !(await confirm(this.app, DELETE_PROMPT))) return;
    await this.store.deleteAnnotation(sourcePath, id);
  }

  private async activateAside(reveal: boolean): Promise<void> {
    let leaf: WorkspaceLeaf | null = this.app.workspace.getLeavesOfType(ASIDE_VIEW_TYPE)[0] ?? null;
    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false);
      if (!leaf) return;
      await leaf.setViewState({ type: ASIDE_VIEW_TYPE, active: true });
    }
    if (reveal) this.app.workspace.revealLeaf(leaf);
    const active = this.app.workspace.getActiveFile();
    if (active) this.getAside()?.setSourceFile(this.resolveSourcePath(active.path));
  }
}

/** Obsidian exposes the underlying CM6 view as the undocumented `editor.cm`. */
function editorView(editor: Editor): EditorView | undefined {
  return (editor as unknown as { cm?: EditorView }).cm;
}

/** Stable signature of a highlight set, to detect "did the painted set change?". */
function specSignature(specs: HighlightSpec[]): string {
  return specs.map((s) => `${s.id}:${s.from}:${s.to}:${s.color ?? ''}`).join('|');
}
