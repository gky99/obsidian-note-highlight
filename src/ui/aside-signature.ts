/**
 * Pure helpers for the aside panel's render gating (no Obsidian runtime).
 *
 * The panel does a full DOM rebuild on `render()`. That rebuild is harmful when
 * nothing displayed actually changed: it resets the panel's scroll position and
 * destroys whatever element the user is mid-clicking (so the *first* click into
 * the panel — which fires `active-leaf-change` → a redundant same-file sync —
 * does nothing, and the panel jumps to the top). {@link annotationsSignature}
 * lets `render()` skip the rebuild when the cards would be byte-identical.
 */
import { normalizeColorValue } from '@/color';
import type { ResolvedAnnotation } from '@/store/store';

/**
 * Order resolved annotations by live document position (start offset), ascending.
 * Orphaned annotations have no range and sink to the end; ties/orphans keep their
 * relative order (Array#sort is stable, ES2019+).
 */
export function sortByPosition(resolved: ResolvedAnnotation[]): ResolvedAnnotation[] {
  const start = (r: ResolvedAnnotation): number =>
    r.result.status === 'anchored' ? r.result.range.from : Number.POSITIVE_INFINITY;
  return [...resolved].sort((a, b) => start(a) - start(b));
}

/**
 * A stable string capturing everything the panel's cards display, in document
 * order: id, color, comment, status/method, position, and source sidecar. Two
 * resolution sets with equal signatures render to identical cards, so `render()`
 * can skip the rebuild — preserving scroll position and any in-progress click.
 */
export function annotationsSignature(resolved: ResolvedAnnotation[]): string {
  return JSON.stringify(
    sortByPosition(resolved).map((r) => [
      r.annotation.id,
      normalizeColorValue(r.annotation.record.color),
      r.annotation.comment,
      r.result.status,
      r.result.status === 'anchored' ? r.result.method : '',
      r.result.status === 'anchored' ? r.result.range.from : -1,
      r.sidecarPath,
    ]),
  );
}
