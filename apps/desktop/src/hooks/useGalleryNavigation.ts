import { useCallback, useEffect, useState } from 'react';

/**
 * Index state and keyboard handling for anything shown one-at-a-time in an
 * overlay: the attachment viewer, the extension screenshots.
 *
 * Kept in one place because the fiddly parts are not the counter. They are:
 * wrapping past both ends (so the last item's "next" is the first, not a blank
 * screen), and taking the keys on the CAPTURE phase with `stopPropagation` —
 * the app's global shortcut handler has its own Escape branch and single-letter
 * shortcuts with no modal-open suppression, so without capturing first, closing
 * an overlay with Escape also fired whatever Escape means underneath it.
 */
export function useGalleryNavigation({
  count,
  initialIndex = 0,
  onClose,
}: {
  count: number;
  initialIndex?: number;
  onClose: () => void;
}): { index: number; goTo: (next: number) => void } {
  const [index, setIndex] = useState(() =>
    Math.min(Math.max(initialIndex, 0), Math.max(count - 1, 0))
  );

  const goTo = useCallback(
    (next: number) => {
      if (count === 0) return;
      setIndex(((next % count) + count) % count);
    },
    [count]
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (count > 1 && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
        // Leave the arrows alone while a media element has focus, so seeking a
        // video with the keyboard doesn't skip to the next item instead.
        const tag = (event.target as HTMLElement | null)?.tagName;
        if (tag === 'VIDEO' || tag === 'AUDIO') return;
        event.preventDefault();
        event.stopPropagation();
        goTo(index + (event.key === 'ArrowLeft' ? -1 : 1));
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose, goTo, index, count]);

  return { index, goTo };
}
