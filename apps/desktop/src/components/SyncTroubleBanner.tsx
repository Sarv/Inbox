import { AlertTriangle, RefreshCw, X } from 'lucide-react';
import { useEffect, useState } from 'react';

import { useEmailStore } from '../store/email-store';

import { shouldShowSyncTroubleBanner } from './connection-status';

/**
 * Non-blocking banner shown when the ACTIVE account's socket looks connected but
 * mail sync keeps FAILING (`syncTrouble`) — the "green Live dot while nothing
 * arrives" gap. Without this the user is left waiting with no idea the app can't
 * reach the mail server; here we say so plainly and offer an immediate retry.
 *
 * Priority: re-auth is a harder, terminal problem, so if `needsReauth` is set the
 * ReauthBanner owns the surface and this one stays hidden (no double banner).
 * A successful sync clears `syncTrouble` and the banner disappears on its own.
 */
export function SyncTroubleBanner() {
  const syncTrouble = useEmailStore((s) => s.syncTrouble);
  const connected = useEmailStore((s) => s.connected);
  const needsReauth = useEmailStore((s) => s.needsReauth);
  const reconnect = useEmailStore((s) => s.reconnect);
  const clearSyncTrouble = useEmailStore((s) => s.clearSyncTrouble);
  const [dismissed, setDismissed] = useState(false);

  // Once mail is flowing again (or the socket dropped entirely, handing over to
  // the reconnect/disconnected surfaces), reset dismissed so a FUTURE stall
  // re-shows the banner instead of staying silenced.
  useEffect(() => { if (!syncTrouble || !connected) setDismissed(false); }, [syncTrouble, connected]);

  if (!shouldShowSyncTroubleBanner({ syncTrouble, connected, needsReauth, dismissed })) return null;

  const handleRetry = () => {
    // Optimistically clear so the banner + amber dot flip immediately; a fresh
    // reconnect re-runs sync, and if it fails again the streak re-raises trouble.
    clearSyncTrouble();
    void reconnect();
  };

  return (
    <div className="flex items-center gap-3 px-4 py-2 bg-amber-500/10 border-b border-amber-500/30 text-sm text-amber-800 dark:text-amber-300">
      <AlertTriangle className="h-4 w-4 flex-shrink-0 text-amber-600 dark:text-amber-400" />
      <span className="flex-1 min-w-0 truncate">
        <span className="font-semibold">Trouble reaching your mail server.</span>{' '}
        <span className="opacity-90">New mail may be delayed — retrying automatically.</span>{' '}
        <span className="opacity-70">Your existing mail is still available.</span>
      </span>
      <button
        onClick={handleRetry}
        className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-amber-500/20 hover:bg-amber-500/30 font-medium text-amber-900 dark:text-amber-200 transition-colors flex-shrink-0"
      >
        <RefreshCw className="h-3.5 w-3.5" />
        Retry now
      </button>
      <button
        onClick={() => setDismissed(true)}
        className="p-1 rounded hover:bg-amber-500/20 transition-colors flex-shrink-0"
        title="Dismiss (the app keeps retrying in the background)"
        aria-label="Dismiss"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
