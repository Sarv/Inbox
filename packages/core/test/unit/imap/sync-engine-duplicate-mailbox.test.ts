import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SyncEngine } from '../../../src/imap/sync-engine';
import { FakeEmailStorage, resetFakeStorageIds } from '../../../src/test-support/fake-email-storage';
import { FakeImapServer, resetFakeMessageIds } from '../../../src/test-support/fake-imap-server';
import type { IMAPFolder } from '../../../src/types/imap';
import { generateFolderId } from '../../../src/utils/id';


/**
 * A server may publish the SAME physical mailbox under two names. Sarv lists
 * both `Sent` and `Sent Mail` — identical UID range, identical messages — and
 * the app synced both. That gave the duplicate its own sync state, its own
 * backfill and its own counts, none of which the sidebar shows: it collapses a
 * role to one folder. The user saw a Sent folder claiming 1,719 messages,
 * listing one, with a "next page" that was always blank.
 *
 * These pin the folder SELECTION: the canonical mailbox is synced and the
 * duplicate is skipped — and an account with no duplicate is untouched, which
 * is the risk of collapsing at all. "Duplicate" means the SERVER said so (same
 * UIDVALIDITY, same EXISTS); the engine reads that from the stored folder
 * records, so a storage read that fails must collapse nothing.
 */

const imapFolder = (path: string, over: Partial<IMAPFolder> = {}): IMAPFolder => ({
  name: path.split('/').pop() ?? path,
  path,
  delimiter: '/',
  specialUse: null,
  subscribed: true,
  selectable: true,
  children: [],
  ...over,
});

/**
 * Stored sync state. The default makes every folder look like the same physical
 * store (one UIDVALIDITY, one message count) so a test only has to say which
 * name actually holds the mail — the thing that decides which one wins.
 */
type StoredState = {
  totalCount?: number;
  serverMessageCount?: number;
  uidValidity?: number;
  /**
   * Tag this folder's rows with that OTHER folder's name too — the shape the
   * live account really has. One physical store listed twice means one row
   * carrying both `|Sent|` and `|Sent Mail|`, so the TAG count reads full under
   * both names and only the filing (`folderId`) says which one holds the mail.
   */
  alsoTaggedAs?: string;
};

function setup(paths: IMAPFolder[], stored: Record<string, StoredState> = {}) {
  resetFakeMessageIds();
  resetFakeStorageIds();
  const server = new FakeImapServer();
  const db = new FakeEmailStorage();
  for (const folder of paths) {
    server.addFolder(folder.path, { uidValidity: 1 });
    const record = db.addFolder(folder.path, {
      // Same id the folder-list sync derives from the path, so its upsert
      // UPDATES this record instead of adding a second one for the same path —
      // which is what the real (ON CONFLICT(id)) folder store does.
      id: generateFolderId(folder.path),
      uidValidity: 1,
      serverMessageCount: 1718,
      totalCount: 0,
      ...stored[folder.path],
    });
    // Seed the rows the count claims, rather than the count alone: before the
    // engine decides anything it RECOUNTS a contested folder from what is
    // really stored (a stale `folders.total_count` is half of the bug), so a
    // bare number would be recomputed to zero and the fixture would be testing
    // the opposite of what it says.
    const alias = stored[folder.path]?.alsoTaggedAs;
    const tags = alias ? `|${folder.path}|${alias}|` : `|${folder.path}|`;
    for (let index = 0; index < (record.totalCount ?? 0); index += 1) {
      db.seedEmail({ folderId: record.id, uid: index + 1, tags });
    }
  }
  const engine = new SyncEngine(db.asStorage());
  vi.spyOn(engine, 'isConnected').mockReturnValue(true);
  const internals = engine as unknown as {
    connectionManager: { _client: unknown; ensureConnection: () => Promise<boolean> };
    reselectMonitoredFolder: () => Promise<void>;
    folderSyncer: { syncFolder: (...args: unknown[]) => unknown };
  };
  internals.connectionManager._client = server;
  internals.connectionManager.ensureConnection = async () => true;
  internals.reselectMonitoredFolder = async () => {};
  vi.spyOn(server, 'listFolders').mockResolvedValue(paths);

  // Record which folders the engine decided to sync, without running a real one.
  const synced: string[] = [];
  vi.spyOn(internals.folderSyncer, 'syncFolder').mockImplementation(async (...args: unknown[]) => {
    synced.push((args[1] as IMAPFolder).path);
    return {
      success: true, messagesProcessed: 0, messagesInserted: 0, messagesUpdated: 0,
      flagsUpdated: 0, deletedCount: 0, lastSyncUid: 1, uidValidityChanged: false,
    };
  });

  return { engine, synced, db };
}

