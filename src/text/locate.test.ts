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
    // Links / images / wikilinks: the renderer shows only the text, so the
    // source projection must reduce them exactly as projectQuoteToText does
    // (regression: a selection spanning a link could not be located, §7.2).
    'I am a big fan of [Obsidian](https://obsidian.md/). Next sentence.',
    'See [the [nested] note](url) then',
    'A [[wikilink]] and a [[target|alias]] inline',
    'before ![alt text](img.png) after',
    'mixed **[bold link](url)** and `code`',
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

  it('locates a selection that spans a markdown link (rendered as plain text)', () => {
    // The real failing case (samples/How I use Obsidian for academic work.md):
    // reading mode renders "[Obsidian](https://obsidian.md/)" as just "Obsidian",
    // so the selection text has no link syntax — the source projection must too.
    const source = 'I am a big fan of [Obsidian](https://obsidian.md/). This used to be niche.';
    const range = findSourceRange(source, 'I am a big fan of Obsidian.');
    expect(range).not.toBeNull();
    expect(source.slice(range!.from, range!.to)).toBe('I am a big fan of [Obsidian](https://obsidian.md/).');
  });

  it('locates a selection that spans a wikilink alias', () => {
    const source = 'Read the [[Zettelkasten Method|method]] for details.';
    const range = findSourceRange(source, 'the method for');
    expect(range).not.toBeNull();
    expect(source.slice(range!.from, range!.to)).toBe('the [[Zettelkasten Method|method]] for');
  });

  it('returns null when the text is not present', () => {
    expect(findSourceRange('hello world', 'goodbye')).toBeNull();
  });

  it('returns null for an empty selection', () => {
    expect(findSourceRange('hello world', '   ')).toBeNull();
  });
});
