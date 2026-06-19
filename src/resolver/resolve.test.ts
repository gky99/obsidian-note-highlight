import { describe, it, expect } from 'vitest';

import type { Annotation, AnnoRecord, Range } from '@/model/types';

import { resolve } from './resolve';
import { inMemoryStructure } from './structure';
import type { SourceStructure } from './structure';

/**
 * Build an {@link Annotation} from a quote + partial record. Status starts
 * `anchored`; the resolver must never mutate it.
 */
function anno(quote: string, record: Partial<AnnoRecord> = {}): Annotation {
  return {
    id: record.id ?? 'test',
    quote,
    comment: '',
    record: { id: record.id ?? 'test', status: 'anchored', ...record },
  };
}

/** Find the [from, to) of the first occurrence of `sub` in `text`. */
function regionOf(text: string, sub: string): Range {
  const at = text.indexOf(sub);
  if (at === -1) throw new Error(`fixture bug: ${JSON.stringify(sub)} not in source`);
  return { from: at, to: at + sub.length };
}

/** Assert an anchored result and that its slice equals the expected raw text. */
function expectAnchored(
  result: ReturnType<typeof resolve>,
  source: string,
  expectedRaw: string,
  method?: 'exact' | 'context' | 'fuzzy',
): Range {
  expect(result.status).toBe('anchored');
  if (result.status !== 'anchored') throw new Error('unreachable');
  expect(source.slice(result.range.from, result.range.to)).toBe(expectedRaw);
  if (method) expect(result.method).toBe(method);
  return result.range;
}

// ---------------------------------------------------------------------------
// 1. Source untouched — clean single-block exact match, correct offsets.
// ---------------------------------------------------------------------------
describe('exact single-block match', () => {
  const source = [
    'Intro paragraph one.',
    '',
    'The sentence I care about lives right here in block two.',
    '',
    'A third paragraph for padding.',
  ].join('\n');

  const blockTwo = regionOf(source, 'The sentence I care about lives right here in block two.');
  const structure = inMemoryStructure({ blocks: { '^h2': blockTwo } });

  it('anchors a sub-block phrase with byte-correct offsets', () => {
    const result = resolve(anno('The sentence I care about', { pin: '^h2' }), source, structure);
    const range = expectAnchored(result, source, 'The sentence I care about', 'exact');
    expect(range.from).toBe(source.indexOf('The sentence I care about'));
  });

  it('does not mutate the annotation', () => {
    const a = anno('The sentence I care about', { pin: '^h2' });
    const before = JSON.parse(JSON.stringify(a));
    resolve(a, source, structure);
    expect(a).toEqual(before);
    expect(a.record.status).toBe('anchored');
  });
});

// ---------------------------------------------------------------------------
// 2. Whitespace-collapsed quote vs reflowed/extra-spaced source (#1 case, §4.8).
// ---------------------------------------------------------------------------
describe('whitespace-normalized matching (§4.8)', () => {
  it('matches a collapsed quote against a re-wrapped source', () => {
    const source = [
      'Block one.',
      '',
      'The   quick\tbrown',
      'fox    jumps over',
      'the   lazy   dog.',
    ].join('\n');
    const block = regionOf(source, 'The   quick\tbrown\nfox    jumps over\nthe   lazy   dog.');
    const structure = inMemoryStructure({ blocks: { '^p': block } });

    const result = resolve(anno('quick brown fox jumps', { pin: '^p' }), source, structure);
    // The raw slice carries the original (un-collapsed) whitespace.
    expectAnchored(result, source, 'quick\tbrown\nfox    jumps', 'exact');
  });

  it('matches when the quote was stored with collapsed whitespace', () => {
    const source = 'lead in.\n\nalpha    beta     gamma delta\n\ntail.';
    const block = regionOf(source, 'alpha    beta     gamma delta');
    const structure = inMemoryStructure({ blocks: { '^p': block } });
    // Quote as it would be stored: single-spaced.
    const result = resolve(anno('beta gamma', { pin: '^p' }), source, structure);
    expectAnchored(result, source, 'beta     gamma', 'exact');
  });

  it('trims leading/trailing whitespace on the stored quote', () => {
    const source = 'x.\n\n  padded  quote  here  \n\ny.';
    const block = regionOf(source, '  padded  quote  here  ');
    const structure = inMemoryStructure({ blocks: { '^p': block } });
    const result = resolve(anno('  padded  quote  here  ', { pin: '^p' }), source, structure);
    expectAnchored(result, source, 'padded  quote  here', 'exact');
  });
});

