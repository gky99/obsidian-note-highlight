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

  // --- Immersive Translate interop (CLAUDE.md / Design.md §7.2) -------------
  // The Immersive Translate plugin injects translated text into the reading-mode
  // DOM as `<font class="immersive-translate-target-wrapper">` nodes, appended
  // after each original chunk. With its `selectors: [".markdown-reading-view *"]`
  // config a translation can land *between* the text nodes a quote spans, which
  // used to break `concat.indexOf(needle)` and silently drop the highlight. The
  // painter now skips those foreign nodes so it matches only the note's own text.

  it('paints an inline-spanning quote even when a translation is interleaved (Immersive Translate)', () => {
    // Faithful Immersive Translate DOM: original text nodes wrapped in bare
    // <font>, a translation <font.immersive-translate-target-wrapper> appended
    // after the <strong> *inside* it, and another after the block. The translation
    // sits between "brown fox" and " jumps" — the two nodes the quote spans.
    const paint = makeReadingHighlighter(fakeStore([anchored('The quick **brown fox** jumps', 0, 0)]));
    const el = richParagraph(
      '<font>The quick </font>' +
        '<strong><font>brown fox</font>' +
        '<font class="immersive-translate-target-wrapper">棕色狐狸</font></strong>' +
        '<font> jumps over the lazy dog.</font>' +
        '<font class="immersive-translate-target-wrapper">敏捷的棕色狐狸跳过懒狗。</font>',
    );
    paint(el, ctx(null));

    const spans = el.querySelectorAll('.mrg-highlight');
    const painted = Array.from(spans)
      .map((s) => s.textContent)
      .join('');
    expect(painted).toBe('The quick brown fox jumps');
    // The translation must never be highlighted, and must stay intact in the DOM.
    spans.forEach((s) => expect(s.textContent).not.toMatch(/[一-鿿]/));
    expect(el.querySelectorAll('.immersive-translate-target-wrapper').length).toBe(2);
  });

  it('matches the original, not a translation that echoes the same token', () => {
    // The translation keeps the English proper noun "Obsidian" verbatim. The quote
    // must paint the original occurrence, never the one inside the translation.
    const SRC = 'I use Obsidian daily.';
    const paint = makeReadingHighlighter(fakeStore([anchored('Obsidian', 6, 14)]));
    const el = richParagraph(
      'I use <font>Obsidian</font> daily.' +
        '<font class="immersive-translate-target-wrapper">我每天使用 Obsidian。</font>',
    );
    paint(el, ctx({ text: SRC, lineStart: 0, lineEnd: 0 }));

    const spans = el.querySelectorAll('.mrg-highlight');
    expect(spans.length).toBe(1);
    expect(spans[0].textContent).toBe('Obsidian');
    // The painted span is the original, outside any translation wrapper.
    expect(spans[0].closest('.immersive-translate-target-wrapper')).toBeNull();
  });

  it('still paints a plain quote when the block-level translation is appended (no regression)', () => {
    const paint = makeReadingHighlighter(fakeStore([anchored('brown fox', 10, 19)]));
    const el = richParagraph(
      `${SENTENCE}<br><font class="immersive-translate-target-wrapper">敏捷的棕色狐狸跳跃。</font>`,
    );
    paint(el, ctx({ text: SENTENCE, lineStart: 0, lineEnd: 0 }));
    expect(el.querySelector('.mrg-highlight')?.textContent).toBe('brown fox');
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
