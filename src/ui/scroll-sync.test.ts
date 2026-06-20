import { describe, expect, it } from 'vitest';

import { pickTopmostVisible, type HighlightBox } from './scroll-sync';

const box = (id: string, top: number, bottom: number): HighlightBox => ({ id, top, bottom });

describe('pickTopmostVisible', () => {
  it('returns null when there are no highlights', () => {
    expect(pickTopmostVisible([], 0, 500)).toBeNull();
  });

  it('returns null when every highlight is off screen', () => {
    const boxes = [box('above', -80, -20), box('below', 600, 660)];
    expect(pickTopmostVisible(boxes, 0, 500)).toBeNull();
  });

  it('picks the highlight with the smallest top among the visible ones', () => {
    const boxes = [box('mid', 200, 230), box('top', 40, 70), box('low', 400, 430)];
    expect(pickTopmostVisible(boxes, 0, 500)).toBe('top');
  });

  it('ignores highlights scrolled above the viewport top', () => {
    // 'gone' ends above the top; 'first' straddles into view and should win.
    const boxes = [box('gone', -50, -1), box('first', -10, 20), box('next', 120, 150)];
    expect(pickTopmostVisible(boxes, 0, 500)).toBe('first');
  });

  it('counts a highlight straddling the bottom edge as visible', () => {
    const boxes = [box('straddle', 480, 540)];
    expect(pickTopmostVisible(boxes, 0, 500)).toBe('straddle');
  });

  it('treats a box flush at the bottom edge as off screen (half-open viewport)', () => {
    // top === viewBottom: not strictly less than, so not visible.
    expect(pickTopmostVisible([box('edge', 500, 560)], 0, 500)).toBeNull();
  });
});
