import { useEffect, useState } from 'react';

import {
  addReauthSession,
  mergeReauthSnapshot,
  removeReauthSession,
  type ReauthSession,
} from '../utils/reauth-sessions';

/**
 * The accounts currently needing an interactive sign-in.
 *
 * Shared by the banner and by Settings → Accounts so the two can never
 * disagree — the original bug was precisely that: the banner said a session had
 * expired while the Accounts list still showed the account as Connected, and
 * dismissing the banner left no way to find out at all.
 *
 * Both halves of the delivery are here: a PULL on mount (a failure that
 * happened before this component existed) and a live push. The list transforms
 * are pure and unit-tested in `utils/reauth-sessions`.
 */
export function useReauthSessions(): ReauthSession[] {
  const [sessions, setSessions] = useState<ReauthSession[]>([]);

  useEffect(() => {
    const api = window.electronAPI;
    let cancelled = false;

    void (async () => {
      try {
        const res = await api?.oauth?.listReauthRequired?.();
        if (cancelled || !res?.success || !res.data) return;
        setSessions((current) => mergeReauthSnapshot(current, res.data as ReauthSession[]));
      } catch {
        // Main process not ready — the push below still covers live failures.
      }
    })();

    const offRequired = api?.notifications?.onReauthRequired?.((data) => {
      setSessions((current) =>
        addReauthSession(current, { ...data, since: new Date().toISOString() }),
      );
    });
    const offResolved = api?.notifications?.onReauthResolved?.((data) => {
      setSessions((current) => removeReauthSession(current, data));
    });

    return () => {
      cancelled = true;
      try { offRequired?.(); } catch { /* ignore */ }
      try { offResolved?.(); } catch { /* ignore */ }
    };
  }, []);

  return sessions;
}
