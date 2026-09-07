import { AlertTriangle, RefreshCw, Settings, X } from 'lucide-react';
import { useEffect, useState } from 'react';

import { useEmailStore } from '../store/email-store';

/**
 * Non-blocking banner shown when the ACTIVE account's IMAP login was rejected
 * (needsReauth). Deliberately NOT a full-screen dialog: the local mailbox stays
 * readable, other accounts stay switchable, and the user fixes credentials on
 * their own time — new mail simply won't sync until they do.
 *
 * "Reconnect" opens the on-demand ConnectionDialog to re-enter the password;
 * "Account settings" deep-links to Settings → Accounts.
 */
export function ReauthBanner({ onReconnect, onFix }: { onReconnect: () => void; onFix: () => void }) {
  const needsReauth = useEmailStore((s) => s.needsReauth);
  const connected = useEmailStore((s) => s.connected);
  const activeAccountId = useEmailStore((s) => s.activeAccountId);
  const accounts = useEmailStore((s) => s.accounts);
  const [dismissed, setDismissed] = useState(false);

  // A successful reconnect clears needsReauth; reset dismissed so a FUTURE
  // rejection shows the banner again.
  useEffect(() => { if (!needsReauth || connected) setDismissed(false); }, [needsReauth, connected]);

  if (!needsReauth || connected || dismissed) return null;

  const label = accounts.find((a) => a.id === activeAccountId)?.email || 'this account';

  return (
    <div className="flex items-center gap-3 px-4 py-2 bg-destructive/10 border-b border-destructive/30 text-sm text-destructive">
      <AlertTriangle className="h-4 w-4 flex-shrink-0" />
      <span className="flex-1 min-w-0 truncate">
        <span className="font-semibold">Sign-in failed for {label}.</span>{' '}
        <span className="opacity-90">The saved password was rejected — new mail won&apos;t sync until you reconnect. Your existing mail is still available.</span>
      </span>
      <button
        onClick={onReconnect}
        className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-destructive/15 hover:bg-destructive/25 font-medium transition-colors flex-shrink-0"
      >
        <RefreshCw className="h-3.5 w-3.5" />
        Reconnect
      </button>
      <button
        onClick={onFix}
        className="flex items-center gap-1.5 px-2.5 py-1 rounded-md hover:bg-destructive/15 font-medium transition-colors flex-shrink-0"
      >
        <Settings className="h-3.5 w-3.5" />
        Account settings
      </button>
      <button
        onClick={() => setDismissed(true)}
        className="p-1 rounded hover:bg-destructive/15 transition-colors flex-shrink-0"
        title="Dismiss (account stays unsynced until reconnected)"
        aria-label="Dismiss"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
