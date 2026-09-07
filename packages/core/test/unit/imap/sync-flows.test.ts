import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeEmailStorage, resetFakeStorageIds } from '../../../src/test-support/fake-email-storage';
import { FakeImapServer, resetFakeMessageIds } from '../../../src/test-support/fake-imap-server';
import type { IMAPFolder } from '../../../src/types/imap';

import { FolderSyncer } from '../../../src/imap/folder-syncer';

// END-TO-END sync flows: the real FolderSyncer + the real MessageProcessor driven
// against the in-memory server and DB. Where the unit files pin one function's
// contract, these pin the SEQUENCES that actually went wrong in the field —
// nobody ever hit "syncFlags with a truncated list", they hit "I trashed a mail
// in webmail and it came back", which is three functions interacting.
//
// Covered here:
//   - new mail only above the last seen UID, and re-running a sync is a no-op
//   - a UIDVALIDITY change re-keys NON-destructively (label rows survive) and a
//     garbage/NaN/0 validity never wipes anything
//   - a server-side expunge reaches the UI (onEmailDeleted) via the folder sync
//   - a webmail move and move-BACK leave exactly ONE live copy and never a
//     foreign UID (a stale uid in the wrong folder is what deleted restored mail)
//   - the recovery heuristic re-syncs a folder that drifted far below the server
//
// No network, no DB, no clock dependence.

const INBOX = 'INBOX';
const TRASH = 'Trash';
const ARCHIVE = 'Archive';

const imapFolder = (path: string): IMAPFolder => ({
  name: path.split('/').pop() ?? path,
  path,
  delimiter: '/',
  specialUse: null,
  subscribed: true,
  selectable: true,
  children: [],
});

interface Ctx {
  server: FakeImapServer;
  db: FakeEmailStorage;
  fs: FolderSyncer;
  newEmails: Array<{ id: string; folderPath: string }>;
  deletedEmails: Array<{ uid: number; folderPath: string }>;
  reconciled: string[];
}

function setup(): Ctx {
  resetFakeMessageIds();
  resetFakeStorageIds();
  const server = new FakeImapServer();
  const db = new FakeEmailStorage();
  for (const path of [INBOX, TRASH, ARCHIVE]) {
    server.addFolder(path, { uidValidity: 1 });
    db.addFolder(path, { uidValidity: 1 });
  }
  const fs = new FolderSyncer();
  const newEmails: Ctx['newEmails'] = [];
  const deletedEmails: Ctx['deletedEmails'] = [];
  const reconciled: string[] = [];
  fs.setOnNewEmail((id, folderPath) => newEmails.push({ id, folderPath }));
  fs.setOnEmailDeleted((_id, uid, folderPath) => deletedEmails.push({ uid, folderPath }));
  fs.setOnReconcileFolders((folders) => reconciled.push(...folders));
  return { server, db, fs, newEmails, deletedEmails, reconciled };
}

const sync = (ctx: Ctx, path: string, options: Record<string, unknown> = {}) =>
  ctx.fs.syncFolder(ctx.server, imapFolder(path), ctx.db.asStorage(), options);

