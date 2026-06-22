/**
 * The re-anchoring engine — "the spine" (Design.md §13). Re-resolves an
 * annotation's content selectors against the *current* source text on every use
 * and returns a live range, or honestly orphans (§4.6, §6.2, §6.3, §6.5).
 *
 * Nothing here mutates the annotation: `resolve` is pure. The caller flips
 * `status` and persists the repair (§6.5, §8).
 *
 * Matching runs on the whitespace-normalized *projection* of the source **body**
 * — a leading YAML frontmatter block is excluded ({@link bodyStart}), since its
 * `title`/`description` routinely duplicate body text and are not annotatable.
 * `mapRange` (plus the body-start `base`) carries every hit back to true source
 * offsets (§4.8); returned ranges are always in original `sourceText` offsets.
 * Searching the whole body projection (rather than block-by-block) is what lets a
 * heading-spanning quote match across a block boundary (§6.4) — the structural
 * pin/heading is then a *disambiguation signal*, not a search-space restriction.
 *
 * The §6.5 cascade:
 *   - exact, globally unique, and `unique` last time → accept (the cheap path);
 *   - exact otherwise → confirm/disambiguate by the {before, after, structural}
 *     signals (pick all-three, else ≥2, else orphan);
 *   - no exact hit → fuzzy, but only if the available signals confirm it, and
 *     then the caller *repairs* the stored quote to the matched bytes.
 * A signal "matches" only on an **exact** full-window agreement (§6.5 choice).
 */
import type { Annotation, AnnoRecord, Range } from '@/model/types';
import { normalize, mapRange, normalizeQuote } from '@/text/normalize';
import { bodyStart } from '@/text/frontmatter';

import type { SourceStructure } from './structure';
import { fuzzyLocate } from './fuzzy';

export type ResolveMethod = 'exact' | 'context' | 'fuzzy';

/** Whether the anchored match is the sole occurrence (gates the §6.5 cheap path). */
export type AnchorConfidence = 'unique' | 'exact';

export type ResolveResult =
  | { status: 'anchored'; range: Range; method: ResolveMethod; confidence: AnchorConfidence }
  | { status: 'orphaned'; reason: string };

export interface ResolveOptions {
  /** Minimum similarity ratio to accept a fuzzy hit (default 0.7). */
  fuzzyThreshold?: number;
  /** dmp `Match_Threshold` for the fuzzy probe step (default 0.5). */
  matchThreshold?: number;
  /**
   * How many normalized chars of `before`/`after` to weigh as a context signal
   * (default 30, matching the ~30-char context the format stores, §5.4). Only an
   * upper bound — a shorter stored window is used whole.
   */
  contextChars?: number;
}

const DEFAULT_CONTEXT_CHARS = 30;

/** A single exact occurrence within the normalized projection. */
interface ExactHit {
  /** Start index in the normalized text. */
  start: number;
  /** End index (exclusive) in the normalized text. */
  end: number;
}

/**
 * The precomputed §6.5 confirmation signals for one annotation: the normalized,
 * boundary-keeping `before`/`after` windows (capped at `contextChars`) and the
 * structural regions (pin block / heading section) in true source offsets.
 */
