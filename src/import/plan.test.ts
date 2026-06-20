import { describe, it, expect } from 'vitest';

import { planImport } from './plan';
import type { Mark } from './web-highlights';

const SOURCE = [
  '# The Article',
  '',
  'The quick **brown** fox jumps over the lazy dog.',
  '',
  'Another paragraph mentions the lazy dog again.',
].join('\n');

const opts = { defaultColor: 'yellow' };

describe('planImport', () => {
  it('locates a mark across inline markers and carries its color + comment', () => {
    const marks: Mark[] = [
      { text: 'brown fox', color: '#fdffb4', notes: '<p>nice</p>' },
    ];
    const plan = planImport(SOURCE, marks, [], opts);

    expect(plan.unmatched).toHaveLength(0);
    expect(plan.planned).toHaveLength(1);
    const p = plan.planned[0]!;
    expect(SOURCE.slice(p.range.from, p.range.to)).toContain('brown');
    expect(SOURCE.slice(p.range.from, p.range.to)).toContain('fox');
    expect(p.color).toBe('#fdffb4');
    expect(p.comment).toBe('nice');
  });

  it('falls back to the default color when a mark has none', () => {
    const plan = planImport(SOURCE, [{ text: 'brown fox' }], [], opts);
    expect(plan.planned[0]!.color).toBe('yellow');
  });

  it('reports marks whose text is not in the source as unmatched', () => {
    const plan = planImport(SOURCE, [{ text: 'a phrase not present' }], [], opts);
    expect(plan.planned).toHaveLength(0);
    expect(plan.unmatched).toHaveLength(1);
  });

  it('skips a mark whose range overlaps an existing annotation', () => {
    // Pre-occupy the span around "brown fox".
    const i = SOURCE.indexOf('brown');
    const existing = [{ from: i, to: i + 'brown fox'.length }];
    const plan = planImport(SOURCE, [{ text: 'brown fox' }], existing, opts);
    expect(plan.planned).toHaveLength(0);
    expect(plan.skipped).toBe(1);
  });

  it('first occurrence wins and the duplicate is skipped, not stacked', () => {
    // "the lazy dog" appears twice; two identical marks → one highlight.
    const marks: Mark[] = [{ text: 'the lazy dog' }, { text: 'the lazy dog' }];
    const plan = planImport(SOURCE, marks, [], opts);
    expect(plan.planned).toHaveLength(1);
    expect(plan.skipped).toBe(1);
    // It binds to the first occurrence.
    expect(plan.planned[0]!.range.from).toBe(SOURCE.indexOf('the lazy dog'));
  });

  it('returns planned highlights sorted by source position', () => {
    const marks: Mark[] = [
      { text: 'Another paragraph' },
      { text: 'brown fox' },
    ];
    const plan = planImport(SOURCE, marks, [], opts);
    expect(plan.planned).toHaveLength(2);
    expect(plan.planned[0]!.range.from).toBeLessThan(plan.planned[1]!.range.from);
  });

  it('ignores blank-text marks', () => {
    const plan = planImport(SOURCE, [{ text: '   ' }, { text: '' }], [], opts);
    expect(plan.planned).toHaveLength(0);
    expect(plan.unmatched).toHaveLength(0);
  });
});
