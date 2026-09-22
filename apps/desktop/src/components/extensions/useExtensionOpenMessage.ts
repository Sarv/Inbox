import { useEffect } from 'react';

import { openEmailFromNotification } from '../../utils/open-email-from-notification';

/**
 * Honour `ctx.ui.openMessage(...)` from an extension.
 *
 * Routed through the same helper a notification click uses, so "show me this
 * message" navigates identically however it was asked for — switch account
 * first, then select — instead of a second near-identical navigation path that
 * drifts from the first.
 *
 * Mounted once, near the root: the request can arrive while the reader is in
 * Settings or Contacts, where no mail component is on screen to receive it.
 */
export function useExtensionOpenMessage(): void {
  useEffect(() => {
    const off = window.electronAPI?.extensions?.onOpenMessage?.(({ emailId, accountId }) => {
      openEmailFromNotification(emailId, accountId);
    });
    return () => {
      try { off?.(); } catch { /* listener already gone */ }
    };
  }, []);
}