interface Signals {
  /** Normalized stored `before`, trailing boundary space kept, capped. Empty = unavailable. */
  beforeTail: string;
  /** Normalized stored `after`, leading boundary space kept, capped. Empty = unavailable. */
  afterHead: string;
  /** Enclosing pinned-block region (source offsets), or null if no/unknown pin. */
  pinRegion: Range | null;
  /** Enclosing heading-section region (source offsets), or null if no/unknown heading. */
  headRegion: Range | null;
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
 * Build the §6.5 signals for a record. The `before` window keeps its trailing
 * boundary space and the `after` window its leading one — that space is real in
 * the haystack (the quote needle is trimmed, so the surrounding space lives in
 * `before`/`after`); trimming it would break the exact full-window agreement.
 */
function buildSignals(
  record: AnnoRecord,
  structure: SourceStructure,
  contextChars: number,
): Signals {
  const nb = record.before ? normalize(record.before).text.replace(/^\s+/, '') : '';
  const na = record.after ? normalize(record.after).text.replace(/\s+$/, '') : '';
  return {
    beforeTail: nb.slice(Math.max(0, nb.length - contextChars)),
    afterHead: na.slice(0, contextChars),
    pinRegion: record.pin ? structure.blockRegion(record.pin) : null,
    headRegion: record.heading ? structure.headingRegion(record.heading) : null,
  };
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

/** Does the candidate's *preceding* text end with the full stored `before` window? */
function beforeMatches(hay: string, from: number, s: Signals): boolean {
  if (s.beforeTail.length === 0) return false;
  const preceding = hay.slice(Math.max(0, from - s.beforeTail.length), from);
  return commonSuffixLen(preceding, s.beforeTail) === s.beforeTail.length;
}

/** Does the candidate's *following* text start with the full stored `after` window? */
function afterMatches(hay: string, to: number, s: Signals): boolean {
  if (s.afterHead.length === 0) return false;
  const following = hay.slice(to, to + s.afterHead.length);
  return commonPrefixLen(following, s.afterHead) === s.afterHead.length;
}

/** Is the candidate (true source offset) inside the pinned block OR heading section? */
function structuralMatches(rawFrom: number, s: Signals): boolean {
  const inPin = !!s.pinRegion && rawFrom >= s.pinRegion.from && rawFrom < s.pinRegion.to;
  const inHead = !!s.headRegion && rawFrom >= s.headRegion.from && rawFrom < s.headRegion.to;
  return inPin || inHead;
}

const structuralAvailable = (s: Signals): boolean => s.pinRegion != null || s.headRegion != null;

/**
 * Count how many of the three §6.5 signals an exact hit satisfies. Each counts
 * only when *available* (its field is stored) AND it matches; so a count of 3
 * means all three were present and agreed. `base` is the body-start offset, added
 * to the normalized hit so the structural test compares true source offsets.
 */
function matchedSignals(
  norm: ReturnType<typeof normalize>,
  hit: ExactHit,
  s: Signals,
  base: number,
): number {
  let n = 0;
  if (beforeMatches(norm.text, hit.start, s)) n++;
  if (afterMatches(norm.text, hit.end, s)) n++;
  if (structuralAvailable(s) && structuralMatches(base + mapRange(norm, hit.start, hit.end).from, s)) {
    n++;
  }
  return n;
}

/**
 * §6.5 branch 2: choose among exact hits by signal agreement — the highest
 * scorer wins, requiring at least 2 signals, and the **first** such hit (in
 * document order) wins a tie at the top score. Returns null when no hit clears
 * the 2-signal bar, so the caller orphans rather than guess from weak evidence.
 */
function pickByExactSignals(
  norm: ReturnType<typeof normalize>,
  hits: ExactHit[],
  s: Signals,
  base: number,
): ExactHit | null {
  let best: ExactHit | null = null;
  let bestScore = 1; // require ≥2 to win
  for (const hit of hits) {
    const score = matchedSignals(norm, hit, s, base);
    // Strictly-greater keeps the FIRST hit at any given top score (first-wins).
    if (score > bestScore) {
      best = hit;
      bestScore = score;
    }
  }
  return best;
}

/**
 * §6.5 branch 3 gate: a fuzzy hit is trusted only when every *available* signal
 * agrees exactly (vacuously true when none are stored, falling back to the fuzzy
 * threshold). The quote bytes drifted, but the surrounding context/structure
 * should be intact for a benign in-quote edit.
 */
function confirmFuzzy(
  norm: ReturnType<typeof normalize>,
  hit: ExactHit,
  s: Signals,
  base: number,
): boolean {
  if (s.beforeTail.length > 0 && !beforeMatches(norm.text, hit.start, s)) return false;
  if (s.afterHead.length > 0 && !afterMatches(norm.text, hit.end, s)) return false;
  if (structuralAvailable(s) && !structuralMatches(base + mapRange(norm, hit.start, hit.end).from, s)) {
    return false;
  }
  return true;
}

/**
 * Re-resolve `anno`'s selectors against the current `sourceText` (§6.5).
 *
 * Never returns a guessed range: a globally-unique exact match is taken on the
 * cheap path only when it was unique last time; otherwise context must confirm,
 * and fuzzy is gated by the same signals before the caller repairs the quote.
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
  const priorUnique = anno.record.status === 'unique';
  const signals = buildSignals(anno.record, structure, contextChars);

  // Exclude a leading YAML frontmatter block from the search: its title/description
  // duplicate body text but are not annotatable, so a hit there is never the target.
  // `base` carries every normalized offset back to true source offsets.
  const base = bodyStart(sourceText);
  const norm = normalize(sourceText.slice(base));
  const hits = findAllExact(norm.text, needle);
  const globalCount = hits.length;
  // Did the (excluded) frontmatter also carry the quote? If so, a record marked
  // ambiguous (`exact`) owes that ambiguity to the frontmatter, not a real body
  // duplicate — used by branch 1b to recover a now-sole body match.
  const inFrontmatter = base > 0 && normalize(sourceText.slice(0, base)).text.includes(needle);

  // Branch 1 — globally unique AND unique last time: accept directly, no context
  // check (the cheap path; the sole occurrence is almost certainly the same one).
  if (globalCount === 1 && priorUnique) {
    return anchored(norm, hits[0], 'exact', 'unique', base);
  }

  // Branch 1b — a sole body match whose *only* other occurrence(s) sat in the
  // (now-excluded) frontmatter. The frontmatter was the entire source of the
  // historical ambiguity that stamped this record `exact`, so the body match is
  // unambiguous: anchor it and let the caller heal (method 'context' refreshes the
  // stale frontmatter-pointing before/after; confidence 'unique' takes the cheap
  // path next time). Without a frontmatter duplicate this stays the §6.5-A orphan.
  if (globalCount === 1 && !priorUnique && inFrontmatter) {
    return anchored(norm, hits[0], 'context', 'unique', base);
  }

  // Branch 2 — the exact quote is present: confirm/disambiguate by context. This
  // also covers a *single* match whose history was ambiguous (prior !== unique),
  // which must clear the context bar or orphan (§6.5 question A).
  if (globalCount >= 1) {
    const pick = pickByExactSignals(norm, hits, signals, base);
    if (pick) {
      const method: ResolveMethod = globalCount === 1 ? 'exact' : 'context';
      const confidence: AnchorConfidence = globalCount === 1 ? 'unique' : 'exact';
      return anchored(norm, pick, method, confidence, base);
    }
    // Exact bytes exist but context can't single out the right one. Fuzzy would
    // only re-find the same bytes, so orphan rather than guess (§4.6).
    return {
      status: 'orphaned',
      reason:
        globalCount === 1
          ? 'single match was ambiguous before and context could not confirm it'
          : 'multiple equally-plausible matches; context could not disambiguate',
    };
  }

  // Branch 3 — no exact hit: fuzzy (over the body), gated by context confirmation.
  // A hit here is a *repair* (method 'fuzzy') — the caller rewrites the stored
  // quote to the matched bytes so it resolves exact next time. Never marked
  // 'unique' (no exact verification yet); the following load promotes it if it
  // then resolves unique.
  const fuzzy = fuzzyLocate(norm.text, needle, {
    threshold: options.fuzzyThreshold,
    matchThreshold: options.matchThreshold,
  });
  if (fuzzy && confirmFuzzy(norm, { start: fuzzy.from, end: fuzzy.to }, signals, base)) {
    return anchored(norm, { start: fuzzy.from, end: fuzzy.to }, 'fuzzy', 'exact', base);
  }

  return {
    status: 'orphaned',
    reason: 'quote not found: no exact match and no context-confirmed fuzzy match',
  };
}

/**
 * Map a normalized `[start, end)` back to true source offsets and wrap it. `base`
 * is the body-start offset stripped before normalization (0 when no frontmatter).
 */
function anchored(
  norm: ReturnType<typeof normalize>,
  hit: ExactHit,
  method: ResolveMethod,
  confidence: AnchorConfidence,
  base: number,
): ResolveResult {
  const range = mapRange(norm, hit.start, hit.end);
  return {
    status: 'anchored',
    range: { from: base + range.from, to: base + range.to },
    method,
    confidence,
  };
}
