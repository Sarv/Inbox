import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SyncEngine } from '../../../src/imap/sync-engine';
import { FakeEmailStorage, resetFakeStorageIds } from '../../../src/test-support/fake-email-storage';
import { FakeImapServer, resetFakeMessageIds } from '../../../src/test-support/fake-imap-server';
import type { IMAPFolder } from '../../../src/types/imap';
import { MID_SYNC_RECOUNT_MS } from '../../../src/utils/folder-counts';

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

// Regression: the sidebar badge that sits frozen through an entire first sync.
//
// `folders.total_count` / `unread_count` are STORED columns, and the engine used
// to re-state them exactly once — AFTER the whole folder loop. On a first sync of
// a big mailbox that is minutes away, so the badge stayed on its opening number
// while the list totals beside it (live queries) climbed into the thousands.
// Reported from the field as "counters are increasing drastically ... just [the]
// counter is stuck", i.e. read as a stalled download.
//
// These tests pin BOTH directions: the count must move while the folder is still
// syncing, and it must not turn into a recount per committed batch (that is the
// full-table-scan-per-10-messages stall the end-of-sync gate exists to avoid).

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
  const recount = vi.spyOn(db, 'recalculateFolderCounts');
  return { server, db, engine, recount };
}

/** Every recount the pass made EXCEPT the end-of-sync one, which is the only
 *  call that asks for all folders (no paths). */
const midSyncCalls = (recount: { mock: { calls: unknown[][] } }): unknown[] =>
  recount.mock.calls.map((c) => c[0]).filter((paths) => paths !== undefined);

/** A clock that jumps a full gate window on every read, so each progress tick
 *  is eligible — the engine only ever compares Date.now() differences. */
const freeRunningClock = () => {
  let now = 1_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => (now += MID_SYNC_RECOUNT_MS));
};

describe('SyncEngine.syncFolder — stored counts move WHILE the folder syncs', () => {
  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(() => { vi.restoreAllMocks(); });

  // Breaks: the badge goes back to being frozen for the whole sync, which is the
  // reported bug — the only recount would be the one after the folder loop.
  it('recounts the folder in progress before the sync finishes', async () => {
    const { server, engine, recount } = setup();
    server.addMessages(INBOX, 25); // > 1 commit batch (processBatch commits per 10)
    freeRunningClock();

    await engine.syncAll();

    expect(midSyncCalls(recount).length).toBeGreaterThanOrEqual(1);
  });

  // Breaks: a mid-sync recount that asks for every folder. Scoped to one folder
  // it is two aggregate queries; unscoped it is the ~200ms main-thread full scan,
  // and firing that every couple of seconds is the beachball all over again.
  it('scopes every mid-sync recount to the one folder being synced', async () => {
    const { server, engine, recount } = setup();
    server.addMessages(INBOX, 25);
    freeRunningClock();

    await engine.syncAll();

    for (const paths of midSyncCalls(recount)) expect(paths).toEqual([INBOX]);
  });

  // Breaks: the time gate. The message processor calls back every 10 messages,
  // so without it a 25k-message folder would fire 2,500 recounts.
  it('does not recount when the batches land inside the gate window', async () => {
    const { server, engine, recount } = setup();
    server.addMessages(INBOX, 25);
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000); // no time passes at all

    await engine.syncAll();

    expect(midSyncCalls(recount)).toEqual([]);
    // ...and the end-of-sync recount still runs (one call, no paths = all
    // folders), so the counts are right by the time the sync reports done.
    expect(recount.mock.calls).toEqual([[]]);
  });

  // Breaks: the counts the user ends up looking at. A mid-sync recount that
  // writes a partial number must still be superseded by the final, complete one.
  it('leaves the folder counts correct once the sync completes', async () => {
    const { server, db, engine } = setup();
    server.addMessages(INBOX, 25);
    freeRunningClock();

    await engine.syncAll();

    expect(db.folder(INBOX)?.totalCount).toBe(25);
  });
});
