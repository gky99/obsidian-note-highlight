import { describe, it, expect } from 'vitest';

import type { Sidecar } from '@/model/types';
import { SCHEMA_VERSION } from '@/model/types';

import { parseSidecar, type ParseIssue } from './parse';
import { serializeSidecar } from './serialize';
import { SidecarParseError, SidecarSchemaError } from './errors';

/**
 * The §5.2 worked example, verbatim (minus the outer 4-backtick display fence
 * that only exists to render the inner block in the doc). Comments are closed by
 * the invisible `[/]:#` terminator and the anno blocks note `comment: true`.
 */
const EXAMPLE_52 = `---
schema: webclip-annotations/1
annotates: "Clips/The Article.md"
source_url: "https://example.com/the-article"
clipped: 2026-06-19
source_hash: "sha1:ab12cd34ef…"
---

> the sentence I care about   ^anno-01J8X2

My note about why this matters — ordinary prose, [[wikilinks]], #tags,
multiple paragraphs, whatever.

[/]:#

> ## A quoted heading
> followed by text with **strong** emphasis   ^anno-01J8X9

This reference spans a heading and the paragraph under it — see §6.4.

[/]:#

\`\`\`anno
id: 01J8X2
pin: "^h1"
heading: "Intro › Background"
before: "…the words just before "
after: " the words right after…"
qhash: "3f9a"
status: exact
color: yellow
created: 2026-06-19T10:32:00Z
comment: true
\`\`\`

\`\`\`anno
id: 01J8X9
pin: "^h4"
heading: "Methods"
before: "…preceding sentence. "
after: " The following sentence…"
qhash: "b1c2"
status: orphan
color: green
created: 2026-06-19T11:05:00Z
comment: true
\`\`\`
`;

describe('parseSidecar — §5.2 worked example', () => {
  const sidecar = parseSidecar(EXAMPLE_52);

  it('parses the frontmatter', () => {
    expect(sidecar.frontmatter).toEqual({
      schema: SCHEMA_VERSION,
      annotates: 'Clips/The Article.md',
      source_url: 'https://example.com/the-article',
      clipped: '2026-06-19',
      source_hash: 'sha1:ab12cd34ef…',
    });
  });

  it('parses two annotation units in order', () => {
    expect(sidecar.annotations).toHaveLength(2);
    expect(sidecar.annotations.map((a) => a.id)).toEqual(['01J8X2', '01J8X9']);
  });

  it('extracts the first (single-line, anchored) unit', () => {
    const a = sidecar.annotations[0];
    expect(a.quote).toBe('the sentence I care about');
    expect(a.record).toEqual({
      id: '01J8X2',
      pin: '^h1',
      heading: 'Intro › Background',
      before: '…the words just before ',
      after: ' the words right after…',
      qhash: '3f9a',
      status: 'exact',
      color: 'yellow',
      created: '2026-06-19T10:32:00Z',
    });
    expect(a.comment).toBe(
      'My note about why this matters — ordinary prose, [[wikilinks]], #tags,\nmultiple paragraphs, whatever.',
    );
  });

  it('extracts the second (multi-line quoted-heading, orphaned) unit', () => {
    const a = sidecar.annotations[1];
    // Markdown markers (`##`, `**`) are preserved verbatim (§6.4).
    expect(a.quote).toBe('## A quoted heading\nfollowed by text with **strong** emphasis');
    expect(a.record.status).toBe('orphan');
    expect(a.record.color).toBe('green');
    expect(a.comment).toBe(
      'This reference spans a heading and the paragraph under it — see §6.4.',
    );
  });

  it('round-trips (parse → serialize → parse is stable)', () => {
    const reparsed = parseSidecar(serializeSidecar(sidecar));
    expect(reparsed).toEqual(sidecar);
  });

  it('serializes to a shape that re-parses identically and is idempotent', () => {
    const once = serializeSidecar(sidecar);
    const twice = serializeSidecar(parseSidecar(once));
    expect(twice).toBe(once);
  });
});

/** Build a minimal valid sidecar around a list of units, for focused tests. */
function makeSidecar(annotations: Sidecar['annotations']): Sidecar {
  return {
    frontmatter: { schema: SCHEMA_VERSION, annotates: 'Clips/Note.md' },
    annotations,
  };
}

