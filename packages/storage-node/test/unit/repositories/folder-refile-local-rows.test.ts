import type Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';

import { FolderRepository } from '../../../src/repositories/folder-repository';
import { openTestDb } from '../../../src/test-support/test-db';

/**
 * Rescuing mail filed under a mailbox name the app collapses away.
 *
 * A server can publish one physical Sent under two names (`Sent` and
 * `Sent Mail`, same UID space). The app picks one and stops syncing the other,
 * so a LOCAL-ONLY row left under the loser — the copy the send path mirrors
 * before IMAP has the message — is stranded: nothing lists that folder and
 * nothing syncs it. What breaks if this file fails: a message that was really
 * sent, and really recorded, is nowhere in the app.
 */

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
    INSERT INTO folders (id, path) VALUES ('f-alias','Sent Mail'), ('f-sent','Sent');
  `);
  return db;
}

const add = (db: Database.Database, id: string, folderId: string, uid: number | null, tags: string): void => {
  db.prepare('INSERT INTO emails (id, folder_id, uid, tags) VALUES (?,?,?,?)').run(id, folderId, uid, tags);
};

const row = (db: Database.Database, id: string) =>
  db.prepare('SELECT folder_id AS folderId, uid, tags FROM emails WHERE id = ?').get(id) as
    | { folderId: string; uid: number | null; tags: string }
    | undefined;

describe('FolderRepository.refileLocalRows', () => {
  let db: Database.Database;
  let repo: FolderRepository;

  beforeEach(() => {
    db = newDb();
    repo = new FolderRepository(() => db);
  });

  // Breaks: THE bug — a sent message on disk under a folder the UI never shows.
  it('moves a local-only row onto the folder the app actually shows', async () => {
    add(db, 'mirror', 'f-alias', 0, '|Sent Mail|read|');

    expect(await repo.refileLocalRows('f-alias', 'f-sent')).toBe(1);

    expect(row(db, 'mirror')!.folderId).toBe('f-sent');
    expect(row(db, 'mirror')!.tags).toContain('|Sent|');
    expect(row(db, 'mirror')!.tags).not.toContain('Sent Mail');
    // The row's own state travels with it — re-filing is a move, not a rewrite.
    expect(row(db, 'mirror')!.tags).toContain('read');
  });

  // Breaks: a present message reading as "missing from the server" and being
  // deleted. A row with a UID belongs to the UID space of the name it synced
  // from; the destination's deletion reconcile has never seen that UID.
  it('never moves a row carrying a server uid', async () => {
    add(db, 'synced', 'f-alias', 42, '|Sent Mail|');

    expect(await repo.refileLocalRows('f-alias', 'f-sent')).toBe(0);
    expect(row(db, 'synced')!.folderId).toBe('f-alias');
  });

  // Breaks: a NULL uid (what an unlink repoint leaves behind) being read as a
  // server uid, so the one row that most needs rescuing is the one left behind.
  it('treats a null uid as local-only', async () => {
    add(db, 'repointed', 'f-alias', null, '|Sent Mail|');

    expect(await repo.refileLocalRows('f-alias', 'f-sent')).toBe(1);
    expect(row(db, 'repointed')!.folderId).toBe('f-sent');
  });

  // Breaks: mail filed under an unrelated folder being dragged into Sent.
  it('touches only rows whose primary folder is the one being emptied', async () => {
    add(db, 'elsewhere', 'f-sent', 0, '|Sent|');

    expect(await repo.refileLocalRows('f-alias', 'f-sent')).toBe(0);
    expect(row(db, 'elsewhere')!.folderId).toBe('f-sent');
  });

  // Breaks: a row already correctly filed being rewritten into itself, and the
  // caller reporting a rescue that never happened.
  it('does nothing when asked to re-file a folder onto itself', async () => {
    add(db, 'mirror', 'f-alias', 0, '|Sent Mail|');

    expect(await repo.refileLocalRows('f-alias', 'f-alias')).toBe(0);
    expect(row(db, 'mirror')!.tags).toBe('|Sent Mail|');
  });

  // Breaks: a stale alias map (a folder deleted between listing and re-filing)
  // moving rows onto a folder id that no longer exists — mail filed into
  // nowhere, which is worse than leaving it where it was.
  it.each([
    ['source', 'f-missing', 'f-sent'],
    ['destination', 'f-alias', 'f-missing'],
  ])('refuses when the %s folder does not exist', async (_which, from, to) => {
    add(db, 'mirror', 'f-alias', 0, '|Sent Mail|');

    expect(await repo.refileLocalRows(from, to)).toBe(0);
    expect(row(db, 'mirror')!.folderId).toBe('f-alias');
  });

  // Breaks: a half-applied rescue. All the rows move or none do, so a failure
  // mid-way cannot leave one message in each folder.
  it('moves every local-only row in one transaction', async () => {
    add(db, 'one', 'f-alias', 0, '|Sent Mail|');
    add(db, 'two', 'f-alias', null, '|Sent Mail|');
    add(db, 'three', 'f-alias', 7, '|Sent Mail|');

    expect(await repo.refileLocalRows('f-alias', 'f-sent')).toBe(2);
    expect(row(db, 'one')!.folderId).toBe('f-sent');
    expect(row(db, 'two')!.folderId).toBe('f-sent');
    expect(row(db, 'three')!.folderId).toBe('f-alias');
  });
});
