/**
 * Structure-preserving in-place edit of a sidecar `.md` file.
 *
 * The original write path was `parseSidecar → mutate → serializeSidecar`, which
 * regenerates the WHOLE file from the parsed model. Anything the model doesn't
 * capture — custom headings, intros, between-unit prose, bottom summaries, custom
 * frontmatter keys, and the on-disk *grouping/order* of `anno` blocks — was lost
 * on every write. {@link patchSidecar} keeps every non-annotation byte and edits
 * only what changed:
 *
 *  - an unchanged annotation's unit and `anno` block are copied **verbatim**;
 *  - a changed one's unit and/or `anno` block is re-serialized **in place**;
 *  - a NEW annotation's unit is inserted immediately before the last contiguous
 *    `anno`-block group, and its `anno` block is appended after the last existing
 *    one (the §5.5 insertion rules);
 *  - a deleted one's unit and `anno` block are removed;
 *  - frontmatter is kept verbatim unless a field actually changed.
 *
 * Parsing is **strict** (via {@link parseLayout}) — a malformed unit throws, so a
 * read-modify-write refuses rather than clobbering, exactly like the old path.
 *
 * Invariants (see `patch.test.ts`):
 *  - `patchSidecar(t, () => {}) === t` for a normalized `t` (no edits → verbatim);
 *  - `parseSidecar(patchSidecar(t, m))` is content-equal (by id) to `m(parseSidecar(t))`.
 */
import type { Annotation, Sidecar } from '@/model/types';

import { parseLayout, type UnitLayout } from './parse';
import { serializeAnnoBlock, serializeUnit } from './serialize';
import { dumpFrontmatter } from './yaml';

/** Structural equality via canonical JSON (records/frontmatter are plain JSON-ish maps). */
function jsonEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Did a kept annotation's human *unit* (quote or comment prose) change? */
function unitChanged(before: Annotation, after: Annotation): boolean {
  return before.quote !== after.quote || before.comment !== after.comment;
}

/** Did a kept annotation's machine `anno` block change (record, or the comment-presence hint)? */
function annoChanged(before: Annotation, after: Annotation): boolean {
  return (
    !jsonEqual(before.record, after.record) ||
    (before.comment.length > 0) !== (after.comment.length > 0)
  );
}

export function patchSidecar(originalText: string, mutate: (s: Sidecar) => void): string {
  const layout = parseLayout(originalText);
  const before = layout.sidecar;
  const after: Sidecar = structuredClone(before);
  mutate(after);

  const frontmatter = jsonEqual(before.frontmatter, after.frontmatter)
    ? layout.frontmatterRaw
    : `---\n${dumpFrontmatter(after.frontmatter).replace(/\n$/, '')}\n---`;

  const beforeIds = new Set(before.annotations.map((a) => a.id));
  const beforeById = new Map(before.annotations.map((a) => [a.id, a]));
  const afterById = new Map(after.annotations.map((a) => [a.id, a]));
  // New annotations, in the order the mutation added them.
  const added = after.annotations.filter((a) => !beforeIds.has(a.id));

  // Index each span's start line so the walk can branch in O(1).
  interface Span {
    kind: 'unit' | 'anno';
    layout: UnitLayout;
  }
  const spanAt = new Map<number, Span>();
  for (const u of layout.units) {
    spanAt.set(u.unitStart, { kind: 'unit', layout: u });
    spanAt.set(u.annoStart, { kind: 'anno', layout: u });
  }

  const { bodyLines, newUnitAt, newAnnoAt } = layout;
  const out: string[] = [];
  const push = (text: string): void => {
    for (const line of text.split('\n')) out.push(line);
  };
  const lastBlank = (): boolean => out.length === 0 || out[out.length - 1].trim() === '';

  let unitsInserted = false;
  let annosInserted = false;
  const insertAddedUnits = (): void => {
    if (unitsInserted) return;
    unitsInserted = true;
    if (added.length === 0) return;
    if (!lastBlank()) out.push('');
    for (const a of added) {
      push(serializeUnit(a));
      out.push('');
    }
  };
  const insertAddedAnnos = (): void => {
    if (annosInserted) return;
    annosInserted = true;
    if (added.length === 0) return;
    if (!lastBlank()) out.push('');
    added.forEach((a, k) => {
      push(serializeAnnoBlock(a));
      if (k < added.length - 1) out.push('');
    });
  };

  let j = 0;
  while (j < bodyLines.length) {
    if (j === newUnitAt) insertAddedUnits();
    if (j === newAnnoAt) insertAddedAnnos();

    const span = spanAt.get(j);
    if (!span) {
      out.push(bodyLines[j]);
      j++;
      continue;
    }

    const id = span.layout.id;
    const isUnit = span.kind === 'unit';
    const start = isUnit ? span.layout.unitStart : span.layout.annoStart;
    const end = isUnit ? span.layout.unitEnd : span.layout.annoEnd;

    if (!afterById.has(id)) {
      // Deleted: drop the span and one trailing blank so no double-blank is left.
      j = end < bodyLines.length && bodyLines[end].trim() === '' ? end + 1 : end;
      continue;
    }

    const a = afterById.get(id)!;
    const b = beforeById.get(id)!;
    const changed = isUnit ? unitChanged(b, a) : annoChanged(b, a);
    if (changed) push(isUnit ? serializeUnit(a) : serializeAnnoBlock(a));
    else for (let k = start; k < end; k++) out.push(bodyLines[k]);
    j = end;
  }

  // Insertions whose anchor is the end of the body (e.g. a sidecar with no anno
  // blocks yet): units first, then anno blocks.
  if (newUnitAt >= bodyLines.length) insertAddedUnits();
  if (newAnnoAt >= bodyLines.length) insertAddedAnnos();

  return `${frontmatter}\n${out.join('\n')}`;
}
