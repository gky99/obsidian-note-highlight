/**
 * The re-anchoring engine — "the spine" (Design.md §13). Re-resolves an
 * annotation's content selectors against the *current* source text on every use
 * and returns a live range, or honestly orphans (§4.6, §6.2, §6.3).
 *
 * Nothing here mutates the annotation: `resolve` is pure. The caller flips
 * `status` and persists (§8).
 *
 * The whole cascade runs on the whitespace-normalized *projection* of each
 * scope, with `mapRange` carrying every hit back to true source offsets (§4.8).
 * Returned ranges are always in original `sourceText` offsets.
 */
import type { Annotation, Range } from '@/model/types';
import { normalize, mapRange, normalizeQuote } from '@/text/normalize';

import type { SourceStructure } from './structure';
import { fuzzyLocate } from './fuzzy';

export type ResolveMethod = 'exact' | 'context' | 'fuzzy';

export type ResolveResult =
  | { status: 'anchored'; range: Range; method: ResolveMethod }
  | { status: 'orphaned'; reason: string };

export interface ResolveOptions {
  /** Minimum similarity ratio to accept a fuzzy hit (default 0.7). */
  fuzzyThreshold?: number;
  /** dmp `Match_Threshold` for the fuzzy probe step (default 0.5). */
  matchThreshold?: number;
  /**
   * How many normalized chars of `before`/`after` to weigh when disambiguating
   * duplicate exact hits (default 30, matching the ~30-char context the format
   * stores, §5.4). Only an upper bound — shorter stored context is used whole.
   */
  contextChars?: number;
}

const DEFAULT_CONTEXT_CHARS = 30;

/** A candidate scope to search, in original source offsets, widest-last. */
interface Scope {
  region: Range;
  /** For diagnostics / orphan reasons. */
  label: string;
}

/** A single exact occurrence within a normalized scope. */
interface ExactHit {
  /** Start index in the normalized scope text. */
  start: number;
  /** End index (exclusive) in the normalized scope text. */
  end: number;
}

/**
 * Does the normalized quote look like it spans a heading? A leading `#` run
 * (after optional list/quote markers) is the tell. We also treat an internal
 * ` #`-prefixed token as heading-spanning, since a heading can sit mid-quote.
 * Heading-spanning quotes can't live inside a single block, so we widen past the
 * pin scope eagerly for them (§6.4).
 */
function looksHeadingSpanning(normQuote: string): boolean {
  return /(^|\s)#{1,6}\s/.test(normQuote);
}

/**
 * Build the ordered list of scopes to try, narrowest-first (§6.2 step 2).
 *
 * - Always start at the pinned block (narrowest, least fragile).
 * - For heading-spanning quotes, the `headingThroughFollowing` window is
 *   inserted right after the pin so we widen *before* wasting an exact pass that
 *   structurally cannot succeed inside one block (§6.4).
 * - `headingRegion` (section body) and the whole document follow as fallbacks.
 *
 * Duplicate/again-null regions are skipped. The whole document is always the
 * final backstop.
 */
function buildScopes(
  anno: Annotation,
  structure: SourceStructure,
  sourceText: string,
  headingSpanning: boolean,
): Scope[] {
  const scopes: Scope[] = [];
  const seen = new Set<string>();
  const push = (region: Range | null, label: string): void => {
    if (!region) return;
    if (region.to <= region.from) return;
    const key = `${region.from}:${region.to}`;
    if (seen.has(key)) return;
    seen.add(key);
    scopes.push({ region, label });
  };

  const pin = anno.record.pin;
  const heading = anno.record.heading;

  if (pin) push(structure.blockRegion(pin), `block ${pin}`);
  if (headingSpanning && heading) {
    push(structure.headingThroughFollowing(heading), `heading-through ${heading}`);
  }
  if (heading) {
    push(structure.headingRegion(heading), `heading ${heading}`);
    // Even for non-spanning quotes, the through-following window is a useful
    // wider net before falling all the way to the document.
    if (!headingSpanning) {
      push(structure.headingThroughFollowing(heading), `heading-through ${heading}`);
    }
  }
  push({ from: 0, to: sourceText.length }, 'document');
  return scopes;
}

/** All occurrences of `needle` in `hay` (normalized text), non-overlapping. */
function findAllExact(hay: string, needle: string): ExactHit[] {
  const hits: ExactHit[] = [];
  if (needle.length === 0) return hits;
  let from = 0;
  for (;;) {
    const at = hay.indexOf(needle, from);
    if (at === -1) break;
    hits.push({ start: at, end: at + needle.length });
    from = at + needle.length;
  }
  return hits;
}

/**
 * Disambiguate >1 exact hits by `before`/`after` context (§6.1). Each candidate
 * is scored by how much of the (normalized, length-capped) stored context
 * agrees with the text immediately preceding/following the occurrence. The hit
 * with the strictly-greatest positive score wins; a tie returns `null` so the
 * caller falls through to fuzzy/orphan rather than guessing (§4.6).
 */
