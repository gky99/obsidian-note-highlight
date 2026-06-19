import { describe, it, expect } from 'vitest';

import { findSourceRange, projectSourceWithMap } from './locate';
import { projectQuoteToText } from '@/reading/project';

describe('projectSourceWithMap', () => {
  const samples = [
    'Some **bold** text',
    '## Heading\nSome *emphasized* prose',
    '> a quote\n> second line',
    '- item one\n- item two',
    '1. first\n2. second',
    'plain paragraph with   irregular   spacing',
    '`code` and _under_ and **strong**',
    '\n\nLeading blanks\n\n',
  ];

  it('produces the same text as projectQuoteToText', () => {
    for (const s of samples) {
      expect(projectSourceWithMap(s).text).toBe(projectQuoteToText(s));
    }
  });

  it('maps each projected character back to a real source offset', () => {
    const input = 'Some **bold** text';
    const { text, off } = projectSourceWithMap(input);
    expect(off.length).toBe(text.length);
    // Every kept char must equal the source char at its mapped offset.
    for (let i = 0; i < text.length; i++) {
      if (text[i] !== ' ') expect(input[off[i]]).toBe(text[i]);
    }
  });
});

describe('findSourceRange', () => {
  it('locates a plain-text selection exactly', () => {
    const source = 'The quick brown fox jumps.';
    const range = findSourceRange(source, 'brown fox');
    expect(range).not.toBeNull();
    expect(source.slice(range!.from, range!.to)).toBe('brown fox');
  });

  it('locates a selection whose source had inline emphasis', () => {
    const source = 'Some **bold** words here';
    // Reading mode hands us the rendered (marker-free) text.
    const range = findSourceRange(source, 'bold words');
    expect(range).not.toBeNull();
    // The span covers the source from "bold" through "words" (markers included).
    expect(source.slice(range!.from, range!.to)).toContain('bold');
    expect(source.slice(range!.from, range!.to)).toContain('words');
  });

  it('locates text across a heading-stripped line', () => {
    const source = '# Title\nFirst paragraph body';
    const range = findSourceRange(source, 'First paragraph');
    expect(range).not.toBeNull();
    expect(source.slice(range!.from, range!.to)).toBe('First paragraph');
  });

  it('returns null when the text is not present', () => {
    expect(findSourceRange('hello world', 'goodbye')).toBeNull();
  });

  it('returns null for an empty selection', () => {
    expect(findSourceRange('hello world', '   ')).toBeNull();
  });
});
