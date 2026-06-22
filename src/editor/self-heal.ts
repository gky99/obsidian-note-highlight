/**
 * In-session self-healing: the delete-by-word guard (Design.md §6.5).
 *
 * The load path (`store.resolveAll`) already self-heals after Obsidian autosaves:
 * a benign in-quote edit fuzzy-repairs to the new bytes, a one-shot deletion
 * orphans carrying the original quote, and surrounding edits are tolerated. The
 * one case it gets wrong on its own is **gradual** deletion: deleting a highlight
 * a word at a time, *pausing* long enough to autosave, would repair the stored
 * quote down to a fragment ("the") before it finally vanishes — so the orphan
 * would show a meaningless scrap instead of the original passage.
 *
 * This module closes that gap with a CM6 view plugin that watches transactions,
 * classifies each one's effect on every painted highlight, and runs a
 * per-highlight **deletion-run** state machine. While a highlight is being eaten
 * into, it tells the store to *suppress* repair for that id (hold the original)
 * AND the store stops repainting it — so the live CM decoration keeps the clean,
 * exactly-mapped survivor range. When the run **settles** (a 15 s lull or focus
 * loss), is **interrupted** by an edit, or **collapses**, the plugin reads that
 * live range and either **commits the survivor precisely** (`onRunCommit` with the
 * editor's exact `[from, to)` + live text — fuzzy resolution would *overshoot* a
 * shortened passage, capturing trailing text) or, if it collapsed, **orphans with
 * the original** (`onRunCollapse`, which the load path resolves).
 *
 * The bug-prone parts — {@link classifyForRun} and {@link DeletionRunTracker} —
 * are pure and unit-tested (`@codemirror/state` is a real dep under vitest; the
 * timer is exercised with fake timers); {@link findHighlightRange} too. The
 * view-plugin shell is the only piece that needs a live editor.
 */
import type { ChangeSet } from '@codemirror/state';
import { ViewPlugin, type EditorView, type ViewUpdate, type DecorationSet } from '@codemirror/view';

import { highlightField } from './highlights';

/** A half-open range in document offsets. */
export interface SimpleRange {
  from: number;
  to: number;
}

/**
 * How one transaction affects a single highlight:
 *  - `untouched`     — no change overlaps it (it may still shift; not our concern);
 *  - `delete-shrink` — a pure deletion ate into it but it survives (run fuel);
 *  - `collapse`      — it is now empty (fully deleted/replaced away);
 *  - `other-edit`    — an insertion/replacement landed inside it (it survives).
 */
export type RunKind = 'untouched' | 'delete-shrink' | 'collapse' | 'other-edit';

/**
 * Classify a transaction's effect on the highlight at `old` (pre-transaction
 * coordinates). Pure over the {@link ChangeSet}; the haystack is never read.
 */
export function classifyForRun(old: SimpleRange, changes: ChangeSet): RunKind {
  let deletionOverlap = false;
  let insertionInside = false;
  let fullyContained = false;
  changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    // A single change whose deleted span covers the whole highlight (delete or
    // replace) — the original bytes are gone wholesale (the fully-contains case).
    if (fromA <= old.from && toA >= old.to) fullyContained = true;
    // Does the *deleted* span [fromA, toA) overlap the highlight's interior?
    if (Math.min(toA, old.to) > Math.max(fromA, old.from)) {
      deletionOverlap = true;
      if (inserted.length > 0) insertionInside = true; // a replacement is an edit, not a delete
    } else if (inserted.length > 0 && fromA > old.from && fromA < old.to) {
      // A pure insertion strictly inside the highlight (no deleted-span overlap).
      insertionInside = true;
    }
  });

  if (!deletionOverlap && !insertionInside) return 'untouched';
  if (fullyContained) return 'collapse';

  // Map the endpoints inward (from biases right, to biases left) so a boundary
  // insertion doesn't read as growth and a full deletion reads as collapse.
  const newFrom = changes.mapPos(old.from, 1);
  const newTo = changes.mapPos(old.to, -1);
  if (newTo <= newFrom) return 'collapse';
  if (insertionInside) return 'other-edit';
  return 'delete-shrink';
}

/** Why a run ended (diagnostic; the store treats them all as "release"). */
export type RunEndReason = 'settle' | 'collapse' | 'edit' | 'destroy' | 'blur';

/**
 * Per-highlight deletion-run state machine. A run begins on the first
 * `delete-shrink`, is kept alive (timer reset) by each subsequent one, and ends
 * on a 15 s lull (`settle`), an `other-edit` into the region, a `collapse`, or
 * teardown. `onStart`/`onEnd` bracket the suppression window; runs are
 * independent per id, so unrelated edits elsewhere never disturb them.
 */
