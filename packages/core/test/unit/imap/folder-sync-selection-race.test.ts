import { describe, expect, it } from 'vitest';

import { FakeEmailStorage, resetFakeStorageIds } from '../../../src/test-support/fake-email-storage';
import { FakeImapServer, resetFakeMessageIds } from '../../../src/test-support/fake-imap-server';
import type { IMAPFolder } from '../../../src/types/imap';
import type { IEmailStorage } from '../../../src/types/storage';

import { FolderSyncer } from '../../../src/imap/folder-syncer';

/**
 * `syncFolder` selects the folder ONCE at the top and then runs a long sequence
 * — UIDVALIDITY handling, storage reads/writes, the flag reconcile, the
 * new-message fetch. By the time the reconcile issues its first FETCH the
 * selection is many awaits old, and anything else sharing the socket (the body
 * prefetch pulling from [Gmail]/All Mail, the realtime re-select, a drain) has
 * had ample opportunity to re-select underneath it.
 *
 * This is not hypothetical: after the mailbox lock shipped, the remaining
 * `Mailbox mismatch` warnings in the app log all had this shape —
 *
 *   [syncFlags] Sarv Inbox/Important: entering — server EXISTS=66 ...
 *   CONDSTORE delta flag sync failed for Sarv Inbox/Important ... Mailbox
 *   mismatch: connection has "[Gmail]/All Mail" selected, not "Sarv Inbox/Important"
 *
 * — the reconcile started in the right mailbox and lost it mid-pass, then
 * swallowed the failure and reported nothing to do. Every sub-sequence of
 * syncFolder that talks to IMAP therefore re-asserts the mailbox under the lock
 * rather than trusting the select at the top.
 */

const INBOX = 'INBOX';
/** Stands in for [Gmail]/All Mail — where the body prefetch pulls from. */
const ELSEWHERE = 'Archive';

const imapFolder = (path: string): IMAPFolder => ({
  name: path.split('/').pop() ?? path,
  path,
  delimiter: '/',
  specialUse: null,
  subscribed: true,
  selectable: true,
  children: [],
});

function setup() {
  resetFakeMessageIds();
  resetFakeStorageIds();
  const server = new FakeImapServer({ condstore: true });
  const db = new FakeEmailStorage();
  for (const path of [INBOX, ELSEWHERE]) {
    server.addFolder(path, { uidValidity: 1 });
    db.addFolder(path, { uidValidity: 1 });
  }
  // Three messages the server reports as read; the local rows still say unread.
  // A reconcile that survives the race must flip all three.
  for (let i = 0; i < 3; i++) {
    const uid = server.addMessage(INBOX, { flags: ['\\Seen'] });
    db.seedEmail({ folderId: db.folderId(INBOX), uid, tags: `|${INBOX}|` });
  }
  server.addMessage(ELSEWHERE, {});
  // An established watermark at the newest UID: incremental path, no new mail —
  // so the flag reconcile is the only thing this sync has to get right.
  db.updateFolder(db.folderId(INBOX), { lastSyncUid: 3, totalCount: 3 });
  return { server, db, syncer: new FolderSyncer() };
}

/**
 * A storage whose FIRST updateFolder re-selects another mailbox on the shared
 * connection. That call sits between syncFolder's own SELECT and the flag
 * reconcile — exactly the window the production aggressor (the body prefetch
 * pulling from [Gmail]/All Mail) landed in.
 */
function storageThatBarges(db: FakeEmailStorage, server: FakeImapServer): {
  storage: IEmailStorage;
  settled: () => Promise<void>;
} {
  const storage = db.asStorage();
  const original = storage.updateFolder.bind(storage);
  let barge: Promise<unknown> = Promise.resolve();
  let fired = false;
  storage.updateFolder = async (id: string, updates: Parameters<typeof original>[1]) => {
    const out = await original(id, updates);
    if (!fired) {
      fired = true;
      barge = server.selectFolder(ELSEWHERE);
      // Let it actually land, so this is a real interleaving.
      await barge;
    }
    return out;
  };
  return { storage, settled: async () => { await barge; } };
}

