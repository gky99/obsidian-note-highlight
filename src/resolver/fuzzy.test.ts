import { describe, it, expect } from 'vitest';
import { fuzzyLocate } from './fuzzy';

describe('fuzzyLocate', () => {
  it('finds an exact substring as a perfect (score 1) hit', () => {
    const scope = 'lorem ipsum dolor sit amet consectetur adipiscing elit';
    const quote = 'dolor sit amet consectetur';
    const hit = fuzzyLocate(scope, quote);
    expect(hit).not.toBeNull();
    if (!hit) throw new Error('unreachable');
    expect(scope.slice(hit.from, hit.to)).toBe('dolor sit amet consectetur');
    expect(hit.score).toBeCloseTo(1, 5);
  });

  it('recovers a quote with one changed word above threshold', () => {
    const scope = 'the rapid brown fox leaps over the sleepy hound nearby';
    const quote = 'the rapid brown fox jumps over the sleepy hound'; // leaps→jumps
    const hit = fuzzyLocate(scope, quote);
    expect(hit).not.toBeNull();
    if (!hit) throw new Error('unreachable');
    expect(hit.score).toBeGreaterThanOrEqual(0.7);
    expect(scope.slice(hit.from, hit.to)).toContain('brown fox');
  });

  it('returns null when nothing clears the threshold', () => {
    const scope = 'completely unrelated text with no overlap to speak of here';
    const quote = 'a sentence about quantum chromodynamics and gluons';
    expect(fuzzyLocate(scope, quote)).toBeNull();
  });

  it('returns null for empty inputs', () => {
    expect(fuzzyLocate('', 'x')).toBeNull();
    expect(fuzzyLocate('x', '')).toBeNull();
  });

  it('handles long quotes that exceed dmp Match_MaxBits (~32 chars)', () => {
    const passage =
      'In a hole in the ground there lived a hobbit, not a nasty dirty wet hole, ' +
      'filled with the ends of worms and an oozy smell.';
    const scope = `Preface text. ${passage} Following sentence.`;
    // Long quote (>32 chars) with a single typo deep inside it.
    const quote = passage.replace('oozy smell', 'oozey smell');
    const hit = fuzzyLocate(scope, quote);
    expect(hit).not.toBeNull();
    if (!hit) throw new Error('unreachable');
    expect(hit.score).toBeGreaterThanOrEqual(0.9);
    expect(scope.slice(hit.from, hit.to)).toContain('there lived a hobbit');
  });

  it('honours a custom (stricter) threshold', () => {
    const scope = 'alpha beta gamma delta epsilon zeta eta theta';
    const quote = 'alpha beta XXXXX delta epsilon zeta'; // sizeable corruption
    expect(fuzzyLocate(scope, quote, { threshold: 0.99 })).toBeNull();
  });
});
