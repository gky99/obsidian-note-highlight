/**
 * Highlight rendering in the CM6 source / Live Preview editor (Design.md §7.1).
 *
 * Resolved annotation ranges are pushed in via a {@link StateEffect}; a
 * {@link StateField} holds the resulting {@link DecorationSet} and `.map()`s it
 * through every document change so highlights stay glued to their text as the
 * user types above or within them (§7.1, edge case §10 #1).
 */

import { StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView } from '@codemirror/view';
import type { DecorationSet } from '@codemirror/view';

import { renderColor } from '@/color';

/** A resolved highlight to paint: a range in the live document plus its color. */
export interface HighlightSpec {
  id: string;
  from: number;
  to: number;
  color?: string;
}

/** Replace the entire set of highlights with the carried specs. */
export const setHighlightsEffect = StateEffect.define<readonly HighlightSpec[]>();

/**
 * Turn a single spec into a `Decoration.mark`. Built-in colors render through
 * the `mrg-color-<token>` class (theme-aware); a custom hex renders via an
 * inline `background-color`. `data-anno-id` lets the DOM click handler (and any
 * external lookup) recover the annotation id.
 */
function markFor(spec: HighlightSpec): Decoration {
  const render = renderColor(spec.color);
  const attributes: Record<string, string> = { 'data-anno-id': spec.id };
  let cls = 'mrg-highlight';
  if (render.className) cls += ` ${render.className}`;
  if (render.background) attributes.style = `background-color: ${render.background};`;
  return Decoration.mark({ class: cls, attributes });
}

/**
 * Pure helper (unit-tested): build a sorted, validated decoration set from
 * specs against a document of length `docLength`.
 *
 * - Skips zero-length and inverted ranges — `Decoration.mark` rejects empty
 *   ranges and would throw.
 * - Clamps to the document bounds so a stale/over-long spec can't blow up.
 * - Sorts by `from` (then `to`); `Decoration.set` requires sorted input.
 */
export function buildHighlightDecorations(
  specs: readonly HighlightSpec[],
  docLength: number,
): DecorationSet {
  const ranges = [];
  for (const spec of specs) {
    const from = Math.max(0, Math.min(spec.from, docLength));
    const to = Math.max(0, Math.min(spec.to, docLength));
    if (!(to > from)) continue; // drop empty/inverted/out-of-range
    ranges.push(markFor(spec).range(from, to));
  }
  ranges.sort((a, b) => a.from - b.from || a.to - b.to);
  return Decoration.set(ranges, /* already sorted */ true);
}

/** Holds the current highlight decorations; mapped across edits, reset on effect. */
export const highlightField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(deco, tr) {
    let next = deco.map(tr.changes);
    for (const effect of tr.effects) {
      if (effect.is(setHighlightsEffect)) {
        next = buildHighlightDecorations(effect.value, tr.newDoc.length);
      }
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});
