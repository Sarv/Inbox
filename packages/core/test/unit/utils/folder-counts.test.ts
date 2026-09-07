import { describe, expect, it, vi } from 'vitest';

import { refreshCountsForFolders } from '../../../src/utils/folder-counts';

/**
 * The recount every membership-changing sync pass owes the sidebar.
 *
 * What breaks if this file fails: the folder badge. It renders the STORED
 * `folders.unread_count`, so a pass that files mail into a folder without
 * recounting leaves the badge disagreeing with the list the user is reading —
 * observed live as an INBOX stuck at 5 unread while the folder held 15.
 */
describe('refreshCountsForFolders', () => {
  const recounter = () => {
    const calls: Array<string[] | undefined> = [];
    return {
      calls,
      storage: { recalculateFolderCounts: vi.fn(async (paths?: string[]) => { calls.push(paths); }) },
    };
  };

  // Breaks: the scoped recount silently becomes a FULL one. Passing no paths
  // means "every folder", which is a synchronous pass over every row (~200ms
  // main-thread stall on a big mailbox) — the exact cost the scoping avoids.
  it('always passes explicit paths, never an empty-means-everything list', async () => {
    const { storage, calls } = recounter();

    await refreshCountsForFolders(storage, ['INBOX'], 'test');

    expect(calls).toEqual([['INBOX']]);
  });

  // Breaks: a folder is recounted N times for one pass that touched it N times.
  it('deduplicates repeated paths', async () => {
    const { storage, calls } = recounter();

    await refreshCountsForFolders(storage, ['INBOX', 'INBOX', 'Archive'], 'test');

    expect(calls).toEqual([['INBOX', 'Archive']]);
  });

  // Breaks: a pass that changed nothing still pays for a recount on every tick.
  it('does nothing at all when no folder was touched', async () => {
    const { storage } = recounter();

    await refreshCountsForFolders(storage, [], 'test');
    await refreshCountsForFolders(storage, [''], 'test');

    expect(storage.recalculateFolderCounts).not.toHaveBeenCalled();
  });

  /**
   * Breaks: a locked/busy database turns a cosmetic stale badge into a FAILED
   * SYNC. This runs inside syncFlags and the Gmail label repair, mid-pass, with
   * inserted rows already committed — throwing here would abandon the rest of
   * the reconcile and (worse) look like a connection fault to the caller.
   */
  it('swallows a recount failure instead of failing the sync', async () => {
    const storage = {
      recalculateFolderCounts: vi.fn(async () => { throw new Error('database is locked'); }),
    };

    await expect(refreshCountsForFolders(storage, ['INBOX'], 'test')).resolves.toBeUndefined();
    expect(storage.recalculateFolderCounts).toHaveBeenCalledTimes(1);
  });

  /**
   * Breaks: callers have to pre-filter their own tag set. Membership changes
   * arrive as TAGS — `|INBOX|read|access|` — and only some of those are folder
   * paths. `recalculateFolderCounts` intersects the list with the folders table,
   * so handing it flag and category tokens is safe by design; a caller that had
   * to separate them first would duplicate that knowledge.
   */
  it('forwards non-folder tag tokens rather than trying to classify them', async () => {
    const { storage, calls } = recounter();

    await refreshCountsForFolders(storage, ['INBOX', 'read', 'newsletters'], 'test');

    expect(calls).toEqual([['INBOX', 'read', 'newsletters']]);
  });
});
