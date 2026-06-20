/**
 * Plan an import: turn a clip's source text plus the Web Highlights marks made on
 * its page into a list of highlights ready to write as sidecar annotations.
 *
 * Each mark's highlighted text is re-anchored into the source by {@link locateMark},
 * which matches on an aggressively normalized projection (markers stripped,
 * punctuation folded, whitespace removed) and maps the hit back to exact source
 * offsets — best-effort, first occurrence. A mark that can't be located is
 * reported as `unmatched` rather than guessed at (the "orphan, never mis-point"
 * rule, §4.6).
 *
 * The plan also enforces "one passage, one highlight" (§4.4): a mark whose range
 * overlaps an existing annotation — or one already accepted earlier in this batch
 * — is dropped as `skipped`. This makes a re-run idempotent: marks imported last
 * time overlap the highlights they created and are skipped, never duplicated.
 *
 * Pure: no `obsidian`, no DOM. The runtime importer feeds it source text + the
 * existing anchored ranges and writes the result via the store.
 */

import type { Range } from '@/model/types';
import { rangesOverlap } from '@/reading/project';

import { locateMark } from './locate';
import { markColor, markComment, type Mark } from './web-highlights';

/** A highlight the import will create, located in the clip source. */
export interface PlannedHighlight {
  /** Source range `[from, to)` the mark's text was located at. */
  range: Range;
  /** Stored color (the mark's hex, or the fallback when it had none). */
  color: string;
  /** Markdown comment derived from the mark's HTML note ('' when none). */
  comment: string;
  /** The originating mark (for reporting / debugging). */
  mark: Mark;
}

export interface PlanOptions {
  /** Color to use when a mark carries none. */
  defaultColor: string;
}

export interface ImportPlan {
  /** Highlights to create, in source order. */
  planned: PlannedHighlight[];
  /** Marks whose text could not be located in the source. */
  unmatched: Mark[];
  /** Marks dropped because their range overlaps an existing/earlier highlight. */
  skipped: number;
}

/**
 * Build the {@link ImportPlan} for one clip. `existing` is the set of ranges
 * already covered by anchored annotations on the source (so we never stack).
 */
export function planImport(
  sourceText: string,
  marks: Mark[],
  existing: Range[],
  opts: PlanOptions,
): ImportPlan {
  const planned: PlannedHighlight[] = [];
  const unmatched: Mark[] = [];
  let skipped = 0;

  // Accumulates existing ranges plus the ones we accept, so intra-batch overlaps
  // (and overlaps with prior annotations) are both rejected against one set.
  const occupied: Range[] = [...existing];

  for (const mark of marks) {
    const text = mark.text ?? '';
    if (text.trim().length === 0) continue;

    const range = locateMark(sourceText, text);
    if (!range) {
      unmatched.push(mark);
      continue;
    }
    if (occupied.some((r) => rangesOverlap(range.from, range.to, r.from, r.to))) {
      skipped++;
      continue;
    }

    occupied.push(range);
    planned.push({
      range,
      color: markColor(mark) ?? opts.defaultColor,
      comment: markComment(mark),
      mark,
    });
  }

  // Write in source order so the sidecar reads top-to-bottom like the note.
  planned.sort((a, b) => a.range.from - b.range.from);
  return { planned, unmatched, skipped };
}
