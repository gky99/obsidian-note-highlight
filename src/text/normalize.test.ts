import { describe, it, expect } from 'vitest';
import { normalize, mapRange, normalizeQuote, quoteHash } from './normalize';

describe('normalize', () => {
  it('collapses runs of whitespace to a single space', () => {
    expect(normalize('a   b\t\tc\n\nd').text).toBe('a b c d');
  });

  it('keeps a map entry per normalized char plus an end sentinel', () => {
    const n = normalize('a  b');
    expect(n.text).toBe('a b');
    expect(n.map).toHaveLength(n.text.length + 1);
    expect(n.map[n.map.length - 1]).toBe('a  b'.length);
  });

  it('maps a collapsed run to the offset where the run began', () => {
    //  index:  0123456
    //  input: "a   bc"
    const n = normalize('a   bc');
    expect(n.text).toBe('a bc');
    // 'a' at 0, ' ' (run) at 1, 'b' at 4, 'c' at 5
    expect(n.map).toEqual([0, 1, 4, 5, 6]);
  });

  it('preserves leading and trailing whitespace as single spaces', () => {
    const n = normalize('  hi  ');
    expect(n.text).toBe(' hi ');
    expect(n.map[0]).toBe(0);
  });

  it('preserves Markdown markers (does not stem them)', () => {
    expect(normalize('## A   heading\n\nwith **bold**').text).toBe(
      '## A heading with **bold**',
    );
  });

  it('treats non-breaking and unicode spaces as whitespace', () => {
    expect(normalize('a  b').text).toBe('a b');
  });
});

describe('mapRange', () => {
  it('maps a normalized match back to true source offsets', () => {
    const src = 'the   quick  brown fox';
    const n = normalize(src);
    expect(n.text).toBe('the quick brown fox');
    const needle = 'quick brown';
    const at = n.text.indexOf(needle);
    const range = mapRange(n, at, at + needle.length);
    expect(src.slice(range.from, range.to)).toBe('quick  brown');
  });

  it('excludes trailing collapsed whitespace from the mapped range', () => {
    const src = 'word    next';
    const n = normalize(src);
    const at = n.text.indexOf('word');
    const range = mapRange(n, at, at + 'word'.length);
    expect(range).toEqual({ from: 0, to: 4 });
    expect(src.slice(range.from, range.to)).toBe('word');
  });

  it('maps a match that runs to the end of the text', () => {
    const src = 'alpha   beta';
    const n = normalize(src);
    const at = n.text.indexOf('beta');
    const range = mapRange(n, at, at + 'beta'.length);
    expect(src.slice(range.from, range.to)).toBe('beta');
    expect(range.to).toBe(src.length);
  });

  it('clamps out-of-bounds indices instead of returning undefined', () => {
    const n = normalize('abc');
    const range = mapRange(n, 0, 999);
    expect(range).toEqual({ from: 0, to: 3 });
  });
});

describe('normalizeQuote / quoteHash', () => {
  it('trims and collapses for a canonical needle', () => {
    expect(normalizeQuote('  the   sentence\nI care about  ')).toBe(
      'the sentence I care about',
    );
  });

  it('hashes equal across reflowed whitespace', () => {
    expect(quoteHash('the sentence I care about')).toBe(
      quoteHash('the   sentence\n\nI care about'),
    );
  });

  it('hashes differently for different text', () => {
    expect(quoteHash('one thing')).not.toBe(quoteHash('another thing'));
  });
});
