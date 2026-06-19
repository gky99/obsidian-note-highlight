/**
 * Reverse navigation (Design.md §8.2): when the cursor/selection lands inside a
 * painted highlight, surface the matching annotation id(s) so the caller can
 * pulse the corresponding aside card.
 *
 * The set of "active" ids is recomputed on selection/doc change and reported
 * only when it actually changes, to avoid spamming the callback.
 */

import { ViewPlugin } from '@codemirror/view';
import type { DecorationSet } from '@codemirror/view';
import type { EditorView, ViewUpdate } from '@codemirror/view';
import type { Extension } from '@codemirror/state';

import { highlightField } from './highlights';

/**
 * Pure helper (unit-tested): ids of highlights whose range contains `pos`,
 * scanned from a highlight {@link DecorationSet}. Treats ranges as half-open
 * `[from, to)` but also includes the closing edge so a caret resting at the end
 * of a highlight still counts as "inside" it.
 */
export function activeIdsAt(decorations: DecorationSet, pos: number): string[] {
  const ids: string[] = [];
  decorations.between(pos, pos, (from, to, value) => {
    if (pos < from || pos > to) return undefined;
    const id = value.spec?.attributes?.['data-anno-id'];
    if (typeof id === 'string') ids.push(id);
    return undefined;
  });
  return ids;
}

/** Stable-order, set-equality compare so we only report genuine changes. */
function sameIds(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Build the reverse-nav ViewPlugin. It watches selection/doc changes and calls
 * `onChange` with the currently-active ids (empty when the cursor leaves all
 * highlights), deduping repeats.
 */
export function reverseNavPlugin(onChange: (ids: string[]) => void): Extension {
  return ViewPlugin.define((view: EditorView) => {
    let last: string[] = computeActive(view);
    // Report an initial non-empty state so freshly-opened-on-a-highlight works.
    if (last.length > 0) onChange(last.slice());

    return {
      update(update: ViewUpdate) {
        if (!update.selectionSet && !update.docChanged) return;
        const next = computeActive(update.view);
        if (!sameIds(next, last)) {
          last = next;
          onChange(next.slice());
        }
      },
    };
  });
}

function computeActive(view: EditorView): string[] {
  const decorations = view.state.field(highlightField, false);
  if (!decorations) return [];
  const head = view.state.selection.main.head;
  return activeIdsAt(decorations, head);
}
