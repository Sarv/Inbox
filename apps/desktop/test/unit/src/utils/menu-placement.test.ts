import { describe, expect, it } from 'vitest';

import { MENU_WIDTH, placeMenu, scrollTopToReveal } from '../../../../src/utils/menu-placement';

/**
 * Where the app's own menus open, and how a scrolling menu follows the focus.
 *
 * What breaks if this file goes red: a menu drawn partly off-screen (its lower
 * items, or the whole of it past the right edge, unreachable), a menu opening
 * as a two-item sliver where the other side had room, or — for the scroll —
 * keyboard focus landing on an item the reader cannot see, where Enter then
 * runs an action they never saw (Delete).
 */

const VIEWPORT = { width: 1024, height: 768 };

/** A button's box, as `getBoundingClientRect` reports it. */
const box = (top: number, right: number, height = 28, width = 28) =>
  ({ top, bottom: top + height, right, left: right - width, width, height, x: right - width, y: top, toJSON: () => ({}) }) as DOMRect;

describe('placeMenu — from the three-dot button', () => {
  // Unchanged from before the split: right-aligned under the button, the
  // height capped to the room below.
  it('opens downward, right-aligned to the button', () => {
    const rect = box(100, 600);
    expect(placeMenu({ kind: 'rect', rect }, VIEWPORT)).toEqual({
      left: 600 - MENU_WIDTH,
      top: rect.bottom + 4,
      maxHeight: VIEWPORT.height - rect.bottom - 8,
    });
  });

  // A button near the left edge must not push the menu off-screen.
  it('keeps the menu off the left edge', () => {
    expect(placeMenu({ kind: 'rect', rect: box(100, 40) }, VIEWPORT).left).toBe(8);
  });

  // Regression guard for the flip: near the bottom, with more room above, the
  // menu opens upward — a downward one would be a sliver of two items.
  it('flips upward near the bottom edge', () => {
    const rect = box(700, 600);
    expect(placeMenu({ kind: 'rect', rect }, VIEWPORT)).toEqual({
      left: 600 - MENU_WIDTH,
      bottom: VIEWPORT.height - rect.top + 4,
      maxHeight: rect.top - 8,
    });
  });

  // The preference: with enough room to be usable below, it stays downward even
  // when there is MORE room above — the first items sit right at the button.
  it('stays downward while the room below is usable', () => {
    const rect = box(500, 600); // 232px below, 492 above
    expect(placeMenu({ kind: 'rect', rect }, VIEWPORT).top).toBe(rect.bottom + 4);
  });

  // And downward when cramped both ways but less cramped below.
  it('stays downward when cramped, if below is still the roomier side', () => {
    const small = { width: 1024, height: 300 };
    const rect = box(100, 600); // 164 below, 92 above
    expect(placeMenu({ kind: 'rect', rect }, small).top).toBe(rect.bottom + 4);
  });
});

describe('placeMenu — at a pointer', () => {
  // A context menu opens with its corner on the pointer.
  it('opens at the point, downward', () => {
    expect(placeMenu({ kind: 'point', x: 100, y: 120 }, VIEWPORT)).toEqual({
      left: 100,
      top: 120,
      maxHeight: VIEWPORT.height - 120 - 8,
    });
  });

  // Near the right edge it flips to the pointer's left, like a native menu,
  // rather than running off-screen.
  it('flips to the left of the pointer near the right edge', () => {
    expect(placeMenu({ kind: 'point', x: 1000, y: 120 }, VIEWPORT).left).toBe(1000 - MENU_WIDTH);
  });

  // Too narrow to fit on either side of the pointer: flipped left and then
  // held off the left edge, never drawn past it.
  it('clamps into a viewport too narrow for either side', () => {
    expect(placeMenu({ kind: 'point', x: 150, y: 120 }, { width: 300, height: 768 }).left).toBe(8);
  });

  // Near the bottom it opens upward from the pointer.
  it('opens upward near the bottom edge', () => {
    expect(placeMenu({ kind: 'point', x: 100, y: 700 }, VIEWPORT)).toEqual({
      left: 100,
      bottom: VIEWPORT.height - 700,
      maxHeight: 700 - 8,
    });
  });

  // Regression guard: a point can arrive from outside the viewport (a frame's
  // coordinates translated into the page). The menu is still drawn inside.
  it('clamps a point outside the viewport back inside it', () => {
    expect(placeMenu({ kind: 'point', x: -50, y: -40 }, VIEWPORT)).toEqual({
      left: 8,
      top: 8,
      maxHeight: VIEWPORT.height - 16,
    });
    const beyond = placeMenu({ kind: 'point', x: 5000, y: 5000 }, VIEWPORT);
    expect(beyond.left).toBe(VIEWPORT.width - 8 - MENU_WIDTH);
    expect(beyond.bottom).toBe(8);
  });

  // A viewport smaller than the margins leaves no room at all: a zero height,
  // never a negative one (which CSS would ignore, drawing the whole menu).
  it('never asks for a negative height', () => {
    const tiny = { width: 100, height: 10 };
    const down = placeMenu({ kind: 'rect', rect: box(3, 50, 2) }, tiny);
    expect(down.top).toBeDefined();
    expect(down.maxHeight).toBe(0);
    const up = placeMenu({ kind: 'rect', rect: box(5, 50, 25) }, tiny);
    expect(up.bottom).toBeDefined();
    expect(up.maxHeight).toBe(0);
  });
});

describe('scrollTopToReveal', () => {
  // Already in view: the menu does not move under the reader.
  it('leaves the scroll alone for a visible item', () => {
    expect(scrollTopToReveal(40, 200, 100, 36)).toBe(40);
  });

  // Below the fold (End, or ArrowDown past the last visible row): scrolled
  // just far enough that the item's bottom edge is the view's.
  it('scrolls down to an item below the view', () => {
    expect(scrollTopToReveal(0, 200, 500, 36)).toBe(336);
  });

  // Above it (ArrowDown wrapping to the first, Home): scrolled up to its top.
  it('scrolls up to an item above the view', () => {
    expect(scrollTopToReveal(300, 200, 40, 36)).toBe(40);
  });

  // An item cut by the bottom edge counts as hidden, not as visible.
  it('reveals an item the bottom edge cuts in half', () => {
    expect(scrollTopToReveal(0, 200, 180, 36)).toBe(16);
  });
});
