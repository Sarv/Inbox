import { app } from 'electron';

import type { SecureStorageAccessResult } from '../../src/types/secure-storage';

import { requestMacKeychainAccess } from './macos-keychain-access';
import { relaunchForSecureStorage } from './secure-storage-relaunch';
import { probeSecureStorage } from './secure-storage-startup';

let pending: Promise<SecureStorageAccessResult> | undefined;
let restarting = false;

/** One native prompt globally, even when the banner and Security panel both request it. */
export function requestSecureStorageAccess(): Promise<SecureStorageAccessResult> {
  if (pending) return pending;
  pending = (async () => {
    if (process.platform !== 'darwin') return { outcome: 'unavailable', status: -4 } as const;
    app.focus({ steal: true });
    const result = await requestMacKeychainAccess();
    if (result.outcome !== 'authorized' || result.status !== 0) return result;
    if (probeSecureStorage()) return { ...result, restarting: false };
    // The native unlock can succeed while the synchronous encryption backend
    // still remembers a failed lookup. A fresh process is necessary to retry.
    relaunchForSecureStorage();
    restarting = true;
    setImmediate(() => app.quit());
    return { ...result, restarting: true };
  })().finally(() => { if (!restarting) pending = undefined; });
  return pending;
}
