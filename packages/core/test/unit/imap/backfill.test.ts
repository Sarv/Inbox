import { describe, it, expect, vi } from 'vitest';

import { BACKFILL_UID_SPAN } from '../../../src/config/sync';

import { FolderSyncer } from '../../../src/imap/folder-syncer';

// Unit tests for FolderSyncer.backfillChunk — the downward UID paging that the
// background historical backfill drives. Pure logic: a mock IMAP client + mock
// storage + a spy MessageProcessor. No network, no DB, no real account.

const PROCESS_RESULT = { inserted: 0, updated: 0, skipped: 0, errors: 0, maxUid: 0, insertedIds: [] as string[], relinkedFromFolders: [] as string[], erroredUids: [] as number[] };

function makeSyncer(inserted = 0) {
  const fs = new FolderSyncer();
  const processBatch = vi.fn(async () => ({ ...PROCESS_RESULT, inserted }));
  (fs as any).messageProcessor = { processBatch };
  return { fs, processBatch };
}

function makeStorage(oldestUid: number | null) {
  return {
    getOldestUidInFolder: vi.fn(async () => oldestUid),
    updateFolder: vi.fn(async () => {}),
  };
}

function makeClient(messages: any[] = []) {
  return {
    selectFolder: vi.fn(async () => ({})),
    fetchMessagesByUidRange: vi.fn(async () => messages),
  };
}

const folder = (over: Record<string, any> = {}) => ({
  id: 'f1',
  path: 'INBOX',
  backfillOldestUid: null,
  backfillComplete: false,
  serverMessageCount: 5000,
  lastSyncTime: 123,
  lastSyncUid: 4999,
  ...over,
});

describe('FolderSyncer.backfillChunk', () => {
  it('first chunk pages down from the oldest local UID by SPAN', async () => {
    const { fs, processBatch } = makeSyncer();
    const storage = makeStorage(10000);
    const client = makeClient([]);

    const r = await (fs as any).backfillChunk(client, folder(), storage);

    expect(storage.getOldestUidInFolder).toHaveBeenCalledWith('f1');
    expect(r.hiUid).toBe(9999);
    expect(r.loUid).toBe(10000 - BACKFILL_UID_SPAN); // 9999 - SPAN + 1
    expect(r.done).toBe(false);
    expect(client.fetchMessagesByUidRange).toHaveBeenCalledWith(r.loUid, 9999, expect.objectContaining({ fetchBody: false }));
    expect(storage.updateFolder).toHaveBeenCalledWith('f1', { backfillOldestUid: r.loUid });
    expect(processBatch).not.toHaveBeenCalled(); // no messages fetched
  });

  it('advances the persisted floor even across an EMPTY (gap) range', async () => {
    const { fs } = makeSyncer();
    const storage = makeStorage(null);
    const client = makeClient([]); // UID gap: range holds no messages

    const r = await (fs as any).backfillChunk(client, folder({ backfillOldestUid: 5000 }), storage);

    expect(r.hiUid).toBe(4999);
    expect(r.loUid).toBe(5000 - BACKFILL_UID_SPAN);
    expect(r.fetched).toBe(0);
    expect(r.done).toBe(false);
    // Floor advanced despite zero messages — this is what guarantees termination.
    expect(storage.updateFolder).toHaveBeenCalledWith('f1', { backfillOldestUid: r.loUid });
  });

  it('marks COMPLETE when the floor reaches UID 1', async () => {
    const { fs } = makeSyncer();
    const storage = makeStorage(null);
    const client = makeClient([]);

    const r = await (fs as any).backfillChunk(client, folder({ backfillOldestUid: 300 }), storage);

    expect(r.loUid).toBe(1);
    expect(r.hiUid).toBe(299);
    expect(r.done).toBe(true);
    expect(storage.updateFolder).toHaveBeenCalledWith('f1', { backfillOldestUid: 1, backfillComplete: true });
  });

  it('completes immediately (no fetch) when the anchor is already at the bottom', async () => {
    const { fs } = makeSyncer();
    const storage = makeStorage(null);
    const client = makeClient([]);

    const r = await (fs as any).backfillChunk(client, folder({ backfillOldestUid: 1 }), storage);

    expect(r.done).toBe(true);
    expect(client.fetchMessagesByUidRange).not.toHaveBeenCalled();
    expect(storage.updateFolder).toHaveBeenCalledWith('f1', { backfillOldestUid: 1, backfillComplete: true });
  });

  it('inserts fetched messages QUIETLY (no pipeline/categorization)', async () => {
    const { fs, processBatch } = makeSyncer(2);
    const storage = makeStorage(null);
    const client = makeClient([{ uid: 900 }, { uid: 800 }]);

    const r = await (fs as any).backfillChunk(client, folder({ backfillOldestUid: 1000 }), storage);

    expect(r.fetched).toBe(2);
    expect(r.inserted).toBe(2);
    // The 5th arg MUST be { quiet: true } — that's what suppresses categorisation
    // + the prefetch wake for historical mail.
    expect(processBatch).toHaveBeenCalledWith(
      expect.any(Array), expect.any(Object), storage, undefined, { quiet: true },
    );
  });

  it('waits (not done) when the folder has never been synced', async () => {
    const { fs } = makeSyncer();
    const storage = makeStorage(null); // no local UID floor yet
    const client = makeClient([]);

    const r = await (fs as any).backfillChunk(
      client,
      folder({ backfillOldestUid: null, lastSyncTime: null, lastSyncUid: null, serverMessageCount: 1000 }),
      storage,
    );

    expect(r.done).toBe(false);
    expect(storage.updateFolder).not.toHaveBeenCalled(); // must NOT mark complete
  });

  it('completes a synced-but-empty folder', async () => {
    const { fs } = makeSyncer();
    const storage = makeStorage(null);
    const client = makeClient([]);

    const r = await (fs as any).backfillChunk(
      client,
      folder({ backfillOldestUid: null, lastSyncTime: 123, serverMessageCount: 0 }),
      storage,
    );

    expect(r.done).toBe(true);
    expect(storage.updateFolder).toHaveBeenCalledWith('f1', { backfillComplete: true });
  });

  it('completes (does not spin) when the client cannot page by UID range', async () => {
    const { fs } = makeSyncer();
    const storage = makeStorage(5000);
    const client = { selectFolder: vi.fn() } as any; // no fetchMessagesByUidRange

    const r = await (fs as any).backfillChunk(client, folder(), storage);

    expect(r.done).toBe(true);
    expect(storage.updateFolder).toHaveBeenCalledWith('f1', { backfillComplete: true });
  });
});
