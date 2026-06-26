/**
 * Reading-mode post-jump flash (Design.md §8.1). The editor gets its flash from a
 * CM6 decoration (`src/editor/flash.ts`); reading mode has no CodeMirror, so we
 * flash the **painted** `.mrg-highlight[data-anno-id]` spans directly — the same
 * elements scroll-sync reads, present in the reading DOM in both modes. A single
 * highlight can paint as several adjacent spans (it crosses inline/block markup),
 * so we flash every fragment of the target id.
 *
 * Pure DOM (testable with happy-dom): finds the spans, adds the `mrg-flash` class
 * that drives the CSS pulse, and removes it after the animation. Returns the number
 * of spans flashed so the caller can retry while reading mode is still painting.
 */

/** How long the `mrg-flash` class stays on (ms). Must cover the `mrg-flash` CSS animation. */
export const READING_FLASH_MS = 1670;

const FLASH_CLASS = 'mrg-flash';

/** Escape a string for safe use inside an attribute selector `[..="x"]`. */
function cssAttrEscape(value: string): string {
  const esc = (globalThis as { CSS?: { escape?: (s: string) => string } }).CSS?.escape;
  return esc ? esc(value) : value.replace(/["\\]/g, '\\$&');
}

export function flashReadingHighlights(
  container: ParentNode,
  id: string,
  win: { setTimeout: (fn: () => void, ms: number) => unknown } = window,
): number {
  const els = Array.from(
    container.querySelectorAll<HTMLElement>(
      `.mrg-highlight[data-anno-id="${cssAttrEscape(id)}"]`,
    ),
  );
  if (els.length === 0) return 0;
  for (const el of els) el.classList.add(FLASH_CLASS);
  win.setTimeout(() => {
    for (const el of els) el.classList.remove(FLASH_CLASS);
  }, READING_FLASH_MS);
  return els.length;
}
