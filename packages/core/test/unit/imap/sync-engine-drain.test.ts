import { describe, expect, it, vi } from 'vitest';

import { FakeEmailStorage, resetFakeStorageIds } from '../../../src/test-support/fake-email-storage';
import { FakeImapServer, resetFakeMessageIds } from '../../../src/test-support/fake-imap-server';

import { SyncEngine } from '../../../src/imap/sync-engine';

// Regression for the "Gmail stuck at ~8.6k, never finishes" strand in the DRAIN.
//
// The drain is oldest-first and, on a Gmail All-Mail superset, the oldest UIDs are
// messages that already exist locally under another folder (primary = Archive/label,
// tagged here) — folder_id-"missing" but real no-ops. The old drain fetched the
// oldest 300, counted those relinks as "progress" (remaining = genuinelyMissing −
// (inserted+linked)), computed remaining 0, returned `done`, and the scheduler
// skipped the folder for the whole session — so the genuinely-missing NEWER holes
// never downloaded. The fix: a per-folder tried-set + `done` derived from UNTRIED
// candidates, so the drain advances through to the real gaps.

const INBOX = 'INBOX';

function setup() {
  resetFakeMessageIds();
  resetFakeStorageIds();
  const server = new FakeImapServer({ qresync: true, condstore: true });
  server.addFolder(INBOX, { uidValidity: 1 });
  const db = new FakeEmailStorage();
  db.addFolder(INBOX, { uidValidity: 1 });
  db.addFolder('Archive', { uidValidity: 1 });
  const engine = new SyncEngine(db.asStorage());
  vi.spyOn(engine, 'isConnected').mockReturnValue(true);
  (engine as unknown as { isSyncing: () => boolean }).isSyncing = () => false;
  (engine as unknown as { connectionManager: { _client: unknown } }).connectionManager._client = server;
  (engine as unknown as { reselectMonitoredFolder: () => Promise<void> }).reselectMonitoredFolder = async () => {};
  return { server, db, engine };
}

describe('SyncEngine.drainFolderChunk — converges past cross-folder no-ops', () => {
  it('drains untried candidates across calls to reach the genuinely-missing (no premature done)', async () => {
    const { server, db, engine } = setup();
    // 400 server messages. uid 1..300 already exist locally (primary Archive, tagged
    // INBOX) → oldest-first NO-OPS. uid 301..400 are genuinely missing.
    for (let i = 1; i <= 400; i++) server.addMessage(INBOX, { uid: i, messageId: `<d${i}@t>` });
    for (let i = 1; i <= 300; i++) {
      db.seedEmail({ folderId: db.folderId('Archive'), uid: i, tags: `|Archive|${INBOX}|`, messageId: `<d${i}@t>` });
    }

    // Call 1: fetches the oldest 300 — all present-by-tag no-ops. NOT done (old bug:
    // counted the relinks as progress and returned done → folder skipped forever).
    const r1 = await engine.drainFolderChunk(INBOX);
    expect(r1).toMatchObject({ inserted: 0, done: false });
    expect(db.rowsPrimaryIn(INBOX)).toHaveLength(0);

    // Call 2: the 300 no-ops are marked tried, so it drains the untried 301..400 and
    // actually downloads them.
    const r2 = await engine.drainFolderChunk(INBOX);
    expect(r2!.inserted).toBe(100);
    expect(r2!.done).toBe(true);
    expect(db.rowsPrimaryIn(INBOX).map((e) => e.uid!).sort((a, b) => a - b))
      .toEqual(Array.from({ length: 100 }, (_, k) => k + 301));
  });

  it('does NOT report done while a requested UID was DROPPED from a partial response — retries it', async () => {
    // "0 mistakes": a UID the server dropped from the FETCH response was never
    // downloaded. `done` must stay false so the drain comes back for it instead of
    // the scheduler marking the folder complete and stranding it.
    const { server, db, engine } = setup();
    for (let i = 1; i <= 3; i++) server.addMessage(INBOX, { uid: i, messageId: `<p${i}@t>` });

    const realFetch = server.fetchMessagesByUID.bind(server);
    const spy = vi.spyOn(server, 'fetchMessagesByUID').mockImplementationOnce(async (uids: number[], opts: never) => {
      const all = await realFetch(uids, opts);
      return all.filter((m) => m.uid !== 2); // server drops uid 2
    });

    const r1 = await engine.drainFolderChunk(INBOX);
    expect(r1!.done).toBe(false);            // uid 2 dropped → not done
    expect(db.rowsPrimaryIn(INBOX).map((e) => e.uid!).sort((a, b) => a - b)).toEqual([1, 3]);

    spy.mockRestore();
    await engine.drainFolderChunk(INBOX);
    expect(db.rowsPrimaryIn(INBOX).map((e) => e.uid!).sort((a, b) => a - b)).toEqual([1, 2, 3]); // 2 retried + stored
  });

  it('does NOT mark a transiently-ERRORED UID as tried — retries it next call', async () => {
    // A UID the server returned but that failed to store (transient) must not be
    // suppressed as "downloaded". processBatch reports it in erroredUids; the drain
    // must exclude it from the tried-set and come back for it.
    const { server, db, engine } = setup();
    for (let i = 1; i <= 2; i++) server.addMessage(INBOX, { uid: i, messageId: `<e${i}@t>` });

    const mp = (engine as unknown as { messageProcessor: { processBatch: (...a: unknown[]) => Promise<unknown> } }).messageProcessor;
    const realProcess = mp.processBatch.bind(mp);
    const spy = vi.spyOn(mp, 'processBatch').mockImplementationOnce(async (msgs: any, ...rest: unknown[]) => {
      // uid 1 "transiently errors": store only uid 2, report uid 1 as errored.
      const r = await realProcess(msgs.filter((m: any) => m.uid === 2), ...rest) as { erroredUids: number[] };
      return { ...r, erroredUids: [1] };
    });

    const r1 = await engine.drainFolderChunk(INBOX);
    expect(r1!.done).toBe(false);            // uid 1 errored → unaccounted → not done
    expect(db.rowsPrimaryIn(INBOX).map((e) => e.uid!)).toEqual([2]);

    spy.mockRestore();
    await engine.drainFolderChunk(INBOX);
    expect(db.rowsPrimaryIn(INBOX).map((e) => e.uid!).sort((a, b) => a - b)).toEqual([1, 2]); // uid 1 retried + stored
  });
});
