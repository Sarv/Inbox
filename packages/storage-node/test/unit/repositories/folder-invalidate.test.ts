import type Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';

import { openTestDb } from '../../../src/test-support/test-db';
import { FolderRepository } from '../../../src/repositories/folder-repository';

// Regression: a UIDVALIDITY change must re-key a folder WITHOUT destroying rows
// that still live in other folders. The old path (deleteEmailsByFolder) ran a
// blind `DELETE ... WHERE instr(tags,'|path|')`, wiping Gmail-label / multi-folder
// rows that also belonged to INBOX etc. invalidateFolderMembership must instead
// unlink-or-delete: drop only this folder's tag (repoint primary + clear uid) on
// survivors, and hard-delete only rows in no other folder.

function newDb(): Database.Database {
  const db = openTestDb();
  db.exec(`
    CREATE TABLE folders (id TEXT PRIMARY KEY, path TEXT UNIQUE NOT NULL);
    CREATE TABLE emails (id TEXT PRIMARY KEY, folder_id TEXT NOT NULL, uid INTEGER, tags TEXT NOT NULL DEFAULT '||');
    INSERT INTO folders (id, path) VALUES ('f-inbox','INBOX'), ('f-label','Work'), ('f-trash','Trash');
  `);
  return db;
}
const add = (db: Database.Database, id: string, folderId: string, uid: number | null, tags: string) =>
  db.prepare('INSERT INTO emails (id, folder_id, uid, tags) VALUES (?,?,?,?)').run(id, folderId, uid, `|${tags}|`);
const row = (db: Database.Database, id: string) =>
  db.prepare('SELECT folder_id AS folderId, uid, tags FROM emails WHERE id = ?').get(id) as
    | { folderId: string; uid: number | null; tags: string } | undefined;

describe('invalidateFolderMembership — non-destructive UIDVALIDITY re-key', () => {
  let db: Database.Database;
  let repo: FolderRepository;
  beforeEach(() => { db = newDb(); repo = new FolderRepository(() => db); });

  it('deletes single-folder rows but PRESERVES multi-folder rows (drops only the tag)', async () => {
    add(db, 'only', 'f-inbox', 10, 'INBOX');            // lives ONLY in INBOX
    add(db, 'labeled', 'f-inbox', 11, 'INBOX|Work');    // also in the Work label

    const res = await repo.invalidateFolderMembership('f-inbox');

    expect(res).toEqual({ unlinked: 1, deleted: 1 });
    expect(row(db, 'only')).toBeUndefined();            // single-folder → gone
    const kept = row(db, 'labeled')!;
    expect(kept).toBeDefined();                          // multi-folder → survives
    expect(kept.tags).not.toContain('INBOX');           // INBOX membership dropped
    expect(kept.tags).toContain('Work');                // Work membership kept
    expect(kept.folderId).toBe('f-label');              // primary repointed off INBOX
    expect(kept.uid).toBeNull();                         // uid cleared for a fresh re-sync
  });

  it('touches only rows tagged with the target folder', async () => {
    add(db, 'inbox1', 'f-inbox', 1, 'INBOX');
    add(db, 'trash1', 'f-trash', 2, 'Trash');

    await repo.invalidateFolderMembership('f-inbox');

    expect(row(db, 'inbox1')).toBeUndefined();          // wiped
    expect(row(db, 'trash1')).toBeDefined();            // untouched
    expect(row(db, 'trash1')!.uid).toBe(2);
  });

  it('no-ops on an empty folder', async () => {
    expect(await repo.invalidateFolderMembership('f-inbox')).toEqual({ unlinked: 0, deleted: 0 });
  });
});
