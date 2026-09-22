/**
 * Carrying a `read` / `starred` change to the server.
 *
 * Its own module because two callers need it and they have nothing else in
 * common: the workflow runner applies a flag the instant mail arrives, and the
 * extension mail backend applies one whenever an extension asks. Keeping it
 * here means the runner — which loads at startup and runs on every synced
 * message — does not have to pull in the IPC handler module (and through it the
 * whole account runtime) to push a single flag.
 *
 * The two paths differ in WHEN they apply a flag, never in what applying one
 * means, so there is exactly one implementation of the meaning.
 */

import { createLogger, type EmailRecord, type SyncableFlagTag } from '@sarvinbox/core';

import { getSyncEngineForStorage } from '../shared';

const logger = createLogger('flag-push');

/** A flag the host can carry back to the server, and its target state. */
export interface FlagChange {
  tag: SyncableFlagTag;
  value: boolean;
}

/**
 * Carry a flag change to the server.
 *
 * The local tag is already persisted by the time this runs, so a failure here
 * is logged and swallowed: the reader sees the star, and the operation queue
 * retries the server side on reconnect. Throwing would abandon the remaining
 * flag changes for the same message.
 */
export async function pushFlagToServer(
  storage: any,
  email: EmailRecord,
  change: FlagChange
): Promise<void> {
  const syncEngine = getSyncEngineForStorage(storage);
  if (!syncEngine || !email.uid) return;

  try {
    const folder = await storage.getFolder(email.folderId);
    if (!folder?.path) return;
    if (change.tag === 'starred') {
      await syncEngine.markAsStarred(folder.path, email.uid, change.value);
    } else {
      await syncEngine.markAsRead(folder.path, email.uid, change.value);
    }
  } catch (error) {
    logger.warn(`Could not push ${change.tag} for ${email.id} to the server:`, error);
  }
}