// ---------------------------------------------------------------------------
// 3. Duplicate quote text disambiguated by before/after (§6.1) — wrong one NOT chosen.
// ---------------------------------------------------------------------------
describe('duplicate-quote disambiguation by context (§6.1)', () => {
  const source = [
    'In the first section we say the key phrase appears here for reasons one.',
    '',
    'Much later in the document the key phrase appears here for reasons two.',
  ].join('\n');

  // One scope spanning the whole doc so both occurrences are in range.
  const structure: SourceStructure = inMemoryStructure({
    headings: { 'Doc': { from: 0, to: source.length } },
  });

  it('picks the occurrence matching `before`', () => {
    const result = resolve(
      anno('the key phrase appears here', {
        heading: 'Doc',
        before: 'In the first section we say ',
        after: ' for reasons one',
      }),
      source,
      structure,
    );
    const range = expectAnchored(result, source, 'the key phrase appears here', 'context');
    // Must be the FIRST occurrence, not the second.
    expect(range.from).toBe(source.indexOf('the key phrase appears here'));
    expect(range.from).toBeLessThan(source.indexOf('Much later'));
  });

  it('picks the occurrence matching `after` (the later one)', () => {
    const lateStart = source.indexOf('the key phrase appears here', source.indexOf('Much later'));
    const result = resolve(
      anno('the key phrase appears here', {
        heading: 'Doc',
        before: 'Much later in the document ',
        after: ' for reasons two',
      }),
      source,
      structure,
    );
    const range = expectAnchored(result, source, 'the key phrase appears here', 'context');
    expect(range.from).toBe(lateStart);
  });

  it('orphans rather than guessing when context cannot disambiguate', () => {
    const result = resolve(
      anno('the key phrase appears here', { heading: 'Doc' }), // no before/after
      source,
      structure,
    );
    // Two identical hits, no context, no fuzzy improvement → orphan, never guess.
    expect(result.status).toBe('orphaned');
  });
});

// ---------------------------------------------------------------------------
// 4. CRITICAL: heading-spanning quote (§6.4) + single-paragraph control.
// ---------------------------------------------------------------------------
describe('heading-spanning quotes (§6.4) — the critical set', () => {
  const source = [
    'Lead paragraph before the methods section.',
    '',
    '## Methods',
    '',
    'We measured the thing carefully and twice.',
    '',
    '## Results',
    '',
    'The thing was found to be large.',
  ].join('\n');

  // The heading "## Methods" is one block; the paragraph under it is another.
  const headingBlock = regionOf(source, '## Methods');
  const methodsPara = regionOf(source, 'We measured the thing carefully and twice.');
  // The "through-following" window spans from the heading line through its paragraph.
  const methodsThrough: Range = { from: headingBlock.from, to: methodsPara.to };
  // The section body (under the heading) is just the paragraph.
  const methodsBody: Range = { from: methodsPara.from, to: methodsPara.to };

  const structure = inMemoryStructure({
    blocks: { '^methods-h': headingBlock },
    headings: { 'Methods': methodsBody },
    headingThrough: { 'Methods': methodsThrough },
  });

  it('widens past the single pinned block to match heading + paragraph', () => {
    // Pin points at the HEADING block, which cannot contain the paragraph text.
    const quote = '## Methods We measured the thing carefully';
    const result = resolve(
      anno(quote, { pin: '^methods-h', heading: 'Methods' }),
      source,
      structure,
    );
    // The raw span crosses the block boundary (heading line + blank + paragraph).
    expectAnchored(result, source, '## Methods\n\nWe measured the thing carefully', 'exact');
  });

  it('matches the full heading-through-paragraph span', () => {
    const quote = '## Methods We measured the thing carefully and twice.';
    const result = resolve(
      anno(quote, { pin: '^methods-h', heading: 'Methods' }),
      source,
      structure,
    );
    expectAnchored(
      result,
      source,
      '## Methods\n\nWe measured the thing carefully and twice.',
      'exact',
    );
  });

  it('keeps Markdown markers in the match (does not stem ##)', () => {
    const quote = '## Methods';
    const result = resolve(
      anno(quote, { pin: '^methods-h', heading: 'Methods' }),
      source,
      structure,
    );
    expectAnchored(result, source, '## Methods', 'exact');
  });

  it('CONTROL: a single-paragraph highlight stays a clean single-block anchor', () => {
    // No heading markers → resolves inside the pinned block, never widened.
    const onlyParaStructure = inMemoryStructure({
      blocks: { '^methods-p': methodsPara },
      // Intentionally give a heading region too, to prove the pin is preferred.
      headings: { 'Methods': methodsBody },
    });
    const result = resolve(
      anno('the thing carefully', { pin: '^methods-p', heading: 'Methods' }),
      source,
      onlyParaStructure,
    );
    const range = expectAnchored(result, source, 'the thing carefully', 'exact');
    // Confined to the pinned paragraph block.
    expect(range.from).toBeGreaterThanOrEqual(methodsPara.from);
    expect(range.to).toBeLessThanOrEqual(methodsPara.to);
  });

  it('does NOT mis-match the wrong section heading', () => {
    // Quote mentions Results, pinned at Results heading: must land in Results.
    const resultsHeading = regionOf(source, '## Results');
    const resultsPara = regionOf(source, 'The thing was found to be large.');
    const s = inMemoryStructure({
      blocks: { '^results-h': resultsHeading },
      headings: { 'Results': { from: resultsPara.from, to: resultsPara.to } },
      headingThrough: { 'Results': { from: resultsHeading.from, to: resultsPara.to } },
    });
    const result = resolve(
      anno('## Results The thing was found', { pin: '^results-h', heading: 'Results' }),
      source,
      s,
    );
    const range = expectAnchored(result, source, '## Results\n\nThe thing was found', 'exact');
    expect(range.from).toBe(source.indexOf('## Results'));
  });
});

