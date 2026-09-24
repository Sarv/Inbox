import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FolderSyncer } from '../../../src/imap/folder-syncer';
import { FakeEmailStorage, resetFakeStorageIds } from '../../../src/test-support/fake-email-storage';
import { FakeImapServer, resetFakeMessageIds } from '../../../src/test-support/fake-imap-server';
import type { IMAPFolder } from '../../../src/types/imap';
import type { FolderRecord } from '../../../src/types/models';
import type { IEmailStorage } from '../../../src/types/storage';


// FolderSyncer surface that the flow tests (sync-flows.test.ts) and the backfill
// tests (backfill.test.ts) don't reach: folder-list ingest, sync ordering, the
// partial-failure paths, the Sent-folder edge case, and the background
// deletion-reconcile entry point. These are the seams where a folder quietly
// stops syncing — a failing batch aborting the rest of a first sync, a sent mail
// never appearing because its UID is below lastSyncUid, or a callback throwing
// and taking the sync down with it.

const INBOX = 'INBOX';
const SENT = 'Sent';

const imapFolder = (path: string, children: IMAPFolder[] = []): IMAPFolder => ({
  name: path.split('/').pop() ?? path,
  path,
  delimiter: '/',
  specialUse: null,
  subscribed: true,
  selectable: true,
  children,
});

