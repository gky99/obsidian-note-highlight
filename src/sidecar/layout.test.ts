import { describe, it, expect } from 'vitest';

import { parseLayout, type UnitLayout } from './parse';

/** The body slice for a unit's blockquote+comment region. */
function unitText(layout: ReturnType<typeof parseLayout>, u: UnitLayout): string {
  return layout.bodyLines.slice(u.unitStart, u.unitEnd).join('\n');
}
/** The body slice for a unit's `anno` fenced block. */
function annoText(layout: ReturnType<typeof parseLayout>, u: UnitLayout): string {
  return layout.bodyLines.slice(u.annoStart, u.annoEnd).join('\n');
}
function unit(layout: ReturnType<typeof parseLayout>, id: string): UnitLayout {
  const u = layout.units.find((x) => x.id === id);
  if (!u) throw new Error(`no unit ${id}`);
  return u;
}

const FM = `---
annotation_schema: 1
annotates: "[[X]]"
---`;

describe('parseLayout — spans', () => {
  it('captures unit and anno spans for a canonical two-unit file with comments', () => {
    const text = `${FM}

> q1   ^anno-AAA

comment one

[/]:#

> q2   ^anno-BBB

comment two

[/]:#

\`\`\`anno
id: AAA
status: unique
comment: true
\`\`\`

\`\`\`anno
id: BBB
status: unique
comment: true
\`\`\`
`;
    const layout = parseLayout(text);

    expect(layout.units.map((u) => u.id)).toEqual(['AAA', 'BBB']);

    // The unit region is the blockquote + comment prose + the [/]:# terminator.
    expect(unitText(layout, unit(layout, 'AAA'))).toBe(
      '> q1   ^anno-AAA\n\ncomment one\n\n[/]:#',
    );
    expect(unitText(layout, unit(layout, 'BBB'))).toBe(
      '> q2   ^anno-BBB\n\ncomment two\n\n[/]:#',
    );

    // The anno region is exactly the fenced block.
    expect(annoText(layout, unit(layout, 'AAA'))).toBe(
      '```anno\nid: AAA\nstatus: unique\ncomment: true\n```',
    );
    expect(annoText(layout, unit(layout, 'BBB'))).toBe(
      '```anno\nid: BBB\nstatus: unique\ncomment: true\n```',
    );

    // A new unit lands at the start of the (only, trailing) anno-block group.
    expect(layout.bodyLines[layout.newUnitAt]).toBe('```anno');
    // …and that group is the LAST thing: no blockquote unit at/after newUnitAt.
    expect(
      layout.bodyLines.slice(layout.newUnitAt).some((l) => /\^anno-/.test(l) && l.startsWith('>')),
    ).toBe(false);

    // A new anno block appends right after the last existing anno block; only
    // trailing blank lines (if any) follow it.
    expect(layout.bodyLines[layout.newAnnoAt - 1]).toBe('```');
    expect(layout.bodyLines.slice(layout.newAnnoAt).every((l) => l.trim() === '')).toBe(true);
  });

  it('inserts a new unit before the LAST anno-block group when groups are interleaved', () => {
    const text = `${FM}

> q1   ^anno-AAA

\`\`\`anno
id: AAA
status: unique
\`\`\`

> q2   ^anno-BBB

\`\`\`anno
id: BBB
status: unique
\`\`\`
`;
    const layout = parseLayout(text);

    // newUnitAt points at the BBB anno block (the last group), NOT the AAA group.
    const before = layout.bodyLines.slice(layout.newUnitAt).join('\n');
    expect(before.startsWith('```anno\nid: BBB')).toBe(true);
    // The AAA group is before the insertion point.
    expect(layout.bodyLines.slice(0, layout.newUnitAt).join('\n')).toContain('id: AAA');
    // New anno block still appends right after the last anno block.
    expect(layout.bodyLines[layout.newAnnoAt - 1]).toBe('```');
    expect(layout.bodyLines.slice(layout.newAnnoAt).every((l) => l.trim() === '')).toBe(true);
  });

  it('points newUnitAt at the LAST anno-block group even when every unit is above the first group', () => {
    // Mirrors a real file: all quotes at the top, then group 1, custom content, then group 2.
    const text = `${FM}

> q1   ^anno-AAA

> q2   ^anno-BBB

> q3   ^anno-CCC

> q4   ^anno-DDD

\`\`\`anno
id: AAA
status: unique
\`\`\`

\`\`\`anno
id: BBB
status: unique
\`\`\`

### Custom heading

> a plain blockquote with no ref

\`\`\`anno
id: CCC
status: unique
\`\`\`

\`\`\`anno
id: DDD
status: unique
\`\`\`
`;
    const layout = parseLayout(text);
    // The insertion point is the FIRST fence of the LAST group (CCC), not group 1 (AAA).
    expect(layout.bodyLines.slice(layout.newUnitAt).join('\n').startsWith('```anno\nid: CCC')).toBe(
      true,
    );
    // Group 1 stays above the insertion point.
    const above = layout.bodyLines.slice(0, layout.newUnitAt).join('\n');
    expect(above).toContain('id: AAA');
    expect(above).toContain('id: BBB');
    expect(above).toContain('### Custom heading');
  });

  it('excludes the trailing blank for a comment-less unit followed by another unit', () => {
    const text = `${FM}

> q1   ^anno-AAA

> q2   ^anno-BBB

\`\`\`anno
id: AAA
status: unique
\`\`\`

\`\`\`anno
id: BBB
status: unique
\`\`\`
`;
    const layout = parseLayout(text);
    // q1 has no comment: its region is just the blockquote line, not the blank after it.
    expect(unitText(layout, unit(layout, 'AAA'))).toBe('> q1   ^anno-AAA');
    expect(unitText(layout, unit(layout, 'BBB'))).toBe('> q2   ^anno-BBB');
  });

  it('keeps custom content (top, between, bottom) outside every span', () => {
    const text = `${FM}

# My reading notes

Intro paragraph I wrote by hand.

> q1   ^anno-AAA

comment one

[/]:#

## A divider section

> q2   ^anno-BBB

\`\`\`anno
id: AAA
status: unique
comment: true
\`\`\`

\`\`\`anno
id: BBB
status: unique
\`\`\`

## Bottom summary

Closing thoughts.
`;
    const layout = parseLayout(text);
    const inAnySpan = (lineIdx: number): boolean =>
      layout.units.some(
        (u) =>
          (lineIdx >= u.unitStart && lineIdx < u.unitEnd) ||
          (lineIdx >= u.annoStart && lineIdx < u.annoEnd),
      );

    const customMarkers = ['# My reading notes', 'Intro paragraph I wrote by hand.', '## A divider section', '## Bottom summary', 'Closing thoughts.'];
    for (const marker of customMarkers) {
      const idx = layout.bodyLines.indexOf(marker);
      expect(idx, `"${marker}" present`).toBeGreaterThanOrEqual(0);
      expect(inAnySpan(idx), `"${marker}" outside spans`).toBe(false);
    }
  });
});