// ---------------------------------------------------------------------------
// 5. Small edit inside the quoted passage → fuzzy recovery.
// ---------------------------------------------------------------------------
describe('fuzzy recovery on small edits (§6.2 step 4)', () => {
  it('recovers a quote after a word inside it changed', () => {
    // Source now says "carefully and thrice"; stored quote said "carefully and twice".
    const source = [
      'Lead.',
      '',
      '## Methods',
      '',
      'We measured the thing very carefully and thrice in the lab.',
    ].join('\n');
    const para = regionOf(source, 'We measured the thing very carefully and thrice in the lab.');
    const structure = inMemoryStructure({ blocks: { '^p': para } });

    const storedQuote = 'We measured the thing very carefully and twice in the lab';
    const result = resolve(anno(storedQuote, { pin: '^p' }), source, structure);

    expect(result.status).toBe('anchored');
    if (result.status !== 'anchored') throw new Error('unreachable');
    expect(result.method).toBe('fuzzy');
    // The recovered slice should contain the surviving anchor words.
    const slice = source.slice(result.range.from, result.range.to);
    expect(slice).toContain('We measured the thing');
    expect(slice).toContain('in the lab');
  });

  it('recovers after a small insertion within the passage', () => {
    const source = 'pre.\n\nThe alpha beta gamma delta epsilon zeta passage continues.';
    const para = regionOf(source, 'The alpha beta gamma delta epsilon zeta passage continues.');
    const structure = inMemoryStructure({ blocks: { '^p': para } });
    // Stored quote lacks the inserted "delta".
    const stored = 'The alpha beta gamma epsilon zeta passage';
    const result = resolve(anno(stored, { pin: '^p' }), source, structure);
    expect(result.status).toBe('anchored');
    if (result.status !== 'anchored') throw new Error('unreachable');
    expect(result.method).toBe('fuzzy');
    expect(source.slice(result.range.from, result.range.to)).toContain('alpha beta gamma');
  });
});

// ---------------------------------------------------------------------------
// 6. Wholesale rewrite / deletion → orphaned (never mis-points, §4.6).
// ---------------------------------------------------------------------------
describe('orphaning on rewrite/deletion (§4.6)', () => {
  it('orphans when the passage is gone entirely', () => {
    const source = 'Completely different content about unrelated topics and ideas.';
    const structure = inMemoryStructure({
      blocks: { '^p': { from: 0, to: source.length } },
    });
    const result = resolve(
      anno('The original sentence that no longer exists anywhere here', { pin: '^p' }),
      source,
      structure,
    );
    expect(result.status).toBe('orphaned');
    if (result.status !== 'orphaned') throw new Error('unreachable');
    expect(typeof result.reason).toBe('string');
    expect(result.reason.length).toBeGreaterThan(0);
  });

  it('orphans rather than mis-pointing at superficially similar text', () => {
    const source = 'The cat sat on the mat near the door of the old house.';
    const structure = inMemoryStructure({
      blocks: { '^p': { from: 0, to: source.length } },
    });
    // A quote with no real overlap to the source content.
    const result = resolve(
      anno('Quantum entanglement of distant photons defies locality entirely', { pin: '^p' }),
      source,
      structure,
    );
    expect(result.status).toBe('orphaned');
  });
});

