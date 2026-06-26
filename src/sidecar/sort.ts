/**
 * Sort the highlight units in a sidecar by source reading order, **within each
 * heading section**, without disturbing the file's structure.
 *
 * Rules (confirmed with the design, see Design.md §5.7):
 *  - **Every heading line is a fixed divider** (any level — `#`…`######`). Highlights
 *    are sorted only against the others in the same run between consecutive headings;
 *    nothing crosses a heading and **no heading moves** (conservative nesting — a
 *    quote directly under a `#` is never mixed with quotes under a nested `##`).
 *  - A highlight's **trailing custom text travels with it**: a unit's movable block is
 *    its blockquote + comment + any content up to the next highlight, heading, or
 *    `anno` block. Text between a heading and its *first* highlight stays with the
 *    heading (section intro), not moved.
 *  - The machine `anno` blocks are **immovable** (they bind by id; order is irrelevant)
 *    and so is all other custom content — only highlight blocks are reordered, in
 *    place, by swapping their text among the slots they already occupy.
 *
 * `positionOf(id)` returns the highlight's source offset (e.g. the resolved
 * `range.from`), or `null` when it can't be located — orphans sink to the end of
 * their section, keeping their prior relative order (the sort is stable).
 *
 * Pure: it never resolves anything itself; the caller supplies positions.
 */
import { parseLayout, type UnitLayout } from './parse';

/** An ATX heading line (`#`…`######` followed by a space or end of line). */
const HEADING = /^#{1,6}(?:\s|$)/;

export function sortHighlights(text: string, positionOf: (id: string) => number | null): string {
  const layout = parseLayout(text);
  const { bodyLines, units } = layout;
  if (units.length < 2) return text; // nothing to reorder

  const headingLines: number[] = [];
  for (let i = 0; i < bodyLines.length; i++) {
    if (HEADING.test(bodyLines[i])) headingLines.push(i);
  }

  // A movable block ends at the next structural boundary: a heading, another unit's
  // start, or an `anno` block — whichever comes first. So the trailing text after a
  // unit's comment is absorbed, but headings / other units / machine blocks are not.
  const boundaries = [
    ...headingLines,
    ...units.map((u) => u.unitStart),
    ...layout.annoSpans.map((a) => a.start),
    bodyLines.length,
  ].sort((a, b) => a - b);
  const blockEndAfter = (start: number): number =>
    boundaries.find((b) => b > start) ?? bodyLines.length;

  // The section of a unit = the nearest heading line above its start (−1 = before any).
  const sectionOf = (start: number): number => {
    let section = -1;
    for (const h of headingLines) {
      if (h < start) section = h;
      else break;
    }
    return section;
  };

  // Group units by section, preserving document order (units arrive in order).
  const sections = new Map<number, UnitLayout[]>();
  for (const u of units) {
    const key = sectionOf(u.unitStart);
    const group = sections.get(key);
    if (group) group.push(u);
    else sections.set(key, [u]);
  }

  // For each section, sort its units by source position (stable; orphans last) and
  // re-assign block texts to the original slots, in sorted order.
  const blockText = (u: UnitLayout): string =>
    bodyLines.slice(u.unitStart, blockEndAfter(u.unitStart)).join('\n');
  const emitAt = new Map<number, string>(); // slot start → text to emit there
  const slotEnd = new Map<number, number>(); // slot start → original slot end
  for (const group of sections.values()) {
    const sorted = [...group].sort((a, b) => {
      const pa = positionOf(a.id);
      const pb = positionOf(b.id);
      return (pa ?? Infinity) - (pb ?? Infinity);
    });
    group.forEach((slot, i) => {
      emitAt.set(slot.unitStart, blockText(sorted[i]));
      slotEnd.set(slot.unitStart, blockEndAfter(slot.unitStart));
    });
  }

  // Rebuild: copy verbatim except at slot starts, where the sorted block is emitted
  // and the original slot skipped. Everything else keeps its exact line position.
  const out: string[] = [];
  let j = 0;
  while (j < bodyLines.length) {
    const replacement = emitAt.get(j);
    if (replacement !== undefined) {
      out.push(replacement);
      j = slotEnd.get(j) ?? j + 1;
      continue;
    }
    out.push(bodyLines[j]);
    j++;
  }

  return `${layout.frontmatterRaw}\n${out.join('\n')}`;
}
