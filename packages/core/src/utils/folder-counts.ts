// Folder count maintenance shared by the sync paths that change folder
// MEMBERSHIP (as opposed to flags), where the caller's own recount gate can't
// see the change.

import { duplicateRoleCandidates, type ClassifiableFolder } from '../config/folder-mapping';
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

/** Just the slice of storage the filed-count measurement needs. */
export type FiledCountReader = Pick<IEmailStorage, 'countEmailsFiledIn'>;

/**
 * Measure how much mail is actually FILED under each name of a role the server
 * published twice, and attach it as `ownedCount`.
 *
 * Which of two names for one mailbox the app should route to is decided by
 * where the mail is — but `folders.total_count` cannot answer that. It counts
 * membership TAGS, and a message that belongs to two folders is ONE row
 * carrying both, so an aliased Sent reads ~1,718 under both names. The primary
 * `folder_id` count reads 1,718 and 1: mail is filed under the name it was
 * synced from, and dedup never files it twice.
 *
 * Measured only for contested roles (a query per folder, a handful at most) and
 * only where the storage offers the count; everywhere else `ownedCount` stays
 * absent, which the mapping reads as "not measured" and falls back to the tag
 * count. Best effort: a failure leaves every folder untouched rather than
 * feeding a half-measured set into a decision that can drop a mailbox.
 */
export async function withFiledCounts<T extends ClassifiableFolder & { id: string }>(
  storage: FiledCountReader,
  folders: T[],
): Promise<T[]> {
  if (typeof storage.countEmailsFiledIn !== 'function') return folders;

  const contested = new Set(
    duplicateRoleCandidates(folders).flatMap(({ candidates }) =>
      candidates.map((candidate) => candidate.path),
    ),
  );
  if (contested.size === 0) return folders;

  const filed = new Map<string, number>();
  try {
    for (const folder of folders) {
      if (!contested.has(folder.path)) continue;
      filed.set(folder.id, await storage.countEmailsFiledIn(folder.id));
    }
  } catch (error) {
    logger.warn(`[FolderCounts] filed-count measurement failed: ${(error as Error).message}`);
    return folders;
  }

  return folders.map((folder) =>
    filed.has(folder.id) ? { ...folder, ownedCount: filed.get(folder.id) } : folder,
  );
}