// ---------------------------------------------------------------------------
// 7. Scope fallback: pin unknown → heading; both unknown → whole document.
// ---------------------------------------------------------------------------
describe('scope fallback (§6.2 step 2)', () => {
  const source = [
    'Top matter.',
    '',
    '## Section',
    '',
    'Here the findable phrase lives in the section body.',
  ].join('\n');
  const sectionBody = regionOf(source, 'Here the findable phrase lives in the section body.');

  it('falls back to the heading scope when the pin id is unknown', () => {
    // Structure knows the heading but NOT the pin id.
    const structure = inMemoryStructure({
      headings: { 'Section': sectionBody },
    });
    const result = resolve(
      anno('the findable phrase', { pin: '^missing', heading: 'Section' }),
      source,
      structure,
    );
    expectAnchored(result, source, 'the findable phrase', 'exact');
  });

  it('falls back to the whole document when pin and heading are both unknown', () => {
    const structure = inMemoryStructure({}); // knows nothing
    const result = resolve(
      anno('the findable phrase', { pin: '^missing', heading: 'Nope' }),
      source,
      structure,
    );
    expectAnchored(result, source, 'the findable phrase', 'exact');
  });

  it('uses whole document when there is no pin or heading at all', () => {
    const structure = inMemoryStructure({});
    const result = resolve(anno('the findable phrase'), source, structure);
    expectAnchored(result, source, 'the findable phrase', 'exact');
  });
});

// ---------------------------------------------------------------------------
// 8. Offsets always map back through collapsed whitespace — assert on .slice.
// ---------------------------------------------------------------------------
describe('offset fidelity through collapsed whitespace', () => {
  it('maps a multi-run-whitespace quote to exact raw offsets', () => {
    const source = 'before\n\nalpha\t\tbeta   gamma\n  delta after.';
    const structure = inMemoryStructure({
      blocks: { '^p': { from: 0, to: source.length } },
    });
    const result = resolve(anno('beta gamma delta', { pin: '^p' }), source, structure);
    const range = expectAnchored(result, source, 'beta   gamma\n  delta', 'exact');
    // Round-trip: re-normalizing the raw slice equals the normalized quote.
    expect(source.slice(range.from, range.to).replace(/\s+/g, ' ')).toBe('beta gamma delta');
  });

  it('excludes trailing collapsed whitespace from the mapped range', () => {
    const source = 'lead.\n\nword    next continues here.';
    const structure = inMemoryStructure({ blocks: { '^p': { from: 0, to: source.length } } });
    const result = resolve(anno('word', { pin: '^p' }), source, structure);
    const range = expectAnchored(result, source, 'word', 'exact');
    // The range ends right after "word", not into the run of spaces.
    expect(source[range.to]).toBe(' ');
    expect(source.slice(range.from, range.to)).toBe('word');
  });

  it('adds the scope base offset correctly (match not at document start)', () => {
    const source = 'XXXXXXXXXX paddingpaddingpadding TARGET PHRASE here at the end.';
    const block = regionOf(source, 'TARGET PHRASE here at the end.');
    const structure = inMemoryStructure({ blocks: { '^p': block } });
    const result = resolve(anno('TARGET PHRASE', { pin: '^p' }), source, structure);
    const range = expectAnchored(result, source, 'TARGET PHRASE', 'exact');
    expect(range.from).toBe(source.indexOf('TARGET PHRASE'));
    expect(range.from).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 9. Edge cases.
// ---------------------------------------------------------------------------
describe('edge cases', () => {
  it('orphans an empty/whitespace-only quote', () => {
    const structure = inMemoryStructure({ blocks: { '^p': { from: 0, to: 5 } } });
    const result = resolve(anno('   ', { pin: '^p' }), 'hello', structure);
    expect(result.status).toBe('orphaned');
  });

  it('prefers an exact hit in a wider scope over a fuzzy hit in a narrow one', () => {
    // The pinned block has a near-miss (fuzzy-able) copy; the document has the
    // exact text elsewhere. Exact must win and land on the exact occurrence.
    const source = [
      'The quick brown fax jumped.', // typo "fax" in the pinned block
      '',
      'Later: the quick brown fox jumped cleanly.',
    ].join('\n');
    const pinnedBlock = regionOf(source, 'The quick brown fax jumped.');
    const structure = inMemoryStructure({
      blocks: { '^p': pinnedBlock },
      headings: { 'Doc': { from: 0, to: source.length } },
    });
    const result = resolve(
      anno('the quick brown fox jumped', { pin: '^p', heading: 'Doc' }),
      source,
      structure,
    );
    const range = expectAnchored(result, source, 'the quick brown fox jumped', 'exact');
    // It must be the exact lowercase occurrence in the second block.
    expect(range.from).toBe(source.indexOf('the quick brown fox jumped'));
  });

  it('respects a stricter fuzzy threshold (orphans a marginal match)', () => {
    const source = 'pre.\n\nThe somewhat similar but quite changed passage of text.';
    const structure = inMemoryStructure({ blocks: { '^p': { from: 0, to: source.length } } });
    const stored = 'The totally different original wording of words';
    // With a very high threshold, a weak fuzzy match must be rejected.
    const result = resolve(anno(stored, { pin: '^p' }), source, structure, {
      fuzzyThreshold: 0.95,
    });
    expect(result.status).toBe('orphaned');
  });
});
