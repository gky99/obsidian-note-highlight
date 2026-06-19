import { describe, it, expect } from 'vitest';
import {
  sidecarPathForSource,
  isSidecarPath,
  sourcePathForSidecar,
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

  it('re-roots under a custom folder, mirroring the source path', () => {
    expect(sidecarPathForSource('Clips/The Article.md', '.annotations', '_anno')).toBe(
      '_anno/Clips/The Article.annotations.md',
    );
  });

  it('trims slashes around the folder', () => {
    expect(sidecarPathForSource('Note.md', '.annotations', '/_anno/')).toBe(
      '_anno/Note.annotations.md',
    );
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
      sourcePathForSidecar('_anno/Clips/The Article.annotations.md', '.annotations', '_anno'),
    ).toBe('Clips/The Article.md');
  });

  it('round-trips with a custom folder', () => {
    const src = 'Deep/Nested/Doc.md';
    expect(
      sourcePathForSidecar(sidecarPathForSource(src, '.annotations', '_anno'), '.annotations', '_anno'),
    ).toBe(src);
  });
});