describe('round-trip safety', () => {
  function roundTrips(s: Sidecar): void {
    const out = serializeSidecar(s);
    expect(parseSidecar(out)).toEqual(s);
    // Serialization is a fixed point after the first normalization pass.
    expect(serializeSidecar(parseSidecar(out))).toBe(out);
  }

  it('handles a multi-line blockquote with ## and ** markers', () => {
    roundTrips(
      makeSidecar([
        {
          id: 'AA',
          quote: '## Heading line\nbody with **bold** and *italic*\nthird line',
          record: { id: 'AA', status: 'exact' },
          comment: 'a comment',
        },
      ]),
    );
  });

  it('preserves unknown frontmatter and unknown anno keys', () => {
    roundTrips({
      frontmatter: {
        schema: SCHEMA_VERSION,
        annotates: 'Clips/Note.md',
        source_url: 'https://x.test',
        custom_top: 'kept',
        nested: { a: 1, b: ['x', 'y'] },
      },
      annotations: [
        {
          id: 'BB',
          quote: 'quote',
          record: {
            id: 'BB',
            status: 'exact',
            color: 'pink',
            // Unknown forward-compatible keys must survive (index signature).
            weight: 3,
            tags: ['one', 'two'],
          },
          comment: 'note',
        },
      ],
    });
  });

  it('handles an empty comment', () => {
    const s = makeSidecar([
      { id: 'CC', quote: 'no comment here', record: { id: 'CC', status: 'orphan' }, comment: '' },
    ]);
    roundTrips(s);
    expect(parseSidecar(serializeSidecar(s)).annotations[0].comment).toBe('');
  });

  it('handles a sidecar with zero annotations', () => {
    roundTrips(makeSidecar([]));
  });

  it('handles multiple units in sequence', () => {
    roundTrips(
      makeSidecar([
        { id: 'A1', quote: 'first', record: { id: 'A1', status: 'exact' }, comment: 'c1' },
        { id: 'A2', quote: 'second', record: { id: 'A2', status: 'orphan' }, comment: 'c2' },
        { id: 'A3', quote: 'third', record: { id: 'A3', status: 'exact' }, comment: '' },
      ]),
    );
  });

  it('preserves context strings with em-dashes, quotes, and -- runs (no wrapping)', () => {
    roundTrips(
      makeSidecar([
        {
          id: 'DD',
          quote: 'q',
          record: {
            id: 'DD',
            status: 'exact',
            before:
              'a very long lead-in context string that would normally be wrapped by YAML — with an em-dash, "double quotes", and -- a double hyphen --> arrow-ish run, kept verbatim',
            after: ' …trailing context with more than eighty characters so we exercise the lineWidth:-1 guard fully…',
          },
          comment: 'c',
        },
      ]),
    );
  });
});

describe('comment delimiting (§5.1 terminator + safeguards)', () => {
  it('keeps a thematic rule and a list inside a comment, ending at [/]:#', () => {
    const text = `---
schema: webclip-annotations/1
annotates: "Clips/Note.md"
---

> the quote   ^anno-XYZ

A comment with a thematic rule:

---

and a list:

- one
- two

[/]:#

\`\`\`anno
id: XYZ
status: exact
comment: true
\`\`\`
`;
    const sidecar = parseSidecar(text);
    expect(sidecar.annotations).toHaveLength(1);
    const a = sidecar.annotations[0];
    expect(a.quote).toBe('the quote');
    // A bare --- is ordinary comment content now (the terminator is [/]:#).
    expect(a.comment).toContain('---');
    expect(a.comment).toContain('- one');
    expect(a.comment.endsWith('- two')).toBe(true);
    // The [/]:# sentinel itself is consumed, never part of the comment.
    expect(a.comment).not.toContain('[/]:#');
  });

  it('ends a comment at the next unit blockquote even without a [/]:# terminator', () => {
    const text = `---
schema: webclip-annotations/1
annotates: "Clips/Note.md"
---

> first   ^anno-A

comment for A

> second   ^anno-B

\`\`\`anno
id: A
status: exact
comment: true
\`\`\`

\`\`\`anno
id: B
status: exact
\`\`\`
`;
    const annotations = parseSidecar(text).annotations;
    expect(annotations.map((x) => x.id)).toEqual(['A', 'B']);
    // The blockquote safeguard stops A's comment; it never eats unit B.
    expect(annotations[0].comment).toBe('comment for A');
    expect(annotations[1].comment).toBe('');
  });

  it('ends a comment at a fenced code block (safeguard)', () => {
    const text = `---
schema: webclip-annotations/1
annotates: "Clips/Note.md"
---

> q   ^anno-A

comment before code

\`\`\`js
not part of the comment
\`\`\`

[/]:#

\`\`\`anno
id: A
status: exact
comment: true
\`\`\`
`;
    const a = parseSidecar(text).annotations[0];
    expect(a.comment).toBe('comment before code');
  });

  it('binds a multi-line quote to its anno block by id', () => {
    const text = `---
schema: webclip-annotations/1
annotates: "Clips/Note.md"
---

> line one
> line two   ^anno-Q1

\`\`\`anno
id: Q1
status: exact
\`\`\`
`;
    const a = parseSidecar(text).annotations[0];
    expect(a.quote).toBe('line one\nline two');
    expect(a.id).toBe('Q1');
  });
});

