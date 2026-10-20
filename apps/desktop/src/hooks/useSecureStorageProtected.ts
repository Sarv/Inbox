import { useEffect, useState } from 'react';

/**
 * Whether this device's OS key store really protects saved secrets at rest.
 * False on Linux without a Secret Service / KWallet (Chromium's `basic_text`
 * backend, whose key is public) or with a locked/unavailable keychain; main
 * answers via `secureCreds.available` (isOsBackedEncryption). `null` until it
 * has answered.
 *
 * If the check itself can't run, this says `true`: it only picks wording and
 * warnings (main makes every storage decision itself), and a false alarm on
 * macOS or Windows would teach users to ignore the real one.
 */
export function useSecureStorageProtected(): boolean | null {
  const [protectedAtRest, setProtectedAtRest] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await window.electronAPI?.secureCreds?.available?.();
        if (!cancelled) setProtectedAtRest(res?.success ? res.data === true : true);
      } catch {
        if (!cancelled) setProtectedAtRest(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  return protectedAtRest;
}
