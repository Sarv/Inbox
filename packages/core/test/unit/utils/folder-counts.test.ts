import { describe, expect, it, vi } from 'vitest';

import {
  applyReadFlagCountDelta,
  refreshCountsForFolders,
  setEmailReadFlag,
  withFiledCounts,
} from '../../../src/utils/folder-counts';

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

/**
 * What breaks if this block fails: the customer stops seeing his sent mail.
 *
 * Sarv publishes ONE physical Sent store under two names, `Sent` and `Sent Mail`
 * (the latter carrying `\Sent`). A message in both is ONE row tagged with both,
 * so `folders.total_count` reads ~1,718 under EITHER name and cannot say which
 * one the app should route to — it routed to the flagged one, whose listing
 * hides every row also tagged `|Sent|`: one message under a header saying 1,719.
 * The primary `folder_id` count is the one that still separates them.
 */
describe('withFiledCounts', () => {
  const folder = (path: string, over: Record<string, unknown> = {}) => ({
    id: `f-${path}`, path, uidValidity: 7, serverMessageCount: 1718, totalCount: 1718, ...over,
  });

  const reader = (counts: Record<string, number>) => ({
    countEmailsFiledIn: vi.fn(async (folderId: string) => counts[folderId] ?? 0),
  });

  // Breaks: the decision is made on tag counts that read full under both names,
  // and the role stays on the empty alias.
  it('attaches the filed count to every name of a contested role', async () => {
    const storage = reader({ 'f-Sent': 1718, 'f-Sent Mail': 1 });

    const measured = await withFiledCounts(storage, [folder('Sent'), folder('Sent Mail')]);

    expect(measured.map((f) => f.ownedCount)).toEqual([1718, 1]);
  });

  // Breaks: a query per folder on every folder list. Only names that actually
  // share a role can be wrong about which holds the mail; the rest are free.
  it('measures only the contested names, never the whole folder list', async () => {
    const storage = reader({});

    const measured = await withFiledCounts(storage, [
      folder('INBOX'), folder('Sent'), folder('Sent Mail'), folder('Archive/Old'),
    ]);

    expect(storage.countEmailsFiledIn.mock.calls.flat().sort())
      .toEqual(['f-Sent', 'f-Sent Mail']);
    expect(measured.find((f) => f.path === 'INBOX')?.ownedCount).toBeUndefined();
  });

  // Breaks: the ordinary account (one mailbox per role) paying a query per
  // folder for a question it never asks.
  it('touches the database not at all when no role is contested', async () => {
    const storage = reader({});

    const folders = [folder('INBOX'), folder('Sent'), folder('Drafts')];
    expect(await withFiledCounts(storage, folders)).toBe(folders);
    expect(storage.countEmailsFiledIn).not.toHaveBeenCalled();
  });

  /**
   * Breaks: a half-measured set decides which mailbox to drop. If the second
   * count throws, the first name looks fully filed and the other "unmeasured" —
   * exactly the asymmetry that collapses a real mailbox. Falling back to the tag
   * counts keeps both syncing, which is the safe direction.
   */
  it('returns the folders untouched when a count fails', async () => {
    const storage = {
      countEmailsFiledIn: vi.fn(async (folderId: string) => {
        if (folderId === 'f-Sent Mail') throw new Error('database is locked');
        return 1718;
      }),
    };

    const folders = [folder('Sent'), folder('Sent Mail')];
    const measured = await withFiledCounts(storage, folders);

    expect(measured).toBe(folders);
    expect(measured.every((f) => f.ownedCount === undefined)).toBe(true);
  });

  // Breaks: an older storage implementation (or a fake) without the counter
  // throwing mid-sync instead of falling back to the tag counts.
  it('falls back silently when the storage cannot count filings', async () => {
    const folders = [folder('Sent'), folder('Sent Mail')];
    expect(await withFiledCounts({} as never, folders)).toBe(folders);
  });
});

/**
 * The ONE way to flip a read flag locally.
 *
 * What breaks if this file fails: the sidebar badge stops matching the
 * unread-filtered list. `folders.unread_count` is a stored scalar, not a live
 * query, so every writer of the `|read|` tag owes it a delta. Four call sites
 * hand-rolled the tag edit and only one paid that debt; the triage pipeline's
 * auto-read silently left INBOX showing 7 over an empty list, and nothing
 * recomputed it for the rest of the session.
 */
