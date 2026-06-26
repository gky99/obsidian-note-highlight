import { describe, it, expect } from 'vitest';

import type { Sidecar } from '@/model/types';

import { parseSidecar, parseLayout } from './parse';
import { serializeSidecar } from './serialize';
import { patchSidecar } from './patch';

const FM = `---
annotation_schema: 1
annotates: "[[X]]"
---`;

/** Build a one-annotation sidecar with the given comment string. */
function withComment(comment: string): Sidecar {
  return {
    frontmatter: { annotation_schema: 1, annotates: '[[X]]' },
    annotations: [{ id: 'AAA', quote: 'q', record: { id: 'AAA', status: 'unique' }, comment }],
  };
}

describe('comment spacing on serialize (≤1 blank line before [/]:#)', () => {
  it('trims trailing newlines so exactly one blank line precedes the end mark', () => {
    const out = serializeSidecar(withComment('my note\n\n'));
    expect(out).toContain('my note\n\n[/]:#');
    expect(out).not.toContain('my note\n\n\n');
  });

  it('trims leading newlines so exactly one blank line follows the quote', () => {
    const out = serializeSidecar(withComment('\n\nmy note'));
    expect(out).toContain('^anno-AAA\n\nmy note');
    expect(out).not.toContain('^anno-AAA\n\n\nmy note');
  });

  it('keeps internal blank lines of a multi-paragraph comment', () => {
    const out = serializeSidecar(withComment('para one\n\npara two'));
    expect(out).toContain('para one\n\npara two\n\n[/]:#');
  });
});

describe('comment:true gates comment parsing', () => {
  it('parses the comment up to [/]:# when the flag is set', () => {
    const text = `${FM}

> q1   ^anno-AAA

my comment

[/]:#

\`\`\`anno
id: AAA
status: unique
comment: true
\`\`\`
`;
    const s = parseSidecar(text);
    expect(s.annotations[0].comment).toBe('my comment');
  });

  it('triggers the safeguard (next blockquote) only when the flag is set and the end mark is missing', () => {
    const text = `${FM}

> q1   ^anno-AAA

comment with no end mark

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
`;
    const s = parseSidecar(text);
    expect(s.annotations.find((a) => a.id === 'AAA')!.comment).toBe('comment with no end mark');
    // BBB has no flag → no comment.
    expect(s.annotations.find((a) => a.id === 'BBB')!.comment).toBe('');
  });

  it('does NOT absorb prose after a flag-less quote (it stays custom content)', () => {
    const text = `${FM}

> q1   ^anno-AAA

this prose is NOT a comment

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
    const s = parseSidecar(text);
    expect(s.annotations.find((a) => a.id === 'AAA')!.comment).toBe('');

    // In the layout, AAA's unit span is just the blockquote — the prose is outside it.
    const layout = parseLayout(text);
    const aaa = layout.units.find((u) => u.id === 'AAA')!;
    expect(layout.bodyLines.slice(aaa.unitStart, aaa.unitEnd).join('\n')).toBe('> q1   ^anno-AAA');

    // …so an in-place edit preserves the prose verbatim.
    const patched = patchSidecar(text, (sc) => {
      const a = sc.annotations.find((x) => x.id === 'AAA');
      if (a) a.record.color = '#fff';
    });
    expect(patched).toContain('this prose is NOT a comment');
  });

  it('round-trips a commented annotation: serialize writes the flag, parse reads it back', () => {
    const original = withComment('a real comment');
    const text = serializeSidecar(original);
    expect(text).toContain('comment: true');
    const reparsed = parseSidecar(text);
    expect(reparsed.annotations[0].comment).toBe('a real comment');
  });
});
