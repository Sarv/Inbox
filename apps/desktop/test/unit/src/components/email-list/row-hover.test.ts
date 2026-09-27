import { describe, expect, it } from 'vitest';

import { isRowHovered } from '../../../../../src/components/email-list/row-hover';

// ---------------------------------------------------------------------------
// The hover-actions preference (Appearance -> Layout).
//
// What breaks if this goes red: turning hover actions off does nothing — the
// row still swaps its time, attachment clip and category badges for the quick
// actions as the pointer passes over it.
// ---------------------------------------------------------------------------
describe('isRowHovered', () => {
  it('hovers the row the pointer is over when the preference is on', () => {
    expect(isRowHovered(true, 'thread-1', 'thread-1')).toBe(true);
  });

  it('leaves every other row unhovered', () => {
    expect(isRowHovered(true, 'thread-1', 'thread-2')).toBe(false);
  });

  // THE REGRESSION: with the preference off, no row may enter the hovered
  // state — not even the one under the pointer.
  it('never hovers a row when the preference is off', () => {
    expect(isRowHovered(false, 'thread-1', 'thread-1')).toBe(false);
  });

  // Nothing hovered (pointer outside the list) is the resting state.
  it('hovers nothing when no thread is hovered', () => {
    expect(isRowHovered(true, null, 'thread-1')).toBe(false);
  });
});
