import { getSyncEngine, requireStorage, getStorageFor, getSyncEngineFor, getCurrentAccountId } from '../shared';

import { ensureAccountRuntime } from './accounts-runtime';

/**
 * Resolve the storage + sync engine for an operation, honoring a per-row
 * `accountId` when acting on a message from the unified "All Inboxes" view (whose
 * rows can belong to non-active accounts). Falls back to the active account when
 * no accountId is given (the normal single-account path). Ensures the target
 * account's runtime exists first, so we never silently hit the wrong DB — the
 * root cause of the mark-read "Email not found" loop across accounts.
 *
 * Lives here rather than in the IPC module because the `sarv-attachment://`
 * protocol handler needs the same resolution and must not import the IPC layer.
 */
export async function resolveAccountTarget(
  accountId?: string,
): Promise<{ storage: ReturnType<typeof requireStorage>; syncEngine: ReturnType<typeof getSyncEngine> }> {
  if (accountId && accountId !== getCurrentAccountId()) {
    let storage = getStorageFor(accountId);
    let syncEngine = getSyncEngineFor(accountId);
    if (!storage) {
      const rt = await ensureAccountRuntime(accountId);
      storage = rt?.storage ?? null;
      syncEngine = rt?.syncEngine ?? null;
    }
    if (storage) return { storage, syncEngine };
  }
  return { storage: requireStorage(), syncEngine: getSyncEngine() };
}
