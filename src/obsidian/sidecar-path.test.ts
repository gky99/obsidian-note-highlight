import { describe, it, expect } from 'vitest';
import type { MetadataCache, TFile } from 'obsidian';
import {
  sidecarPathForSource,
  isSidecarPath,
  sourcePathForSidecar,
  annotatesLink,
  annotatesLinkpath,
  resolveAnnotates,
} from './sidecar-path';

describe('sidecarPathForSource', () => {
  it('inserts the suffix before the .md extension', () => {
    expect(sidecarPathForSource('Clips/The Article.md')).toBe(
      'Clips/The Article.annotations.md',
    );
  });

  it('handles a top-level file', () => {
    expect(sidecarPathForSource('Note.md')).toBe('Note.annotations.md');
  });

  it('handles a dotted folder name without a file extension', () => {
    // The only dot is in the folder; treat the file as extensionless.
    expect(sidecarPathForSource('my.folder/Note')).toBe('my.folder/Note.annotations.md');
  });

  it('respects a custom suffix', () => {
    expect(sidecarPathForSource('A/B.md', '.notes')).toBe('A/B.notes.md');
  });

  it('places the sidecar directly in a custom folder, by basename', () => {
    expect(sidecarPathForSource('Clips/The Article.md', '.annotations', '_anno')).toBe(
      '_anno/The Article.annotations.md',
    );
  });

  it('flattens deeply-nested sources into the exact folder', () => {
    expect(sidecarPathForSource('A/B/C/Deep Note.md', '.annotations', 'Sidecars')).toBe(
      'Sidecars/Deep Note.annotations.md',
    );
  });

  it('trims slashes around the folder', () => {
    expect(sidecarPathForSource('Note.md', '.annotations', '/_anno/')).toBe(
      '_anno/Note.annotations.md',
    );
  });

  describe('disambiguator (basename collision)', () => {
    it('appends a -N number before the suffix', () => {
      expect(sidecarPathForSource('Clips/The Article.md', '.annotations', '_anno', 1)).toBe(
        '_anno/The Article-1.annotations.md',
      );
    });

    it('counts up across slots', () => {
      expect(sidecarPathForSource('A/Note.md', '.annotations', '_anno', 2)).toBe(
        '_anno/Note-2.annotations.md',
      );
    });

    it('N=0 is the canonical (un-numbered) path', () => {
      expect(sidecarPathForSource('A/Note.md', '.annotations', '_anno', 0)).toBe(
        sidecarPathForSource('A/Note.md', '.annotations', '_anno'),
      );
    });

    it('keeps the number on the basename, before the suffix and extension', () => {
      expect(sidecarPathForSource('Note', '.annotations', '_anno', 3)).toBe(
        '_anno/Note-3.annotations.md',
      );
    });

    it('is ignored without a folder (no collisions arise alongside the source)', () => {
      expect(sidecarPathForSource('A/Note.md', '.annotations', '', 1)).toBe(
        'A/Note.annotations.md',
      );
    });
  });
});

describe('isSidecarPath', () => {
  it('recognizes the convention', () => {
    expect(isSidecarPath('A/B.annotations.md')).toBe(true);
    expect(isSidecarPath('A/B.md')).toBe(false);
  });
});

describe('sourcePathForSidecar', () => {
  it('inverts the convention', () => {
    expect(sourcePathForSidecar('Clips/The Article.annotations.md')).toBe(
      'Clips/The Article.md',
    );
  });

  it('returns null for a non-sidecar path', () => {
    expect(sourcePathForSidecar('Clips/The Article.md')).toBeNull();
  });

  it('round-trips with sidecarPathForSource', () => {
    const src = 'Deep/Nested/Path/Doc.md';
    expect(sourcePathForSidecar(sidecarPathForSource(src))).toBe(src);
  });

  it('strips a custom folder prefix before inverting', () => {
    expect(
      sourcePathForSidecar('_anno/The Article.annotations.md', '.annotations', '_anno'),
    ).toBe('The Article.md');
  });

  it('recovers only the basename for a custom folder (the directory is lost)', () => {
    // A folder flattens sidecars by basename, so the inverse cannot reconstruct
    // the source's directory — callers prefer the `annotates` frontmatter instead.
    const src = 'Deep/Nested/Doc.md';
    expect(
      sourcePathForSidecar(sidecarPathForSource(src, '.annotations', '_anno'), '.annotations', '_anno'),
    ).toBe('Doc.md');
  });
});

describe('annotatesLink', () => {
  it('wraps a source path as a wikilink and drops the .md extension', () => {
    expect(annotatesLink('Clips/The Article.md')).toBe('[[Clips/The Article]]');
  });

  it('handles a top-level source', () => {
    expect(annotatesLink('Note.md')).toBe('[[Note]]');
  });

  it('leaves an extensionless path intact', () => {
    expect(annotatesLink('Folder/Note')).toBe('[[Folder/Note]]');
  });
});

describe('annotatesLinkpath', () => {
  it('extracts the target from a wikilink', () => {
    expect(annotatesLinkpath('[[Clips/The Article]]')).toBe('Clips/The Article');
  });

  it('strips a display alias and a subpath', () => {
    expect(annotatesLinkpath('[[Clips/The Article|Pretty Name]]')).toBe('Clips/The Article');
    expect(annotatesLinkpath('[[Clips/The Article#Heading]]')).toBe('Clips/The Article');
  });

  it('accepts a bare path for back-compat', () => {
    expect(annotatesLinkpath('Clips/The Article.md')).toBe('Clips/The Article.md');
  });

  it('returns null for an empty value', () => {
    expect(annotatesLinkpath('   ')).toBeNull();
    expect(annotatesLinkpath('[[]]')).toBeNull();
  });
});

describe('resolveAnnotates', () => {
  /** A fake cache that resolves a fixed linkpath→file, mimicking the metadata cache. */
  const cacheReturning = (path: string | null): Pick<MetadataCache, 'getFirstLinkpathDest'> => ({
    getFirstLinkpathDest: () => (path === null ? null : ({ path } as unknown as TFile)),
  });

  it('resolves a wikilink through the cache to the source vault path', () => {
    const cache = cacheReturning('Sources/The Article.md');
    expect(resolveAnnotates(cache, 'Sidecars/The Article.annotations.md', '[[The Article]]')).toBe(
      'Sources/The Article.md',
    );
  });

  it('falls back to the literal linkpath + .md when the target is not in the vault', () => {
    const cache = cacheReturning(null);
    expect(resolveAnnotates(cache, 'x.annotations.md', '[[Clips/The Article]]')).toBe(
      'Clips/The Article.md',
    );
  });

  it('keeps an explicit .md in the fallback', () => {
    const cache = cacheReturning(null);
    expect(resolveAnnotates(cache, 'x.annotations.md', 'Clips/The Article.md')).toBe(
      'Clips/The Article.md',
    );
  });

  it('returns null for an empty annotates value', () => {
    const cache = cacheReturning('whatever.md');
    expect(resolveAnnotates(cache, 'x.annotations.md', '')).toBeNull();
  });
});
