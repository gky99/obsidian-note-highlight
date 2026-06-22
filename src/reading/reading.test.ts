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
    annotation: { id: 'a1', quote, comment: '', record: { id: 'a1', status: 'exact', color } },
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

/** Build a <p> from HTML so a quote can straddle inline elements. */
function richParagraph(html: string): HTMLElement {
  const el = document.createElement('p');
  el.innerHTML = html;
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

  it('wraps a quote that straddles an inline element (<strong>)', () => {
    // Rendered "The quick <strong>brown fox</strong> jumps over the lazy dog."
    // The projected needle "brown fox jumps" crosses the <strong> boundary.
    const paint = makeReadingHighlighter(fakeStore([anchored('brown fox jumps', 10, 25)]));
    const el = richParagraph('The quick <strong>brown fox</strong> jumps over the lazy dog.');
    paint(el, ctx(null));

    const spans = el.querySelectorAll('.mrg-highlight');
    // One span per contributing text node (inside <strong> + the trailing text).
    expect(spans.length).toBe(2);
    const painted = Array.from(spans)
      .map((s) => s.textContent)
      .join('');
    expect(painted).toBe('brown fox jumps');
    // The inner span stays nested inside <strong> (DOM not restructured).
    expect(el.querySelector('strong .mrg-highlight')?.textContent).toBe('brown fox');
    spans.forEach((s) => expect(s.getAttribute('data-anno-id')).toBe('a1'));
  });

  it('wraps a quote whose projection spans a rendered link', () => {
    // projectQuoteToText turns "[Obsidian site](url)" into "Obsidian site", and
    // the painter matches across the <a> boundary.
    const paint = makeReadingHighlighter(
      fakeStore([anchored('See [Obsidian site](https://obsidian.md) for', 4, 25)]),
    );
    const el = richParagraph('See <a href="https://obsidian.md">Obsidian site</a> for more.');
    paint(el, ctx(null));

    const painted = Array.from(el.querySelectorAll('.mrg-highlight'))
      .map((s) => s.textContent)
      .join('');
    expect(painted).toBe('See Obsidian site for');
    expect(el.querySelector('a .mrg-highlight')?.textContent).toBe('Obsidian site');
  });

  it('paints a quote that spans two block elements, one portion per block', () => {
    // Source: "Alpha beta." (line 0) and "gamma delta." (line 1) are separate
    // blocks; the highlight [6,17) covers "beta.\ngamma" across the block break.
    // Each block must paint only its own overlapping slice — the whole quote
    // never appears in a single element, so the old whole-needle search painted
    // nothing here.
    const TEXT = 'Alpha beta.\ngamma delta.';
    const items = [anchored('beta. gamma', 6, 17)];

    const block1 = paragraph('Alpha beta.');
    makeReadingHighlighter(fakeStore(items))(block1, ctx({ text: TEXT, lineStart: 0, lineEnd: 0 }));
    expect(block1.querySelector('.mrg-highlight')?.textContent).toBe('beta.');

    const block2 = paragraph('gamma delta.');
    makeReadingHighlighter(fakeStore(items))(block2, ctx({ text: TEXT, lineStart: 1, lineEnd: 1 }));
    expect(block2.querySelector('.mrg-highlight')?.textContent).toBe('gamma');
  });

  it('does not paint a block the highlight does not reach', () => {
    // Same source, but a highlight confined to line 0 must leave line 1 alone.
    const TEXT = 'Alpha beta.\ngamma delta.';
    const items = [anchored('beta', 6, 10)];
    const block2 = paragraph('gamma delta.');
    makeReadingHighlighter(fakeStore(items))(block2, ctx({ text: TEXT, lineStart: 1, lineEnd: 1 }));
    expect(block2.querySelector('.mrg-highlight')).toBeNull();
  });

  it('does not paint orphaned annotations', () => {
    const orphan = {
      annotation: { id: 'o', quote: 'brown fox', comment: '', record: { id: 'o', status: 'exact' } },
      result: { status: 'orphaned' },
    } as unknown as ResolvedAnnotation;
    const paint = makeReadingHighlighter(fakeStore([orphan]));
    const el = paragraph();
    paint(el, ctx(null));
    expect(el.querySelector('.mrg-highlight')).toBeNull();
  });
});
