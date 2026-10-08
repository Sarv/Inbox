import { ShieldAlert, X } from 'lucide-react';
import { useEffect, useState } from 'react';

import { Tooltip } from './Tooltip';

/**
 * Inline warning shown ONLY when no OS key store protects secrets at rest:
 * Linux without a Secret Service / KWallet (where Chromium falls back to its
 * `basic_text` backend, whose key is public), or a locked/unavailable
 * keychain. Passwords, sign-in tokens, AI keys and the mail database key are
 * then readable by anyone who copies the profile — the user should know.
 *
 * On macOS (Keychain) and Windows (DPAPI) this renders nothing.
 */
export function SecurityStatusBanner() {
  // null = not yet checked; true/false = keychain-backed encryption available.
  const [available, setAvailable] = useState<boolean | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await window.electronAPI?.secureCreds?.available?.();
        if (!cancelled) setAvailable(res?.success ? res.data === true : true);
      } catch {
        // If we can't even check, don't alarm the user — assume fine.
        if (!cancelled) setAvailable(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  if (available !== false || dismissed) return null;

  return (
    <div className="flex items-center gap-3 px-4 py-2 bg-amber-500/10 border-b border-amber-500/30 text-sm text-amber-800 dark:text-amber-300">
      <ShieldAlert className="h-4 w-4 flex-shrink-0 text-amber-600 dark:text-amber-400" />
      <span className="flex-1 min-w-0 truncate">
        <span className="font-semibold">Saved sign-ins aren&apos;t protected on this device.</span>{' '}
        <span className="opacity-90">
          No system keyring was found, so passwords, sign-in tokens, AI keys and the key to your stored mail can be read by anyone who copies your profile.
        </span>{' '}
        <span className="opacity-70">
          Install and unlock a keyring (e.g. gnome-keyring or KWallet), then restart Sarv Inbox.
        </span>
      </span>
      <Tooltip content="Dismiss" delayMs={40}>
        <button
          onClick={() => setDismissed(true)}
          aria-label="Dismiss"
          className="p-1 rounded hover:bg-amber-500/20 transition-colors flex-shrink-0"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </Tooltip>
    </div>
  );
}
