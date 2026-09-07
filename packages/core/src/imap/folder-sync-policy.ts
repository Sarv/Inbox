import type { FolderRecord } from '../types/models';

/**
 * Per-folder sync policy helpers (pure, unit-testable). Both default SAFE: a
 * folder with no stored policy (older rows, or a folder we haven't recorded yet)
 * syncs normally — a missing value must never silently stop mail from arriving.
 */

/** Whether this folder should be synced at all. Default true. */
export function isFolderSyncEnabled(folder: Pick<FolderRecord, 'syncEnabled'> | undefined | null): boolean {
  return folder ? folder.syncEnabled !== false : true;
}

/**
 * Effective headers-only for a folder: a per-folder `syncMode` overrides the
 * global default; undefined/null defers to the global. 'headers' = don't download
 * bodies in this folder; 'full' = always download.
 */
export function folderHeadersOnly(
  folder: Pick<FolderRecord, 'syncMode'> | undefined | null,
  globalHeadersOnly: boolean,
): boolean {
  const mode = folder?.syncMode;
  if (mode === 'headers') return true;
  if (mode === 'full') return false;
  return globalHeadersOnly;
}