export class DeletionRunTracker {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly settleMs: number,
    private readonly onStart: (id: string) => void,
    private readonly onEnd: (id: string, reason: RunEndReason) => void,
  ) {}

  /** Feed one highlight's classified edit into the machine. */
  apply(id: string, kind: RunKind): void {
    switch (kind) {
      case 'delete-shrink':
        if (!this.timers.has(id)) this.onStart(id);
        this.arm(id);
        break;
      case 'collapse':
        this.finish(id, 'collapse');
        break;
      case 'other-edit':
        this.finish(id, 'edit'); // no-op unless a run is active
        break;
      case 'untouched':
        break;
    }
  }

  /** Active run ids (for tests / introspection). */
  get active(): string[] {
    return [...this.timers.keys()];
  }

  private arm(id: string): void {
    const existing = this.timers.get(id);
    if (existing !== undefined) clearTimeout(existing);
    this.timers.set(
      id,
      setTimeout(() => this.finish(id, 'settle'), this.settleMs),
    );
  }

  private finish(id: string, reason: RunEndReason): void {
    const timer = this.timers.get(id);
    if (timer === undefined) return; // not an active run (e.g. one-shot collapse)
    clearTimeout(timer);
    this.timers.delete(id);
    this.onEnd(id, reason);
  }

  /**
   * Finish every active run now, regardless of its timer — e.g. the editor lost
   * focus (the user moved on, so don't wait out the 15 s lull) or is tearing down.
   */
  finishAll(reason: RunEndReason): void {
    for (const id of [...this.timers.keys()]) this.finish(id, reason);
  }

  /**
   * Abandon every active run *without* committing (clears the timers only). Used
   * when an undo/redo will re-anchor the highlights by content instead — their
   * live decoration can no longer be trusted (a re-inserted edge doesn't re-grow
   * an exclusive mark).
   */
  cancelAll(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  /** Release every active run (view teardown), so suppression never leaks. */
  destroy(): void {
    this.finishAll('destroy');
  }
}

/** Read the `data-anno-id` off a (mark) decoration value. */
function annoIdOf(value: unknown): string | undefined {
  return (value as { spec?: { attributes?: Record<string, string> } }).spec?.attributes?.[
    'data-anno-id'
  ];
}

/**
 * Find a painted highlight's live range in a decoration set by its `data-anno-id`,
 * or null if it isn't present (e.g. it collapsed to empty and was dropped). Pure
 * over the {@link DecorationSet}; unit-tested.
 */
export function findHighlightRange(set: DecorationSet | undefined, id: string): SimpleRange | null {
  if (!set) return null;
  const cursor = set.iter();
  while (cursor.value) {
    if (annoIdOf(cursor.value) === id) return { from: cursor.from, to: cursor.to };
    cursor.next();
  }
  return null;
}

/** Options wiring the in-session guard to the store (via the plugin). */
export interface SelfHealOptions {
  /** Lull after which an unfinished deletion run is considered settled (ms). */
  settleMs: number;
  /** A highlight entered an active deletion run → suppress its repair. */
  onRunStart: (id: string) => void;
  /**
   * A run ended with the highlight surviving → commit the survivor from the
   * editor's exact live range `[from, to)` + full document text (precise; no fuzzy).
   */
  onRunCommit: (id: string, from: number, to: number, docText: string) => void;
  /** A run ended with the highlight gone (collapsed) → orphan with the original. */
  onRunCollapse: (id: string) => void;
  /**
   * An undo/redo touched the doc while runs were active → re-anchor each by
   * content against the live `docText` (the decoration is no longer reliable).
   */
  onRunRecheck: (id: string, docText: string) => void;
}

/**
 * The CM6 view-plugin shell: on each doc change, classify every painted highlight
 * (read by `data-anno-id` off the live decoration set) and drive the tracker. On
 * a run end it reads the highlight's *current* live range — kept clean because the
 * store stops repainting it during the run — and commits the survivor precisely,
 * or orphans if it has collapsed. State fields precede this in the extension, so
 * the highlight field is current when we read it.
 */
export function selfHealPlugin(options: SelfHealOptions) {
  return ViewPlugin.fromClass(
    class {
      private readonly view: EditorView;
      private readonly tracker: DeletionRunTracker;

      constructor(view: EditorView) {
        this.view = view;
        this.tracker = new DeletionRunTracker(options.settleMs, options.onRunStart, (id) =>
          this.end(id),
        );
      }

      private end(id: string): void {
        const range = findHighlightRange(this.view.state.field(highlightField, false), id);
        if (range) options.onRunCommit(id, range.from, range.to, this.view.state.doc.toString());
        else options.onRunCollapse(id);
      }

      private recheckRuns(): void {
        const ids = this.tracker.active;
        if (ids.length === 0) return;
        const docText = this.view.state.doc.toString();
        for (const id of ids) options.onRunRecheck(id, docText);
        this.tracker.cancelAll();
      }

      update(u: ViewUpdate): void {
        // Losing editor focus settles every active deletion run at once — the user
        // moved on, so commit the survivor now instead of waiting out the timer.
        if (u.focusChanged && !u.view.hasFocus) this.tracker.finishAll('blur');
        if (!u.docChanged) return;
        // An undo/redo restores content the CM mark mapping can't reflect (a
        // re-inserted edge doesn't re-grow an exclusive mark), so the decoration is
        // stale: abandon the runs and re-anchor the affected highlights by content.
        if (u.transactions.some((t) => t.isUserEvent('undo') || t.isUserEvent('redo'))) {
          this.recheckRuns();
          return;
        }
        const old = u.startState.field(highlightField, false);
        if (!old || old.size === 0) return;
        const cursor = old.iter();
        while (cursor.value) {
          const id = annoIdOf(cursor.value);
          if (id) {
            this.tracker.apply(id, classifyForRun({ from: cursor.from, to: cursor.to }, u.changes));
          }
          cursor.next();
        }
      }

      destroy(): void {
        this.tracker.destroy();
      }
    },
  );
}
