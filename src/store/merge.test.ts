import { describe, it, expect } from 'vitest';

import { mergeResolved, pickPrimary, type MergeItem, type PerFile } from './merge';

/** Build a resolved-annotation-shaped item for the merge tests. */
function anchored(id: string, sidecarPath: string, from: number, to: number): MergeItem {
  return {
    annotation: { id },
    result: { status: 'anchored', range: { from, to }, method: 'exact', confidence: 'exact' },
    sidecarPath,
  };
}
function orphan(id: string, sidecarPath: string): MergeItem {
  return { annotation: { id }, result: { status: 'orphaned', reason: 'not found' }, sidecarPath };
}
function file(sidecarPath: string, ...resolved: MergeItem[]): PerFile<MergeItem> {
  return { sidecarPath, resolved };
}

describe('pickPrimary', () => {
  const cands = (xs: [string, number][]) => xs.map(([path, mtime]) => ({ path, mtime }));

  it('throws on an empty candidate list', () => {
    expect(() => pickPrimary([], 'canon.md')).toThrow();
  });

  it('prefers the sticky bound path when it is a candidate', () => {
    const c = cands([['a.md', 100], ['b.md', 200]]);
    expect(pickPrimary(c, 'b.md', 'a.md')).toBe('a.md');
  });

  it('ignores a bound path that is not among the candidates', () => {
    const c = cands([['a.md', 100], ['b.md', 200]]);
    expect(pickPrimary(c, 'b.md', 'gone.md')).toBe('b.md'); // falls to canonical
  });

  it('prefers the candidate at the canonical path next', () => {
    const c = cands([['a.md', 999], ['canon.md', 1]]);
    expect(pickPrimary(c, 'canon.md')).toBe('canon.md');
  });

  it('falls to the newest mtime when neither bound nor canonical match', () => {
    const c = cands([['a.md', 100], ['b.md', 300], ['c.md', 200]]);
    expect(pickPrimary(c, 'none.md')).toBe('b.md');
  });

  it('breaks an mtime tie lexicographically', () => {
    const c = cands([['b.md', 100], ['a.md', 100]]);
    expect(pickPrimary(c, 'none.md')).toBe('a.md');
  });
});

describe('mergeResolved', () => {
  it('returns just the primary when it is the only file', () => {
    const merged = mergeResolved([file('p.md', anchored('1', 'p.md', 0, 5))], 'p.md');
    expect(merged.map((r) => r.annotation.id)).toEqual(['1']);
  });

  it('unions non-overlapping marks from every file', () => {
    const merged = mergeResolved(
      [file('p.md', anchored('1', 'p.md', 0, 5)), file('q.md', anchored('2', 'q.md', 10, 15))],
      'p.md',
    );
    expect(merged.map((r) => r.annotation.id).sort()).toEqual(['1', '2']);
  });

  it('drops a non-primary duplicate that shares an id (wholesale copy)', () => {
    const merged = mergeResolved(
      [file('p.md', anchored('1', 'p.md', 0, 5)), file('q.md', anchored('1', 'q.md', 0, 5))],
      'p.md',
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].sidecarPath).toBe('p.md'); // the primary's copy wins
  });

  it('drops a non-primary mark overlapping a primary one (independent same passage)', () => {
    const merged = mergeResolved(
      [file('p.md', anchored('A', 'p.md', 0, 10)), file('q.md', anchored('B', 'q.md', 5, 12))],
      'p.md',
    );
    expect(merged.map((r) => r.annotation.id)).toEqual(['A']);
  });

  it('keeps a non-primary mark that merely abuts a primary one (half-open ranges)', () => {
    const merged = mergeResolved(
      [file('p.md', anchored('A', 'p.md', 0, 5)), file('q.md', anchored('B', 'q.md', 5, 10))],
      'p.md',
    );
    expect(merged.map((r) => r.annotation.id).sort()).toEqual(['A', 'B']);
  });

  it('never drops an orphaned non-primary mark for overlap (orphans have no range)', () => {
    const merged = mergeResolved(
      [file('p.md', anchored('A', 'p.md', 0, 10)), file('q.md', orphan('B', 'q.md'))],
      'p.md',
    );
    expect(merged.map((r) => r.annotation.id).sort()).toEqual(['A', 'B']);
  });

  it('is deterministic across non-primary files (walked in path order)', () => {
    // Two non-primary files both overlap the same gap; lower path wins the slot.
    const merged = mergeResolved(
      [file('z.md', anchored('Z', 'z.md', 0, 5)), file('a.md', anchored('A', 'a.md', 0, 5))],
      'p.md',
    );
    expect(merged.map((r) => r.annotation.id)).toEqual(['A']); // a.md processed first
  });
});
