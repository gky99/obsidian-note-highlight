// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { flashReadingHighlights, READING_FLASH_MS } from './flash';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

/** A reading-mode container with painted highlight spans for `ids`. */
function container(ids: string[]): HTMLElement {
  const el = document.createElement('div');
  for (const id of ids) {
    const span = document.createElement('span');
    span.className = 'mrg-highlight mrg-color-yellow';
    span.setAttribute('data-anno-id', id);
    span.textContent = `h-${id}`;
    el.appendChild(span);
  }
  return el;
}

describe('flashReadingHighlights', () => {
  it('adds the flash class to every span of the target id, then removes it after the duration', () => {
    const root = container(['a', 'a', 'b']); // id "a" spans two fragments
    const count = flashReadingHighlights(root, 'a');
    expect(count).toBe(2);

    const aSpans = root.querySelectorAll('[data-anno-id="a"]');
    for (const el of aSpans) expect(el.classList.contains('mrg-flash')).toBe(true);
    // The unrelated highlight is untouched.
    expect(root.querySelector('[data-anno-id="b"]')!.classList.contains('mrg-flash')).toBe(false);

    vi.advanceTimersByTime(READING_FLASH_MS);
    for (const el of aSpans) expect(el.classList.contains('mrg-flash')).toBe(false);
  });

  it('returns 0 and schedules nothing when the target is not painted yet', () => {
    const root = container(['x']);
    expect(flashReadingHighlights(root, 'missing')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
