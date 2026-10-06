import { useCallback, useEffect, useRef } from 'react';

/** Run `fn` after `ms`, unless the component has unmounted by then. */
export type MountedTimeout = (fn: () => void, ms: number) => void;

/**
 * `setTimeout` for a delayed DOM touch that belongs to a mounted component —
 * scroll a card into view once it has rendered, focus a composer once it has
 * mounted. The callback runs only if the component is still mounted when the
 * timer fires.
 *
 * A bare `setTimeout` outlives its component: it scrolls or focuses inside a
 * pane that is gone, and at the end of a test file it runs after the DOM
 * environment is torn down, throwing "document is not defined" — an unhandled
 * error that fails the whole run though every assertion passed (main's CI,
 * PR #54).
 *
 * Checked when the timer FIRES rather than cleared on unmount, because
 * StrictMode's dev-only unmount-and-remount would otherwise cancel a timer
 * that an effect guarded by a ref (run once per selection) never schedules
 * again.
 *
 * The returned function is stable across renders.
 */
export function useMountedTimeout(): MountedTimeout {
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return useCallback((fn: () => void, ms: number) => {
    setTimeout(() => {
      if (mounted.current) fn();
    }, ms);
  }, []);
}
