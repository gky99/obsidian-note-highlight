/**
 * Pure helpers for combining the annotation files that belong to one source clip
 * (Design.md §4.1). A clip's identity is its `annotates` link, not a filename, so a
 * clip can have **several** annotation files (a copy, a sync conflict, a deliberate
 * split). The store loads them all, resolves each independently, then asks this module
 * to pick a deterministic *primary* and fold the rest in.
 *
 * Obsidian-free so it can be unit-tested: it imports only the pure {@link ResolveResult}
 * type and works structurally over whatever resolved-annotation shape the store passes.
 */
import type { ResolveResult } from '@/resolver';

/** A candidate annotation file for a source: its path and last-modified time. */
export interface Candidate {
  path: string;
  mtime: number;
}

/** The minimal shape {@link mergeResolved} needs from a resolved annotation. */
export interface MergeItem {
  annotation: { id: string };
  result: ResolveResult;
  sidecarPath: string;
}

/** A file's resolved annotations, tagged with the file they came from. */
export interface PerFile<T> {
  sidecarPath: string;
  resolved: T[];
}

/**
 * Choose the *primary* annotation file for a source from one or more candidates.
 * The primary drives both new-highlight writes and overlap precedence on render.
 *
 * Precedence (first match wins):
 *  1. the session-sticky `bound` path, if it is among the candidates (keeps a clip's
 *     file stable across a load once we've committed to it);
 *  2. the candidate sitting at `canonicalPath` (the configured default location);
 *  3. the most recently modified candidate (newest `mtime`);
 *  4. the lexicographically smallest `path` (a stable final tiebreak).
 *
 * Must be called with at least one candidate.
 */
export function pickPrimary(candidates: Candidate[], canonicalPath: string, bound?: string): string {
  if (candidates.length === 0) throw new Error('pickPrimary: no candidates');
  if (bound && candidates.some((c) => c.path === bound)) return bound;
  if (candidates.some((c) => c.path === canonicalPath)) return canonicalPath;
  let best = candidates[0];
  for (const c of candidates.slice(1)) {
    if (c.mtime > best.mtime || (c.mtime === best.mtime && c.path < best.path)) best = c;
  }
  return best.path;
}

/** An anchored item's `[from, to)` range, or `null` if it's orphaned. */
function rangeOf(item: MergeItem): { from: number; to: number } | null {
  return item.result.status === 'anchored' ? item.result.range : null;
}

/**
 * Union the resolved annotations of all of a clip's files, with the **primary file
 * always winning** any conflict — upholding "one passage, one highlight" across files.
 *
 * The primary's annotations are kept wholesale. A non-primary annotation is dropped
 * when it duplicates a kept one — either by `id` (a wholesale copy shares ids) or by an
 * overlapping anchored range (independent marks on the same passage). Orphaned items
 * never overlap, so they're only ever dropped by id. Non-primary files are walked in
 * path order so the result is deterministic.
 */
export function mergeResolved<T extends MergeItem>(perFile: PerFile<T>[], primaryPath: string): T[] {
  const primary = perFile.find((f) => f.sidecarPath === primaryPath);
  const others = perFile
    .filter((f) => f.sidecarPath !== primaryPath)
    .sort((a, b) => (a.sidecarPath < b.sidecarPath ? -1 : a.sidecarPath > b.sidecarPath ? 1 : 0));

  const kept: T[] = primary ? [...primary.resolved] : [];
  const keptIds = new Set(kept.map((r) => r.annotation.id));
  const keptRanges = kept.map(rangeOf).filter((r): r is { from: number; to: number } => r !== null);

  for (const file of others) {
    for (const item of file.resolved) {
      if (keptIds.has(item.annotation.id)) continue;
      const range = rangeOf(item);
      if (range && keptRanges.some((k) => Math.max(range.from, k.from) < Math.min(range.to, k.to))) {
        continue;
      }
      kept.push(item);
      keptIds.add(item.annotation.id);
      if (range) keptRanges.push(range);
    }
  }
  return kept;
}
