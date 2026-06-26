import { describe, it, expect } from 'vitest';

import type { Annotation, Sidecar } from '@/model/types';

import { parseSidecar } from './parse';
import { patchSidecar } from './patch';

/** Minimal well-formed annotation for mutations under test. */
function newAnno(id: string, quote: string, comment = ''): Annotation {
  return { id, quote, record: { id, status: 'unique', color: 'yellow' }, comment };
}

/** Compare two sidecars by annotation *content keyed by id* (order-independent) + frontmatter. */
function expectSemanticEq(patched: string, expected: Sidecar): void {
  const got = parseSidecar(patched);
  const byId = (s: Sidecar): Record<string, Annotation> =>
    Object.fromEntries(s.annotations.map((a) => [a.id, a]));
  expect(byId(got)).toEqual(byId(expected));
  expect(got.frontmatter).toEqual(expected.frontmatter);
}

/** Apply a mutation to a freshly-parsed model — the reference the patch must match. */
function expectedModel(input: string, mutate: (s: Sidecar) => void): Sidecar {
  const m = parseSidecar(input);
  mutate(m);
  return m;
}

const FM = `---
annotation_schema: 1
annotates: "[[X]]"
---`;

const SIMPLE = `${FM}

> existing quote   ^anno-AAA

\`\`\`anno
id: AAA
status: unique
color: yellow
\`\`\`
`;

const RICH = `${FM}

# My reading notes

Intro I wrote by hand.

> first quote   ^anno-AAA

a comment on the first

[/]:#

> second quote   ^anno-BBB

\`\`\`anno
id: AAA
status: unique
color: yellow
comment: true
\`\`\`

\`\`\`anno
id: BBB
status: unique
color: yellow
\`\`\`

## Bottom summary

closing thoughts
`;

