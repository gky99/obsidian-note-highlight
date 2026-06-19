import { describe, it, expect } from 'vitest';
import { inMemoryStructure } from './structure';

describe('inMemoryStructure', () => {
  it('returns explicit block / heading regions and null for unknowns', () => {
    const s = inMemoryStructure({
      blocks: { '^h1': { from: 0, to: 10 } },
      headings: { 'Intro': { from: 11, to: 40 } },
    });
    expect(s.blockRegion('^h1')).toEqual({ from: 0, to: 10 });
    expect(s.blockRegion('^missing')).toBeNull();
    expect(s.headingRegion('Intro')).toEqual({ from: 11, to: 40 });
    expect(s.headingRegion('Nope')).toBeNull();
  });

  it('defaults headingThroughFollowing to the heading region when unspecified', () => {
    const s = inMemoryStructure({ headings: { 'A': { from: 5, to: 20 } } });
    expect(s.headingThroughFollowing('A')).toEqual({ from: 5, to: 20 });
  });

  it('prefers an explicit headingThrough window over the heading region', () => {
    const s = inMemoryStructure({
      headings: { 'A': { from: 5, to: 20 } },
      headingThrough: { 'A': { from: 5, to: 50 } },
    });
    expect(s.headingThroughFollowing('A')).toEqual({ from: 5, to: 50 });
  });

  it('returns null from every accessor on an empty spec', () => {
    const s = inMemoryStructure();
    expect(s.blockRegion('x')).toBeNull();
    expect(s.headingRegion('x')).toBeNull();
    expect(s.headingThroughFollowing('x')).toBeNull();
  });
});
