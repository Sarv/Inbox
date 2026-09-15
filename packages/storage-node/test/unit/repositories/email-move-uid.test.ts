import type Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';

import { EmailRepository } from '../../../src/repositories/email-repository';
import { openTestDb } from '../../../src/test-support/test-db';

// Regression: an IN-APP move (updateEmail with a folder_id change) must invalidate
// the row's old server UID. A UID is scoped to its PRIMARY folder; carried into the
// destination it makes that folder's deletion reconcile treat the stale UID as a
// server-side deletion and destroy the row — the "restored mail vanishes from
// Inbox" bug (Trash->Inbox restore kept the Trash UID; INBOX's next reconcile
// diffed it against INBOX's server UIDs, found it missing, deleted it; only rows
// re-synced first survived, so "4 restored, 1 shows"). update() must clear the UID
// so the destination's next sync stamps the correct one via linkEmail.

function newDb(): Database.Database {
  const db = openTestDb();
  db.exec(`
    CREATE TABLE emails (
      id TEXT PRIMARY KEY,
      folder_id TEXT NOT NULL,
      uid INTEGER,
      tags TEXT NOT NULL DEFAULT '||'
    );
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

describe('updateEmail clears the UID when the primary folder changes', () => {
  let db: Database.Database;
  let repo: EmailRepository;

  beforeEach(() => {
    db = newDb();
    repo = new EmailRepository(() => db);
  });

  it('Trash -> Inbox restore (folderId change, no uid) clears the stale UID', async () => {
    add(db, 'e1', 'f-trash', 50, 'Trash');
    await repo.update('e1', { folderId: 'f-inbox', tags: '|INBOX|' });
    const after = row(db, 'e1');
    expect(after!.folderId).toBe('f-inbox');
    expect(after!.uid).toBeNull();            // stale Trash uid dropped
    expect(after!.tags).toContain('INBOX');
  });

  it('keeps an explicitly-supplied destination UID (a real relink)', async () => {
    add(db, 'e2', 'f-trash', 50, 'Trash');
    await repo.update('e2', { folderId: 'f-inbox', uid: 91, tags: '|INBOX|' });
    expect(row(db, 'e2')!.uid).toBe(91);
  });

  it('leaves the UID untouched when the folder does not change', async () => {
    add(db, 'e3', 'f-inbox', 10, 'INBOX');
    await repo.update('e3', { folderId: 'f-inbox', tags: '|INBOX|read|' });
    expect(row(db, 'e3')!.uid).toBe(10);
  });

  it('leaves the UID untouched on a tags-only update (no folderId)', async () => {
    add(db, 'e4', 'f-inbox', 10, 'INBOX');
    await repo.update('e4', { tags: '|INBOX|starred|' });
    expect(row(db, 'e4')!.uid).toBe(10);
  });
});