describe('patchSidecar', () => {
  it('is a byte-for-byte no-op when nothing changes', () => {
    expect(patchSidecar(SIMPLE, () => {})).toBe(SIMPLE);
    expect(patchSidecar(RICH, () => {})).toBe(RICH);
  });

  it('adds a new unit before the anno group and a new anno block at the end (golden)', () => {
    const out = patchSidecar(SIMPLE, (s) => {
      s.annotations.push(newAnno('BBB', 'new quote'));
    });
    expect(out).toBe(`${FM}

> existing quote   ^anno-AAA

> new quote   ^anno-BBB

\`\`\`anno
id: AAA
status: unique
color: yellow
\`\`\`

\`\`\`anno
id: BBB
status: unique
color: yellow
\`\`\`
`);
  });

  it('preserves custom content (top, between, bottom) when adding a highlight', () => {
    const out = patchSidecar(RICH, (s) => {
      s.annotations.push(newAnno('CCC', 'third quote'));
    });
    expect(out).toContain('# My reading notes');
    expect(out).toContain('Intro I wrote by hand.');
    expect(out).toContain('## Bottom summary');
    expect(out).toContain('closing thoughts');
    // New unit lands before the anno-block group …
    expect(out.indexOf('> third quote')).toBeGreaterThan(out.indexOf('> second quote'));
    expect(out.indexOf('> third quote')).toBeLessThan(out.indexOf('```anno'));
    // … new anno block sits after the last existing anno, above the bottom summary.
    expect(out.indexOf('id: CCC')).toBeGreaterThan(out.indexOf('id: BBB'));
    expect(out.indexOf('id: CCC')).toBeLessThan(out.indexOf('## Bottom summary'));
    expectSemanticEq(out, expectedModel(RICH, (s) => s.annotations.push(newAnno('CCC', 'third quote'))));
  });

  it('inserts a new unit before the LAST anno-block group, not the first', () => {
    const multigroup = `${FM}

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
    const out = patchSidecar(multigroup, (s) => s.annotations.push(newAnno('EEE', 'new quote')));
    // The new quote lands before the LAST group (CCC/DDD), after the custom content,
    // and after group 1 (AAA/BBB) — never before the first group.
    expect(out.indexOf('> new quote')).toBeGreaterThan(out.indexOf('id: BBB'));
    expect(out.indexOf('> new quote')).toBeGreaterThan(out.indexOf('### Custom heading'));
    expect(out.indexOf('> new quote')).toBeLessThan(out.indexOf('id: CCC'));
  });

  it('updates only the changed unit when a comment changes; rest verbatim', () => {
    const mutate = (s: Sidecar): void => {
      const a = s.annotations.find((x) => x.id === 'AAA');
      if (a) a.comment = 'edited comment text';
    };
    const out = patchSidecar(RICH, mutate);
    expect(out).toContain('edited comment text');
    expect(out).not.toContain('a comment on the first');
    // The unrelated second unit and the bottom summary are untouched.
    expect(out).toContain('> second quote   ^anno-BBB');
    expect(out).toContain('## Bottom summary');
    expectSemanticEq(out, expectedModel(RICH, mutate));
  });

  it('updates only the anno block when only the color changes; the unit text is byte-identical', () => {
    const mutate = (s: Sidecar): void => {
      const a = s.annotations.find((x) => x.id === 'AAA');
      if (a) a.record.color = '#ffffff';
    };
    const out = patchSidecar(SIMPLE, mutate);
    // Everything up to the first anno block (frontmatter + the quote) is unchanged.
    expect(out.slice(0, out.indexOf('```anno'))).toBe(SIMPLE.slice(0, SIMPLE.indexOf('```anno')));
    expect(out).toContain("color: '#ffffff'");
    expectSemanticEq(out, expectedModel(SIMPLE, mutate));
  });

  it('removes a deleted annotation’s unit and anno block, leaving neighbors intact', () => {
    const mutate = (s: Sidecar): void => {
      s.annotations = s.annotations.filter((a) => a.id !== 'AAA');
    };
    const out = patchSidecar(RICH, mutate);
    expect(out).not.toContain('first quote');
    expect(out).not.toContain('a comment on the first');
    expect(out).not.toContain('[/]:#'); // AAA's terminator went with it (BBB had no comment)
    expect(out).not.toContain('id: AAA');
    // Neighbors + custom content survive.
    expect(out).toContain('> second quote   ^anno-BBB');
    expect(out).toContain('# My reading notes');
    expect(out).toContain('## Bottom summary');
    expectSemanticEq(out, expectedModel(RICH, mutate));
  });

  it('rewrites a unit and its anno block in place on a self-heal repair', () => {
    const mutate = (s: Sidecar): void => {
      const a = s.annotations.find((x) => x.id === 'BBB');
      if (a) {
        a.quote = 'second quote repaired';
        a.record.qhash = 'deadbeef';
        a.record.before = 'ctx';
      }
    };
    const out = patchSidecar(RICH, mutate);
    expect(out).toContain('> second quote repaired   ^anno-BBB');
    expect(out).not.toContain('> second quote   ^anno-BBB');
    expect(out).toContain('qhash: deadbeef');
    // Position preserved: BBB's anno block still follows AAA's.
    expect(out.indexOf('id: BBB')).toBeGreaterThan(out.indexOf('id: AAA'));
    expectSemanticEq(out, expectedModel(RICH, mutate));
  });

  it('re-emits the frontmatter block when a frontmatter field changes; body untouched', () => {
    const mutate = (s: Sidecar): void => {
      s.frontmatter.source_hash = 'sha1:changed';
    };
    const out = patchSidecar(SIMPLE, mutate);
    expect(out).toContain('source_hash: sha1:changed');
    // The body (everything after the frontmatter) is byte-identical.
    const body = (t: string): string => t.slice(t.indexOf('---', 3) + 3);
    expect(body(out)).toBe(body(SIMPLE));
    expectSemanticEq(out, expectedModel(SIMPLE, mutate));
  });

  it('appends the first annotation to a sidecar that has none', () => {
    const empty = `${FM}\n`;
    const out = patchSidecar(empty, (s) => s.annotations.push(newAnno('AAA', 'only quote')));
    expect(out).toContain('> only quote   ^anno-AAA');
    expect(out).toContain('id: AAA');
    expect(out.indexOf('> only quote')).toBeLessThan(out.indexOf('```anno'));
    expectSemanticEq(out, expectedModel(empty, (s) => s.annotations.push(newAnno('AAA', 'only quote'))));
  });

  it('refuses (throws) on a malformed unit, never clobbering', () => {
    const malformed = `${FM}

> dangling quote   ^anno-ZZZ
`;
    // ZZZ has no matching anno block → strict parse throws.
    expect(() => patchSidecar(malformed, () => {})).toThrow();
  });
});
