import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The core DB against the REAL addon. It holds the account registry and every
 * saved credential.
 *
 * What breaks if this file fails: on 2026-09-09 an unreadable registry read as
 * "zero accounts" and the startup sweep deleted two live mailbox databases. A
 * library upgrade that moved a cipher default would make this file unreadable in
 * exactly that way, on every install, with no error at the upgrade.
 */

const h = vi.hoisted(() => ({
  dir: '',
  key: null as string | null,
  /** Simulate a later library whose compiled-in cipher defaults have moved. */
  laterLibrary: false,
}));

vi.mock('electron', () => ({ app: { getPath: () => h.dir } }));
vi.mock('../../../../electron/services/db-key-store', () => ({ getDbEncryptionKey: () => h.key }));
vi.mock('better-sqlite3', async (importOriginal) => {
  const Real = (await importOriginal<{ default: new (...args: unknown[]) => { pragma: (s: string) => unknown } }>()).default;
  class SimulatedLibrary extends Real {
    constructor(...args: unknown[]) {
      super(...args);
      if (h.laterLibrary) {
        super.pragma('kdf_iter=12345');
        super.pragma(`cipher='aes256cbc'`);
      }
    }
  }
  return { default: SimulatedLibrary };
});

const KEY = 'a'.repeat(32) + 'b'.repeat(32);

/** A fresh module graph, as the next launch of the app gets. */
async function launch(): Promise<typeof import('../../../../electron/services/core-db')> {
  vi.resetModules();
  return import('../../../../electron/services/core-db');
}

const corePath = (): string => join(h.dir, 'sarvinbox-core.db');
const sha256 = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');

/** A registry the way every release before the pin wrote it: `key`, no cipher pragma. */
async function createBeforeThePin(): Promise<void> {
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(corePath());
  db.pragma(`key='${KEY}'`);
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE registry_meta (key TEXT PRIMARY KEY, value TEXT)');
  db.prepare('INSERT INTO registry_meta (key, value) VALUES (?, ?)').run('primary', 'acct-1');
  db.close();
}

const primary = (db: { prepare(sql: string): { get(): unknown } }): unknown =>
  db.prepare(`SELECT value FROM registry_meta WHERE key = 'primary'`).get();

beforeEach(() => {
  h.dir = mkdtempSync(join(tmpdir(), 'core-db-cipher-'));
  h.key = KEY;
  h.laterLibrary = false;
});
afterEach(() => { rmSync(h.dir, { recursive: true, force: true }); });

describe('getCoreDb', () => {
  // Breaks the first launch after the pin ships: every install's registry was
  // written without it.
  it('opens a registry created before the pin and keeps its data', async () => {
    await createBeforeThePin();
    const { getCoreDb } = await launch();
    expect(primary(getCoreDb())).toEqual({ value: 'acct-1' });
    getCoreDb().close();
  });

  // Breaks the point of the pin: the registry must survive a later library.
  it('still opens it under a later library', async () => {
    await createBeforeThePin();
    h.laterLibrary = true;
    const { getCoreDb } = await launch();
    expect(primary(getCoreDb())).toEqual({ value: 'acct-1' });
    getCoreDb().close();
  });

  // Breaks if a new install under a later library wrote a file the old sequence
  // cannot read, because the pin was skipped on the path that CREATES the database.
  it('creates a new registry in the pinned format', async () => {
    h.laterLibrary = true;
    const { getCoreDb } = await launch();
    getCoreDb().prepare(`INSERT INTO registry_meta (key, value) VALUES ('primary', 'acct-2')`).run();
    getCoreDb().close();

    h.laterLibrary = false;
    const { default: Database } = await import('better-sqlite3');
    const old = new Database(corePath());
    old.pragma(`key='${KEY}'`);
    expect(primary(old)).toEqual({ value: 'acct-2' });
    old.close();
  });

  // Breaks CLAUDE.md's rule. A wrong key has to THROW from the open. The file must be
  // left as it was, and the right key must work on the next launch, because a locked
  // keychain is transient. Anything else risks the startup sweep's 2026-09-09 mistake.
  it('throws on a wrong key, leaves the file, and the right key opens it next launch', async () => {
    await createBeforeThePin();
    const before = sha256(corePath());

    h.key = 'c'.repeat(64);
    const { getCoreDb } = await launch();
    expect(() => getCoreDb()).toThrow(/file is not a database/);
    expect(sha256(corePath())).toBe(before);

    h.key = KEY;
    const next = await launch();
    expect(primary(next.getCoreDb())).toEqual({ value: 'acct-1' });
    next.getCoreDb().close();
  });

  // Breaks the keyless path, which has no key to pin settings for: it must neither
  // encrypt nor refuse.
  it('stays plaintext with no key', async () => {
    h.key = null;
    const { getCoreDb } = await launch();
    getCoreDb().close();
    expect(readFileSync(corePath()).subarray(0, 15).toString('latin1')).toBe('SQLite format 3');
  });
});
