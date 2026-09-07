import { describe, it, expect, vi } from 'vitest';

import { MessageProcessor } from '../../../src/imap/message-processor';

// Regression: syncFlags must BAIL when the folder's UIDVALIDITY changed on the
// server, instead of (a) matching server flags to local rows by stale uid number
// (flag corruption) and (b) persisting the NEW validity onto the folder — which
// permanently defeated the folder-sync re-key/wipe (it then saw "no change"),
// stranding mis-keyed rows forever. On a change it returns immediately and leaves
// the re-key to FolderSyncer.handleUidValidity.

function makeClient(mailboxState: Record<string, any>) {
  return {
    supportsCondstore: () => false,
    getCurrentMailboxState: () => ({ path: 'INBOX', exists: 100, ...mailboxState }),
    fetchAllFlags: vi.fn(async () => [] as any[]),
    fetchAllUIDs: vi.fn(async () => [] as number[]),
    fetchUidsSince: vi.fn(async () => [] as number[]),
    fetchFlagsOnly: vi.fn(async () => [] as any[]),
  };
}

function makeStorage(rows: Array<{ id: string; uid: number; tags: string }>) {
  return {
    getEmailTagsInFolder: vi.fn(async () => rows),
    getEmailUidsInFolder: vi.fn(async () => rows.map((r) => ({ id: r.id, uid: r.uid }))),
    bulkUpdateTags: vi.fn(async () => {}),
    updateFolder: vi.fn(async () => {}),
    deleteEmails: vi.fn(async () => {}),
    unlinkOrDeleteEmailsFromFolder: vi.fn(async () => ({ unlinked: 0, deleted: 0 })),
  };
}

const folder = { id: 'f1', path: 'INBOX', highestModseq: 10, uidValidity: 1 } as any;

describe('syncFlags — UIDVALIDITY change safety', () => {
  it('BAILS on a changed UIDVALIDITY: no flag fetch, no deletion, does NOT adopt the new validity', async () => {
    const mp = new MessageProcessor();
    const client = makeClient({ uidValidity: 2, highestModseq: 10 }); // 1 -> 2
    const storage = makeStorage([{ id: 'a', uid: 5, tags: '|INBOX|' }]);

    const res = await mp.syncFlags(client as any, folder, storage as any, undefined, undefined, undefined);

    expect(client.fetchAllFlags).not.toHaveBeenCalled();   // no flag reconcile against new-validity uids
    expect(storage.deleteEmails).not.toHaveBeenCalled();    // no deletion
    // Critically: never persisted the new validity (that would defeat the re-key).
    const adoptedValidity = storage.updateFolder.mock.calls.some(
      ([, upd]: any[]) => upd && upd.uidValidity === 2,
    );
    expect(adoptedValidity).toBe(false);
    expect(res).toEqual({ updated: 0, deleted: 0 });
  });

  it('proceeds normally when UIDVALIDITY is unchanged', async () => {
    const mp = new MessageProcessor();
    const client = makeClient({ uidValidity: 1, highestModseq: 10 }); // same as folder
    client.fetchAllFlags = vi.fn(async () => [{ uid: 5, flags: [] }]);
    const storage = makeStorage([{ id: 'a', uid: 5, tags: '|INBOX|' }]);

    await mp.syncFlags(client as any, folder, storage as any, undefined, undefined, undefined);

    expect(client.fetchAllFlags).toHaveBeenCalledTimes(1);  // normal whole-mailbox path runs
  });

  it('does NOT bail on a missing/garbage server UIDVALIDITY (NaN/0) — never a spurious skip', async () => {
    const mp = new MessageProcessor();
    const client = makeClient({ uidValidity: NaN, highestModseq: 10 });
    client.fetchAllFlags = vi.fn(async () => [{ uid: 5, flags: [] }]);
    const storage = makeStorage([{ id: 'a', uid: 5, tags: '|INBOX|' }]);

    await mp.syncFlags(client as any, folder, storage as any, undefined, undefined, undefined);

    expect(client.fetchAllFlags).toHaveBeenCalledTimes(1);  // garbage validity is ignored, sync proceeds
  });
});
