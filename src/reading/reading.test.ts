// @vitest-environment happy-dom
/**
 * DOM tests for the reading-mode painter — proves it wraps a plain-text quote in
 * a `.mrg-highlight` span, both when `getSectionInfo` is available and when it
 * returns null (the fallback path). The real Obsidian render pipeline is out of
 * scope; these isolate the painter from store/timing/integration concerns.
 */
import { describe, it, expect } from 'vitest';
import type { MarkdownPostProcessorContext } from 'obsidian';

import { makeReadingHighlighter } from './reading';
import type { AnnotationStore, ResolvedAnnotation } from '@/store/store';

const SENTENCE = 'The quick brown fox jumps.';

function fakeStore(items: ResolvedAnnotation[]): AnnotationStore {
  return { getResolved: () => items } as unknown as AnnotationStore;
}

function anchored(quote: string, from: number, to: number, color = 'yellow'): ResolvedAnnotation {
  return {
    annotation: { id: 'a1', quote, comment: '', record: { id: 'a1', status: 'anchored', color } },
    result: { status: 'anchored', method: 'exact', range: { from, to } },
  } as unknown as ResolvedAnnotation;
}

function ctx(
  info: { text: string; lineStart: number; lineEnd: number } | null,
): MarkdownPostProcessorContext {
  return { sourcePath: 'note.md', getSectionInfo: () => info } as unknown as MarkdownPostProcessorContext;
}

function paragraph(text = SENTENCE): HTMLElement {
  const el = document.createElement('p');
  el.textContent = text;
  return el;
}

describe('makeReadingHighlighter', () => {
  it('wraps a plain-text quote when section info is available', () => {
    const paint = makeReadingHighlighter(fakeStore([anchored('brown fox', 10, 19)]));
    const el = paragraph();
    paint(el, ctx({ text: SENTENCE, lineStart: 0, lineEnd: 0 }));

    const span = el.querySelector('.mrg-highlight');
    expect(span).not.toBeNull();
    expect(span?.textContent).toBe('brown fox');
    expect(span?.getAttribute('data-anno-id')).toBe('a1');
    expect(span?.className).toContain('mrg-color-yellow');
  });

  it('still wraps when section info is unavailable (the fallback path)', () => {
    const paint = makeReadingHighlighter(fakeStore([anchored('brown fox', 10, 19)]));
    const el = paragraph();
    paint(el, ctx(null));
    expect(el.querySelector('.mrg-highlight')?.textContent).toBe('brown fox');
  });

  it('applies a custom hex color as an inline background', () => {
    const paint = makeReadingHighlighter(fakeStore([anchored('brown fox', 10, 19, '#ff0000')]));
    const el = paragraph();
    paint(el, ctx(null));

    const span = el.querySelector<HTMLElement>('.mrg-highlight');
    expect(span).not.toBeNull();
    expect(span?.style.backgroundColor).not.toBe('');
    expect(span?.className).not.toContain('mrg-color-');
  });

  it('does not paint orphaned annotations', () => {
    const orphan = {
      annotation: { id: 'o', quote: 'brown fox', comment: '', record: { id: 'o', status: 'orphaned' } },
      result: { status: 'orphaned' },
    } as unknown as ResolvedAnnotation;
    const paint = makeReadingHighlighter(fakeStore([orphan]));
    const el = paragraph();
    paint(el, ctx(null));
    expect(el.querySelector('.mrg-highlight')).toBeNull();
  });
});
