import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FolderSyncer } from '../../../src/imap/folder-syncer';
import { MessageProcessor } from '../../../src/imap/message-processor';
import { FakeEmailStorage, resetFakeStorageIds } from '../../../src/test-support/fake-email-storage';
import { FakeImapServer, resetFakeMessageIds } from '../../../src/test-support/fake-imap-server';
import type { IMAPFolder } from '../../../src/types/imap';


// A star set on the server (webmail, phone) reaches the app through ONE path:
// the folder sync's syncFlags, which maps \Flagged to the `starred` tag. That
// is the only server-to-local star path. Two IPC handlers in email-handlers.ts
// used to run a second, hand-rolled pass: SEARCH the starred folder, match rows
// by Message-ID, and write `{ flags: [...] }`. `flags` is not a column, so the
// first unstarred row threw and the loop gave up on the rest. That pass also
// never consulted pending local ops, so "fixing" its field would have re-starred
// mail whose unstar was still queued. Both handlers were removed. These tests
// pin what the real path has to deliver in their place:
//
//   - a server star lands locally, and a re-run is a no-op (no write, no dupes)
//   - a queued local unstar is NOT flipped back by the server's stale \Flagged
//   - a failed write is retried by the next sync, never lost, never doubled
//   - odd rows (no uid yet, legacy empty tags) don't stop their neighbours
//   - each account's server stars only that account's copy, even when two
//     accounts hold the same Message-ID
//
// No network, no DB, no clock dependence.

const INBOX = 'INBOX';

const imapFolder = (path: string): IMAPFolder => ({
  name: path.split('/').pop() ?? path,
  path,
  delimiter: '/',
  specialUse: null,
  subscribed: true,
  selectable: true,
  children: [],
});

interface Account {
  server: FakeImapServer;
  db: FakeEmailStorage;
  fs: FolderSyncer;
}

function account(options: { condstore?: boolean } = {}): Account {
  const server = new FakeImapServer({ condstore: options.condstore ?? false });
  const db = new FakeEmailStorage();
  server.addFolder(INBOX, { uidValidity: 1 });
  db.addFolder(INBOX, { uidValidity: 1 });
  return { server, db, fs: new FolderSyncer() };
}

const sync = (acct: Account) => acct.fs.syncFolder(acct.server, imapFolder(INBOX), acct.db.asStorage());

const rowFor = (acct: Account, messageId: string) => {
  const row = acct.db.rowByMessageId(messageId);
  if (!row) throw new Error(`no local row for ${messageId}`);
  return row;
};

const tagWrites = (acct: Account) => acct.db.callCount('bulkUpdateTags') + acct.db.callCount('updateEmail');

/** Server + local both hold the message, unstarred, after one real sync. */
async function seedUnstarred(acct: Account, messageId = '<star@test.local>'): Promise<number> {
  const uid = acct.server.addMessage(INBOX, { messageId, flags: [] });
  const first = await sync(acct);
  expect(first.success).toBe(true);
  expect(acct.db.tagsOf(rowFor(acct, messageId).id)).not.toContain('starred');
  return uid;
}

beforeEach(() => {
  vi.restoreAllMocks();
  resetFakeMessageIds();
  resetFakeStorageIds();
});

describe('a star set on the server reaches the local row (folder sync)', () => {
  // Breaks if \Flagged stops mapping to the `starred` tag on an already-synced
  // row: stars set in webmail or on a phone never show up in the app.
  it('lands as the `starred` tag on the next sync', async () => {
    const acct = account();
    const uid = await seedUnstarred(acct);

    acct.server.setFlagsOnServer(INBOX, uid, ['\\Flagged']);
    const res = await sync(acct);

    expect(res.success).toBe(true);
    expect(acct.db.tagsOf(rowFor(acct, '<star@test.local>').id)).toContain('starred');
  });

  // Breaks if the reconcile rewrites a row that already matches the server, or
  // adds the tag twice: every sync then churns the read model and fires per-row
  // UI events for nothing.
  it('leaves an already-starred row alone on a re-run (no write, tag once)', async () => {
    const acct = account();
    const uid = await seedUnstarred(acct);
    acct.server.setFlagsOnServer(INBOX, uid, ['\\Flagged']);
    await sync(acct);
    const writesBefore = tagWrites(acct);

    const again = await sync(acct);

    expect(again.success).toBe(true);
    expect(again.flagsUpdated).toBe(0);
    expect(tagWrites(acct)).toBe(writesBefore);
    const tags = acct.db.tagsOf(rowFor(acct, '<star@test.local>').id);
    expect(tags.filter((t) => t === 'starred')).toHaveLength(1);
  });

  // Breaks if the server's stale \Flagged wins over a local unstar the
  // operation queue has not delivered yet: the star flips back on. This guard
  // is why the hand-rolled handler pass was removed rather than repaired.
  it('does not re-star a row whose local unstar is still pending', async () => {
    const acct = account();
    const uid = await seedUnstarred(acct);
    acct.server.setFlagsOnServer(INBOX, uid, ['\\Flagged']);
    await sync(acct);
    const row = rowFor(acct, '<star@test.local>');

    // The user unstars in the app; the STORE -FLAGS is still queued.
    row.tags = row.tags.replace('|starred|', '|');
    const pending = new Set<number>([uid]);
    acct.fs.setPendingUidsProvider(async (path) => (path === INBOX ? pending : new Set()));

    await sync(acct);
    expect(acct.db.tagsOf(row.id)).not.toContain('starred');

    // The op lands on the server; from then on both sides agree.
    acct.server.setFlagsOnServer(INBOX, uid, []);
    pending.clear();
    await sync(acct);
    expect(acct.db.tagsOf(row.id)).not.toContain('starred');
  });
});

