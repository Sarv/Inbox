// Folder count maintenance shared by the sync paths that change folder
// MEMBERSHIP (as opposed to flags), where the caller's own recount gate can't
// see the change.

import type { IEmailStorage } from '../types/storage';

import { logger } from './logger';

/** Just the slice of storage a recount needs, so callers can pass a fake. */
export type FolderCountRecounter = Pick<IEmailStorage, 'recalculateFolderCounts'>;

/**
 * Refresh `folders.total_count` / `unread_count` for the folders a membership
 * change touched — best effort, never throwing into a sync.
 *
 * Why this exists: the sidebar badge and the folder list read the STORED
 * counts, not a live query, and every recount gate in the sync engine keys off
 * flag updates, inserts reported by the folder syncer, or deletions. A pass
 * that only ADDS a folder tag to an existing row (Gmail label repair, the
 * addition reconcile's relinks) satisfies none of those, so the stored count
 * silently drifts from the list the user is looking at and stays wrong until
 * something unrelated triggers a full recount.
 *
 * `paths` may contain non-folder tag tokens (`read`, `starred`, a category):
 * `recalculateFolderCounts` intersects the list with the folders table, so
 * anything that isn't a folder path is ignored rather than being an error —
 * callers can pass the raw set of tags they added.
 */
export async function refreshCountsForFolders(
  storage: FolderCountRecounter,
  paths: Iterable<string>,
  context: string,
): Promise<void> {
  const unique = [...new Set(paths)].filter((path) => !!path);
  if (unique.length === 0) return;
  try {
    await storage.recalculateFolderCounts(unique);
  } catch (error) {
    // A stale badge is a cosmetic bug; failing the sync over one is not.
    logger.warn(`[FolderCounts] recount after ${context} failed: ${(error as Error).message}`);
  }
}
