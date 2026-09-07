import type Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';

import { openTestDb } from '../../../src/test-support/test-db';
import { FolderRepository } from '../../../src/repositories/folder-repository';

// Proves a webmail move (e.g. Trash -> Inbox) never erases a message from BOTH
// folders. The destination sync relinks the row (linkEmail adds the folder tag),
// and the SOURCE folder's expunge then UNLINKS instead of hard-deleting when the
// message still belongs elsewhere (unlinkOrDeleteFromFolder). Also covers the
// primary-uid refresh linkEmail now performs and the true-delete last-folder case.

function newDb(): Database.Database {
  const db = openTestDb();
  db.exec(`
    CREATE TABLE folders (id TEXT PRIMARY KEY, path TEXT UNIQUE NOT NULL);
    CREATE TABLE emails (
      id TEXT PRIMARY KEY,
      folder_id TEXT NOT NULL,
      uid INTEGER,
      tags TEXT NOT NULL DEFAULT '||'
    );
    INSERT INTO folders (id, path) VALUES
      ('f-inbox','INBOX'), ('f-trash','Trash'), ('f-label','Sarv Inbox/Work');
  `);
  return db;
}

function add(db: Database.Database, id: string, folderId: string, uid: number | null, tags: string): void {
  db.prepare('INSERT INTO emails (id, folder_id, uid, tags) VALUES (?,?,?,?)').run(id, folderId, uid, `|${tags}|`);
}

const row = (db: Database.Database, id: string) =>
  db.prepare('SELECT folder_id AS folderId, uid, tags FROM emails WHERE id = ?').get(id) as
    | { folderId: string; uid: number | null; tags: string }
    | undefined;

describe('webmail move-back (Trash -> Inbox) never loses the message', () => {
  let db: Database.Database;
  let repo: FolderRepository;

  beforeEach(() => {
    db = newDb();
    repo = new FolderRepository(() => db);
  });

  it('destination relink + source expunge => message survives in the new folder', async () => {
    // Message currently lives in Trash (uid 50).
    add(db, 'e1', 'f-trash', 50, 'Trash');

    // 1. Inbox sync sees it reappear (new uid 90) — relink adds the INBOX tag.
    await repo.linkEmail('e1', 'f-inbox', 90);
    expect(row(db, 'e1')!.tags).toContain('INBOX');
    expect(row(db, 'e1')!.tags).toContain('Trash'); // both, until the expunge

    // 2. Trash expunge fires — the row still belongs to INBOX, so it is UNLINKED,
    //    not deleted, and the primary pointer repoints to INBOX (uid cleared).
    const res = await repo.unlinkOrDeleteFromFolder(['e1'], 'f-trash');
    expect(res).toEqual({ unlinked: 1, deleted: 0 });

    const after = row(db, 'e1');
    expect(after).toBeDefined();               // survived
    expect(after!.tags).not.toContain('Trash'); // gone from Trash
    expect(after!.tags).toContain('INBOX');     // present in Inbox
    expect(after!.folderId).toBe('f-inbox');    // primary repointed
    expect(after!.uid).toBeNull();              // cleared, awaiting Inbox sync

    // 3. Next Inbox sync supplies the real uid via linkEmail (primary refresh).
    await repo.linkEmail('e1', 'f-inbox', 90);
    expect(row(db, 'e1')!.uid).toBe(90);
  });

  it('a message in its LAST folder is truly deleted on expunge', async () => {
    add(db, 'e2', 'f-trash', 50, 'Trash');
    const res = await repo.unlinkOrDeleteFromFolder(['e2'], 'f-trash');
    expect(res).toEqual({ unlinked: 0, deleted: 1 });
    expect(row(db, 'e2')).toBeUndefined();
  });

  it('losing one Gmail label keeps the row and its primary folder intact', async () => {
    // In INBOX (primary) and a label; the label is removed on the server.
    add(db, 'e3', 'f-inbox', 10, 'INBOX|Sarv Inbox/Work');
    const res = await repo.unlinkOrDeleteFromFolder(['e3'], 'f-label');
    expect(res).toEqual({ unlinked: 1, deleted: 0 });
    const after = row(db, 'e3');
    expect(after!.tags).toContain('INBOX');
    expect(after!.tags).not.toContain('Sarv Inbox/Work');
    expect(after!.folderId).toBe('f-inbox'); // primary untouched (not the expunged folder)
    expect(after!.uid).toBe(10);             // primary uid untouched
  });

  it('linkEmail refreshes uid ONLY for the primary folder, never a secondary tag', async () => {
    add(db, 'e4', 'f-inbox', 10, 'INBOX');
    // Secondary label link must not clobber the primary uid.
    await repo.linkEmail('e4', 'f-label', 999);
    expect(row(db, 'e4')!.uid).toBe(10);
    expect(row(db, 'e4')!.tags).toContain('Sarv Inbox/Work');
    // Primary re-link with a renumbered uid updates it.
    await repo.linkEmail('e4', 'f-inbox', 11);
    expect(row(db, 'e4')!.uid).toBe(11);
  });
});

