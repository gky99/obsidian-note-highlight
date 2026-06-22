/**
 * Marginalia CM6 editor extension (Design.md §7.1, §4.4, §8.2).
 *
 * Public surface handed to the plugin:
 *  - {@link marginaliaEditorExtension}: the `Extension` for
 *    `plugin.registerEditorExtension([...])`. Paints highlights, hides `anno`
 *    blocks, surfaces reverse-nav ids and highlight clicks.
 *  - {@link setHighlights} / {@link clearHighlights}: push/clear the resolved
 *    highlights for a given editor view.
 *  - {@link flashRange}: transient post-jump flash over a range.
 *
 * All highlight/anchor *resolution* happens upstream; this layer only renders
 * the ranges it is given and reports interaction back out through callbacks.
 */

import type { EditorView } from '@codemirror/view';
import type { Extension } from '@codemirror/state';

import {
  highlightField,
  setHighlightsEffect,
  type HighlightSpec,
} from './highlights';
import { flashField, flashRange as flashRangeImpl } from './flash';
import { reverseNavPlugin } from './reverse-nav';
import { highlightClickHandler } from './click';
import { annoHideField } from './anno-hide';
import { selfHealPlugin } from './self-heal';

/** Default lull (ms) after which an unfinished deletion run settles (§6.5). */
const DELETION_SETTLE_MS = 15_000;

export type { HighlightSpec } from './highlights';

/** Options wiring the editor extension back to the plugin (Design.md §8.2). */
export interface EditorExtensionOptions {
  /**
   * Cursor/selection entered these annotation highlights (reverse nav, §8.2).
   * Called with `[]` when the selection leaves all highlights.
   */
  onActiveHighlightsChange?: (ids: string[]) => void;
  /** A painted highlight was clicked; carries its `data-anno-id`. */
  onHighlightClick?: (id: string) => void;
  /**
   * Reveal raw `anno` blocks when the cursor is inside them, instead of always
   * hiding them (from `settings.revealAnnoOnCursor`). Defaults to `false`.
   */
  revealAnnoBlocks?: boolean;
  /**
   * In-session self-healing (§6.5): a highlight entered an active deletion run →
   * suppress its repair (and repaint) so its live range stays clean. All three
   * `onDeletionRun*` callbacks must be set to enable the guard.
   */
  onDeletionRunStart?: (id: string) => void;
  /** Run ended, highlight survived → commit the survivor from the editor's exact range + text. */
  onDeletionRunCommit?: (id: string, from: number, to: number, docText: string) => void;
  /** Run ended, highlight collapsed → orphan with the original quote. */
  onDeletionRunCollapse?: (id: string) => void;
  /** An undo/redo hit an active run → re-anchor that highlight by content against `docText`. */
  onDeletionRunRecheck?: (id: string, docText: string) => void;
}

/**
 * The composed CM6 extension. Order: highlight field (decorations) → flash
 * field → anno-hide field → reverse-nav view plugin → click handler. State
 * fields are listed before the view-level pieces that read them.
 *
 * The selection toolbar is deliberately NOT here: it is a DOM-level surface so
 * it can serve reading mode too (see `@/ui/selection-toolbar`).
 */
export function marginaliaEditorExtension(
  options: EditorExtensionOptions = {},
): Extension {
  const extensions: Extension[] = [
    highlightField,
    flashField,
    annoHideField(options.revealAnnoBlocks ?? false),
  ];

  if (options.onActiveHighlightsChange) {
    const onChange = options.onActiveHighlightsChange;
    extensions.push(reverseNavPlugin(onChange));
  }

  if (options.onHighlightClick) {
    extensions.push(highlightClickHandler(options.onHighlightClick));
  }

  if (
    options.onDeletionRunStart &&
    options.onDeletionRunCommit &&
    options.onDeletionRunCollapse &&
    options.onDeletionRunRecheck
  ) {
    extensions.push(
      selfHealPlugin({
        settleMs: DELETION_SETTLE_MS,
        onRunStart: options.onDeletionRunStart,
        onRunCommit: options.onDeletionRunCommit,
        onRunCollapse: options.onDeletionRunCollapse,
        onRunRecheck: options.onDeletionRunRecheck,
      }),
    );
  }

  return extensions;
}

/**
 * Push the current file's resolved highlights into a specific editor's view.
 * Replaces any existing highlight set (the field rebuilds from these specs).
 */
export function setHighlights(view: EditorView, specs: HighlightSpec[]): void {
  view.dispatch({ effects: setHighlightsEffect.of(specs) });
}

/** Clear all highlights from a view. */
export function clearHighlights(view: EditorView): void {
  view.dispatch({ effects: setHighlightsEffect.of([]) });
}

/**
 * Transient post-jump flash over `[from, to)` (§8.1); auto-clears after ~1.1s.
 * No-op if the range is empty.
 */
export function flashRange(view: EditorView, from: number, to: number): void {
  flashRangeImpl(view, from, to);
}
