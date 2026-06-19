/**
 * Unit tests for the pure highlight/decoration helpers, exercised against the
 * real `@codemirror/state` (+ `@codemirror/view` for `Decoration`). These cover
 * the spec→ranges logic and the active-id scan; the live CM6-in-Obsidian
 * behavior is out of scope for unit tests (Design.md note on CM6 testing).
 */

import { describe, expect, it } from 'vitest';

import { buildHighlightDecorations, type HighlightSpec } from './highlights';
import { activeIdsAt } from './reverse-nav';

/** Collect a DecorationSet into plain tuples for assertions. */
function collect(set: ReturnType<typeof buildHighlightDecorations>): {
  from: number;
  to: number;
  id: unknown;
  cls: unknown;
}[] {
  const out: { from: number; to: number; id: unknown; cls: unknown }[] = [];
  const cursor = set.iter();
  while (cursor.value) {
    out.push({
      from: cursor.from,
      to: cursor.to,
      id: cursor.value.spec?.attributes?.['data-anno-id'],
      cls: cursor.value.spec?.class,
    });
    cursor.next();
  }
  return out;
}

describe('buildHighlightDecorations', () => {
  it('sorts specs by `from` and carries id + color class', () => {
    const specs: HighlightSpec[] = [
      { id: 'b', from: 10, to: 15, color: 'green' },
      { id: 'a', from: 2, to: 5, color: 'blue' },
    ];
    const got = collect(buildHighlightDecorations(specs, 100));
    expect(got).toEqual([
      { from: 2, to: 5, id: 'a', cls: 'mrg-highlight mrg-color-blue' },
      { from: 10, to: 15, id: 'b', cls: 'mrg-highlight mrg-color-green' },
    ]);
  });

  it('defaults an unknown/missing color to yellow', () => {
    const got = collect(
      buildHighlightDecorations(
        [
          { id: 'x', from: 0, to: 3 },
          { id: 'y', from: 4, to: 6, color: 'chartreuse' },
        ],
        100,
      ),
    );
    expect(got.map((d) => d.cls)).toEqual([
      'mrg-highlight mrg-color-yellow',
      'mrg-highlight mrg-color-yellow',
    ]);
  });

  it('drops zero-length and inverted ranges (mark decorations cannot be empty)', () => {
    const got = collect(
      buildHighlightDecorations(
        [
          { id: 'empty', from: 5, to: 5 },
          { id: 'inverted', from: 9, to: 4 },
          { id: 'ok', from: 1, to: 3 },
        ],
        100,
      ),
    );
    expect(got.map((d) => d.id)).toEqual(['ok']);
  });

  it('clamps out-of-range specs to the document length', () => {
    const got = collect(buildHighlightDecorations([{ id: 'z', from: 8, to: 50 }], 10));
    expect(got).toEqual([
      { from: 8, to: 10, id: 'z', cls: 'mrg-highlight mrg-color-yellow' },
    ]);
  });
});

describe('activeIdsAt', () => {
  const set = buildHighlightDecorations(
    [
      { id: 'a', from: 2, to: 6 },
      { id: 'b', from: 10, to: 14 },
    ],
    100,
  );

  it('returns ids whose range contains the position', () => {
    expect(activeIdsAt(set, 4)).toEqual(['a']);
    expect(activeIdsAt(set, 12)).toEqual(['b']);
  });

  it('includes both the opening and closing edge', () => {
    expect(activeIdsAt(set, 2)).toEqual(['a']);
    expect(activeIdsAt(set, 6)).toEqual(['a']);
  });

  it('returns empty when outside every highlight', () => {
    expect(activeIdsAt(set, 0)).toEqual([]);
    expect(activeIdsAt(set, 8)).toEqual([]);
    expect(activeIdsAt(set, 20)).toEqual([]);
  });
});
