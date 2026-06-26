import { describe, it, expect } from 'vitest';

import type { ResolvedAnnotation } from '@/store/store';

import { annotationsSignature, sortByPosition } from './aside-signature';

/** Build a resolved annotation fixture (anchored at `from`, or orphaned when null). */
function res(
  id: string,
  opts: { from?: number | null; color?: string; comment?: string; sidecar?: string } = {},
): ResolvedAnnotation {
  const { from = 0, color = 'yellow', comment = '', sidecar = 'A.annotations.md' } = opts;
  return {
    annotation: { id, quote: `q-${id}`, record: { id, status: 'unique', color }, comment },
    result:
      from === null
        ? { status: 'orphaned', reason: 'x' }
        : { status: 'anchored', range: { from, to: from + 5 }, method: 'exact', confidence: 'unique' },
    sidecarPath: sidecar,
  };
}

describe('annotationsSignature', () => {
  it('is identical for the same displayed data', () => {
    const a = [res('a', { from: 10 }), res('b', { from: 20 })];
    const b = [res('a', { from: 10 }), res('b', { from: 20 })];
    expect(annotationsSignature(a)).toBe(annotationsSignature(b));
  });

  it('is order-independent in input but reflects document order', () => {
    // Same set, different array order, same positions → same signature (sorted by position).
    const a = [res('a', { from: 10 }), res('b', { from: 20 })];
    const b = [res('b', { from: 20 }), res('a', { from: 10 })];
    expect(annotationsSignature(a)).toBe(annotationsSignature(b));
  });

  it('changes when a color changes', () => {
    const a = [res('a', { from: 10, color: 'yellow' })];
    const b = [res('a', { from: 10, color: '#ff0000' })];
    expect(annotationsSignature(a)).not.toBe(annotationsSignature(b));
  });

  it('changes when a comment changes', () => {
    const a = [res('a', { from: 10, comment: '' })];
    const b = [res('a', { from: 10, comment: 'note' })];
    expect(annotationsSignature(a)).not.toBe(annotationsSignature(b));
  });

  it('changes when document order changes (positions swap)', () => {
    const a = [res('a', { from: 10 }), res('b', { from: 20 })];
    const b = [res('a', { from: 30 }), res('b', { from: 20 })]; // a now after b
    expect(annotationsSignature(a)).not.toBe(annotationsSignature(b));
  });

  it('changes when an annotation orphans', () => {
    const a = [res('a', { from: 10 })];
    const b = [res('a', { from: null })];
    expect(annotationsSignature(a)).not.toBe(annotationsSignature(b));
  });

  it('changes when the count changes (add/delete)', () => {
    const a = [res('a', { from: 10 })];
    const b = [res('a', { from: 10 }), res('b', { from: 20 })];
    expect(annotationsSignature(a)).not.toBe(annotationsSignature(b));
  });

  it('sortByPosition puts orphans last, stably', () => {
    const sorted = sortByPosition([res('a', { from: 30 }), res('o', { from: null }), res('b', { from: 10 })]);
    expect(sorted.map((r) => r.annotation.id)).toEqual(['b', 'a', 'o']);
  });
});
