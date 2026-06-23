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
import { annoBlockSubpath, annoBlockWikilink } from '@/obsidian/anno-link';

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

/**
 * Sideways navigation: annotation card → its record in the **sidecar** file, at
 * the quote's `^anno-<id>` block ref (§7.3). Unlike {@link jumpToAnnotation} this
 * needs no live re-resolution — the block ref is literally in the file — so it
 * works even when the annotation is *orphaned* in the source. Focuses an existing
 * tab of the sidecar if one is open; otherwise opens a new tab. Obsidian scrolls
 * to the block from the link subpath.
 */
export async function openAnnotationInSidecar(
  app: App,
  sidecarPath: string,
  id: string,
): Promise<void> {
  const file = app.vault.getAbstractFileByPath(sidecarPath);
  if (!(file instanceof TFile)) {
    new Notice('Marginalia: annotations file not found.');
    return;
  }
  const linktext = `${app.metadataCache.fileToLinktext(file, file.path)}${annoBlockSubpath(id)}`;
  const open = app.workspace
    .getLeavesOfType('markdown')
    .find((leaf) => leaf.view instanceof MarkdownView && leaf.view.file?.path === sidecarPath);
  if (open) {
    // Reuse the tab already showing the sidecar — openLinkText(…, false) targets
    // the active leaf, so make it active first, then just scroll to the block.
    app.workspace.setActiveLeaf(open, { focus: true });
    await app.workspace.openLinkText(linktext, file.path, false);
  } else {
    await app.workspace.openLinkText(linktext, file.path, 'tab');
  }
}

/**
 * Copy a wikilink to the annotation's quote block (`[[sidecar#^anno-<id>]]`) to
 * the clipboard, so it can be pasted elsewhere as a link straight to that part of
 * the sidecar. The linktext is `fileToLinktext`'s shortest form, so Obsidian keeps
 * it pointing home if the sidecar is renamed/moved.
 */
export async function copyAnnotationReference(
  app: App,
  sidecarPath: string,
  id: string,
): Promise<void> {
  const file = app.vault.getAbstractFileByPath(sidecarPath);
  if (!(file instanceof TFile)) {
    new Notice('Marginalia: annotations file not found.');
    return;
  }
  const ref = annoBlockWikilink(app.metadataCache.fileToLinktext(file, ''), id);
  try {
    await navigator.clipboard.writeText(ref);
    new Notice('Marginalia: reference copied');
  } catch {
    new Notice('Marginalia: could not copy to clipboard.');
  }
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
