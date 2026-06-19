import { describe, it, expect } from 'vitest';
import type { CachedMetadata } from 'obsidian';
import {
  buildHeadingPaths,
  buildStructure,
  findEnclosingHeadingPath,
  findEnclosingBlockId,
} from './metadata';

/** Minimal position builder — only `offset` is read by the adapter. */
function pos(start: number, end: number) {
  return {
    start: { line: 0, col: 0, offset: start },
    end: { line: 0, col: 0, offset: end },
  };
}

// Source layout (offsets chosen to mirror a real parse):
//   # Intro            [0..7)
//   intro body         [8..18)
//   ## Background      [19..32)
//   bg body            [33..40)   <- block ^h1
//   # Methods          [41..50)
//   methods body       [51..63)
const SOURCE_LEN = 63;

const cache: CachedMetadata = {
  headings: [
    { heading: 'Intro', level: 1, position: pos(0, 7) },
    { heading: 'Background', level: 2, position: pos(19, 32) },
    { heading: 'Methods', level: 1, position: pos(41, 50) },
  ],
  blocks: {
    h1: { id: 'h1', position: pos(33, 40) },
  },
} as unknown as CachedMetadata;

describe('buildHeadingPaths', () => {
  it('reconstructs nested heading paths from the flat list', () => {
    expect(buildHeadingPaths(cache.headings!)).toEqual([
      'Intro',
      'Intro › Background',
      'Methods',
    ]);
  });

  it('pops same-or-higher levels (sibling resets the path)', () => {
    const paths = buildHeadingPaths([
      { heading: 'A', level: 1, position: pos(0, 1) },
      { heading: 'B', level: 2, position: pos(2, 3) },
      { heading: 'C', level: 2, position: pos(4, 5) },
    ] as any);
    expect(paths).toEqual(['A', 'A › B', 'A › C']);
  });
});

describe('buildStructure', () => {
  const s = buildStructure(cache, SOURCE_LEN);

  it('maps a block pin to its content region', () => {
    expect(s.blockRegion('^h1')).toEqual({ from: 33, to: 40 });
    expect(s.blockRegion('^missing')).toBeNull();
  });

  it('maps a heading path to its body region (after the heading line)', () => {
    expect(s.headingRegion('Intro › Background')).toEqual({ from: 32, to: 41 });
    expect(s.headingRegion('Methods')).toEqual({ from: 50, to: 63 });
  });

  it('maps heading-through-following to include the heading line (§6.4)', () => {
    expect(s.headingThroughFollowing('Intro › Background')).toEqual({ from: 19, to: 41 });
    expect(s.headingThroughFollowing('Methods')).toEqual({ from: 41, to: 63 });
  });

  it('ends the last section at the source length', () => {
    expect(s.headingRegion('Methods')!.to).toBe(SOURCE_LEN);
  });

  it('resolves a bare last-segment heading as a fallback', () => {
    expect(s.headingRegion('Background')).toEqual({ from: 32, to: 41 });
  });

  it('returns null for unknown headings', () => {
    expect(s.headingRegion('Nope')).toBeNull();
    expect(s.headingThroughFollowing('Nope')).toBeNull();
  });
});

describe('findEnclosingHeadingPath', () => {
  it('finds the innermost enclosing section', () => {
    expect(findEnclosingHeadingPath(cache, 35)).toBe('Intro › Background');
    expect(findEnclosingHeadingPath(cache, 55)).toBe('Methods');
    expect(findEnclosingHeadingPath(cache, 0)).toBe('Intro');
  });
});

describe('findEnclosingBlockId', () => {
  it('finds an explicitly-id\'d block containing the offset', () => {
    expect(findEnclosingBlockId(cache, 35)).toBe('h1');
  });

  it('returns undefined outside any labelled block', () => {
    expect(findEnclosingBlockId(cache, 5)).toBeUndefined();
  });
});
