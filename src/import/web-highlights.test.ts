import { describe, it, expect } from 'vitest';

import {
  colorsInExport,
  htmlToMarkdown,
  markColor,
  markComment,
  marksForUrl,
  normalizeUrl,
  parseExport,
  urlFromMeta,
  urlsWithMarks,
  type WebHighlightsExport,
} from './web-highlights';

describe('parseExport', () => {
  it('parses a JSON string with a marks array', () => {
    const data = parseExport('{"marks":[{"text":"hi"}]}');
    expect(data.marks).toHaveLength(1);
  });

  it('passes through an already-parsed object', () => {
    const obj: WebHighlightsExport = { marks: [] };
    expect(parseExport(obj)).toBe(obj);
  });

  it('throws when marks is missing', () => {
    expect(() => parseExport('{"bookmarks":[]}')).toThrow(/marks/);
  });
});

describe('normalizeUrl', () => {
  it('drops the hash fragment and trailing slash, lowercases', () => {
    expect(normalizeUrl('https://Example.com/Path/#section')).toBe('https://example.com/path');
  });

  it('treats with/without trailing slash as equal', () => {
    expect(normalizeUrl('https://x.com/a/')).toBe(normalizeUrl('https://x.com/a'));
  });
});

describe('marksForUrl / urlsWithMarks', () => {
  const data: WebHighlightsExport = {
    marks: [
      { url: 'https://x.com/a', text: 'one' },
      { url: 'https://x.com/a/#frag', text: 'two' },
      { url: 'https://x.com/b', text: 'three' },
      { text: 'no url' },
    ],
  };

  it('selects marks whose URL matches (modulo hash/slash)', () => {
    const marks = marksForUrl(data, 'https://x.com/a/');
    expect(marks.map((m) => m.text)).toEqual(['one', 'two']);
  });

  it('collects the set of normalized URLs that have marks', () => {
    expect(urlsWithMarks(data)).toEqual(new Set(['https://x.com/a', 'https://x.com/b']));
  });
});

describe('urlFromMeta', () => {
  it('reads a bare URL from common keys', () => {
    expect(urlFromMeta({ source: 'https://x.com/a' })).toBe('https://x.com/a');
    expect(urlFromMeta({ url: 'https://x.com/b' })).toBe('https://x.com/b');
  });

  it('extracts the URL from a [title](url) markdown link', () => {
    expect(urlFromMeta({ source: '[The Page](https://x.com/a)' })).toBe('https://x.com/a');
  });

  it('returns null when no URL is present', () => {
    expect(urlFromMeta({ title: 'no link here' })).toBeNull();
    expect(urlFromMeta(undefined)).toBeNull();
  });
});

describe('markColor', () => {
  it('keeps a normalized hex color', () => {
    expect(markColor({ color: '#fdffb4' })).toBe('#fdffb4');
    expect(markColor({ color: '#FDFFB4' })).toBe('#fdffb4');
  });

  it('adds a missing leading #', () => {
    expect(markColor({ color: 'fdffb4' })).toBe('#fdffb4');
  });

  it('returns undefined for a non-color / missing value', () => {
    expect(markColor({ color: 'not-a-color' })).toBeUndefined();
    expect(markColor({})).toBeUndefined();
  });
});

describe('htmlToMarkdown / markComment', () => {
  it('unwraps a paragraph note', () => {
    expect(htmlToMarkdown('<p>What about other ways?</p>')).toBe('What about other ways?');
  });

  it('converts inline formatting and links', () => {
    expect(htmlToMarkdown('<strong>bold</strong> and <em>em</em>')).toBe('**bold** and *em*');
    expect(htmlToMarkdown('<a href="https://x.com">link</a>')).toBe('[link](https://x.com)');
  });

  it('converts list items to dashes', () => {
    expect(htmlToMarkdown('<ul><li>a</li><li>b</li></ul>')).toBe('- a\n- b');
  });

  it('decodes HTML entities', () => {
    expect(htmlToMarkdown('Tom &amp; Jerry &#39;quote&#39;')).toBe("Tom & Jerry 'quote'");
  });

  it('markComment returns empty string when there is no note', () => {
    expect(markComment({ text: 'x' })).toBe('');
  });
});

describe('colorsInExport', () => {
  it('returns distinct normalized colors, most-used first', () => {
    const data: WebHighlightsExport = {
      marks: [
        { color: '#fdffb4' },
        { color: '#FDFFB4' }, // same color, different case → merged
        { color: '#c3effc' },
        { color: '#fdffb4' },
        { color: 'not-a-color' }, // ignored
        {}, // no color → ignored
      ],
    };
    expect(colorsInExport(data)).toEqual(['#fdffb4', '#c3effc']);
  });

  it('returns an empty list when no marks carry a usable color', () => {
    expect(colorsInExport({ marks: [{}, { color: 'xyz' }] })).toEqual([]);
  });
});
