import { useEffect, useEffectEvent, type RefObject } from 'react';

type ElementRef = RefObject<HTMLElement | null>;

/**
 * Close an open popup when the pointer goes down anywhere outside it.
 *
 * The listener is attached only while the popup is open, and on `mousedown`
 * rather than `click`: a `click` fires after the press has already moved focus
 * and, for a menu that re-renders on the same gesture, can arrive at an element
 * that no longer exists. Anything inside `refs` is left alone, so choosing an
 * item in the menu is not also a click-away.
 *
 * `refs` is one element or several. A menu portalled out of its trigger is two
 * boxes — the button and the dropdown — and a press on either is "inside".
 * Passing a fresh array literal on every render is fine: the refs and `onAway`
 * are read when an event arrives, so only opening and closing re-attach the
 * listeners.
 *
 * A click inside an `<iframe>` never reaches this document — a sandboxed mail
 * body is a document of its own — so a press there would leave the popup open
 * over the mail being read. What the host DOES see is focus leaving for the
 * frame: the window blurs with the frame as its active element. That counts as
 * a click away too. A blur with anything else active (the reader switched to
 * another app) does not: coming back should find the popup as they left it.
 *
 * Shared because the same twelve lines were being re-derived per menu, and each
 * copy got to decide for itself whether to listen while closed.
 */
export function useClickAway(
  refs: ElementRef | readonly ElementRef[],
  open: boolean,
  onAway: () => void,
): void {
  const isInside = useEffectEvent((node: Node) => {
    const list = 'current' in refs ? [refs] : refs;
    return list.some((ref) => ref.current?.contains(node));
  });
  const away = useEffectEvent(() => onAway());

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!isInside(event.target as Node)) away();
    };
    const onWindowBlur = () => {
      const active = document.activeElement;
      if (active instanceof HTMLIFrameElement && !isInside(active)) away();
    };
    document.addEventListener('mousedown', onPointerDown);
    window.addEventListener('blur', onWindowBlur);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('blur', onWindowBlur);
    };
  }, [open]);
}