describe('anno block placement (id binding, not position)', () => {
  it('binds quotes to anno blocks collected at the end of the file, in any order', () => {
    const text = `---
schema: webclip-annotations/1
annotates: "Clips/Note.md"
---

> quote A   ^anno-AA

note A

[/]:#

> quote B   ^anno-BB

\`\`\`anno
id: BB
status: exact
\`\`\`

\`\`\`anno
id: AA
status: exact
comment: true
\`\`\`
`;
    // AA's anno block is placed AFTER BB's — order is irrelevant; the ref binds.
    const s = parseSidecar(text);
    expect(s.annotations.map((a) => a.id)).toEqual(['AA', 'BB']);
    expect(s.annotations[0].quote).toBe('quote A');
    expect(s.annotations[0].comment).toBe('note A');
    expect(s.annotations[1].quote).toBe('quote B');
    expect(s.annotations[1].comment).toBe('');
  });

  it('serializes every anno block to the end of the file, after the quotes', () => {
    const out = serializeSidecar(
      makeSidecar([
        { id: 'AA', quote: 'qa', record: { id: 'AA', status: 'exact' }, comment: 'ca' },
        { id: 'BB', quote: 'qb', record: { id: 'BB', status: 'exact' }, comment: '' },
      ]),
    );
    // Both quotes precede the first anno block in the serialized output.
    const firstAnno = out.indexOf('```anno');
    expect(out.indexOf('^anno-AA')).toBeLessThan(firstAnno);
    expect(out.indexOf('^anno-BB')).toBeLessThan(firstAnno);
  });
});

