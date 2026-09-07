import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeEmailStorage, resetFakeStorageIds } from '../../../src/test-support/fake-email-storage';
import { FakeImapServer, resetFakeMessageIds } from '../../../src/test-support/fake-imap-server';

import type { IMAPFolder } from '../../../src/types/imap';

import { SyncEngine } from '../../../src/imap/sync-engine';

// getSelectableFolders() requires `selectable` (and prefers `subscribed`), which
// the fake server's listFolders() doesn't set — shape a real folder entry here.
const imapFolder = (path: string): IMAPFolder => ({
  name: path.split('/').pop() ?? path,
  path,
  delimiter: '/',
  specialUse: null,
  subscribed: true,
  selectable: true,
  children: [],
});

// Regression: the macOS beachball / "app not smooth" on a large mailbox.
//
// `recalculateFolderCounts()` is a SYNCHRONOUS, main-thread, full-table scan
// (~120-230ms on a 26k-row account). syncAll used to call it UNCONDITIONALLY at
// the end of every pass — including the overwhelmingly common quiet poll where
// nothing new arrived and no flag/deletion changed. A periodic sync walking N
// folders therefore fired N of those scans back-to-back for zero benefit (the
// counts provably could not have moved), freezing the event loop repeatedly.
//
// The gate: only recount when the pass actually mutated the emails table
// (inserted new mail, updated flags, or deleted) — mirroring the realtime
// flag-sync gate. These tests pin BOTH directions: it must skip the scan on a
// genuine no-op, and it must NOT skip it when something changed (which would
// leave the sidebar counts stale — a silently-wrong count is the worse bug).

const INBOX = 'INBOX';

function setup() {
  resetFakeMessageIds();
  resetFakeStorageIds();
  const server = new FakeImapServer();
  server.addFolder(INBOX, { uidValidity: 1 });
  const db = new FakeEmailStorage();
  db.addFolder(INBOX, { uidValidity: 1 });
  const engine = new SyncEngine(db.asStorage());
  vi.spyOn(engine, 'isConnected').mockReturnValue(true);
  const cm = engine as unknown as {
    connectionManager: { _client: unknown; ensureConnection: () => Promise<boolean> };
    reselectMonitoredFolder: () => Promise<void>;
  };
  cm.connectionManager._client = server;
  cm.connectionManager.ensureConnection = async () => true;
  cm.reselectMonitoredFolder = async () => {};
  vi.spyOn(server, 'listFolders').mockResolvedValue([imapFolder(INBOX)]);
  return { server, db, engine };
}

describe('SyncEngine.syncAll — recalculateFolderCounts is gated on real change', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('skips the full-table recount on a quiet re-sync with nothing new', async () => {
    // The exact field scenario: a periodic poll over an unchanged folder. The
    // first sync ingests mail (and legitimately recounts); the SECOND sync finds
    // nothing new — and must not fire another ~120ms scan.
    const { server, db, engine } = setup();
    server.addMessages(INBOX, 3);

    await engine.syncAll();
    const afterFirst = db.callCount('recalculateFolderCounts');
    expect(afterFirst).toBeGreaterThanOrEqual(1); // inserts happened → recount is warranted

    await engine.syncAll(); // nothing new on the server
    expect(db.callCount('recalculateFolderCounts')).toBe(afterFirst); // no extra scan
  });

  it('DOES recount when new mail arrives (counts would otherwise be stale)', async () => {
    // The skip must never swallow a real insert — the total/unread badge has to move.
    const { server, db, engine } = setup();
    server.addMessages(INBOX, 2);
    await engine.syncAll();
    const afterFirst = db.callCount('recalculateFolderCounts');

    server.addMessages(INBOX, 2); // uids 3,4 arrive
    await engine.syncAll();
    expect(db.callCount('recalculateFolderCounts')).toBeGreaterThan(afterFirst);
  });

  // The next three pin the gate's exact contract on the per-folder result. Only
  // inserts, flag updates or deletions can move a count; the gate must fire the
  // recount on ANY of those and skip only when all three are zero. Driven by
  // stubbing folderSyncer.syncFolder so the outcome is deterministic (the real
  // flag re-read is throttled between back-to-back syncs, which the e2e tests
  // above deliberately avoid).
  const stubFolderResult = (
    engine: SyncEngine,
    result: { messagesInserted: number; flagsUpdated: number; deletedCount: number },
  ): void => {
    const fs = (engine as unknown as { folderSyncer: { syncFolder: unknown } }).folderSyncer;
    vi.spyOn(fs as { syncFolder: (...args: unknown[]) => unknown }, 'syncFolder')
      .mockResolvedValue({ success: true, messagesProcessed: 0, lastSyncUid: 1, ...result });
  };

  it('DOES recount on a flag-only change even though messagesProcessed is 0', async () => {
    // The critical guard: a sync with no NEW mail still reconciles flags, and a
    // flag flip moves the unread count. Gating purely on messagesProcessed (0
    // here) would wrongly skip the recount and leave the unread badge stale.
    const { db, engine } = setup();
    stubFolderResult(engine, { messagesInserted: 0, flagsUpdated: 1, deletedCount: 0 });
    await engine.syncAll();
    expect(db.callCount('recalculateFolderCounts')).toBeGreaterThanOrEqual(1);
  });

  it('DOES recount when only deletions were reconciled (no insert)', async () => {
    // A deletion changes total_count with no insert — must still recount.
    const { db, engine } = setup();
    stubFolderResult(engine, { messagesInserted: 0, flagsUpdated: 0, deletedCount: 2 });
    await engine.syncAll();
    expect(db.callCount('recalculateFolderCounts')).toBeGreaterThanOrEqual(1);
  });

  it('skips the recount when the folder result shows nothing changed', async () => {
    // Deterministic complement to the e2e no-op test: an all-zero result must
    // never trigger the full-table scan.
    const { db, engine } = setup();
    stubFolderResult(engine, { messagesInserted: 0, flagsUpdated: 0, deletedCount: 0 });
    await engine.syncAll();
    expect(db.callCount('recalculateFolderCounts')).toBe(0);
  });
});
