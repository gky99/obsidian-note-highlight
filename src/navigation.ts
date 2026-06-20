/**
 * Plugin-owned navigation (Design.md §8). The jump target is a content selector
 * Obsidian cannot interpret, so we re-resolve live and move the cursor ourselves.
 *
 * Forward jump is "find then go": read the annotation's current resolution from
 * the store (which re-resolves on load, §6.3), refuse if orphaned (§4.6),
 * otherwise open the source, select the range, scroll it into view, and flash.
 */
import { TFile, MarkdownView, Notice, type App } from 'obsidian';
import type { EditorView } from '@codemirror/view';

import type { AnnotationStore } from '@/store/store';

/** Optional CM6 flash, injected by the plugin from the editor extension module. */
export type FlashFn = (view: EditorView, from: number, to: number) => void;

/**
 * Forward navigation: annotation card → its exact place in the source (§8.1).
 * Refuses to guess when the annotation is orphaned. `onBeforeScroll` fires right
 * before the programmatic `scrollIntoView` so the caller can suppress scroll-sync
 * for this jump (the panel shouldn't chase a scroll it caused).
 */
export async function jumpToAnnotation(
  app: App,
  store: AnnotationStore,
  sourcePath: string,
  id: string,
  flash?: FlashFn,
  onBeforeScroll?: () => void,
): Promise<void> {
  const resolved = store.getById(sourcePath, id);
  if (!resolved) return;

  if (resolved.result.status !== 'anchored') {
    new Notice('Marginalia: this passage could no longer be found — annotation is orphaned.');
    return;
  }

  const file = app.vault.getAbstractFileByPath(sourcePath);
  if (!(file instanceof TFile)) return;

  const leaf = app.workspace.getLeaf(false);
  await leaf.openFile(file);

  const view = leaf.view;
  if (!(view instanceof MarkdownView)) return;

  const { from, to } = resolved.result.range;
  // Signal that the scroll about to happen is *ours* — a card click jumps the
  // document, and the scroll-sync listener must not chase it back into the panel
  // (the user clicked a specific card; the panel should stay put).
  onBeforeScroll?.();

  if (view.getMode() === 'preview') {
    // Reading mode: the CM editor is hidden, so `editor.scrollIntoView` would
    // move an off-screen editor and leave the preview exactly where it is — the
    // jump appears to do nothing. Scroll the active sub-view (the preview) to the
    // highlight's line instead. `applyScroll` takes a line number, the same unit
    // both sub-views use, so we derive it from the source offset. The reading-mode
    // post-processor paints the highlight itself; there is no CM flash to give.
    const sourceText = await app.vault.cachedRead(file);
    view.currentMode.applyScroll(lineAtOffset(sourceText, from));
    return;
  }

  const editor = view.editor;
  const fromPos = editor.offsetToPos(from);
  const toPos = editor.offsetToPos(to);
  editor.setSelection(fromPos, toPos);
  editor.scrollIntoView({ from: fromPos, to: toPos }, true);

  // The CM6 EditorView is exposed (undocumented) as `editor.cm`; flash if we can.
  const cm = (editor as unknown as { cm?: EditorView }).cm;
  if (cm && flash) flash(cm, from, to);
}

/** 0-based line number containing source offset `offset` (newlines before it). */
function lineAtOffset(text: string, offset: number): number {
  let line = 0;
  const end = Math.min(offset, text.length);
  for (let i = 0; i < end; i++) {
    if (text.charCodeAt(i) === 10 /* \n */) line++;
  }
  return line;
}