/**
 * Model the PRE-FIX arrangement: the sub-sequences trust whatever syncFolder
 * selected at the top and never re-assert it. Stripping `withFolder` entirely
 * would not reproduce the bug — `withFolderSelected` then falls back to a plain
 * select immediately before the reconcile, which closes the window by accident.
 * The bug was the absence of any re-assert at all.
 */
function withoutTheLock(server: FakeImapServer): void {
  (server as unknown as { withFolder: unknown }).withFolder =
    <T>(_path: string, fn: () => Promise<T>): Promise<T> => fn();
}

const readTags = (db: FakeEmailStorage): string[][] =>
  db.rowsPrimaryIn(INBOX).map((row) => db.tagsOf(row.id).sort());

describe('syncFolder — a re-select landing after its SELECT', () => {
  // THE regression the app log surfaced. The reconcile must still read ITS
  // folder, even though the selection it was given at the top of syncFolder was
  // replaced while storage work was in flight.
  it('still reconciles flags when another mailbox is selected mid-sync', async () => {
    const { server, db, syncer } = setup();
    const { storage, settled } = storageThatBarges(db, server);

    const result = await syncer.syncFolder(server, imapFolder(INBOX), storage);
    await settled();

    expect(result.success).toBe(true);
    expect(result.flagsUpdated).toBe(3);
    expect(readTags(db)).toEqual([[INBOX, 'read'], [INBOX, 'read'], [INBOX, 'read']]);
  });

  // The bug itself, pinned: the same sync with the lock taken away loses the
  // mailbox and reconciles nothing — silently, with success:true. That silence
  // is why this went unnoticed until the log was read.
  it('WITHOUT the lock the reconcile silently does nothing', async () => {
    const { server, db, syncer } = setup();
    withoutTheLock(server);
    const { storage, settled } = storageThatBarges(db, server);

    const result = await syncer.syncFolder(server, imapFolder(INBOX), storage);
    await settled();

    expect(result.flagsUpdated).toBe(0);
    expect(readTags(db)).toEqual([[INBOX], [INBOX], [INBOX]]);
  });

  // Idempotent re-run: once the flags agree, a second sync over the same race
  // must report no further updates rather than re-applying them.
  it('reports nothing further on an immediate re-sync', async () => {
    const { server, db, syncer } = setup();
    const { storage, settled } = storageThatBarges(db, server);
    await syncer.syncFolder(server, imapFolder(INBOX), storage);
    await settled();

    const again = await syncer.syncFolder(server, imapFolder(INBOX), db.asStorage());

    expect(again.flagsUpdated).toBe(0);
    expect(readTags(db)).toEqual([[INBOX, 'read'], [INBOX, 'read'], [INBOX, 'read']]);
  });

  // The flags-only branch (the background deletion/flag pass) takes a different
  // route through syncFolder and needs the same protection.
  it('protects the flags-only branch too', async () => {
    const { server, db, syncer } = setup();
    const { storage, settled } = storageThatBarges(db, server);

    const result = await syncer.syncFolder(server, imapFolder(INBOX), storage, { flagsOnly: true });
    await settled();

    expect(result.flagsUpdated).toBe(3);
  });

  // A full sync fetches by SEQUENCE range, which in the wrong mailbox returns
  // another folder's mail with no error at all — no mismatch guard can catch it,
  // so the section is the only thing standing between this and mail filed under
  // the wrong folder.
  it('fetches the right mailbox on a full sync', async () => {
    const { server, db, syncer } = setup();
    db.updateFolder(db.folderId(INBOX), { lastSyncUid: null });
    const { storage, settled } = storageThatBarges(db, server);

    const result = await syncer.syncFolder(server, imapFolder(INBOX), storage, { fullSync: true });
    await settled();

    expect(result.success).toBe(true);
    // Every row that landed belongs to INBOX — none of ELSEWHERE's mail.
    expect(db.rowsPrimaryIn(ELSEWHERE)).toHaveLength(0);
  });
});
