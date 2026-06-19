/**
 * Transient post-jump flash (Design.md §8.1). After a forward jump from an
 * annotation card, a `mrg-flash` mark is laid over the landed range and then
 * cleared ~1.1s later so the CSS animation runs once.
 */

import { StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView } from '@codemirror/view';
import type { DecorationSet } from '@codemirror/view';

/** Lay a flash mark over `[from, to)`. */
export const addFlashEffect = StateEffect.define<{ from: number; to: number }>();
/** Remove all flash marks. */
export const clearFlashEffect = StateEffect.define<null>();

/** Matches the `mrg-flash` keyframe in styles.css. */
const FLASH_DURATION_MS = 1100;

const flashMark = Decoration.mark({ class: 'mrg-flash' });

/** Holds at most the single active flash mark; mapped across edits like highlights. */
export const flashField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(deco, tr) {
    let next = deco.map(tr.changes);
    for (const effect of tr.effects) {
      if (effect.is(clearFlashEffect)) {
        next = Decoration.none;
      } else if (effect.is(addFlashEffect)) {
        const { from, to } = effect.value;
        const lo = Math.max(0, Math.min(from, tr.newDoc.length));
        const hi = Math.max(0, Math.min(to, tr.newDoc.length));
        next = hi > lo ? Decoration.set([flashMark.range(lo, hi)]) : Decoration.none;
      }
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

/**
 * Dispatch a flash over `[from, to)` and schedule its removal. Guards against
 * the view being torn down before the timer fires (dispatching into a destroyed
 * view throws) by checking the editor DOM is still connected.
 */
export function flashRange(view: EditorView, from: number, to: number): void {
  if (!(to > from)) return;
  view.dispatch({ effects: addFlashEffect.of({ from, to }) });
  window.setTimeout(() => {
    if (!view.dom.isConnected) return; // view destroyed/detached — do nothing
    view.dispatch({ effects: clearFlashEffect.of(null) });
  }, FLASH_DURATION_MS);
}