function setup(paths: string[] = [INBOX]) {
  resetFakeMessageIds();
  resetFakeStorageIds();
  const server = new FakeImapServer();
  const db = new FakeEmailStorage();
  for (const path of paths) {
    server.addFolder(path, { uidValidity: 1 });
    db.addFolder(path, { uidValidity: 1 });
  }
  return { server, db, fs: new FolderSyncer() };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('syncFolderList', () => {
  it('FLATTENS nested folders so every child is stored too', async () => {
    // Only the top level comes back from LIST as a tree; a child that never lands
    // in storage can never be synced or shown.
    const db = new FakeEmailStorage();
    const fs = new FolderSyncer();
    const tree = [
      imapFolder(INBOX),
      imapFolder('Work', [imapFolder('Work/Clients', [imapFolder('Work/Clients/Acme')])]),
    ];

    await fs.syncFolderList(tree, db.asStorage());

    expect((await db.getFolders()).map((f) => f.path).sort())
      .toEqual(['INBOX', 'Work', 'Work/Clients', 'Work/Clients/Acme']);
  });

  it('does NOT reset the sync state of a folder it already knows', async () => {
    // syncFolderList runs on every connect; clobbering uidValidity/lastSyncUid here
    // would force a full re-sync of every folder each time.
    const db = new FakeEmailStorage();
    const fs = new FolderSyncer();
    await fs.syncFolderList([imapFolder(INBOX)], db.asStorage());
    const id = db.folder(INBOX).id;
    await db.updateFolder(id, { uidValidity: 9, lastSyncUid: 77 });

    await fs.syncFolderList([imapFolder(INBOX)], db.asStorage());

    expect(db.folder(INBOX).uidValidity).toBe(9);
    expect(db.folder(INBOX).lastSyncUid).toBe(77);
  });
});

describe('sync ordering', () => {
  it('syncs INBOX first and Trash/Spam last', async () => {
    // Priority is what makes the inbox appear before a huge Trash is walked.
    const { fs } = setup();

    const order = fs.sortFoldersByPriority([
      imapFolder('Trash'), imapFolder('Work'), imapFolder(INBOX), imapFolder('Spam'), imapFolder(SENT),
    ]).map((f) => f.path);

    expect(order).toEqual([INBOX, SENT, 'Work', 'Trash', 'Spam']);
    expect(fs.getFolderPriority(INBOX)).toBeLessThan(fs.getFolderPriority('Work'));
    expect(fs.getFolderPriority('Work')).toBeLessThan(fs.getFolderPriority('Trash'));
    // Case-insensitive: servers spell it "inbox" too.
    expect(fs.getFolderPriority('inbox')).toBe(fs.getFolderPriority(INBOX));
  });
});

describe('partial failures', () => {
  it('a FAILING batch does not abort the rest of a full sync', async () => {
    // A heavy chunk timing out used to abort the whole first sync, so NOTHING was
    // stored and the inbox stayed empty. Each batch is persisted as it lands.
    const { server, db, fs } = setup();
    server.addMessages(INBOX, 250);
    let call = 0;
    const real = server.fetchMessages.bind(server);
    vi.spyOn(server, 'fetchMessages').mockImplementation(async (range, opts) => {
      call += 1;
      if (call === 2) throw new Error('timeout');
      return real(range, opts);
    });

    const res = await fs.syncFolder(server, imapFolder(INBOX), db.asStorage(), { maxMessages: 250 });

    expect(res.success).toBe(true);
    expect(res.messagesInserted).toBe(200);       // the batch that DID land
    expect(db.folder(INBOX).lastSyncUid).toBe(250); // progress persisted
  });

  it('reports (never throws) when the folder cannot even be selected', async () => {
    const { server, db, fs } = setup();
    vi.spyOn(server, 'selectFolder').mockRejectedValue(new Error('NO mailbox unavailable'));

    const res = await fs.syncFolder(server, imapFolder(INBOX), db.asStorage());

    expect(res.success).toBe(false);
    expect(res.error?.message).toContain('mailbox unavailable');
  });

  it('a THROWING new-email callback does not fail the sync', async () => {
    const { server, db, fs } = setup();
    server.addMessages(INBOX, 2);
    fs.setOnNewEmail(() => { throw new Error('renderer gone'); });

    const res = await fs.syncFolder(server, imapFolder(INBOX), db.asStorage());

    expect(res.success).toBe(true);
    expect(db.allRows()).toHaveLength(2);
  });

  it('falls back to a folder-wide delete when the storage cannot unlink-or-delete', async () => {
    // Mobile storage lacks invalidateFolderMembership; a UIDVALIDITY change must
    // still re-key rather than silently doing nothing.
    const { server, db, fs } = setup();
    server.addMessages(INBOX, 2);
    await fs.syncFolder(server, imapFolder(INBOX), db.asStorage());
    server.bumpUidValidity(INBOX, 5);
    const legacy = Object.create(db) as FakeEmailStorage & { invalidateFolderMembership?: undefined };
    legacy.invalidateFolderMembership = undefined;
    const deleteSpy = vi.spyOn(db, 'deleteEmailsByFolder');

    const res = await fs.syncFolder(server, imapFolder(INBOX), legacy as unknown as IEmailStorage);

    expect(res.uidValidityChanged).toBe(true);
    expect(deleteSpy).toHaveBeenCalledWith(db.folder(INBOX).id);
    expect(db.folder(INBOX).uidValidity).toBe(5);
  });
});

describe('no-op syncs', () => {
  it('skips the new-mail fetch entirely when UIDNEXT says nothing arrived', async () => {
    const { server, db, fs } = setup();
    server.addMessages(INBOX, 3);
    await fs.syncFolder(server, imapFolder(INBOX), db.asStorage());
    const newSpy = vi.spyOn(server, 'getNewMessages');

    const res = await fs.syncFolder(server, imapFolder(INBOX), db.asStorage());

    expect(newSpy).not.toHaveBeenCalled(); // uidNext <= lastSyncUid + 1
    expect(res.lastSyncUid).toBe(3);
  });

  it('does nothing for a NON-Sent folder whose new-mail window came up empty', async () => {
    // UIDNEXT moved (a message came and went) but nothing above lastSyncUid remains.
    // Only the Sent folder has a re-check path; everything else must just stop.
    const { server, db, fs } = setup();
    server.addMessages(INBOX, 2);
    await fs.syncFolder(server, imapFolder(INBOX), db.asStorage());
    server.expungeOnServer(INBOX, server.addMessage(INBOX)); // UIDNEXT ahead of us

    const res = await fs.syncFolder(server, imapFolder(INBOX), db.asStorage());

    expect(res.success).toBe(true);
    expect(res.messagesProcessed).toBe(0);
    expect(db.allRows()).toHaveLength(2);
  });

  it('forwards the PENDING-op provider so a folder sync cannot revert a local flag', async () => {
    // The syncer owns the MessageProcessor, so the SyncEngine's pending-uid source
    // has to be threaded through it — otherwise a periodic folder sync reverts the
    // read state the user just changed but that hasn't round-tripped yet.
    const { server, db, fs } = setup();
    const uid = server.addMessage(INBOX, { flags: ['\\Seen'] });
    db.seedEmail({ folderId: db.folderId(INBOX), uid, tags: `|${INBOX}|` });
    await db.updateFolder(db.folderId(INBOX), { lastSyncUid: uid });
    fs.setPendingUidsProvider(async () => new Set([uid]));

    await fs.syncFolder(server, imapFolder(INBOX), db.asStorage());

    expect(db.tagsOf(db.allRows()[0].id)).toEqual([INBOX]); // not marked read
  });

  it('hasChanges compares UIDVALIDITY, message count and UIDNEXT', async () => {
    const { server, db, fs } = setup();
    server.addMessages(INBOX, 2);
    await db.updateFolder(db.folder(INBOX).id, {
      uidValidity: 1, lastKnownMessageCount: 2, lastKnownUidnext: 3,
    } as Partial<FolderRecord>);

    expect(await fs.hasChanges(server, db.folder(INBOX))).toBe(false);
    server.addMessage(INBOX); // count + uidNext move
    expect(await fs.hasChanges(server, db.folder(INBOX))).toBe(true);
  });

  it('hasChanges assumes CHANGED when the status probe fails (never skips a sync)', async () => {
    const { server, db, fs } = setup();
    vi.spyOn(server, 'getFolderStatus').mockRejectedValue(new Error('offline'));

    expect(await fs.hasChanges(server, db.folder(INBOX))).toBe(true);
  });
});

describe('Sent folder edge case', () => {
  it('picks up a sent mail whose UID is BELOW lastSyncUid', async () => {
    // A message can appear in Sent with a UID we've already passed (the server
    // assigns it while a sync is in flight, or it is re-appended). The forward-only
    // incremental fetch can never see it, so Sent silently missed sends.
    const { server, db, fs } = setup([SENT]);
    const older = server.addMessage(SENT, { messageId: '<older@test.local>' });
    const newer = server.addMessage(SENT, { messageId: '<newer@test.local>' });
    // A later message came and went, so UIDNEXT is ahead of everything we hold —
    // which is what makes the sync look for new mail and find none.
    server.expungeOnServer(SENT, server.addMessage(SENT));
    db.seedEmail({
      folderId: db.folderId(SENT), uid: newer, tags: `|${SENT}|`, messageId: '<newer@test.local>',
    });
    await db.updateFolder(db.folderId(SENT), { lastSyncUid: newer });
    // Isolate the Sent path: on a server that answers neither `FETCH 1:*` nor
    // `SEARCH ALL`, syncFlags returns before its own reconcile could ingest it.
    vi.spyOn(server, 'fetchAllFlags').mockRejectedValue(new Error('Command failed'));
    vi.spyOn(server, 'fetchAllUIDs').mockRejectedValue(new Error('Command failed'));

    const res = await fs.syncFolder(server, imapFolder(SENT), db.asStorage());

    expect(res.messagesInserted).toBe(1);
    expect(db.rowByMessageId('<older@test.local>')?.uid).toBe(older);
    // lastSyncUid must NOT regress to the older message's uid.
    expect(db.folder(SENT).lastSyncUid).toBe(newer);
  });

  it('handles an EMPTIED Sent folder without touching storage', async () => {
    const { server, db, fs } = setup([SENT]);
    // Two messages came and went, so UIDNEXT is two ahead of lastSyncUid — the
    // sync looks for new mail, finds none, and re-checks Sent on an empty folder.
    server.expungeOnServer(SENT, server.addMessage(SENT));
    server.expungeOnServer(SENT, server.addMessage(SENT));
    await db.updateFolder(db.folderId(SENT), { lastSyncUid: 1 });

    const res = await fs.syncFolder(server, imapFolder(SENT), db.asStorage());

    expect(res.success).toBe(true);
    expect(db.allRows()).toHaveLength(0);
  });

  it('does nothing when every recent sent mail is already stored', async () => {
    const { server, db, fs } = setup([SENT]);
    server.addMessage(SENT, { messageId: '<a@test.local>' });
    server.expungeOnServer(SENT, server.addMessage(SENT)); // UIDNEXT ahead of us
    db.seedEmail({ folderId: db.folderId(SENT), uid: 1, tags: `|${SENT}|`, messageId: '<a@test.local>' });
    await db.updateFolder(db.folderId(SENT), { lastSyncUid: 1 });
    vi.spyOn(server, 'fetchAllFlags').mockRejectedValue(new Error('Command failed'));
    vi.spyOn(server, 'fetchAllUIDs').mockRejectedValue(new Error('Command failed'));

    const res = await fs.syncFolder(server, imapFolder(SENT), db.asStorage());

    expect(res.messagesInserted ?? 0).toBe(0);
    expect(db.allRows()).toHaveLength(1);
  });
});

describe('reconcileDeletionsFull (background deferred deletion)', () => {
  it('SELECTS the folder itself and forces the whole-mailbox reconcile', async () => {
    // Large mailboxes defer whole-folder deletion off the hot path; this is the
    // background entry point, and it must open the right mailbox first or it would
    // reconcile against whatever was selected.
    const { server, db, fs } = setup([INBOX, 'Other']);
    const gone = server.addMessage(INBOX);
    server.addMessage(INBOX);
    db.seedEmail({ folderId: db.folderId(INBOX), uid: gone, tags: `|${INBOX}|` });
    db.seedEmail({ folderId: db.folderId(INBOX), uid: 2, tags: `|${INBOX}|` });
    server.expungeOnServer(INBOX, gone);
    await server.selectFolder('Other'); // wrong mailbox open
    const flagsSpy = vi.spyOn(fs.getMessageProcessor(), 'syncFlags');

    const res = await fs.reconcileDeletionsFull(server, db.folder(INBOX), db.asStorage());

    expect(server.getCurrentFolder()).toBe(INBOX);
    // CHANGED: reconcileDeletionsFull now also forwards onReadChange (unused here)
    // and the pool-stuck-eviction `touch` heartbeat, so the call carries two extra
    // trailing args (both undefined when no touch is supplied).
    expect(flagsSpy).toHaveBeenCalledWith(
      server, db.folder(INBOX), db.asStorage(), undefined, expect.any(Function),
      { forceDeletion: true, fullReconcile: true }, undefined, undefined,
    );
    expect(res.deleted).toBe(1);
    expect(db.rowsPrimaryIn(INBOX).map((e) => e.uid)).toEqual([2]);
  });

  it('FORWARDS the pool-stuck-eviction touch heartbeat through to syncFlags', async () => {
    // The regression: this whole-mailbox reconcile runs on ONE pooled connection
    // and, on a big folder ([Gmail]/All Mail), out-lasts the 120s stuck-eviction.
    // If reconcileDeletionsFull drops the touch callback, syncFlags can't refresh
    // the connection's acquiredAt, the pool reclaims it mid-run, poisons the
    // socket, drops the primary and triggers the connect-timeout back-off storm
    // (mail stops arriving). It must pass the SAME touch through as the 8th arg.
    const { server, db, fs } = setup([INBOX]);
    server.addMessage(INBOX);
    db.seedEmail({ folderId: db.folderId(INBOX), uid: 1, tags: `|${INBOX}|` });
    await server.selectFolder(INBOX);
    const flagsSpy = vi.spyOn(fs.getMessageProcessor(), 'syncFlags');
    const touch = vi.fn();

    await fs.reconcileDeletionsFull(server, db.folder(INBOX), db.asStorage(), touch);

    expect(flagsSpy).toHaveBeenCalledWith(
      server, db.folder(INBOX), db.asStorage(), undefined, expect.any(Function),
      { forceDeletion: true, fullReconcile: true }, undefined, touch,
    );
  });
});

describe('incremental sync on a far-behind folder', () => {
  // The bug: INBOX sat at lastSyncUid 3226 while the server was at uidNext 27709.
  // The ascending walk had to cross 24,482 UIDs before the caller saw anything,
  // could not finish inside the 120s sync timeout, and was torn down every cycle —
  // so the watermark never moved and the newest month of mail never arrived, even
  // though the oldest end drained steadily. The pass MUST bring back the newest
  // mail first and MUST stay bounded.
  it('fetches the NEWEST mail first instead of walking up from the watermark', async () => {
    const { server, db, fs } = setup();
    server.addMessages(INBOX, 700);                              // UIDs 1..700
    // totalCount keeps this off the low-local-count recovery path, so the
    // INCREMENTAL branch is the one under test.
    await db.updateFolder(db.folderId(INBOX), { lastSyncUid: 1, totalCount: 50 }); // 699 UIDs behind

    const res = await fs.syncFolder(server, imapFolder(INBOX), db.asStorage());

    expect(res.success).toBe(true);
    // The newest UID on the server is in this pass — that is the mail the user
    // is looking for. Before the fix it was ~700 messages away.
    expect(res.messagesInserted).toBe(500);       // capped, not all 699
    expect(db.allRows().some((e) => e.uid === 700)).toBe(true);
  });

  // lastSyncUid means "everything at or below this is synced". Advancing it over
  // the range the cap skipped would mark that mail as done and hide it from
  // incremental sync forever — the exact trap realtime-manager already documents.
  it('does NOT advance lastSyncUid across the hole the cap left below', async () => {
    const { server, db, fs } = setup();
    server.addMessages(INBOX, 700);
    await db.updateFolder(db.folderId(INBOX), { lastSyncUid: 1, totalCount: 50 });

    await fs.syncFolder(server, imapFolder(INBOX), db.asStorage());

    // Scanned down to 201 only, so UIDs 2..200 are still missing: the watermark
    // stays put and the background drain closes the gap.
    expect(db.folder(INBOX).lastSyncUid).toBe(1);
  });

  // Once the gap is small enough to cover in one pass the watermark MUST advance,
  // otherwise a healthy folder re-fetches its newest window forever.
  it('advances lastSyncUid once the pass reaches the watermark', async () => {
    const { server, db, fs } = setup();
    server.addMessages(INBOX, 10);
    await db.updateFolder(db.folderId(INBOX), { lastSyncUid: 4, totalCount: 50 });

    const res = await fs.syncFolder(server, imapFolder(INBOX), db.asStorage());

    expect(res.messagesInserted).toBe(6);            // UIDs 5..10
    expect(db.folder(INBOX).lastSyncUid).toBe(10);   // no hole => advance
  });
});