function disambiguateByContext(
  hay: string,
  hits: ExactHit[],
  before: string | undefined,
  after: string | undefined,
  contextChars: number,
): ExactHit | null {
  // Collapse stored context but KEEP the whitespace on the side that touches the
  // quote — the boundary space between context and quote is real in the
  // haystack (the quote needle is trimmed, so it begins/ends at a word, with the
  // surrounding space living in `before`/`after`). `normalizeQuote` would trim
  // that boundary space away and break suffix/prefix agreement. So we collapse
  // and trim only the *outer* side: `before` keeps its trailing space, `after`
  // keeps its leading space.
  const nb = before ? normalize(before).text.replace(/^\s+/, '') : '';
  const na = after ? normalize(after).text.replace(/\s+$/, '') : '';
  const beforeTail = nb.slice(Math.max(0, nb.length - contextChars));
  const afterHead = na.slice(0, contextChars);

  if (beforeTail.length === 0 && afterHead.length === 0) return null;

  let best: ExactHit | null = null;
  let bestScore = 0;
  let tie = false;

  for (const hit of hits) {
    let score = 0;
    if (beforeTail.length > 0) {
      const preceding = hay.slice(Math.max(0, hit.start - beforeTail.length), hit.start);
      score += commonSuffixLen(preceding, beforeTail);
    }
    if (afterHead.length > 0) {
      const following = hay.slice(hit.end, hit.end + afterHead.length);
      score += commonPrefixLen(following, afterHead);
    }
    if (score > bestScore) {
      bestScore = score;
      best = hit;
      tie = false;
    } else if (score === bestScore && score > 0) {
      tie = true;
    }
  }

  if (bestScore === 0 || tie) return null;
  return best;
}

/** Length of the longest common suffix of `a` and `b`. */
function commonSuffixLen(a: string, b: string): number {
  let i = a.length - 1;
  let j = b.length - 1;
  let n = 0;
  while (i >= 0 && j >= 0 && a[i] === b[j]) {
    i--;
    j--;
    n++;
  }
  return n;
}

/** Length of the longest common prefix of `a` and `b`. */
function commonPrefixLen(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let n = 0;
  while (n < max && a[n] === b[n]) n++;
  return n;
}

/**
 * Re-resolve `anno`'s selectors against the current `sourceText`.
 *
 * Cascade (§6.2): narrowest scope first; within each scope try exact (with
 * context disambiguation for duplicates) then fuzzy; widen scope on failure;
 * orphan only when nothing is confident. Never returns a guessed range.
 */
export function resolve(
  anno: Annotation,
  sourceText: string,
  structure: SourceStructure,
  options: ResolveOptions = {},
): ResolveResult {
  const needle = normalizeQuote(anno.quote);
  if (needle.length === 0) {
    return { status: 'orphaned', reason: 'empty quote selector' };
  }

  const contextChars = options.contextChars ?? DEFAULT_CONTEXT_CHARS;
  const headingSpanning = looksHeadingSpanning(needle);
  const scopes = buildScopes(anno, structure, sourceText, headingSpanning);

  // Pass 1: exact (+ context) across all scopes, narrowest-first. We prefer an
  // exact hit in *any* scope over a fuzzy hit in a narrow one.
  let sawAmbiguous = false;
  for (const scope of scopes) {
    const slice = sourceText.slice(scope.region.from, scope.region.to);
    const norm = normalize(slice);
    const hits = findAllExact(norm.text, needle);

    if (hits.length === 1) {
      const hit = hits[0];
      return anchored(norm, hit.start, hit.end, scope.region.from, 'exact');
    }
    if (hits.length > 1) {
      const chosen = disambiguateByContext(
        norm.text,
        hits,
        anno.record.before,
        anno.record.after,
        contextChars,
      );
      if (chosen) {
        return anchored(norm, chosen.start, chosen.end, scope.region.from, 'context');
      }
      // Ambiguous: multiple identical exact occurrences that `before`/`after`
      // could not separate. Fuzzy cannot disambiguate identical text either —
      // it would just re-find one of them and *guess*, the one thing §4.6
      // forbids. Record it; if no unique exact hit turns up in a different
      // scope, we orphan rather than pick arbitrarily.
      sawAmbiguous = true;
    }
  }

  if (sawAmbiguous) {
    return {
      status: 'orphaned',
      reason: 'multiple equally-plausible matches; context could not disambiguate',
    };
  }

  // Pass 2: fuzzy, narrowest-first. Only after exact has failed everywhere, so a
  // clean exact match elsewhere always wins over a fuzzy near-match. Reached only
  // when no scope contained the exact quote at all (so no ambiguity to guess at).
  for (const scope of scopes) {
    const slice = sourceText.slice(scope.region.from, scope.region.to);
    const norm = normalize(slice);
    const hit = fuzzyLocate(norm.text, needle, {
      threshold: options.fuzzyThreshold,
      matchThreshold: options.matchThreshold,
    });
    if (hit) {
      return anchored(norm, hit.from, hit.to, scope.region.from, 'fuzzy');
    }
  }

  return {
    status: 'orphaned',
    reason: `quote not found in any scope (tried: ${scopes.map((s) => s.label).join(', ')})`,
  };
}

/**
 * Map a normalized-scope `[start, end)` back to true source offsets, adding the
 * scope's base offset, and wrap it as an anchored result.
 */
function anchored(
  norm: ReturnType<typeof normalize>,
  start: number,
  end: number,
  base: number,
  method: ResolveMethod,
): ResolveResult {
  const local = mapRange(norm, start, end);
  return {
    status: 'anchored',
    range: { from: base + local.from, to: base + local.to },
    method,
  };
}
