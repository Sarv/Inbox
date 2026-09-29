/**
 * Where a fixed-position menu goes, and how it scrolls an item into view.
 *
 * Pure and framework-free, so every edge case is a unit test rather than a
 * manual resize. Shared by every menu the app opens itself: the message menu
 * (from its three-dot button, or at the pointer on a right-click in the chat)
 * and the compose editors' right-click menu over a selection. Each of those
 * used to place itself, and the copies that opened at the pointer did no
 * clamping at all — a right-click near the right or bottom edge drew the menu
 * off-screen.
 */

/** The message menu's width, matching its `w-56`. */
export const MENU_WIDTH = 224;
/** The margin a menu keeps from every viewport edge. */
const EDGE = 8;
/** Below this much room under the anchor, the menu may open upward instead. */
const MIN_DOWN = 220;
/** The gap between a trigger button and the menu it opens. */
const BUTTON_GAP = 4;

/**
 * Where a menu opens from: a trigger's box (the three-dot button), or a point
 * (a right-click, in viewport coordinates).
 */
export type MenuAnchor =
  | { kind: 'rect'; rect: Pick<DOMRect, 'top' | 'bottom' | 'right'> }
  | { kind: 'point'; x: number; y: number };

export interface MenuViewport {
  width: number;
  height: number;
}

/** Fixed-position coordinates for the menu: exactly one of top/bottom. */
export interface MenuPlacement {
  left: number;
  top?: number;
  bottom?: number;
  maxHeight: number;
}

/**
 * Downward unless that is cramped. The first items (Reply, Reply all) should
 * sit right against the anchor, and a tall menu (~600px) just scrolls within
 * the space below — so it flips up only when there is too little room below to
 * be usable AND more room above. The height is capped to the chosen side's
 * space so it never runs off-screen.
 */
function placeVertically(
  top: number,
  bottom: number,
  viewportHeight: number,
  gap: number,
): Omit<MenuPlacement, 'left'> {
  const spaceBelow = viewportHeight - bottom - EDGE;
  const spaceAbove = top - EDGE;
  if (spaceBelow >= MIN_DOWN || spaceBelow >= spaceAbove) {
    return { top: bottom + gap, maxHeight: Math.max(0, spaceBelow) };
  }
  return { bottom: viewportHeight - top + gap, maxHeight: Math.max(0, spaceAbove) };
}

/**
 * Where a menu of `width` goes, for an anchor in a viewport.
 *
 * - A button: right-aligned to it, kept off the left edge.
 * - A point: the menu's corner on the pointer, like a native context menu —
 *   flipped to the pointer's left when it would run off the right edge, and
 *   clamped inside the viewport either way. A point can arrive from outside the
 *   visible area (a frame's coordinates translated into the page), and a menu
 *   drawn off-screen is a menu the reader cannot close by choosing from it.
 */
export function placeMenu(
  anchor: MenuAnchor,
  viewport: MenuViewport,
  width: number = MENU_WIDTH,
): MenuPlacement {
  if (anchor.kind === 'rect') {
    const { rect } = anchor;
    return {
      left: Math.max(EDGE, rect.right - width),
      ...placeVertically(rect.top, rect.bottom, viewport.height, BUTTON_GAP),
    };
  }
  const x = Math.min(Math.max(anchor.x, EDGE), viewport.width - EDGE);
  const y = Math.min(Math.max(anchor.y, EDGE), viewport.height - EDGE);
  // With `x` inside the margins, the right-hand side fits by construction —
  // either it opens right because it fits, or it flips left of a point that is
  // itself inside. Only the left edge can still be crossed.
  const preferred = x + width + EDGE <= viewport.width ? x : x - width;
  return {
    left: Math.max(EDGE, preferred),
    ...placeVertically(y, y, viewport.height, 0),
  };
}

/** The current viewport, for `placeMenu`. */
export function currentViewport(): MenuViewport {
  return { width: window.innerWidth, height: window.innerHeight };
}

/**
 * The `scrollTop` that brings an item fully into a scrolling menu's view,
 * moving it as little as possible — `current` when it is already visible.
 *
 * A menu capped to the room on its side scrolls, and walking it from the
 * keyboard must scroll with the focus: otherwise End, or an arrow past the
 * last visible row, puts focus on an item the reader cannot see, and Enter
 * then fires it blind. Computed here rather than left to `scrollIntoView`,
 * which may also scroll the PAGE — and a page scroll closes the menu.
 *
 * `itemTop` is the item's offset from the top of the menu's content.
 */
export function scrollTopToReveal(
  current: number,
  viewHeight: number,
  itemTop: number,
  itemHeight: number,
): number {
  if (itemTop < current) return itemTop;
  const itemBottom = itemTop + itemHeight;
  if (itemBottom > current + viewHeight) return itemBottom - viewHeight;
  return current;
}
