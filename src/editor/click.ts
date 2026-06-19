/**
 * Highlight click handling (Design.md §8.2 surface). A DOM `mousedown` handler
 * reads the `data-anno-id` off the nearest `.mrg-highlight` element under the
 * pointer and reports it, so the plugin can focus/scroll the matching card.
 */

import { EditorView } from '@codemirror/view';
import type { Extension } from '@codemirror/state';

/**
 * Extension that calls `onClick(id)` when a painted highlight is pressed.
 * `mousedown` is used over `click` so the handler fires before CM moves the
 * selection, but either would work; we do not consume the event (return false)
 * so normal cursor placement still happens.
 */
export function highlightClickHandler(onClick: (id: string) => void): Extension {
  return EditorView.domEventHandlers({
    mousedown(event: MouseEvent): boolean {
      const target = event.target;
      if (!(target instanceof Element)) return false;
      const el = target.closest('.mrg-highlight');
      if (!el) return false;
      const id = el.getAttribute('data-anno-id');
      if (id) onClick(id);
      return false; // do not preventDefault — let CM place the cursor normally
    },
  });
}
