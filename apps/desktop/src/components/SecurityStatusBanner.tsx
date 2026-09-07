import { ShieldAlert, X } from 'lucide-react';
import { useEffect, useState } from 'react';

/**
 * Inline warning shown ONLY when the OS keychain is unavailable, so the
 * credential vault can't encrypt at rest (Linux without a Secret Service, or a
 * locked/again-unavailable keychain). In that state passwords fall back to a
 * clearly-marked plaintext file rather than being lost — the user should know.
 *
 * On macOS (Keychain) and Windows (DPAPI) safeStorage is always available, so
 * this renders nothing there.
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
        <span className="font-semibold">Credential encryption unavailable.</span>{' '}
        <span className="opacity-90">
          No system keychain was found, so account passwords are stored unencrypted on this device.
        </span>{' '}
        <span className="opacity-70">
          Install/unlock a keychain (e.g. gnome-keyring or KWallet) for at-rest encryption.
        </span>
      </span>
      <button
        onClick={() => setDismissed(true)}
        aria-label="Dismiss"
        className="p-1 rounded hover:bg-amber-500/20 transition-colors flex-shrink-0"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
