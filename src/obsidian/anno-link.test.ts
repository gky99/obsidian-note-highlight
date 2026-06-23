import { describe, it, expect } from 'vitest';

import { annoBlockSubpath, annoBlockWikilink } from './anno-link';

describe('anno-link', () => {
  it('builds a block subpath for an id', () => {
    expect(annoBlockSubpath('7c')).toBe('#^anno-7c');
  });

  it('builds a block wikilink from a linktext and id', () => {
    expect(annoBlockWikilink('My Note', '7c')).toBe('[[My Note#^anno-7c]]');
  });

  it('keeps a linktext with spaces and punctuation verbatim', () => {
    // The real sample sidecar basename — Obsidian resolves spaces fine.
    expect(annoBlockWikilink('The Difference Between Good and Bad Tags', 'a1b2')).toBe(
      '[[The Difference Between Good and Bad Tags#^anno-a1b2]]',
    );
  });
});
