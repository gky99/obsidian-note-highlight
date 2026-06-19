/**
 * Fuzzy quote location via diff-match-patch, for the small-edit recovery step of
 * the resolution cascade (Design.md §6.2 step 4).
 *
 * The hard constraint: dmp's `match_main` only fuzzes a pattern up to
 * `Match_MaxBits` (≈32) characters. A typical quote is far longer, so we cannot
 * hand the whole quote to `match_main`. Strategy (the "anchor-and-verify"
 * approach the spec suggests):
 *
 *   1. Pick a distinctive ≤32-char *probe* slice from the middle of the
 *      normalized quote and `match_main` it within the normalized scope to get
 *      an approximate location. The middle is preferred over the ends because
 *      real-world edits cluster at boundaries (a word added/removed right before
 *      or after the highlight).
 *   2. From that location, carve a candidate window the length of the quote (with
 *      a little slack on each side) and slide it to the offset that minimises
 *      edit distance to the full normalized quote.
 *   3. Accept only if the similarity ratio over the full quote clears a
 *      threshold (default 0.7). Below it we return `null` and the caller orphans
 *      — we never return a plausible-but-wrong window (§4.6).
 *
 * All inputs/outputs here are in *normalized-scope* coordinates; the caller maps
 * them back to true source offsets.
 */
import { diff_match_patch } from 'diff-match-patch';

/** A located, verified fuzzy candidate in normalized-scope coordinates. */
export interface FuzzyHit {
  /** Half-open `[from, to)` within the normalized scope text. */
  from: number;
  to: number;
  /** Similarity ratio in `[0, 1]` (1 = identical). */
  score: number;
}

export interface FuzzyOptions {
  /**
   * Minimum similarity ratio to accept a fuzzy hit. The spec's "~0.7 similarity"
   * default; below this we orphan rather than guess.
   */
  threshold?: number;
  /**
   * dmp `Match_Threshold` for the probe step (0 = exact, 1 = very loose). The
   * spec's "~0.5". Only gates the coarse *location* probe; final acceptance is
   * always the similarity ratio above.
   */
  matchThreshold?: number;
}

const DEFAULT_THRESHOLD = 0.7;
const DEFAULT_MATCH_THRESHOLD = 0.5;

/** Levenshtein distance between two strings (iterative, two-row). */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = new Array<number>(b.length + 1);
  let curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    const ai = a.charCodeAt(i - 1);
    for (let j = 1; j <= b.length; j++) {
      const cost = ai === b.charCodeAt(j - 1) ? 0 : 1;
      const del = prev[j] + 1;
      const ins = curr[j - 1] + 1;
      const sub = prev[j - 1] + cost;
      curr[j] = del < ins ? (del < sub ? del : sub) : ins < sub ? ins : sub;
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }
  return prev[b.length];
}

/** Similarity ratio in `[0, 1]`, 1 - normalizedEditDistance. */
function similarity(a: string, b: string): number {
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return 1;
  return 1 - levenshtein(a, b) / longest;
}

/**
 * Choose a ≤`maxBits`-char probe from the middle of `quote`. Anchoring on the
 * middle keeps the probe clear of boundary edits, which are the common case.
 */
function pickProbe(quote: string, maxBits: number): { probe: string; offset: number } {
  if (quote.length <= maxBits) return { probe: quote, offset: 0 };
  const start = Math.floor((quote.length - maxBits) / 2);
  return { probe: quote.slice(start, start + maxBits), offset: start };
}

/**
 * Locate `normQuote` within `normScope` fuzzily. Returns the best verified
 * window, or `null` if nothing clears the similarity threshold.
 *
 * @param normScope  Normalized text of the (already scope-sliced) source.
 * @param normQuote  Normalized, trimmed quote (the same form as the needle).
 */
export function fuzzyLocate(
  normScope: string,
  normQuote: string,
  options: FuzzyOptions = {},
): FuzzyHit | null {
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  if (normQuote.length === 0 || normScope.length === 0) return null;

  const dmp = new diff_match_patch();
  dmp.Match_Threshold = options.matchThreshold ?? DEFAULT_MATCH_THRESHOLD;
  // A generous distance so a probe can be found anywhere in the (already
  // narrowed) scope, not just near its expected location.
  dmp.Match_Distance = Math.max(1000, normScope.length);
  const maxBits = dmp.Match_MaxBits || 32;

  const { probe, offset } = pickProbe(normQuote, maxBits);

  // Coarse location of the probe. `loc` is a hint; the middle of the scope is a
  // neutral starting guess.
  const probeLoc = dmp.match_main(normScope, probe, Math.floor(normScope.length / 2));

  // Centre of the search for the full window. If the probe was found, anchor the
  // window so the probe sits where it did in the quote; otherwise fall back to a
  // full scan.
  const candidates: number[] = [];
  if (probeLoc !== -1) {
    candidates.push(probeLoc - offset);
  }

  // Slide a quote-length window around each candidate centre (plus a slack band)
  // and keep the best-scoring placement. Even with a found probe we test a small
  // neighbourhood, because edits inside the window shift its best alignment.
  const len = normQuote.length;
  const slack = Math.min(maxBits, Math.ceil(len / 2));

  let best: FuzzyHit | null = null;
  const tried = new Set<number>();

  const considerWindow = (rawStart: number): void => {
    const from = Math.max(0, Math.min(rawStart, normScope.length));
    if (tried.has(from)) return;
    tried.add(from);
    const to = Math.min(normScope.length, from + len);
    const window = normScope.slice(from, to);
    const score = similarity(window, normQuote);
    if (best === null || score > best.score) {
      best = { from, to, score };
    }
  };

  if (candidates.length > 0) {
    for (const centre of candidates) {
      for (let d = -slack; d <= slack; d++) {
        considerWindow(centre + d);
      }
    }
  } else {
    // No probe location — scan the whole scope at a coarse stride, then refine.
    const stride = Math.max(1, Math.floor(len / 4));
    for (let s = 0; s <= normScope.length - 1; s += stride) {
      considerWindow(s);
    }
    if (best !== null) {
      const around: number = (best as FuzzyHit).from;
      for (let d = -stride; d <= stride; d++) considerWindow(around + d);
    }
  }

  if (best === null) return null;
  const chosen: FuzzyHit = best;
  if (chosen.score < threshold) return null;

  // Refine the end offset independently. The window above is fixed at the quote
  // length, but an edit that *lengthened* the passage (e.g. a longer word) means
  // the true end sits a few chars past `from + len`. Pick the end, within a
  // slack band, that maximises similarity so the returned range covers the whole
  // matched passage rather than clipping its tail.
  return refineEnd(normScope, normQuote, chosen, slack);
}

/**
 * Given a fixed `from`, search a small band of end offsets for the one that best
 * matches the full quote. Returns the original hit when nothing improves on it.
 */
function refineEnd(
  normScope: string,
  normQuote: string,
  hit: FuzzyHit,
  slack: number,
): FuzzyHit {
  let best = hit;
  const lo = Math.max(hit.from, hit.to - slack);
  const hi = Math.min(normScope.length, hit.to + slack);
  for (let end = lo; end <= hi; end++) {
    const score = similarity(normScope.slice(hit.from, end), normQuote);
    if (score > best.score) {
      best = { from: hit.from, to: end, score };
    }
  }
  return best;
}
