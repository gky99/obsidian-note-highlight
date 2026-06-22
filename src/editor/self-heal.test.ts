import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ChangeSet, type ChangeSpec } from '@codemirror/state';

import { buildHighlightDecorations } from './highlights';
import { classifyForRun, DeletionRunTracker, findHighlightRange } from './self-heal';

// The highlight under test occupies [0, 19) ("the quick brown fox") in a 30-char doc.
const HL = { from: 0, to: 19 };
const DOC = 30;
const changes = (...specs: ChangeSpec[]): ChangeSet => ChangeSet.of(specs, DOC);

describe('classifyForRun', () => {
  it('a pure deletion eating the end of the highlight is delete-shrink', () => {
    expect(classifyForRun(HL, changes({ from: 15, to: 19 }))).toBe('delete-shrink');
  });

  it('a pure deletion from the middle is also delete-shrink', () => {
    expect(classifyForRun(HL, changes({ from: 6, to: 12 }))).toBe('delete-shrink');
  });

  it('deleting the whole highlight collapses it', () => {
    expect(classifyForRun(HL, changes({ from: 0, to: 19 }))).toBe('collapse');
  });

  it('an insertion strictly inside is an other-edit', () => {
    expect(classifyForRun(HL, changes({ from: 5, to: 5, insert: 'X' }))).toBe('other-edit');
  });

  it('a replacement inside is an other-edit (not a delete)', () => {
    expect(classifyForRun(HL, changes({ from: 10, to: 13, insert: 'abc' }))).toBe('other-edit');
  });

  it('a replacement spanning the whole highlight collapses it', () => {
    expect(classifyForRun(HL, changes({ from: 0, to: 19, insert: 'brand new' }))).toBe('collapse');
  });

  it('an edit entirely outside the highlight is untouched', () => {
    expect(classifyForRun(HL, changes({ from: 25, to: 28 }))).toBe('untouched');
  });

  it('an insertion exactly at the trailing boundary is untouched (mark is exclusive)', () => {
    expect(classifyForRun(HL, changes({ from: 19, to: 19, insert: 'Y' }))).toBe('untouched');
  });
});

describe('findHighlightRange', () => {
  const set = buildHighlightDecorations(
    [
      { id: 'a', from: 2, to: 9, color: 'yellow' },
      { id: 'b', from: 12, to: 20 },
    ],
    30,
  );

  it('returns the live range of a painted highlight by id', () => {
    expect(findHighlightRange(set, 'a')).toEqual({ from: 2, to: 9 });
    expect(findHighlightRange(set, 'b')).toEqual({ from: 12, to: 20 });
  });

  it('returns null when the id is absent (e.g. it collapsed and was dropped)', () => {
    expect(findHighlightRange(set, 'missing')).toBeNull();
    expect(findHighlightRange(undefined, 'a')).toBeNull();
  });
});

describe('DeletionRunTracker', () => {
  const SETTLE = 15_000;
  let onStart: ReturnType<typeof vi.fn>;
  let onEnd: ReturnType<typeof vi.fn>;
  let tracker: DeletionRunTracker;

  beforeEach(() => {
    vi.useFakeTimers();
    onStart = vi.fn();
    onEnd = vi.fn();
    tracker = new DeletionRunTracker(SETTLE, onStart, onEnd);
  });
  afterEach(() => {
    tracker.destroy();
    vi.useRealTimers();
  });

  it('starts a run on the first delete-shrink and settles after the lull', () => {
    tracker.apply('a', 'delete-shrink');
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onStart).toHaveBeenCalledWith('a');
    expect(tracker.active).toEqual(['a']);

    vi.advanceTimersByTime(SETTLE);
    expect(onEnd).toHaveBeenCalledWith('a', 'settle');
    expect(tracker.active).toEqual([]);
  });

  it('further deletions reset the settle timer (only one start)', () => {
    tracker.apply('a', 'delete-shrink');
    vi.advanceTimersByTime(SETTLE - 1);
    tracker.apply('a', 'delete-shrink'); // resets
    vi.advanceTimersByTime(SETTLE - 1);
    expect(onEnd).not.toHaveBeenCalled(); // would have settled without the reset
    vi.advanceTimersByTime(1);
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onEnd).toHaveBeenCalledWith('a', 'settle');
  });

  it('a collapse during a run ends it immediately (no settle)', () => {
    tracker.apply('a', 'delete-shrink');
    tracker.apply('a', 'collapse');
    expect(onEnd).toHaveBeenCalledWith('a', 'collapse');
    expect(tracker.active).toEqual([]);
    vi.advanceTimersByTime(SETTLE);
    expect(onEnd).toHaveBeenCalledTimes(1); // the stale timer did not fire
  });

  it('an edit into the region during a run ends it (commit survivor)', () => {
    tracker.apply('a', 'delete-shrink');
    tracker.apply('a', 'other-edit');
    expect(onEnd).toHaveBeenCalledWith('a', 'edit');
    expect(tracker.active).toEqual([]);
  });

  it('a collapse or edit with no active run does nothing', () => {
    tracker.apply('a', 'collapse');
    tracker.apply('a', 'other-edit');
    expect(onStart).not.toHaveBeenCalled();
    expect(onEnd).not.toHaveBeenCalled();
  });

  it('runs are independent per highlight id', () => {
    tracker.apply('a', 'delete-shrink');
    tracker.apply('b', 'delete-shrink');
    expect(onStart.mock.calls.map((c) => c[0]).sort()).toEqual(['a', 'b']);
    tracker.apply('a', 'collapse'); // ends a only
    expect(tracker.active).toEqual(['b']);
    vi.advanceTimersByTime(SETTLE);
    expect(onEnd).toHaveBeenCalledWith('b', 'settle');
  });

  it('finishAll settles every active run immediately (e.g. on blur)', () => {
    tracker.apply('a', 'delete-shrink');
    tracker.apply('b', 'delete-shrink');
    tracker.finishAll('blur');
    expect(onEnd).toHaveBeenCalledWith('a', 'blur');
    expect(onEnd).toHaveBeenCalledWith('b', 'blur');
    expect(tracker.active).toEqual([]);
    vi.advanceTimersByTime(SETTLE);
    expect(onEnd).toHaveBeenCalledTimes(2); // the stale timers did not also fire
  });

  it('cancelAll abandons runs without committing (no onEnd) — undo re-checks instead', () => {
    tracker.apply('a', 'delete-shrink');
    tracker.apply('b', 'delete-shrink');
    tracker.cancelAll();
    expect(tracker.active).toEqual([]);
    vi.advanceTimersByTime(SETTLE);
    expect(onEnd).not.toHaveBeenCalled(); // the abandoned timers did not fire
  });

  it('destroy releases every active run', () => {
    tracker.apply('a', 'delete-shrink');
    tracker.apply('b', 'delete-shrink');
    tracker.destroy();
    expect(onEnd).toHaveBeenCalledWith('a', 'destroy');
    expect(onEnd).toHaveBeenCalledWith('b', 'destroy');
    expect(tracker.active).toEqual([]);
  });
});