describe('setEmailReadFlag', () => {
  const makeStorage = (email: { id: string; tags: string } | null, over: Record<string, any> = {}) => {
    const updates: Array<{ id: string; tags?: string }> = [];
    const storage = {
      getEmail: vi.fn(async () => (email ? { ...email } : null)),
      updateEmail: vi.fn(async (id: string, patch: { tags?: string }) => { updates.push({ id, ...patch }); }),
      recalculateFolderCounts: vi.fn(async () => {}),
      applyReadFlagToFolderCountsBatch: vi.fn(async () => {}),
      ...over,
    };
    return { storage, updates };
  };

  // THE regression: writing the tag without the delta is exactly how the badge
  // outlives the mail it was counting.
  it('writes the read tag AND the matching unread delta', async () => {
    const { storage, updates } = makeStorage({ id: 'e1', tags: '|INBOX|promotions|' });

    expect(await setEmailReadFlag(storage as never, 'e1', true, 'test')).toBe(true);

    expect(updates).toEqual([{ id: 'e1', tags: '|INBOX|promotions|read|' }]);
    expect(storage.applyReadFlagToFolderCountsBatch)
      .toHaveBeenCalledWith([{ emailId: 'e1', nowRead: true }]);
  });

  // The undo direction: marking unread must put the thread BACK in the badge.
  it('removes the read tag and applies the +1 delta when marking unread', async () => {
    const { storage, updates } = makeStorage({ id: 'e1', tags: '|INBOX|read|' });

    expect(await setEmailReadFlag(storage as never, 'e1', false, 'test')).toBe(true);

    expect(updates).toEqual([{ id: 'e1', tags: '|INBOX|' }]);
    expect(storage.applyReadFlagToFolderCountsBatch)
      .toHaveBeenCalledWith([{ emailId: 'e1', nowRead: false }]);
  });

  // Idempotent re-run: a replayed action, a double click or a server flag we
  // already applied must write NOTHING. A second delta for a message that never
  // moved is how a badge drifts the other way.
  it('is a no-op when the email is already in the requested state', async () => {
    const { storage } = makeStorage({ id: 'e1', tags: '|INBOX|read|' });

    expect(await setEmailReadFlag(storage as never, 'e1', true, 'test')).toBe(false);

    expect(storage.updateEmail).not.toHaveBeenCalled();
    expect(storage.applyReadFlagToFolderCountsBatch).not.toHaveBeenCalled();
  });

  // Partial/interrupted run: the row vanished between the caller reading it and
  // the flip (a concurrent purge). Nothing to write, nothing to count.
  it('does nothing when the email is gone', async () => {
    const { storage } = makeStorage(null);

    expect(await setEmailReadFlag(storage as never, 'gone', true, 'test')).toBe(false);

    expect(storage.updateEmail).not.toHaveBeenCalled();
    expect(storage.applyReadFlagToFolderCountsBatch).not.toHaveBeenCalled();
  });

  // Transient failure: a locked DB during the recount must not fail the flip or
  // roll back the tag — the IMAP op is queued against that tag, and the drift
  // sweep's recount is the backstop for the badge.
  it('keeps the flip when the count delta throws', async () => {
    const { storage, updates } = makeStorage({ id: 'e1', tags: '|INBOX|' }, {
      applyReadFlagToFolderCountsBatch: vi.fn(async () => { throw new Error('database is locked'); }),
    });

    expect(await setEmailReadFlag(storage as never, 'e1', true, 'test')).toBe(true);

    expect(updates).toEqual([{ id: 'e1', tags: '|INBOX|read|' }]);
  });

  // An older storage impl (or a fake) without the scan-free delta must still get
  // its badge fixed, by the expensive route rather than not at all.
  it('falls back to a full recount when the storage has no delta method', async () => {
    const { storage } = makeStorage({ id: 'e1', tags: '|INBOX|' }, {
      applyReadFlagToFolderCountsBatch: undefined,
    });

    await setEmailReadFlag(storage as never, 'e1', true, 'test');

    expect(storage.recalculateFolderCounts).toHaveBeenCalled();
  });

  // Multi-account: the helper touches exactly the storage it is handed. Routing
  // a flip to the wrong account's DB would decrement a badge on the other one.
  it('only ever touches the storage it was given', async () => {
    const a = makeStorage({ id: 'e1', tags: '|INBOX|' });
    const b = makeStorage({ id: 'e1', tags: '|INBOX|' });

    await setEmailReadFlag(a.storage as never, 'e1', true, 'test');

    expect(a.storage.applyReadFlagToFolderCountsBatch).toHaveBeenCalledTimes(1);
    expect(b.storage.applyReadFlagToFolderCountsBatch).not.toHaveBeenCalled();
    expect(b.storage.updateEmail).not.toHaveBeenCalled();
  });
});

describe('applyReadFlagCountDelta', () => {
  // Breaks: an empty bulk selection triggering a full-table recount — a
  // multi-hundred-millisecond main-thread stall for no change at all.
  it('does nothing for an empty batch', async () => {
    const storage = {
      recalculateFolderCounts: vi.fn(async () => {}),
      applyReadFlagToFolderCountsBatch: vi.fn(async () => {}),
    };

    await applyReadFlagCountDelta(storage, [], 'test');

    expect(storage.applyReadFlagToFolderCountsBatch).not.toHaveBeenCalled();
    expect(storage.recalculateFolderCounts).not.toHaveBeenCalled();
  });

  // Breaks: a bulk mark-read failing outright because the badge could not be
  // updated. The flip is the operation; the count is cosmetic.
  it('swallows a failing delta rather than failing the caller', async () => {
    const storage = {
      recalculateFolderCounts: vi.fn(async () => {}),
      applyReadFlagToFolderCountsBatch: vi.fn(async () => { throw new Error('boom'); }),
    };

    await expect(applyReadFlagCountDelta(storage, [{ emailId: 'e1', nowRead: true }], 'test'))
      .resolves.toBeUndefined();
  });
});