describe('comment presence flag + terminator (serialize)', () => {
  it('emits comment: true and the [/]:# terminator only when a comment exists', () => {
    const withComment = makeSidecar([
      { id: 'WC', quote: 'q', record: { id: 'WC', status: 'exact' }, comment: 'hello note' },
    ]);
    const out = serializeSidecar(withComment);
    expect(out).toContain('comment: true');
    expect(out).toMatch(/hello note\n\n\[\/\]:#/);
    expect(parseSidecar(out)).toEqual(withComment);

    const noComment = makeSidecar([
      { id: 'NC', quote: 'q', record: { id: 'NC', status: 'exact' }, comment: '' },
    ]);
    const out2 = serializeSidecar(noComment);
    expect(out2).not.toContain('comment: true');
    expect(out2).not.toContain('[/]:#');
    expect(parseSidecar(out2)).toEqual(noComment);
  });

  it('strips the derived comment flag from the parsed record', () => {
    const text = `---
schema: webclip-annotations/1
annotates: "Clips/Note.md"
---

> q   ^anno-F

a note

[/]:#

\`\`\`anno
id: F
status: exact
comment: true
\`\`\`
`;
    const a = parseSidecar(text).annotations[0];
    expect('comment' in a.record).toBe(false);
    expect(a.comment).toBe('a note');
  });
});

describe('quote / ref extraction', () => {
  it('parses the id from the ^anno-<id> ref and trims its whitespace', () => {
    const a = parseSidecar(`---
schema: webclip-annotations/1
annotates: "Clips/Note.md"
---

> just the quote text   ^anno-Z9

\`\`\`anno
id: Z9
status: exact
\`\`\`

c
`).annotations[0];
    expect(a.quote).toBe('just the quote text');
  });

  it('drops a quote whose ref matches no anno block, reporting it', () => {
    // The `^anno-<id>` ref is now the binding key: a quote whose ref points at no
    // anno block is an incomplete unit (skipped + reported, never mis-bound).
    const text = `---
schema: webclip-annotations/1
annotates: "Clips/Note.md"
---

> some quote   ^anno-NOPE

\`\`\`anno
id: OTHER
status: exact
\`\`\`
`;
    const issues: ParseIssue[] = [];
    const s = parseSidecar(text, (i) => issues.push(i));
    expect(s.annotations).toHaveLength(0);
    expect(issues.some((x) => x.message.includes('NOPE'))).toBe(true);
  });

  it('handles a blockquote with a blank quoted line (bare >)', () => {
    const s = makeSidecar([
      {
        id: 'BLANK',
        quote: 'first paragraph\n\nsecond paragraph',
        record: { id: 'BLANK', status: 'exact' },
        comment: '',
      },
    ]);
    const out = serializeSidecar(s);
    expect(parseSidecar(out)).toEqual(s);
  });
});

describe('fence collision (§4.4 / §10 #10)', () => {
  it('uses a longer fence when anno content contains a 3-backtick run', () => {
    const s = makeSidecar([
      {
        id: 'FENCE',
        quote: 'q',
        record: {
          id: 'FENCE',
          status: 'exact',
          // A context string literally containing a code fence.
          before: 'preceding text with ``` a triple backtick run in it',
        },
        comment: 'c',
      },
    ]);
    const out = serializeSidecar(s);
    // Opening fence must be at least 4 backticks (longer than the 3-run inside).
    expect(out).toMatch(/\n````+anno\n/);
    // And it must still round-trip.
    expect(parseSidecar(out)).toEqual(s);
  });

  it('escalates further when content has a 5-backtick run', () => {
    const s = makeSidecar([
      {
        id: 'FENCE2',
        quote: 'q',
        record: {
          id: 'FENCE2',
          status: 'exact',
          before: 'edge ````` five backticks ````` here',
        },
        comment: '',
      },
    ]);
    const out = serializeSidecar(s);
    expect(out).toMatch(/\n``````anno\n/); // 6 backticks
    expect(parseSidecar(out)).toEqual(s);
  });

  it('never escapes the verbatim content', () => {
    const s = makeSidecar([
      {
        id: 'VERB',
        quote: 'q',
        record: { id: 'VERB', status: 'exact', after: 'has ``` ticks' },
        comment: '',
      },
    ]);
    const out = serializeSidecar(s);
    expect(out).toContain('has ``` ticks');
    expect(parseSidecar(out)).toEqual(s);
  });
});

describe('schema gate (§5.3)', () => {
  it('throws SidecarSchemaError when schema is missing', () => {
    const text = `---
annotates: "Clips/Note.md"
---

> q   ^anno-X

\`\`\`anno
id: X
status: exact
\`\`\`

c
`;
    expect(() => parseSidecar(text)).toThrow(SidecarSchemaError);
    try {
      parseSidecar(text);
    } catch (err) {
      expect(err).toBeInstanceOf(SidecarSchemaError);
      expect((err as SidecarSchemaError).found).toBeUndefined();
      expect((err as SidecarSchemaError).expected).toBe(SCHEMA_VERSION);
    }
  });

  it('throws SidecarSchemaError when schema is an unsupported version', () => {
    const text = `---
schema: webclip-annotations/2
annotates: "Clips/Note.md"
---

> q   ^anno-X

\`\`\`anno
id: X
status: exact
\`\`\`

c
`;
    expect(() => parseSidecar(text)).toThrow(SidecarSchemaError);
    try {
      parseSidecar(text);
    } catch (err) {
      expect((err as SidecarSchemaError).found).toBe('webclip-annotations/2');
    }
  });
});

describe('status migration (§6.5)', () => {
  const withStatus = (status: string) =>
    `---\nschema: webclip-annotations/1\nannotates: "Clips/Note.md"\n---\n\n` +
    `> hello world ^anno-X\n\n\`\`\`anno\nid: X\nstatus: ${status}\n\`\`\`\n`;

  it('migrates the legacy two-value enum on read', () => {
    expect(parseSidecar(withStatus('anchored')).annotations[0].record.status).toBe('exact');
    expect(parseSidecar(withStatus('orphaned')).annotations[0].record.status).toBe('orphan');
  });

  it('preserves the new confidence enum verbatim', () => {
    for (const s of ['unique', 'exact', 'orphan'] as const) {
      expect(parseSidecar(withStatus(s)).annotations[0].record.status).toBe(s);
    }
  });

  it('rewrites a legacy value to the new enum on serialize (round-trip migration)', () => {
    const out = serializeSidecar(parseSidecar(withStatus('anchored')));
    expect(out).toMatch(/status: exact/);
    expect(out).not.toMatch(/status: anchored/);
  });

  it('never silently promotes a legacy value to "unique" (no evidence)', () => {
    expect(parseSidecar(withStatus('anchored')).annotations[0].record.status).not.toBe('unique');
  });

  it('throws on an unrecognized status', () => {
    expect(() => parseSidecar(withStatus('bogus'))).toThrow(SidecarParseError);
  });
});

describe('malformed input', () => {
  it('throws SidecarParseError when there is no frontmatter', () => {
    expect(() => parseSidecar('> q   ^anno-X\n\n```anno\nid: X\nstatus: exact\n```\n')).toThrow(
      SidecarParseError,
    );
  });

  it('throws SidecarParseError on unterminated frontmatter', () => {
    expect(() => parseSidecar('---\nschema: webclip-annotations/1\n')).toThrow(SidecarParseError);
  });

  it('ignores a dangling anno block with no matching quote (dead data)', () => {
    const text = `---
schema: webclip-annotations/1
annotates: "Clips/Note.md"
---

just prose, no blockquote

\`\`\`anno
id: ORPHANBLOCK
status: exact
\`\`\`
`;
    // No quote references ORPHANBLOCK, so the record is dead data: dropped silently
    // (no throw, no issue) — the serializer never reproduces it.
    const issues: ParseIssue[] = [];
    const s = parseSidecar(text, (i) => issues.push(i));
    expect(s.annotations).toHaveLength(0);
    expect(issues).toHaveLength(0);
  });

  it('throws SidecarParseError on an unterminated anno block', () => {
    const text = `---
schema: webclip-annotations/1
annotates: "Clips/Note.md"
---

> q   ^anno-X

\`\`\`anno
id: X
status: exact
`;
    expect(() => parseSidecar(text)).toThrow(SidecarParseError);
  });

  it('throws SidecarParseError on an invalid status', () => {
    const text = `---
schema: webclip-annotations/1
annotates: "Clips/Note.md"
---

> q   ^anno-X

\`\`\`anno
id: X
status: bogus
\`\`\`

c
`;
    expect(() => parseSidecar(text)).toThrow(SidecarParseError);
  });
});

describe('CRLF and BOM tolerance', () => {
  it('parses a file with CRLF line endings and a leading BOM', () => {
    const crlf = ('﻿' + EXAMPLE_52).replace(/\n/g, '\r\n');
    const sidecar = parseSidecar(crlf);
    expect(sidecar.annotations).toHaveLength(2);
    expect(sidecar.annotations[0].quote).toBe('the sentence I care about');
  });
});

describe('fault isolation (tolerant parse)', () => {
  it('skips a malformed unit and keeps the good ones, reporting issues', () => {
    const text = `---
schema: webclip-annotations/1
annotates: "Clips/Note.md"
---

> good one   ^anno-G1

\`\`\`anno
id: G1
status: exact
\`\`\`

> bad status   ^anno-B1

\`\`\`anno
id: B1
status: bogus
\`\`\`

> good two   ^anno-G2

\`\`\`anno
id: G2
status: exact
\`\`\`
`;
    const issues: ParseIssue[] = [];
    const sidecar = parseSidecar(text, (i) => issues.push(i));
    // The bad unit drops out; the good ones either side survive.
    expect(sidecar.annotations.map((a) => a.id)).toEqual(['G1', 'G2']);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('B1');
  });

  it('isolates an unterminated fence, keeping the units before it', () => {
    const text = `---
schema: webclip-annotations/1
annotates: "Clips/Note.md"
---

> good   ^anno-G

\`\`\`anno
id: G
status: exact
\`\`\`

> dangling   ^anno-D

\`\`\`anno
id: D
status: exact
`;
    const issues: ParseIssue[] = [];
    const sidecar = parseSidecar(text, (i) => issues.push(i));
    expect(sidecar.annotations.map((a) => a.id)).toEqual(['G']);
    expect(issues.some((x) => /nterminated/.test(x.message))).toBe(true);
  });

  it('still throws (strict) when no onIssue callback is given', () => {
    const text = `---
schema: webclip-annotations/1
annotates: "Clips/Note.md"
---

> q   ^anno-X

\`\`\`anno
id: X
status: bogus
\`\`\`
`;
    expect(() => parseSidecar(text)).toThrow(SidecarParseError);
  });

  it('keeps frontmatter/schema problems fatal even in tolerant mode', () => {
    expect(() => parseSidecar('> q\n', () => {})).toThrow(SidecarParseError);
    expect(() =>
      parseSidecar('---\nschema: webclip-annotations/2\nannotates: "x"\n---\n', () => {}),
    ).toThrow(SidecarSchemaError);
  });
});