describe('SyncEngine — a role the server published twice', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  // Breaks: every sent message is fetched twice, and half the folder's state
  // lands under a name the UI never shows — the empty Sent with a 1,719 count.
  it('syncs the canonical mailbox and skips the duplicate', async () => {
    const { engine, synced } = setup(
      [
        imapFolder('INBOX'),
        imapFolder('Sent Mail'), // the alias, listed FIRST
        imapFolder('Sent'),
      ],
      { Sent: { totalCount: 1713 } }, // …and the one the mail is filed under
    );

    await engine.syncAll();

    expect(synced).toContain('Sent');
    expect(synced).not.toContain('Sent Mail');
    expect(synced).toContain('INBOX');
  });

  // Breaks: THE account in the 2026-09-12 report, where the first fix did
  // nothing. One store under two names means ONE row tagged `|Sent|Sent Mail|`,
  // so `folders.total_count` — a TAG count — reads ~1,718 under both names and
  // "follow the mail" cannot tell them apart. The engine must measure primary
  // filing instead: 1,713 rows filed under `Sent`, one under `Sent Mail`.
  it('follows the FILED mail when both names carry the same tags', async () => {
    const { engine, synced } = setup(
      [
        imapFolder('INBOX'),
        imapFolder('Sent Mail', { specialUse: '\\Sent' }), // flagged, and empty
        imapFolder('Sent'),
      ],
      {
        'Sent Mail': { totalCount: 1, alsoTaggedAs: 'Sent' },
        Sent: { totalCount: 1713, alsoTaggedAs: 'Sent Mail' },
      },
    );

    await engine.syncAll();

    expect(synced).toContain('Sent');
    expect(synced).not.toContain('Sent Mail');
  });

  // Breaks: the ordinary account losing a folder to a collapse it never needed.
  it('leaves an account with one mailbox per role completely alone', async () => {
    const { engine, synced } = setup([
      imapFolder('INBOX'), imapFolder('Sent'), imapFolder('Drafts'), imapFolder('Trash'),
    ]);

    await engine.syncAll();

    expect(synced.sort()).toEqual(['Drafts', 'INBOX', 'Sent', 'Trash']);
  });

  // Breaks: a user folder that merely reads like a system one stops syncing —
  // mail silently disappearing is the worst outcome this collapse could have.
  it('never drops a nested folder the user made', async () => {
    const { engine, synced } = setup([
      imapFolder('INBOX'), imapFolder('Sent'), imapFolder('Archive/Sent'),
    ]);

    await engine.syncAll();

    expect(synced).toContain('Archive/Sent');
  });

  // DELIBERATE REVERSAL: this used to assert the SPECIAL-USE mailbox always
  // wins. Shipped, that stopped syncing the only folder that held the user's
  // sent mail — Sarv flags the EMPTY name `Sent Mail` with `\\Sent`. Between two
  // names for one store the mail decides; the flag only breaks a tie.
  // Breaks: the account syncing a mailbox that can never gain a row, while the
  // one holding 1,713 messages goes stale.
  it('keeps the mailbox holding the mail, even against a SPECIAL-USE twin', async () => {
    const { engine, synced } = setup(
      [
        imapFolder('INBOX'),
        imapFolder('Sent Mail'),
        imapFolder('Elküldött', { specialUse: '\\Sent' }),
      ],
      { 'Sent Mail': { totalCount: 1713 } },
    );

    await engine.syncAll();

    expect(synced).toContain('Sent Mail');
    expect(synced).not.toContain('Elküldött');
  });

  // Breaks: the collapse turning a targeted sync into a no-op. Realtime and the
  // UI ask for a folder BY NAME, and the name they hold may be the one that was
  // dropped — "sync Sent Mail" must sync the mailbox Sent Mail stands for, not
  // nothing at all.
  it('redirects a sync requested by the duplicate name onto the canonical one', async () => {
    const { engine, synced } = setup(
      [imapFolder('INBOX'), imapFolder('Sent Mail'), imapFolder('Sent')],
      { Sent: { totalCount: 1713 } },
    );

    await engine.syncAll({ folders: ['Sent Mail'] });

    expect(synced).toEqual(['Sent']);
  });

  // Breaks: an unreadable store and an empty store are the same value here and
  // opposite facts. With no stored state the engine cannot tell a duplicate from
  // a distinct mailbox, so it must drop neither — syncing both costs work,
  // guessing costs mail.
  it('collapses nothing when the folder store cannot be read', async () => {
    const { engine, synced, db } = setup(
      [imapFolder('INBOX'), imapFolder('Sent Mail'), imapFolder('Sent')],
      { Sent: { totalCount: 1713 } },
    );
    vi.spyOn(db, 'getFolders').mockRejectedValue(new Error('database is locked'));

    await engine.syncAll();

    expect(synced).toContain('Sent');
    expect(synced).toContain('Sent Mail');
  });

  // Breaks: the first sync of a brand-new account, where nothing has counts yet,
  // dropping a mailbox on the strength of its name alone.
  it('syncs both names until the server has proven they are one mailbox', async () => {
    const { engine, synced } = setup(
      [imapFolder('INBOX'), imapFolder('Sent Mail'), imapFolder('Sent')],
      {
        'Sent Mail': { uidValidity: 0, serverMessageCount: 0 },
        Sent: { uidValidity: 0, serverMessageCount: 0 },
      },
    );

    await engine.syncAll();

    expect(synced.sort()).toEqual(['INBOX', 'Sent', 'Sent Mail']);
  });
});
