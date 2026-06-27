import { describe, it, expect } from 'vitest';

import { balanceEmphasisRange } from './emphasis';

/** Balance a raw range and return the source substring it now covers. */
function span(source: string, from: number, to: number, base = 0): string {
  const r = balanceEmphasisRange(source, from, to, base);
  return source.slice(r.from, r.to);
}

/** Range covering the literal `pick` inside `source` (first occurrence). */
function rangeOf(source: string, pick: string): [number, number] {
  const from = source.indexOf(pick);
  return [from, from + pick.length];
}

describe('balanceEmphasisRange', () => {
  it('grows a range that starts at bold content to include the opening **', () => {
    const src = 'a **bold** word';
    expect(span(src, ...rangeOf(src, 'bold** word'))).toBe('**bold** word');
  });

  it('grows a range that ends at a bold word to include the closing **', () => {
    const src = 'text **bold** here';
    expect(span(src, ...rangeOf(src, 'text **bold'))).toBe('text **bold**');
  });

  it('wraps a range that is exactly the bold content on both sides', () => {
    const src = 'see **bold** word';
    expect(span(src, ...rangeOf(src, 'bold'))).toBe('**bold**');
  });

  it('includes a surrounding underscore-italic delimiter', () => {
    const src = 'an _italic_ word';
    expect(span(src, ...rangeOf(src, 'italic_ word'))).toBe('_italic_ word');
  });

  it('includes surrounding code-span backticks', () => {
    const src = '`code` runs here';
    expect(span(src, ...rangeOf(src, 'code` runs'))).toBe('`code` runs');
  });

  it('does not grab the opening delimiter of a following span', () => {
    const src = 'see word*italic* now';
    // "word" ends right before the italic opener; pulling the * in would unbalance.
    expect(span(src, ...rangeOf(src, 'word'))).toBe('word');
  });

  it('leaves a plain-text range untouched', () => {
    const src = 'the quick brown fox';
    expect(span(src, ...rangeOf(src, 'quick brown'))).toBe('quick brown');
  });

  it('never extends the leading edge below `base` (frontmatter guard)', () => {
    // Pretend the body starts at index 2: the `**` at [0,2) is off-limits.
    const src = '**bold';
    expect(span(src, 2, 6, 2)).toBe('bold');
  });
});