/** Move on the SERVER as another client would, returning the destination UID. */
async function webmailMove(ctx: Ctx, from: string, to: string, uid: number): Promise<number> {
  await ctx.server.selectFolder(from);
  const map = await ctx.server.moveMessages([uid], to);
  return map!.get(uid)!;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('new mail', () => {
  it('first sync stores the newest window and records lastSyncUid', async () => {
    const ctx = setup();
    ctx.server.addMessages(INBOX, 4);

    const res = await sync(ctx, INBOX);

    expect(res.success).toBe(true);
    expect(res.messagesInserted).toBe(4);
    expect(ctx.db.folder(INBOX).lastSyncUid).toBe(4);
    expect(ctx.newEmails).toHaveLength(4); // one renderer event per inserted row
  });

  it('an incremental sync asks only for UIDs ABOVE the last seen one', async () => {
    const ctx = setup();
    ctx.server.addMessages(INBOX, 3);
    await sync(ctx, INBOX);
    ctx.server.addMessages(INBOX, 2); // uids 4, 5 arrive
    // New mail is now pulled in BOUNDED UID windows starting at lastSeen+1, not an
    // unbounded getNewMessages(3) `4:*` — the low bound proves we ask only above 3.
    const rangeSpy = vi.spyOn(ctx.server, 'fetchMessagesByUidRange');

    await sync(ctx, INBOX);

    // Never re-fetching 1..3 is what keeps a periodic sync cheap on a big mailbox.
    expect(rangeSpy).toHaveBeenCalledWith(4, expect.anything(), expect.anything());
    expect(ctx.db.rowsPrimaryIn(INBOX).map((e) => e.uid).sort((a, b) => a! - b!)).toEqual([1, 2, 3, 4, 5]);
    expect(ctx.db.folder(INBOX).lastSyncUid).toBe(5);
  });

  it('mail already ingested by the addition reconcile is NOT inserted twice', async () => {
    // syncFlags' addition reconcile runs BEFORE the new-mail fetch in the same
    // pass, so on a small mailbox it can be the path that first stores brand-new
    // UIDs. Whichever gets there first, the folder must end up with exactly one
    // row per message and a correctly advanced lastSyncUid.
    const ctx = setup();
    ctx.server.addMessages(INBOX, 3);
    await sync(ctx, INBOX);
    ctx.server.addMessages(INBOX, 2);

    await sync(ctx, INBOX);
    await sync(ctx, INBOX);

    expect(ctx.db.allRows()).toHaveLength(5);
    expect(ctx.db.rowsTaggedWith(INBOX)).toHaveLength(5);
    expect(ctx.db.folder(INBOX).lastSyncUid).toBe(5);
  });

  it('RE-RUNNING a sync with nothing new is a no-op — no duplicate rows', async () => {
    const ctx = setup();
    ctx.server.addMessages(INBOX, 3);
    await sync(ctx, INBOX);

    const second = await sync(ctx, INBOX);
    const third = await sync(ctx, INBOX);

    expect(second.messagesInserted ?? 0).toBe(0);
    expect(third.messagesInserted ?? 0).toBe(0);
    expect(ctx.db.allRows()).toHaveLength(3);
    expect(ctx.db.folder(INBOX).lastSyncUid).toBe(3);
  });

  it('never REGRESSES lastSyncUid when the server re-serves an already-synced message', async () => {
    // IMAP quirk: an unbounded `uid > highest:*` returns the highest message
    // anyway, and a regressed lastSyncUid puts the folder in a permanent refetch
    // loop. The bounded windowed fetch defends twice: it never even ASKS past the
    // head (range hiEnd <= lastSyncUid short-circuits), AND drops any echoed
    // UID <= lastSyncUid. Even if the server DID echo the boundary message, the
    // filter keeps lastSyncUid put.
    const ctx = setup();
    ctx.server.addMessages(INBOX, 3);
    await sync(ctx, INBOX);
    await ctx.db.updateFolder(ctx.db.folder(INBOX).id, { lastSyncUid: 3 });
    // Force the echo through the REAL path: hand back uid 3 for any bounded range.
    await ctx.server.selectFolder(INBOX);
    const stale = await ctx.server.fetchMessagesByUID([3]);
    vi.spyOn(ctx.server, 'fetchMessagesByUidRange').mockResolvedValue(stale);

    await sync(ctx, INBOX);

    expect(ctx.db.folder(INBOX).lastSyncUid).toBe(3);
    expect(ctx.db.allRows()).toHaveLength(3);
  });

  it('flagsOnly sync reconciles flags + deletions and fetches no new mail', async () => {
    const ctx = setup();
    ctx.server.addMessages(INBOX, 3);
    await sync(ctx, INBOX);
    ctx.server.setFlagsOnServer(INBOX, 2, ['\\Seen']);
    await webmailMove(ctx, INBOX, TRASH, 3); // and one mail trashed elsewhere
    const newSpy = vi.spyOn(ctx.server, 'getNewMessages');
    const rangeSpy = vi.spyOn(ctx.server, 'fetchMessagesByUidRange');

    const res = await sync(ctx, INBOX, { flagsOnly: true });

    expect(newSpy).not.toHaveBeenCalled();   // no new-mail fetch on a flags-only pass
    expect(rangeSpy).not.toHaveBeenCalled(); // (neither the bounded windowed path)
    expect(res.flagsUpdated).toBe(1);
    expect(res.deletedCount).toBe(1);      // deletion IS reconciled (forceDeletion)
    expect(ctx.db.rowsPrimaryIn(INBOX).map((e) => e.uid).sort((a, b) => a! - b!)).toEqual([1, 2]);
  });
});

describe('UIDVALIDITY', () => {
  it('a CHANGED validity re-keys non-destructively and re-syncs from scratch', async () => {
    const ctx = setup();
    ctx.server.addMessages(INBOX, 3);
    await sync(ctx, INBOX);
    // A row that ALSO lives in Archive (Gmail label). The old blind
    // deleteEmailsByFolder destroyed these even though they still lived elsewhere.
    const labelled = ctx.db.rowsPrimaryIn(INBOX)[0];
    await ctx.db.linkEmailToFolder(labelled.id, ctx.db.folderId(ARCHIVE));
    // The server lost its UID space: same three messages, brand-new UIDs.
    ctx.server.bumpUidValidity(INBOX, 42);

    const res = await sync(ctx, INBOX);

    expect(res.uidValidityChanged).toBe(true);
    expect(ctx.db.folder(INBOX).uidValidity).toBe(42);
    expect(ctx.db.row(labelled.id)).toBeDefined();            // label row survived
    expect(ctx.db.tagsOf(labelled.id)).toContain(ARCHIVE);
    // Exactly three messages afterwards — re-keyed, not duplicated.
    expect(ctx.db.rowsTaggedWith(INBOX)).toHaveLength(3);
    expect(ctx.db.allRows()).toHaveLength(3);
    // Every uid the folder now owns is from the NEW UID space (1..3 re-issued).
    expect(ctx.db.rowsPrimaryIn(INBOX).every((e) => e.uid != null && e.uid <= 3)).toBe(true);
  });

  it('the new validity is adopted ONLY together with the re-key', async () => {
    // Adopting it without re-keying is what permanently defeated the recovery: the
    // next sync then saw "no change" and left every row mis-keyed forever.
    const ctx = setup();
    ctx.server.addMessages(INBOX, 2);
    await sync(ctx, INBOX);
    ctx.server.bumpUidValidity(INBOX, 7);
    const rekeySpy = vi.spyOn(ctx.db, 'invalidateFolderMembership');
    const updateSpy = vi.spyOn(ctx.db, 'updateFolder');

    await sync(ctx, INBOX);

    const adoptIndex = updateSpy.mock.calls.findIndex(([, upd]) => upd.uidValidity === 7);
    expect(adoptIndex).toBeGreaterThanOrEqual(0);
    // The re-key must have RUN before the new validity was persisted.
    expect(rekeySpy.mock.invocationCallOrder[0])
      .toBeLessThan(updateSpy.mock.invocationCallOrder[adoptIndex]);
    // ...and the stored modseq (only meaningful under the OLD validity) is dropped
    // so the next flag sync takes the proven full path.
    expect(updateSpy.mock.calls[adoptIndex][1]).toMatchObject({ lastSyncUid: null, highestModseq: null });
    expect(ctx.db.folder(INBOX).uidValidity).toBe(7);
  });

  it('a GARBAGE server validity (NaN / 0 / missing) never wipes the folder', async () => {
    // `folder.uidValidity !== NaN` is always true, so the old check "detected a
    // change" on every garbage reading and wiped a perfectly good folder.
    for (const garbage of [NaN, 0, undefined]) {
      const ctx = setup();
      ctx.server.addMessages(INBOX, 3);
      await sync(ctx, INBOX);
      const before = ctx.db.allRows().map((e) => e.id).sort();
      const realSelect = ctx.server.selectFolder.bind(ctx.server);
      vi.spyOn(ctx.server, 'selectFolder').mockImplementation(async (path) => ({
        ...(await realSelect(path)),
        uidValidity: garbage as number,
      }));

      const res = await sync(ctx, INBOX);

      expect(res.uidValidityChanged).toBe(false);
      expect(ctx.db.allRows().map((e) => e.id).sort()).toEqual(before);
      expect(ctx.db.folder(INBOX).uidValidity).toBe(1); // stored value untouched
      vi.restoreAllMocks();
    }
  });

  it('stores the validity on FIRST sight without touching anything', async () => {
    const ctx = setup();
    await ctx.db.updateFolder(ctx.db.folderId(INBOX), { uidValidity: null });
    ctx.server.addMessages(INBOX, 2);
    const rekeySpy = vi.spyOn(ctx.db, 'invalidateFolderMembership');

    const res = await sync(ctx, INBOX);

    expect(res.uidValidityChanged).toBe(false);
    expect(rekeySpy).not.toHaveBeenCalled();
    expect(ctx.db.folder(INBOX).uidValidity).toBe(1);
  });
});

describe('server-side deletion reaches the app', () => {
  it('mail trashed in webmail leaves the folder and emits a per-row deleted event', async () => {
    const ctx = setup();
    ctx.server.addMessages(INBOX, 3);
    await sync(ctx, INBOX);
    await webmailMove(ctx, INBOX, TRASH, 2);

    await sync(ctx, INBOX);

    expect(ctx.deletedEmails).toEqual([{ uid: 2, folderPath: INBOX }]);
    expect(ctx.db.rowsPrimaryIn(INBOX).map((e) => e.uid).sort((a, b) => a! - b!)).toEqual([1, 3]);
  });
});

describe('cross-folder move and move-BACK', () => {
  it('a webmail Inbox->Trash move keeps ONE copy, now in Trash', async () => {
    const ctx = setup();
    ctx.server.addMessage(INBOX);
    await sync(ctx, INBOX);
    const trashUid = await webmailMove(ctx, INBOX, TRASH, 1);

    // Destination first (what the realtime path does), then the source reconcile.
    const trashResult = await sync(ctx, TRASH);
    await sync(ctx, INBOX);

    expect(trashUid).toBe(1);
    expect(ctx.reconciled).toContain(INBOX); // source folder flagged for reconcile
    expect(trashResult.success).toBe(true);
    expect(ctx.db.allRows()).toHaveLength(1);        // never duplicated
    expect(ctx.db.tagsOf(ctx.db.allRows()[0].id)).toEqual([TRASH]); // and never left in Inbox
  });

  it('a Trash->Inbox move-BACK never loses the mail and never keeps a FOREIGN uid', async () => {
    // The vanishing bug: the destination relinked the row but the SOURCE folder's
    // expunge then deleted it outright, so the mail disappeared from everywhere.
    // The other half is the uid: a row carrying another folder's uid gets
    // "deleted" by that folder's next reconcile.
    const ctx = setup();
    ctx.server.addMessage(INBOX);
    await sync(ctx, INBOX);
    const trashUid = await webmailMove(ctx, INBOX, TRASH, 1);
    await sync(ctx, TRASH);
    await sync(ctx, INBOX);

    const backUid = await webmailMove(ctx, TRASH, INBOX, trashUid);
    await sync(ctx, INBOX); // destination
    await sync(ctx, TRASH); // source reconcile
    await sync(ctx, INBOX); // and the NEXT inbox sync must not undo it

    expect(ctx.db.allRows()).toHaveLength(1);
    const row = ctx.db.allRows()[0];
    // The mail is back in the Inbox view and was never destroyed. (It is still
    // ALSO tagged Trash today — the source reconcile can't drop a membership whose
    // uid the earlier unlink nulled; tracked separately, not asserted here.)
    expect(ctx.db.tagsOf(row.id)).toContain(INBOX);
    // Either not yet stamped or stamped with the DESTINATION uid — never a stale
    // uid from the folder it came from (that is what deleted restored mail).
    expect([null, backUid]).toContain(row.uid);
  });

  it('REPEATED round trips stay stable — no vanish, no duplicate, no tag build-up', async () => {
    const ctx = setup();
    ctx.server.addMessage(INBOX);
    await sync(ctx, INBOX);
    let uid = 1;
    let where = INBOX;

    for (let i = 0; i < 3; i++) {
      const to = where === INBOX ? TRASH : INBOX;
      uid = await webmailMove(ctx, where, to, uid);
      await sync(ctx, to);     // destination first
      await sync(ctx, where);  // then reconcile the source
      where = to;

      expect(ctx.db.allRows()).toHaveLength(1);
      // Only ever real folder memberships — never a growing tag string.
      expect(ctx.db.tagsOf(ctx.db.allRows()[0].id).length).toBeLessThanOrEqual(2);
    }

    expect(ctx.db.tagsOf(ctx.db.allRows()[0].id)).toContain(where);
  });
});

describe('recovery from a drifted folder', () => {
  it('forces a FULL re-sync when the local count is far below the server', async () => {
    // After an interrupted first sync the folder can hold a handful of rows against
    // thousands on the server; the incremental path (uid > last) would never fill it.
    const ctx = setup();
    ctx.server.addMessages(INBOX, 100);
    await ctx.db.updateFolder(ctx.db.folderId(INBOX), { lastSyncUid: 99, totalCount: 0 });

    const res = await sync(ctx, INBOX);

    // maxMessages defaults to 50 → the newest 50 are re-fetched despite lastSyncUid.
    expect(res.messagesInserted).toBe(50);
    expect(ctx.db.folder(INBOX).lastSyncUid).toBe(100);
  });

  it('an empty folder syncs cleanly and stays empty', async () => {
    const ctx = setup();

    const res = await sync(ctx, INBOX);

    expect(res.success).toBe(true);
    expect(ctx.db.allRows()).toHaveLength(0);
    expect(ctx.db.folder(INBOX).lastSyncUid).toBeNull();
  });

  it('reports an error (and does not throw) for a folder missing from storage', async () => {
    const ctx = setup();
    ctx.server.addFolder('Unknown');

    const res = await sync(ctx, 'Unknown');

    expect(res.success).toBe(false);
    expect(res.error?.message).toContain('Folder not found');
  });
});
