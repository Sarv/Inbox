import { beforeEach, describe, expect, it, vi } from 'vitest';

import { LARGE_MAILBOX_THRESHOLD } from '../../../src/config/sync';
import { FolderSyncer } from '../../../src/imap/folder-syncer';
import { FakeEmailStorage, resetFakeStorageIds } from '../../../src/test-support/fake-email-storage';
import { FakeImapServer, resetFakeMessageIds } from '../../../src/test-support/fake-imap-server';
import type { IMAPFolder } from '../../../src/types/imap';


/**
 * END-TO-END for the wedged forward sync: mail that silently stops arriving.
 *
 * `sync-watermark.test.ts` proves the policy; this proves it is actually WIRED,
 * which is the half that failed in production. The symptom has no error and no
 * UI signal — `incrementalSync` logs "No new messages", truthfully as far as it
 * knows, on every sync forever. The only way to see it is to notice the server's
 * count climbing while ours doesn't.
 *
 * Each test drives the real FolderSyncer against the real fake server, so the
 * assertions are about MAIL LANDING, not about a boolean being returned.
 */

const INBOX = 'INBOX';

const imapFolder = (path: string): IMAPFolder => ({
  name: path,
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
  const server = new FakeImapServer();
  const db = new FakeEmailStorage();
  server.addFolder(INBOX, { uidValidity: 1 });
  db.addFolder(INBOX, { uidValidity: 1 });
  return { server, db, fs: new FolderSyncer() };
}

/** How many messages actually made it into the folder's local rows. */
const localCount = (db: FakeEmailStorage) => db.rowsPrimaryIn(INBOX).length;

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('poisoned sync watermark (above the server UIDNEXT)', () => {
  it('un-wedges the folder: mail that was invisible now lands', async () => {
    // THE REGRESSION. A watermark far above UIDNEXT makes the "no new messages"
    // gate permanently true, so the folder stops receiving mail for good. If this
    // fails, mail silently stops arriving and nothing reports an error.
    const { server, db, fs } = setup();
    for (let i = 0; i < 5; i += 1) server.addMessage(INBOX, {});
    const uidNext = (await server.selectFolder(INBOX)).uidNext;

    // A watermark that cannot have come from this mailbox.
    await db.asStorage().updateFolder(db.folderId(INBOX), { lastSyncUid: uidNext + 40_000 });
    expect(localCount(db)).toBe(0);

    await fs.syncFolder(server as any, imapFolder(INBOX), db.asStorage());

    // The mail is here — the gate no longer swallows it.
    expect(localCount(db)).toBe(5);
    // And the watermark is now a value the server could actually have issued, so
    // the next incremental sync works normally instead of re-wiping every pass.
    const repaired = db.folder(INBOX).lastSyncUid ?? 0;
    expect(repaired).toBeGreaterThan(0);
    expect(repaired).toBeLessThan(uidNext);
  });

  it('stays fixed: a second sync neither re-wipes nor re-ingests', async () => {
    // Idempotence. A repair that re-triggers every pass would full-sync a 23k
    // mailbox on every sync — trading silent data loss for a permanent stall.
    const { server, db, fs } = setup();
    for (let i = 0; i < 5; i += 1) server.addMessage(INBOX, {});
    const uidNext = (await server.selectFolder(INBOX)).uidNext;
    await db.asStorage().updateFolder(db.folderId(INBOX), { lastSyncUid: uidNext + 40_000 });

    await fs.syncFolder(server as any, imapFolder(INBOX), db.asStorage());
    const afterFirst = db.folder(INBOX).lastSyncUid ?? 0;
    expect(afterFirst).toBeLessThan(uidNext); // the repair actually landed

    await fs.syncFolder(server as any, imapFolder(INBOX), db.asStorage());

    expect(db.folder(INBOX).lastSyncUid).toBe(afterFirst); // not wiped again
    expect(localCount(db)).toBe(5);                        // no duplicates
  });

  it('keeps receiving mail after the repair', async () => {
    // The repair is only worth anything if the folder RESUMES working. Proves the
    // fix restores the ongoing behaviour, not just the one-off backfill.
    const { server, db, fs } = setup();
    for (let i = 0; i < 3; i += 1) server.addMessage(INBOX, {});
    const uidNext = (await server.selectFolder(INBOX)).uidNext;
    await db.asStorage().updateFolder(db.folderId(INBOX), { lastSyncUid: uidNext + 40_000 });

    await fs.syncFolder(server as any, imapFolder(INBOX), db.asStorage());
    expect(localCount(db)).toBe(3);

    // New mail arrives after the repair.
    server.addMessage(INBOX, {});
    await fs.syncFolder(server as any, imapFolder(INBOX), db.asStorage());

    expect(localCount(db)).toBe(4);
    // The watermark now tracks the server again — the forward sync is live, not
    // still pinned above UIDNEXT and coasting on a different repair path.
    const settled = db.folder(INBOX).lastSyncUid ?? 0;
    expect(settled).toBe((await server.selectFolder(INBOX)).uidNext - 1);
  });

  it('repairs a LARGE mailbox, where nothing else can', async () => {
    // The production case, and the one with no second line of defence. On a large
    // mailbox Phase 2 only ever gets a 30-day window, and a folder whose rows
    // never arrived has nothing in its own UID space — so the addition reconcile
    // is bounded out and CANNOT close the gap. (On a small mailbox the whole-folder
    // addition reconcile quietly heals a poisoned watermark, which is why the
    // failure was invisible in tests and fatal in the field.) Here the watermark
    // repair is the only thing standing between the user and a folder that stops
    // receiving mail permanently.
    const { server, db, fs } = setup();
    for (let i = 0; i < 5; i += 1) server.addMessage(INBOX, {});
    const uidNext = (await server.selectFolder(INBOX)).uidNext;
    await db.asStorage().updateFolder(db.folderId(INBOX), { lastSyncUid: uidNext + 40_000 });

    // Report a huge EXISTS so syncFlags takes the windowed large-mailbox path,
    // without seeding thousands of messages.
    vi.spyOn(server, 'getCurrentMailboxState').mockReturnValue({
      path: INBOX,
      exists: LARGE_MAILBOX_THRESHOLD + 1,
      uidValidity: 1,
    } as any);

    await fs.syncFolder(server as any, imapFolder(INBOX), db.asStorage());

    expect(localCount(db)).toBe(5);
    expect(db.folder(INBOX).lastSyncUid ?? 0).toBeLessThan(uidNext);
  });
});

describe('healthy watermarks are never discarded', () => {
  it('a caught-up folder is NOT re-synced', async () => {
    // The cost guard, and the reason the check is `>` and not `>=`. A false
    // positive here means every folder full-syncs its entire history on every
    // pass — the app would be unusable on a large mailbox.
    const { server, db, fs } = setup();
    for (let i = 0; i < 4; i += 1) server.addMessage(INBOX, {});

    await fs.syncFolder(server as any, imapFolder(INBOX), db.asStorage());
    const settled = db.folder(INBOX).lastSyncUid;
    expect(settled).toBeGreaterThan(0);

    // Nothing changed on the server; the watermark must survive untouched.
    await fs.syncFolder(server as any, imapFolder(INBOX), db.asStorage());

    expect(db.folder(INBOX).lastSyncUid).toBe(settled);
    expect(localCount(db)).toBe(4);
  });

  it('a never-synced folder is not treated as corrupt', async () => {
    // A null watermark is the normal first-sync state, not a wedge. Misreading it
    // would be harmless here but would mask the real signal.
    const { server, db, fs } = setup();
    server.addMessage(INBOX, {});
    expect(db.folder(INBOX).lastSyncUid ?? null).toBeNull();

    await fs.syncFolder(server as any, imapFolder(INBOX), db.asStorage());

    expect(localCount(db)).toBe(1);
  });
});
