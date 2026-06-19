import { describe, it, expect } from 'vitest';

import type { Sidecar } from '@/model/types';
import { SCHEMA_VERSION } from '@/model/types';

import { parseSidecar } from './parse';
import { serializeSidecar } from './serialize';
import { SidecarParseError, SidecarSchemaError } from './errors';

/**
 * The §5.2 worked example, verbatim (minus the outer 4-backtick display fence
 * that only exists to render the inner block in the doc).
 */
const EXAMPLE_52 = `---
schema: webclip-annotations/1
annotates: "Clips/The Article.md"
source_url: "https://example.com/the-article"
clipped: 2026-06-19
source_hash: "sha1:ab12cd34ef…"
---

> the sentence I care about   ^anno-01J8X2

\`\`\`anno
id: 01J8X2
pin: "^h1"
heading: "Intro › Background"
before: "…the words just before "
after: " the words right after…"
qhash: "3f9a"
status: anchored
color: yellow
created: 2026-06-19T10:32:00Z
\`\`\`

My note about why this matters — ordinary prose, [[wikilinks]], #tags,
multiple paragraphs, whatever.

---

> ## A quoted heading
> followed by text with **strong** emphasis   ^anno-01J8X9

\`\`\`anno
id: 01J8X9
pin: "^h4"
heading: "Methods"
before: "…preceding sentence. "
after: " The following sentence…"
qhash: "b1c2"
status: orphaned
color: green
created: 2026-06-19T11:05:00Z
\`\`\`

This reference spans a heading and the paragraph under it — see §6.4.
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
      status: 'anchored',
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
    expect(a.record.status).toBe('orphaned');
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
          record: { id: 'AA', status: 'anchored' },
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
            status: 'anchored',
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
      { id: 'CC', quote: 'no comment here', record: { id: 'CC', status: 'orphaned' }, comment: '' },
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
        { id: 'A1', quote: 'first', record: { id: 'A1', status: 'anchored' }, comment: 'c1' },
        { id: 'A2', quote: 'second', record: { id: 'A2', status: 'orphaned' }, comment: 'c2' },
        { id: 'A3', quote: 'third', record: { id: 'A3', status: 'anchored' }, comment: '' },
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
            status: 'anchored',
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

describe('robust unit detection (no reliance on --- separators)', () => {
  it('does NOT split a unit on a --- or > line inside the comment prose', () => {
    const text = `---
schema: webclip-annotations/1
annotates: "Clips/Note.md"
---

> the quote   ^anno-XYZ

\`\`\`anno
id: XYZ
status: anchored
\`\`\`

Here is a comment that itself contains a horizontal rule:

---

and even a blockquote line that must NOT start a new unit:

> this looks like a quote but it is just prose

end of comment.
`;
    const sidecar = parseSidecar(text);
    expect(sidecar.annotations).toHaveLength(1);
    const a = sidecar.annotations[0];
    expect(a.quote).toBe('the quote');
    // The internal --- and > lines are preserved as comment content. The lone
    // trailing-unit HR logic only strips an HR that *terminates* the comment.
    expect(a.comment).toContain('horizontal rule:');
    expect(a.comment).toContain('---');
    expect(a.comment).toContain('> this looks like a quote but it is just prose');
    expect(a.comment.endsWith('end of comment.')).toBe(true);
  });

  it('captures the contiguous blockquote even across blank lines above the anno block', () => {
    const text = `---
schema: webclip-annotations/1
annotates: "Clips/Note.md"
---

> line one
> line two   ^anno-Q1


\`\`\`anno
id: Q1
status: anchored
\`\`\`

comment
`;
    const a = parseSidecar(text).annotations[0];
    expect(a.quote).toBe('line one\nline two');
    expect(a.id).toBe('Q1');
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
status: anchored
\`\`\`

c
`).annotations[0];
    expect(a.quote).toBe('just the quote text');
  });

  it("prefers the anno block's id when the ref and record disagree", () => {
    // Ref says MISMATCH, record says CANON — Annotation.id must follow the record.
    const a = parseSidecar(`---
schema: webclip-annotations/1
annotates: "Clips/Note.md"
---

> some quote   ^anno-MISMATCH

\`\`\`anno
id: CANON
status: anchored
\`\`\`

c
`).annotations[0];
    expect(a.id).toBe('CANON');
    expect(a.record.id).toBe('CANON');
  });

  it('handles a blockquote with a blank quoted line (bare >)', () => {
    const s = makeSidecar([
      {
        id: 'BLANK',
        quote: 'first paragraph\n\nsecond paragraph',
        record: { id: 'BLANK', status: 'anchored' },
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
          status: 'anchored',
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
          status: 'anchored',
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
        record: { id: 'VERB', status: 'anchored', after: 'has ``` ticks' },
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
status: anchored
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
status: anchored
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

describe('malformed input', () => {
  it('throws SidecarParseError when there is no frontmatter', () => {
    expect(() => parseSidecar('> q   ^anno-X\n\n```anno\nid: X\nstatus: anchored\n```\n')).toThrow(
      SidecarParseError,
    );
  });

  it('throws SidecarParseError on unterminated frontmatter', () => {
    expect(() => parseSidecar('---\nschema: webclip-annotations/1\n')).toThrow(SidecarParseError);
  });

  it('throws SidecarParseError when an anno block lacks a blockquote above it', () => {
    const text = `---
schema: webclip-annotations/1
annotates: "Clips/Note.md"
---

just prose, no blockquote

\`\`\`anno
id: ORPHANBLOCK
status: anchored
\`\`\`

c
`;
    expect(() => parseSidecar(text)).toThrow(SidecarParseError);
  });

  it('throws SidecarParseError on an unterminated anno block', () => {
    const text = `---
schema: webclip-annotations/1
annotates: "Clips/Note.md"
---

> q   ^anno-X

\`\`\`anno
id: X
status: anchored
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
