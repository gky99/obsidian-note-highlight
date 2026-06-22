import { describe, it, expect } from 'vitest';

import { bodyStart } from './frontmatter';

describe('bodyStart (leading YAML frontmatter)', () => {
  it('returns 0 when there is no frontmatter', () => {
    expect(bodyStart('# Just a heading\n\nBody text.')).toBe(0);
    expect(bodyStart('')).toBe(0);
  });

  it('skips a simple frontmatter block', () => {
    const src = '---\ntitle: Hi\n---\n# Body';
    expect(src.slice(bodyStart(src))).toBe('# Body');
  });

  it('skips a multi-field block and stops at the FIRST closing fence', () => {
    const src = '---\na: 1\nb: 2\nc: 3\n---\nbody\n---\nnot frontmatter';
    expect(src.slice(bodyStart(src))).toBe('body\n---\nnot frontmatter');
  });

  it('recognizes an empty block and the YAML `...` terminator', () => {
    expect('---\n---\nx'.slice(bodyStart('---\n---\nx'))).toBe('x');
    expect('---\nk: v\n...\nx'.slice(bodyStart('---\nk: v\n...\nx'))).toBe('x');
  });

  it('tolerates CRLF and trailing spaces on the fences', () => {
    const src = '--- \r\ntitle: Hi\r\n--- \r\nBody';
    expect(src.slice(bodyStart(src))).toBe('Body');
  });

  it('does NOT treat a non-leading or unterminated `---` as frontmatter', () => {
    // `---` mid-document is a horizontal rule, not frontmatter.
    expect(bodyStart('Intro.\n\n---\n\nMore.')).toBe(0);
    // An opening fence with no closing fence is left as body (permissive).
    expect(bodyStart('---\ntitle: Hi\nno closing fence')).toBe(0);
  });
});
