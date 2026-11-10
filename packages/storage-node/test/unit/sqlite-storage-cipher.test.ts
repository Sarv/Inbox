// SQLiteStorage under a later library whose compiled-in cipher defaults have moved.
//
// What breaks if this file fails: the helper in db-encryption.ts is proved on its
// own, but the promise is about the facade the app actually opens. If initialize()
// keyed around the helper, every mailbox would read as "file is not a database"
// after a library upgrade, on every install, with no error at the upgrade itself.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { isExistingPlaintextDb } from '../../src/db-encryption';
import { SHARED_CONTACTS_FILE } from '../../src/shared-contacts';
import { SQLiteStorage } from '../../src/sqlite-storage';
import { TestDatabaseCtor } from '../../src/test-support/test-db';

const h = vi.hoisted(() => ({ laterLibrary: false }));

vi.mock('better-sqlite3', async () => {
  const { TestDatabaseCtor: Real } = await import('../../src/test-support/test-db');
  class SimulatedLibrary extends (Real as unknown as new (...args: unknown[]) => { pragma(source: string): unknown }) {
    constructor(...args: unknown[]) {
      super(...args);
      if (h.laterLibrary) {
        // Pragmas, not `SELECT sqlite3mc_config(…)`: a SELECT would read the encrypted
        // file before the key is set, and fail.
        super.pragma('kdf_iter=12345');
        super.pragma(`cipher='aes256cbc'`);
      }
    }
  }
  return { default: SimulatedLibrary };
});

const KEY = 'a'.repeat(32) + 'b'.repeat(32);
const T0 = 1_700_000_000;

const inbox = {
  id: 'f-inbox', name: 'INBOX', path: 'INBOX', parentId: null, uidValidity: 1, lastSyncUid: null, lastSyncTime: null,
  totalCount: 0, unreadCount: 0, specialUse: null, subscribed: true, createdAt: T0, updatedAt: T0,
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sqlite-storage-cipher-'));
  h.laterLibrary = false;
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

/** The way every release before the pin opened a file: `key`, no cipher pragma. */
function readWithOldSequence<T>(path: string, read: (db: InstanceType<typeof TestDatabaseCtor>) => T): T {
  const db = new TestDatabaseCtor(path);
  try {
    db.pragma(`key='${KEY}'`);
    return read(db);
  } finally {
    db.close();
  }
}

describe('SQLiteStorage under a later library', () => {
  it('opens a mailbox and contact directory written under the original settings', async () => {
    const dbPath = join(dir, 'acct.db');
    const before = new SQLiteStorage({ dbPath, key: KEY });
    await before.initialize();
    await before.syncFolders([inbox]);
    await before.upsertContact({ email: 'kept@example.test', name: 'Kept' });
    await before.close();

    h.laterLibrary = true;
    const after = new SQLiteStorage({ dbPath, key: KEY });
    await after.initialize();
    expect((await after.getFolders()).map((f) => f.path)).toEqual(['INBOX']);
    expect((await after.getContactByEmail('kept@example.test'))?.name).toBe('Kept');
    await after.close();
  });

  // A file created here has to be one the original settings can read, or the first
  // account added after an upgrade starts a second, incompatible format.
  it('writes a new mailbox and directory in the original format', async () => {
    h.laterLibrary = true;
    const dbPath = join(dir, 'new.db');
    const storage = new SQLiteStorage({ dbPath, key: KEY });
    await storage.initialize();
    await storage.syncFolders([inbox]);
    await storage.upsertContact({ email: 'new@example.test', name: 'New' });
    await storage.close();

    h.laterLibrary = false;
    expect(readWithOldSequence(dbPath, (db) => db.prepare('SELECT path FROM folders').all())).toEqual([{ path: 'INBOX' }]);
    expect(readWithOldSequence(join(dir, SHARED_CONTACTS_FILE), (db) => db.prepare('SELECT email FROM contacts').all()))
      .toEqual([{ email: 'new@example.test' }]);
  });

  // Rekey is irreversible, and an install from before at-rest encryption can still
  // be upgrading long after a library change.
  it('encrypts a plaintext mailbox in the original format', async () => {
    const dbPath = join(dir, 'plain.db');
    const plain = new SQLiteStorage({ dbPath });
    await plain.initialize();
    await plain.syncFolders([inbox]);
    await plain.close();
    expect(isExistingPlaintextDb(dbPath)).toBe(true);

    h.laterLibrary = true;
    const keyed = new SQLiteStorage({ dbPath, key: KEY });
    await keyed.initialize();
    expect((await keyed.getFolders()).map((f) => f.path)).toEqual(['INBOX']);
    await keyed.close();

    h.laterLibrary = false;
    expect(isExistingPlaintextDb(dbPath)).toBe(false);
    expect(readWithOldSequence(dbPath, (db) => db.prepare('SELECT path FROM folders').all())).toEqual([{ path: 'INBOX' }]);
  });

  // An idempotent re-run: every launch opens every account again.
  it('opens the same mailbox again on the next launch', async () => {
    h.laterLibrary = true;
    const dbPath = join(dir, 'again.db');
    for (let launch = 0; launch < 2; launch++) {
      const storage = new SQLiteStorage({ dbPath, key: KEY });
      await storage.initialize();
      if (launch === 0) await storage.syncFolders([inbox]);
      expect((await storage.getFolders()).map((f) => f.path)).toEqual(['INBOX']);
      await storage.close();
    }
  });
});
