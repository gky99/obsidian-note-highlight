import { describe, it, expect } from 'vitest';

import { locateMark } from './locate';

/** Assert a located range covers exactly the expected source substring. */
function expectSpan(source: string, text: string, expected: string): void {
  const r = locateMark(source, text);
  expect(r).not.toBeNull();
  expect(source.slice(r!.from, r!.to)).toBe(expected);
}

describe('locateMark', () => {
  it('locates plain text', () => {
    expectSpan('The quick brown fox.', 'quick brown', 'quick brown');
  });

  it('includes a leading emphasis marker when the highlight starts at a styled span', () => {
    // Reported bug: a highlight starting exactly at **bold** dropped the opening
    // `**` while keeping the interior closing `**`, producing the unbalanced,
    // broken quote `bold** word`. The opening marker must travel with the span.
    expectSpan('a **bold** word', 'bold word', '**bold** word');
  });

  it('includes a trailing emphasis marker when the highlight ends at a styled span', () => {
    // Symmetric case: the closing `**` sits just past the last matched char.
    expectSpan('text **bold** here', 'text bold', 'text **bold**');
  });

  it('wraps a highlight that is exactly a styled word in its markers', () => {
    expectSpan('see **bold** word', 'bold', '**bold**');
  });

  it('includes a leading italic marker', () => {
    expectSpan('*italic* and more', 'italic and more', '*italic* and more');
  });

  it('includes surrounding code-span backticks', () => {
    expectSpan('`code` runs here', 'code runs', '`code` runs');
  });

  it('keeps interior emphasis markers across a multi-span match', () => {
    expectSpan('**bold** and *italic*', 'bold and italic', '**bold** and *italic*');
  });

  it('does not grab the opening marker of a following span', () => {
    // `word*italic*`: the highlight ends at "word"; the `*` after it opens the
    // next span, so pulling it in would create the unbalanced `word*`.
    expectSpan('see word*italic* now', 'see word', 'see word');
  });

  it('matches across a line wrap (whitespace removed)', () => {
    expectSpan('keep them\ntogether now', 'them together', 'them\ntogether');
  });

  it('matches text mangled across lines by the clipper (*italic* split out)', () => {
    // A real artifact: "another *Zettel*." became its own lines.
    const src = 'kept in another\n\n*\n\nZettel\n\n*\n\n. Next';
    const r = locateMark(src, 'in another Zettel.');
    expect(r).not.toBeNull();
    expect(src.slice(r!.from, r!.to)).toContain('Zettel');
  });

  it('reduces a [text](url) link to its text', () => {
    expectSpan('see [lifehacker](http://x.com) now', 'see lifehacker now', 'see [lifehacker](http://x.com) now');
  });

  it('drops an image but keeps surrounding text', () => {
    expectSpan('before ![alt](img.png) after', 'before after', 'before ![alt](img.png) after');
  });

  it('drops a footnote reference', () => {
    expectSpan('a claim[^1] follows', 'a claim follows', 'a claim[^1] follows');
  });

  it('reduces a [[target|alias]] wikilink to its alias', () => {
    expectSpan('read [[note-id|the note]] today', 'read the note today', 'read [[note-id|the note]] today');
  });

  it('reduces a bare [[target]] wikilink to its target', () => {
    expectSpan('see [[Zettel]] here', 'see Zettel here', 'see [[Zettel]] here');
  });

  it('folds smart quotes to ASCII so curly vs straight still matches', () => {
    const src = 'they didn’t really';
    expectSpan(src, "didn't really", 'didn’t really');
  });

  it('is case-insensitive', () => {
    expectSpan('The Quick Brown', 'quick brown', 'Quick Brown');
  });

  it('returns null when the text is absent', () => {
    expect(locateMark('hello world', 'goodbye world')).toBeNull();
  });

  it('returns null for empty / whitespace-only needles', () => {
    expect(locateMark('hello', '   ')).toBeNull();
    expect(locateMark('hello', '')).toBeNull();
  });

  it('finds the first occurrence', () => {
    const src = 'cat and cat';
    const r = locateMark(src, 'cat');
    expect(r!.from).toBe(0);
  });
});
