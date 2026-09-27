import { useEffect, type RefObject } from 'react';

/**
 * Close an open popup when the pointer goes down anywhere outside it.
 *
 * The listener is attached only while the popup is open, and on `mousedown`
 * rather than `click`: a `click` fires after the press has already moved focus
 * and, for a menu that re-renders on the same gesture, can arrive at an element
 * that no longer exists. Anything inside `ref` is left alone, so choosing an
 * item in the menu is not also a click-away.
 *
 * Shared because the same twelve lines were being re-derived per menu, and each
 * copy got to decide for itself whether to listen while closed.
 */
export function useClickAway(
  ref: RefObject<HTMLElement | null>,
  open: boolean,
  onAway: () => void,
): void {
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) onAway();
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [ref, open, onAway]);
}
