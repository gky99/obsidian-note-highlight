/**
 * Whitespace normalization with an index map back to true offsets (§4.8).
 *
 * Web clips get reflowed and re-wrapped constantly — the #1 cause of "it broke
 * on re-clip". The resolver therefore matches on a whitespace-collapsed
 * *projection* of the source and maps successful matches back to real offsets.
 *
 * Markdown markers (`##`, `**`) are intentionally preserved, never stemmed, so
 * heading-spanning quotes can match their raw source form (§6.4).
 */
import type { Range } from '@/model/types';
import { qhash } from './hash';

export interface NormalizedText {
  /** Whitespace-collapsed text: every maximal run of whitespace → one space. */
  text: string;
  /**
   * `map[i]` is the offset in the original string where normalized character
   * `i` originated. Length is `text.length + 1`; the final entry is the
   * original string's length (an end sentinel), so a normalized half-open
   * range `[from, to)` maps cleanly to original `[map[from], map[to])`.
   */
  map: number[];
}

const WS = /\s/;

/**
 * Collapse every maximal run of whitespace into a single ASCII space, recording
 * for each emitted character the original offset it came from. A collapsed run
 * maps to the offset where the run *began*, so the original range excludes
 * trailing collapsed whitespace.
 */
export function normalize(input: string): NormalizedText {
  const chars: string[] = [];
  const map: number[] = [];
  const n = input.length;
  let i = 0;
  while (i < n) {
    if (WS.test(input[i])) {
      const start = i;
      do {
        i++;
      } while (i < n && WS.test(input[i]));
      chars.push(' ');
      map.push(start);
    } else {
      chars.push(input[i]);
      map.push(i);
      i++;
    }
  }
  map.push(n);
  return { text: chars.join(''), map };
}

/** Map a normalized half-open range `[from, to)` back to original offsets. */
export function mapRange(norm: NormalizedText, from: number, to: number): Range {
  const last = norm.map.length - 1;
  const a = Math.max(0, Math.min(from, last));
  const b = Math.max(a, Math.min(to, last));
  return { from: norm.map[a], to: norm.map[b] };
}

/**
 * Trimmed, whitespace-collapsed projection of a quote — the canonical form used
 * both as the search needle and as the input to {@link quoteHash}.
 */
export function normalizeQuote(quote: string): string {
  return normalize(quote).text.trim();
}

/** Short hash of a quote's normalized form; stored as `qhash` (§5.4). */
export function quoteHash(quote: string): string {
  return qhash(normalizeQuote(quote));
}
