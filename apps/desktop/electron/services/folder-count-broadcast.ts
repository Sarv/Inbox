// Pushing read-model badge repairs to the renderer.
//
// `folders.unread_count` is maintained by the read-model drain: any write to a
// mail's tags dirties its thread, the drain rebuilds the projection, and the
// badge is re-counted from it. That happens BEHIND the app's back on purpose —
// it is what makes the counter unforgettable — but it means the corrected number
// lands in the database with nothing telling the window about it. Before this,
// the sidebar kept rendering the stale badge until some unrelated action
// happened to reload folders.
//
// Kept as a small injected-dependency function rather than reaching for
// `sendToWindow` directly so the policy (which channel, which payload, when to
// stay silent) is unit-testable without an Electron window.

import { createLogger } from '@sarvinbox/core';

const logger = createLogger('FolderCountBroadcast');

/** The channel the renderer already listens on for folder refreshes. */
export const FOLDERS_UPDATED_CHANNEL = 'folders:updated';

/** The slice of storage this needs — narrow on purpose, so tests need no DB. */
export interface FolderCountSource {
  setFolderCountsListener(listener: ((folderPaths: string[]) => void) | null): void;
}

export interface FolderCountBroadcastDeps {
  /** Usually `sendToWindow`. */
  send: (channel: string, payload: unknown) => void;
  /**
   * The account this storage belongs to, resolved LAZILY: storage is
   * constructed before its runtime is registered, so an eagerly-captured id
   * would be null forever.
   */
  accountId: () => string | null;
}

/**
 * Make `storage` push a badge refresh to the renderer whenever the drain moves a
 * count.
 *
 * Deliberately sends NO `folderPath`. Naming a folder tells the renderer to
 * re-run that folder's list query as well, which is right after a flag
 * reconcile but wrong here: the list already reads the read model directly, so
 * it was never the stale half — only the badge was. Badge-only keeps a
 * background repair from re-querying whatever the user happens to be reading.
 */
export function wireFolderCountBroadcast(storage: FolderCountSource, deps: FolderCountBroadcastDeps): void {
  storage.setFolderCountsListener((folderPaths) => {
    // The drain reports only folders whose badge actually moved; an empty list
    // still reaching here would mean waking the sidebar for nothing.
    if (folderPaths.length === 0) return;
    try {
      const accountId = deps.accountId();
      deps.send(FOLDERS_UPDATED_CHANNEL, accountId ? { accountId } : {});
    } catch (error) {
      logger.warn('Failed to push folder-count refresh:', (error as Error).message);
    }
  });
}
