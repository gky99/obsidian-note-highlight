import { describe, it, expect } from 'vitest';

import { parseSidecar } from './parse';
import { sortHighlights } from './sort';

const FM = `---
annotation_schema: 1
annotates: "[[X]]"
---`;

/** Source-position lookup from a plain map; missing id → orphan (null). */
function pos(map: Record<string, number>): (id: string) => number | null {
  return (id) => (id in map ? map[id] : null);
}

/** Annotation content keyed by id, for asserting the sort never loses/alters data. */
function byId(text: string): Record<string, { quote: string; comment: string }> {
  const out: Record<string, { quote: string; comment: string }> = {};
  for (const a of parseSidecar(text).annotations) out[a.id] = { quote: a.quote, comment: a.comment };
  return out;
}

describe('sortHighlights', () => {
  it('orders highlights by source position and moves trailing text with the highlight', () => {
    const text = `${FM}

> second in source   ^anno-B

trailing note for B

> first in source   ^anno-A

\`\`\`anno
id: B
status: unique
\`\`\`

\`\`\`anno
id: A
status: unique
\`\`\`
`;
    const out = sortHighlights(text, pos({ A: 1, B: 2 }));
    // A now precedes B.
    expect(out.indexOf('> first in source')).toBeLessThan(out.indexOf('> second in source'));
    // B's trailing note travelled with B (still right after it, after A).
    expect(out.indexOf('trailing note for B')).toBeGreaterThan(out.indexOf('> second in source'));
    expect(out.indexOf('trailing note for B')).toBeLessThan(out.indexOf('```anno'));
    // No data lost.
    expect(byId(out)).toEqual(byId(text));
  });

  it('sorts only within a heading section, never across, and never moves a heading', () => {
    const text = `${FM}

## Background

> bg-late   ^anno-B2

> bg-early   ^anno-B1

## Results

> res-late   ^anno-R2

> res-early   ^anno-R1

\`\`\`anno
id: B2
status: unique
\`\`\`

\`\`\`anno
id: B1
status: unique
\`\`\`

\`\`\`anno
id: R2
status: unique
\`\`\`

\`\`\`anno
id: R1
status: unique
\`\`\`
`;
    const out = sortHighlights(text, pos({ B1: 1, B2: 2, R1: 3, R2: 4 }));
    // Within Background: early before late.
    expect(out.indexOf('> bg-early')).toBeLessThan(out.indexOf('> bg-late'));
    // Within Results: early before late.
    expect(out.indexOf('> res-early')).toBeLessThan(out.indexOf('> res-late'));
    // Headings keep their order and position; nothing crosses them.
    expect(out.indexOf('## Background')).toBeLessThan(out.indexOf('## Results'));
    expect(out.indexOf('> bg-late')).toBeLessThan(out.indexOf('## Results'));
    expect(out.indexOf('> res-early')).toBeGreaterThan(out.indexOf('## Results'));
  });

  it('treats every heading level as a divider (conservative nesting); direct-unders are not mixed with sub-section highlights', () => {
    const text = `${FM}

# Methods

> methods-direct   ^anno-A

## Setup

> setup-second   ^anno-B

> setup-first   ^anno-C

## Analysis

> analysis-only   ^anno-D

\`\`\`anno
id: A
status: unique
\`\`\`

\`\`\`anno
id: B
status: unique
\`\`\`

\`\`\`anno
id: C
status: unique
\`\`\`

\`\`\`anno
id: D
status: unique
\`\`\`
`;
    // A is 4th in source but sits directly under # Methods (its own group), so it must NOT
    // be pulled down among Setup's highlights despite C=1, B=2 being earlier.
    const out = sortHighlights(text, pos({ A: 4, B: 2, C: 1, D: 3 }));
    expect(out.indexOf('> setup-first')).toBeLessThan(out.indexOf('> setup-second')); // C before B
    expect(out.indexOf('> methods-direct')).toBeLessThan(out.indexOf('## Setup')); // A stays put
    expect(out.indexOf('## Setup')).toBeLessThan(out.indexOf('## Analysis')); // subheadings fixed
    expect(out.indexOf('> analysis-only')).toBeGreaterThan(out.indexOf('## Analysis'));
  });

  it('sinks orphans (no source position) to the end of their section, stably', () => {
    const text = `${FM}

> has-pos-late   ^anno-A

> orphan   ^anno-B

> has-pos-early   ^anno-C

\`\`\`anno
id: A
status: orphan
\`\`\`

\`\`\`anno
id: B
status: orphan
\`\`\`

\`\`\`anno
id: C
status: unique
\`\`\`
`;
    const out = sortHighlights(text, pos({ A: 2, C: 1 })); // B has no position
    // Positioned ones sort first (C, then A); the orphan B sinks to the end.
    expect(out.indexOf('> has-pos-early')).toBeLessThan(out.indexOf('> has-pos-late'));
    expect(out.indexOf('> orphan')).toBeGreaterThan(out.indexOf('> has-pos-late'));
  });

  it('keeps text between a heading and its first highlight attached to the heading', () => {
    const text = `${FM}

## Notes

intro text under the heading

> second   ^anno-B

> first   ^anno-A

\`\`\`anno
id: B
status: unique
\`\`\`

\`\`\`anno
id: A
status: unique
\`\`\`
`;
    const out = sortHighlights(text, pos({ A: 1, B: 2 }));
    // The intro stays right under the heading, above the (now first) highlight.
    expect(out.indexOf('intro text under the heading')).toBeGreaterThan(out.indexOf('## Notes'));
    expect(out.indexOf('intro text under the heading')).toBeLessThan(out.indexOf('> first'));
    expect(out.indexOf('> first')).toBeLessThan(out.indexOf('> second'));
  });

  it('is a byte-for-byte no-op when highlights are already in source order', () => {
    const text = `${FM}

> first   ^anno-A

> second   ^anno-B

\`\`\`anno
id: A
status: unique
\`\`\`

\`\`\`anno
id: B
status: unique
\`\`\`
`;
    expect(sortHighlights(text, pos({ A: 1, B: 2 }))).toBe(text);
  });
});
