import { useCallback, useEffect, useRef, useState } from 'react';

import { createSignInTracker } from '../utils/oauth-signin-tracker';

type OAuthFlowResult = Awaited<ReturnType<NonNullable<Window['electronAPI']>['oauth']['startFlow']>>;

/**
 * Run an interactive OAuth sign-in without the UI getting stuck on it.
 *
 * The flow resolves when the provider redirects back, when it is cancelled, or
 * after the main process's five-minute timeout. It does NOT resolve when the
 * user simply closes the browser tab — nothing reports that — so any button
 * that disables itself until the promise settles can sit on "Opening…" for five
 * minutes with no way back. That is the bug this hook exists to remove:
 * `cancel()` frees the UI immediately and tells the main process to release the
 * loopback port, without waiting for the abandoned promise.
 *
 * `pending` is the provider currently signing in, or null. Results from an
 * abandoned or superseded attempt are dropped (see `createSignInTracker`), so a
 * late FLOW_CANCELLED can never clear the spinner of the flow that replaced it.
 */
export function useOAuthSignIn() {
  const [pending, setPending] = useState<string | null>(null);
  const tracker = useRef(createSignInTracker());
  const mounted = useRef(true);

  useEffect(() => () => { mounted.current = false; }, []);

  const start = useCallback(async (providerId: string): Promise<OAuthFlowResult | null> => {
    const attempt = tracker.current.begin();
    setPending(providerId);
    try {
      const res = await window.electronAPI?.oauth?.startFlow?.(
        providerId as 'gmail' | 'microsoft' | 'yahoo' | 'sarv',
      );
      // null means "this attempt no longer matters" — the caller must not act
      // on it, or a cancelled flow would report an error over a live one.
      if (!tracker.current.isCurrent(attempt)) return null;
      return res ?? { success: false, error: 'OAuth sign-in is unavailable' };
    } catch (err) {
      if (!tracker.current.isCurrent(attempt)) return null;
      return { success: false, error: (err as Error).message || 'OAuth sign-in failed' };
    } finally {
      if (mounted.current && tracker.current.isCurrent(attempt)) setPending(null);
    }
  }, []);

  /**
   * Give up on the flow in progress. Clears the UI at once and asks the main
   * process to abort — deliberately in that order, because the whole point is
   * not to depend on the flow ever answering.
   */
  const cancel = useCallback(() => {
    tracker.current.abandon();
    setPending(null);
    void window.electronAPI?.oauth?.cancel?.().catch(() => { /* already gone */ });
  }, []);

  return { pending, start, cancel };
}
