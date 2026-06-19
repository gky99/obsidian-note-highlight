/**
 * End-to-end core-pipeline test: sidecar parse → live resolve → serialize,
 * exercised together on one realistic fixture. The per-module suites cover each
 * stage in isolation; this guards the *seams* between them (and the §6.4
 * heading-spanning case the design flags as the fragile one).
 *
 * Pure modules only — no Obsidian. Structural scope is left empty so the
 * resolver falls back to whole-document search (still offset-accurate).
 */
import { describe, it, expect } from 'vitest';
import { parseSidecar, serializeSidecar } from '@/sidecar';
import { resolve, inMemoryStructure } from '@/resolver';

const SOURCE = `# Article

Intro paragraph mentioning the sentence I care about right here.

## Methods

A lead-in line.

## A quoted heading
followed by text with **strong** emphasis and more.
`;

const F = '```';

const SIDECAR = `---
schema: webclip-annotations/1
annotates: Article.md
source_url: "https://example.com/article"
clipped: 2026-06-19
---

> the sentence I care about ^anno-01J8X2

${F}anno
id: 01J8X2
heading: Article
before: "paragraph mentioning "
after: " right here."
qhash: deadbeef
status: anchored
color: yellow
${F}

A note about the sentence.

---

> ## A quoted heading
> followed by text with **strong** emphasis ^anno-01J8X9

${F}anno
id: 01J8X9
heading: A quoted heading
before: "A lead-in line. "
after: " and more."
qhash: cafebabe
status: anchored
color: green
${F}

This reference spans a heading and the paragraph under it (§6.4).

---

> a passage that no longer exists anywhere ^anno-01J8XZ

${F}anno
id: 01J8XZ
heading: Methods
qhash: 00000000
status: anchored
color: blue
${F}

This one should orphan.
`;

describe('core pipeline (sidecar → resolve → serialize)', () => {
  const sidecar = parseSidecar(SIDECAR);
  const structure = inMemoryStructure({}); // all scopes null → whole document

  it('parses every annotation unit', () => {
    expect(sidecar.frontmatter.annotates).toBe('Article.md');
    expect(sidecar.annotations.map((a) => a.id)).toEqual(['01J8X2', '01J8X9', '01J8XZ']);
  });

  it('anchors a sub-block quote to its exact source offsets', () => {
    const anno = sidecar.annotations[0];
    const result = resolve(anno, SOURCE, structure);
    expect(result.status).toBe('anchored');
    if (result.status !== 'anchored') return;
    expect(SOURCE.slice(result.range.from, result.range.to)).toBe('the sentence I care about');
  });

  it('anchors a heading-spanning quote across the block boundary (§6.4)', () => {
    const anno = sidecar.annotations[1];
    const result = resolve(anno, SOURCE, structure);
    expect(result.status).toBe('anchored');
    if (result.status !== 'anchored') return;
    // The mapped raw range keeps the real newline between heading and paragraph.
    expect(SOURCE.slice(result.range.from, result.range.to)).toBe(
      '## A quoted heading\nfollowed by text with **strong** emphasis',
    );
  });

  it('orphans a quote that is no longer present, never mis-pointing (§4.6)', () => {
    const anno = sidecar.annotations[2];
    const result = resolve(anno, SOURCE, structure);
    expect(result.status).toBe('orphaned');
  });

  it('round-trips losslessly through serialize → parse', () => {
    const reparsed = parseSidecar(serializeSidecar(sidecar));
    expect(reparsed).toEqual(sidecar);
  });
});