describe('repeated Inbox <-> Trash moves stay stable (no vanish, no tag build-up)', () => {
  let db: Database.Database;
  let repo: FolderRepository;

  beforeEach(() => {
    db = newDb();
    repo = new FolderRepository(() => db);
  });

  const pathOf: Record<string, string> = { 'f-inbox': 'INBOX', 'f-trash': 'Trash' };

  /** The message now belongs to exactly `folderId` at `uid`, and nowhere else. */
  function expectInFolderOnly(id: string, folderId: string, uid: number): void {
    const r = row(db, id);
    expect(r, 'row must survive every move').toBeDefined();
    expect(r!.folderId).toBe(folderId);
    expect(r!.uid).toBe(uid);
    const tags = r!.tags.split('|').filter(Boolean);
    // Exactly one folder-path tag, and it's the destination's.
    const folderTags = tags.filter((t) => Object.values(pathOf).includes(t));
    expect(folderTags).toEqual([pathOf[folderId]]);
  }

  /**
   * One EXTERNAL move (no pending op), destination-sync-first order — the order
   * that used to vanish the mail. Mirrors the real pipeline:
   *   1. destination folder sync relinks the row (adds the dest tag),
   *   2. source folder's expunge unlink-or-deletes,
   *   3. destination's next sync fills the real uid via the primary refresh.
   */
  async function externalMove(id: string, srcFolderId: string, destFolderId: string, destUid: number): Promise<void> {
    await repo.linkEmail(id, destFolderId, destUid);            // 1
    await repo.unlinkOrDeleteFromFolder([id], srcFolderId);     // 2
    await repo.linkEmail(id, destFolderId, destUid);            // 3
  }

  it('survives 6 round trips, ending clean in each folder every time', async () => {
    add(db, 'e1', 'f-inbox', 100, 'INBOX'); // starts in Inbox
    for (let i = 0; i < 6; i++) {
      const trashUid = 200 + i;
      await externalMove('e1', 'f-inbox', 'f-trash', trashUid);
      expectInFolderOnly('e1', 'f-trash', trashUid);

      const inboxUid = 300 + i;
      await externalMove('e1', 'f-trash', 'f-inbox', inboxUid);
      expectInFolderOnly('e1', 'f-inbox', inboxUid);
    }
  });

  it('is order-independent: source-expunge-BEFORE-destination-sync re-inserts fresh, no permanent loss', async () => {
    // The other race order: the source expunge lands before the destination sync
    // has relinked. The row is genuinely gone from everywhere at that instant, so
    // the expunge deletes it — then the destination sync inserts it fresh. Net:
    // the message is in the destination, never permanently lost.
    add(db, 'e2', 'f-inbox', 100, 'INBOX');

    // Inbox expunge first — only the INBOX tag exists, so it deletes.
    const res = await repo.unlinkOrDeleteFromFolder(['e2'], 'f-inbox');
    expect(res).toEqual({ unlinked: 0, deleted: 1 });
    expect(row(db, 'e2')).toBeUndefined();

    // Trash sync then inserts the message fresh (existing === null path).
    add(db, 'e2', 'f-trash', 200, 'Trash');
    expectInFolderOnly('e2', 'f-trash', 200);

    // And it can move back again cleanly.
    await externalMove('e2', 'f-trash', 'f-inbox', 300);
    expectInFolderOnly('e2', 'f-inbox', 300);
  });
});
