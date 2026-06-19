import { describe, it, expect } from 'vitest';

import { projectQuoteToText, rangesOverlap, sectionSpan } from './project';

describe('projectQuoteToText', () => {
  it('returns a plain single-line phrase unchanged', () => {
    expect(projectQuoteToText('the sentence I care about')).toBe('the sentence I care about');
  });

  it('strips leading blockquote markers', () => {
    expect(projectQuoteToText('> a quoted line')).toBe('a quoted line');
    expect(projectQuoteToText('> > nested quote')).toBe('nested quote');
  });

  it('strips leading heading markers', () => {
    expect(projectQuoteToText('## A quoted heading')).toBe('A quoted heading');
    expect(projectQuoteToText('> ## heading in a quote')).toBe('heading in a quote');
  });

  it('removes inline emphasis and code markers', () => {
    expect(projectQuoteToText('text with **strong** emphasis')).toBe('text with strong emphasis');
    expect(projectQuoteToText('some _italic_ and `code` here')).toBe('some italic and code here');
  });

  it('joins multi-line quotes and collapses whitespace', () => {
    const quote = '> ## A quoted heading\n> followed by text with **strong** emphasis';
    expect(projectQuoteToText(quote)).toBe('A quoted heading followed by text with strong emphasis');
  });

  it('collapses internal whitespace runs to single spaces and trims', () => {
    expect(projectQuoteToText('  spaced    out   words  ')).toBe('spaced out words');
  });

  it('strips simple list markers', () => {
    expect(projectQuoteToText('- a bullet item')).toBe('a bullet item');
    expect(projectQuoteToText('1. an ordered item')).toBe('an ordered item');
  });

  it('returns empty string for marker-only / blank input', () => {
    expect(projectQuoteToText('>')).toBe('');
    expect(projectQuoteToText('   ')).toBe('');
  });
});

describe('rangesOverlap', () => {
  it('detects overlap', () => {
    expect(rangesOverlap(0, 10, 5, 15)).toBe(true);
    expect(rangesOverlap(5, 15, 0, 10)).toBe(true);
    expect(rangesOverlap(2, 8, 3, 5)).toBe(true); // contained
  });

  it('treats touching ranges as non-overlapping', () => {
    expect(rangesOverlap(0, 5, 5, 9)).toBe(false);
    expect(rangesOverlap(5, 9, 0, 5)).toBe(false);
  });

  it('detects disjoint ranges', () => {
    expect(rangesOverlap(0, 4, 6, 10)).toBe(false);
  });
});

describe('sectionSpan', () => {
  const doc = 'line0\nline1\nline2\nline3';
  //           0-4   6-10  12-16 18-22  (offsets), newlines at 5, 11, 17

  it('spans a single middle line', () => {
    // line1 occupies [6, 11)
    expect(sectionSpan(doc, 1, 1)).toEqual({ from: 6, to: 11 });
  });

  it('spans the first line', () => {
    expect(sectionSpan(doc, 0, 0)).toEqual({ from: 0, to: 5 });
  });

  it('spans the last line (no trailing newline)', () => {
    expect(sectionSpan(doc, 3, 3)).toEqual({ from: 18, to: doc.length });
  });

  it('spans multiple lines', () => {
    // lines 1..2: from start of line1 (6) to end of line2 (17, before its \n)
    expect(sectionSpan(doc, 1, 2)).toEqual({ from: 6, to: 17 });
  });

  it('handles a single-line document', () => {
    expect(sectionSpan('only line', 0, 0)).toEqual({ from: 0, to: 9 });
  });

  it('returns null for out-of-range lines', () => {
    expect(sectionSpan(doc, 5, 5)).toBeNull();
    expect(sectionSpan(doc, -1, 0)).toBeNull();
    expect(sectionSpan(doc, 2, 1)).toBeNull();
  });
});