describe('a failed write is retried, not lost', () => {
  // Breaks if a transient storage error (SQLITE_BUSY, a locked DB) during the
  // flag write is treated as done: with CONDSTORE the stored modseq would move
  // past the change and the star would never be re-read. Also breaks if the
  // retry double-applies.
  it.each([
    { condstore: true, label: 'CONDSTORE delta' },
    { condstore: false, label: 'full flag re-read' },
  ])('re-applies the star on the next sync ($label)', async ({ condstore }) => {
    const acct = account({ condstore });
    const uid = await seedUnstarred(acct);
    acct.server.setFlagsOnServer(INBOX, uid, ['\\Flagged']);

    const write = vi.spyOn(acct.db, 'bulkUpdateTags').mockRejectedValueOnce(new Error('SQLITE_BUSY: database is locked'));
    const failed = await sync(acct);
    expect(write).toHaveBeenCalledTimes(1);
    expect(failed.success).toBe(false);
    expect(acct.db.tagsOf(rowFor(acct, '<star@test.local>').id)).not.toContain('starred');

    const retried = await sync(acct);
    expect(retried.success).toBe(true);
    const tags = acct.db.tagsOf(rowFor(acct, '<star@test.local>').id);
    expect(tags.filter((t) => t === 'starred')).toHaveLength(1);
  });
});

describe('odd rows do not stop their neighbours', () => {
  // Breaks if one row the reconcile cannot match (no uid yet, legacy empty
  // tags) throws or ends the page: the stars after it never land. That is
  // exactly how the removed handler loop failed.
  it('stars every matchable row around a uid-less row and an empty-tags row', async () => {
    const server = new FakeImapServer();
    const db = new FakeEmailStorage();
    server.addFolder(INBOX, { uidValidity: 1 });
    const folder = db.addFolder(INBOX, { uidValidity: 1 });
    const before = server.addMessage(INBOX, { flags: ['\\Flagged'] });
    const emptyTags = server.addMessage(INBOX, { flags: ['\\Flagged'] });
    const after = server.addMessage(INBOX, { flags: ['\\Flagged'] });
    const a = db.seedEmail({ folderId: folder.id, uid: before, tags: `|${INBOX}|` });
    const awaitingUid = db.seedEmail({ folderId: folder.id, uid: null, tags: `|${INBOX}|` });
    const legacy = db.seedEmail({ folderId: folder.id, uid: emptyTags, tags: '' });
    const b = db.seedEmail({ folderId: folder.id, uid: after, tags: `|${INBOX}|` });
    await server.selectFolder(INBOX);

    const res = await new MessageProcessor().syncFlags(server, db.folder(INBOX), db.asStorage(), undefined, undefined, { skipDeletion: true });

    expect(res.updated).toBe(3);
    expect(db.tagsOf(a.id)).toContain('starred');
    expect(db.tagsOf(legacy.id)).toContain('starred');
    expect(db.tagsOf(b.id)).toContain('starred');
    expect(db.tagsOf(awaitingUid.id)).toEqual([INBOX]);
  });
});

describe('multi-account: the star lands in the account whose server has it', () => {
  // Breaks if a star is matched by Message-ID against the wrong account's DB
  // (as the removed handler did against whichever account was active): the
  // same mail delivered to two of the user's addresses is starred in both, or
  // in the wrong one.
  it('stars account A\'s copy and leaves account B\'s copy of the same Message-ID alone', async () => {
    const shared = '<to-both@test.local>';
    const a = account();
    const b = account();
    const uidA = await seedUnstarred(a, shared);
    await seedUnstarred(b, shared);

    a.server.setFlagsOnServer(INBOX, uidA, ['\\Flagged']);
    await sync(a);
    await sync(b);

    expect(a.db.tagsOf(rowFor(a, shared).id)).toContain('starred');
    expect(b.db.tagsOf(rowFor(b, shared).id)).not.toContain('starred');
  });
});
