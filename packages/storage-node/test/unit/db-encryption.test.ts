// The encryption settings every database in this app is opened with, proved
// against the REAL addon (better-sqlite3-multiple-ciphers), never a stub.
//
// What breaks if this file fails: a library upgrade that changes a cipher default
// raises no error at the upgrade. `PRAGMA key` still says "ok", every existing
// database reads as "file is not a database", and this app's swallowing reads turn
// that into an empty mailbox. On 2026-09-09 an unreadable registry read as "zero
// accounts" got two live mailboxes deleted. See CLAUDE.md.

import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  applyDbKey,
  DB_CIPHER_SETTINGS,
  encryptPlaintextDb,
  isExistingPlaintextDb,
  pinDbCipher,
  type PragmaConnection,
} from '../../src/db-encryption';
import { attachSharedContacts, SHARED_SCHEMA } from '../../src/shared-contacts';
import { openTestDb } from '../../src/test-support/test-db';

const KEY = 'a'.repeat(32) + 'b'.repeat(32);
const WRONG_KEY = 'c'.repeat(64);

/**
 * Made once, on 2026-11-05, with better-sqlite3-multiple-ciphers 12.11.1 (SQLite3
 * Multiple Ciphers 2.3.5) and no cipher pragma: `new Database`, `key`,
 * `journal_mode = WAL`, a `messages` table, three rows, `wal_checkpoint(TRUNCATE)`.
 * Its value is that it is never regenerated: a future library has to read THESE bytes.
 */
const FIXTURE = join(__dirname, '../fixtures/pre-pin-chacha20.dbfixture');
const FIXTURE_KEY = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
const FIXTURE_SHA256 = 'a6577290bfce14ae3ea24c2336ee93647d33610f373d13da5dce69ca6fc1f824';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'db-encryption-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const sha256 = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');
const countRows = (db: Database.Database, table = 't'): number =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

/**
 * The open sequence every database was created with before the pin: `new
 * Database`, then `key`, and no cipher pragma. Written out here on purpose, so it
 * cannot follow the helper if the helper changes.
 */
function keyLikeBeforeThePin(db: Database.Database, key = KEY): void {
  db.pragma(`key='${key}'`);
}

function createWithoutThePin(path: string, rows = 3): void {
  const db = openTestDb(path);
  keyLikeBeforeThePin(db);
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
  const insert = db.prepare('INSERT INTO t (v) VALUES (?)');
  for (let i = 0; i < rows; i++) insert.run(`row ${i}`);
  db.close();
}

/**
 * A later library whose compiled-in defaults differ, simulated per connection.
 * These pragmas set the same per-connection defaults a compiled-in change would
 * start from (`sqlite3mc_config("default:…")`), and they run before the key
 * because any SELECT would read the encrypted file first and fail.
 */
const CHANGED_DEFAULTS: ReadonlyArray<readonly [string, (db: Database.Database) => void]> = [
  ['cipher', (db) => { db.pragma(`cipher='aes256cbc'`); }],
  ['kdf_iter', (db) => { db.pragma('kdf_iter=12345'); }],
  ['legacy', (db) => { db.pragma('legacy=1'); }],
  ['plaintext_header_size', (db) => { db.pragma('plaintext_header_size=32'); }],
];

const everyDefaultChanged = (db: Database.Database): void => {
  db.pragma('kdf_iter=12345');
  db.pragma('plaintext_header_size=32');
  db.pragma(`cipher='aes256cbc'`);
};

describe('the pinned settings', () => {
  // Breaks if a library upgrade moves a default. The pin keeps existing files
  // readable regardless, but this is the place that upgrade has to be reviewed,
  // including the settings below that are watched rather than pinned.
  it("are the library's own defaults, so no existing database changes", () => {
    const db = openTestDb(':memory:');
    const read = (name: string): string => String(db.pragma(name, { simple: true }));
    for (const [name, value] of DB_CIPHER_SETTINGS) expect([name, read(name)]).toEqual([name, value]);
    expect(read('legacy_page_size')).toBe('4096');
    expect(read('hmac_check')).toBe('1');
    expect(read('mc_legacy_wal')).toBe('0');
    db.close();
  });

  // Breaks if a setting is dropped from the list or its value edited: every
  // database in every install was written with exactly these.
  it('are exactly chacha20 / not legacy / no plaintext header / 64007 iterations', () => {
    expect(Object.fromEntries(DB_CIPHER_SETTINGS)).toEqual({
      cipher: 'chacha20', legacy: '0', plaintext_header_size: '0', kdf_iter: '64007',
    });
  });

  // Breaks if `cipher` stops coming first: the numeric settings apply to the cipher
  // selected at that moment, so kdf_iter would land on the old default cipher.
  it('select the cipher before the settings that belong to it', () => {
    expect(DB_CIPHER_SETTINGS[0][0]).toBe('cipher');

    const path = join(dir, 'order.db');
    createWithoutThePin(path);
    const wrongOrder = openTestDb(path);
    everyDefaultChanged(wrongOrder);
    wrongOrder.pragma('kdf_iter=64007');
    wrongOrder.pragma(`cipher='chacha20'`);
    expect(String(wrongOrder.pragma('kdf_iter', { simple: true }))).toBe('12345');
    wrongOrder.close();
  });

  // Breaks if the pin stops overriding what the connection held: the read-back
  // is what the app relies on instead of a value it merely asked for.
  it('read back as applied on a connection that held other values', () => {
    const db = openTestDb(':memory:');
    everyDefaultChanged(db);
    expect(db.pragma('cipher', { simple: true })).toBe('aes256cbc');

    pinDbCipher(db);

    for (const [name, value] of DB_CIPHER_SETTINGS) {
      expect([name, String(db.pragma(name, { simple: true }))]).toEqual([name, value]);
    }
    db.close();
  });

  // Breaks if a pin starts writing: it runs on every open of every database, and
  // must leave the bytes of an existing file alone.
  it('do not touch the file, however often they are applied', () => {
    const path = join(dir, 'untouched.db');
    createWithoutThePin(path);
    const before = sha256(path);
    for (let i = 0; i < 2; i++) {
      const db = openTestDb(path);
      pinDbCipher(db);
      pinDbCipher(db);
      db.close();
    }
    expect(sha256(path)).toBe(before);
  });
});

describe('a connection the settings cannot be pinned on', () => {
  /** A connection whose library answers `reads` for a setting's value. */
  function connection(reads: (name: string) => unknown): PragmaConnection & { statements: string[] } {
    const statements: string[] = [];
    return {
      statements,
      pragma(source, options) {
        statements.push(source);
        return options?.simple ? reads(source) : [];
      },
    };
  }

  // Breaks if the read-back goes. The library is quiet about a setting it did not
  // take: an unknown name returns nothing and an out-of-range number keeps the old
  // value, so without this a future library would carry on under unpinned settings.
  it.each([
    ['an unknown setting', () => undefined],
    ['a different value kept by the library', (name: string) => (name === 'kdf_iter' ? '12345' : DB_CIPHER_SETTINGS.find(([n]) => n === name)?.[1])],
  ])('throws for %s, and the key is never sent', (_label, reads) => {
    const db = connection(reads);
    expect(() => applyDbKey(db, KEY)).toThrow(/Could not pin the database encryption settings/);
    expect(db.statements.some((s) => s.startsWith('key='))).toBe(false);
  });

  // Breaks if a failure can rekey anyway. encryptPlaintextDb is irreversible, so it
  // must stop before it changes the journal mode or rewrites a page.
  it('does not start encrypting a plaintext database', () => {
    const db = connection(() => undefined);
    expect(() => encryptPlaintextDb(db, KEY)).toThrow(/Could not pin/);
    expect(db.statements.some((s) => s.includes('rekey') || s.includes('journal_mode'))).toBe(false);
  });

  // Breaks if the message ever names the key: it reaches app.log.
  it('does not put the key in the error', () => {
    const db = connection(() => undefined);
    let thrown: unknown;
    try {
      applyDbKey(db, KEY);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain('Could not pin');
    expect((thrown as Error).message).not.toContain(KEY);
  });

  // Breaks the day a real library refuses a pinned value: the pragma's own error has
  // to reach the caller. Absorbing it would not be caught by the read-back, because
  // the settings would still read back as the library's defaults, which match today.
  it('passes on a real refusal from the library, and the key is never sent', () => {
    const real = openTestDb(':memory:');
    const statements: string[] = [];
    const refused: PragmaConnection = {
      pragma(source, options) {
        statements.push(source);
        return real.pragma(source === `cipher='chacha20'` ? `cipher='no-such-cipher'` : source, options);
      },
    };

    expect(() => pinDbCipher(refused)).toThrow(/unknown/i);
    expect(() => applyDbKey(refused, KEY)).toThrow(/unknown/i);
    expect(statements.some((s) => s.startsWith('key='))).toBe(false);
    real.close();
  });
});

describe('an existing database, created without the pin', () => {
  // Breaks if a future library, or a future edit of the pin, can no longer read a
  // file written by 12.11.1 (SQLite3 Multiple Ciphers 2.3.5). This is the one test
  // that keeps its meaning across an upgrade: the bytes were made by the old code
  // (the unpinned sequence below) and are committed, not regenerated.
  it('opens from the committed bytes of the old library', () => {
    expect(sha256(FIXTURE)).toBe(FIXTURE_SHA256);
    const path = join(dir, 'fixture.db');
    copyFileSync(FIXTURE, path);
    expect(isExistingPlaintextDb(path)).toBe(false);

    const db = openTestDb(path);
    applyDbKey(db, FIXTURE_KEY);
    const rows = db.prepare('SELECT body FROM messages ORDER BY id').all();
    db.close();

    expect(rows).toEqual([{ body: 'first message' }, { body: 'second message' }, { body: 'third message' }]);
  });

  // Breaks if the pin differs from what the unpinned sequence writes today.
  it('opens with the pin and keeps its rows', () => {
    const path = join(dir, 'a.db');
    createWithoutThePin(path);

    const db = openTestDb(path);
    applyDbKey(db, KEY);
    expect(countRows(db)).toBe(3);
    db.exec(`INSERT INTO t (v) VALUES ('written after the pin')`);
    db.close();

    const again = openTestDb(path);
    keyLikeBeforeThePin(again);
    expect(countRows(again)).toBe(4);
    again.close();
  });

  // Breaks if an app that crashed before the pin shipped loses what was only in
  // its WAL: the sidecar's pages are encrypted under the same settings.
  it('keeps writes that had only reached the WAL when the old version crashed', () => {
    const path = join(dir, 'live.db');
    const live = openTestDb(path);
    keyLikeBeforeThePin(live);
    live.pragma('journal_mode = WAL');
    live.pragma('wal_autocheckpoint = 0');
    live.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    live.prepare('INSERT INTO t (v) VALUES (?)').run('only in the WAL');

    const copy = join(dir, 'crash.db');
    copyFileSync(path, copy);
    copyFileSync(`${path}-wal`, `${copy}-wal`);
    live.close();
    expect(statSync(`${copy}-wal`).size).toBeGreaterThan(0);

    const db = openTestDb(copy);
    applyDbKey(db, KEY);
    expect(countRows(db)).toBe(1);
    db.close();
  });

  // Breaks the way back: a user who reinstalls the previous version must still be
  // able to open a database the pinned version wrote to.
  it('stays readable by the old open sequence after the pinned app wrote to it', () => {
    const path = join(dir, 'created-pinned.db');
    const db = openTestDb(path);
    applyDbKey(db, KEY);
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT); INSERT INTO t (v) VALUES (1), (2)');
    db.close();

    const old = openTestDb(path);
    keyLikeBeforeThePin(old);
    expect(countRows(old)).toBe(2);
    old.close();
  });

  // Breaks if the pin stops overriding the library. This is the whole point of the
  // pin, and the first half of each case proves the simulation really is one: the
  // old sequence fails on a connection whose default has moved.
  it.each(CHANGED_DEFAULTS)('survives a later library changing the %s default', (_name, changeDefault) => {
    const path = join(dir, 'upgraded.db');
    createWithoutThePin(path);

    const unpinned = openTestDb(path);
    changeDefault(unpinned);
    keyLikeBeforeThePin(unpinned);
    expect(() => countRows(unpinned)).toThrow(/file is not a database/);
    unpinned.close();

    const pinned = openTestDb(path);
    changeDefault(pinned);
    applyDbKey(pinned, KEY);
    expect(countRows(pinned)).toBe(3);
    pinned.close();
  });

  // Same promise for bytes a real old library wrote, not bytes written moments ago.
  it('opens from the committed bytes under every changed default at once', () => {
    const path = join(dir, 'fixture.db');
    copyFileSync(FIXTURE, path);
    const db = openTestDb(path);
    everyDefaultChanged(db);
    applyDbKey(db, FIXTURE_KEY);
    expect(countRows(db, 'messages')).toBe(3);
    db.close();
  });
});

describe('compaction (VACUUM) of a pinned connection', () => {
  /** The same statements the VACUUM worker runs, on a connection keyed by the helper. */
  function vacuum(db: Database.Database): void {
    db.pragma('temp_store = FILE');
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.pragma('auto_vacuum = INCREMENTAL');
    db.exec('VACUUM');
    db.pragma('wal_checkpoint(TRUNCATE)');
  }

  // Breaks if the rebuilt file comes out under anything but the original settings:
  // VACUUM rewrites every page, and the whole account is in those pages.
  it('leaves a file that opens both pinned and with the old sequence', () => {
    const path = join(dir, 'c.db');
    createWithoutThePin(path, 200);

    const db = openTestDb(path);
    applyDbKey(db, KEY);
    vacuum(db);
    expect(db.pragma('auto_vacuum', { simple: true })).toBe(2);
    expect(countRows(db)).toBe(200);
    db.close();

    const pinned = openTestDb(path);
    applyDbKey(pinned, KEY);
    expect(countRows(pinned)).toBe(200);
    pinned.close();

    const old = openTestDb(path);
    keyLikeBeforeThePin(old);
    expect(countRows(old)).toBe(200);
    old.close();
  });

  // Breaks if a later library's defaults could leak into a rebuild. The file must
  // come out in the original format, readable by a connection that never saw them.
  it('rewrites the original format under a later library', () => {
    const path = join(dir, 'c.db');
    createWithoutThePin(path, 50);

    const db = openTestDb(path);
    everyDefaultChanged(db);
    applyDbKey(db, KEY);
    vacuum(db);
    db.close();

    const old = openTestDb(path);
    keyLikeBeforeThePin(old);
    expect(countRows(old)).toBe(50);
    old.close();
  });

  // Breaks if re-running a rebuild on an already rebuilt file damages it (the app
  // offers compaction again whenever enough space is reclaimable).
  it('can be repeated', () => {
    const path = join(dir, 'c.db');
    createWithoutThePin(path, 20);
    for (let run = 0; run < 2; run++) {
      const db = openTestDb(path);
      applyDbKey(db, KEY);
      vacuum(db);
      db.close();
    }
    const db = openTestDb(path);
    applyDbKey(db, KEY);
    expect(countRows(db)).toBe(20);
    db.close();
  });
});

describe('a wrong key on a pinned connection', () => {
  // Breaks CLAUDE.md's rule: an unreadable store and an empty store are the same
  // value and opposite facts. A wrong key must never read as "no rows", and every
  // first statement a caller actually runs has to be the one that says so.
  it.each([
    ['the journal mode, as SQLiteStorage and the core DB do first', (db: Database.Database) => db.pragma('journal_mode = WAL')],
    ['the checkpoint, as the VACUUM worker does first', (db: Database.Database) => db.pragma('wal_checkpoint(TRUNCATE)')],
    ['a read', (db: Database.Database) => countRows(db)],
    ['a VACUUM', (db: Database.Database) => db.exec('VACUUM')],
  ])('fails loudly on %s and leaves the file alone', (_label, firstStatement) => {
    const path = join(dir, 'k.db');
    createWithoutThePin(path);
    const before = sha256(path);

    const db = openTestDb(path);
    applyDbKey(db, WRONG_KEY);
    expect(() => firstStatement(db)).toThrow(/file is not a database/);
    db.close();

    expect(sha256(path)).toBe(before);
  });

  // Breaks if a failed attempt burns the file. Most key failures are transient: a
  // locked keychain that unlocks on the next launch.
  it('does not stop the right key working on the next open', () => {
    const path = join(dir, 'k.db');
    createWithoutThePin(path);

    const wrong = openTestDb(path);
    applyDbKey(wrong, WRONG_KEY);
    expect(() => countRows(wrong)).toThrow(/file is not a database/);
    wrong.close();

    const right = openTestDb(path);
    applyDbKey(right, KEY);
    expect(countRows(right)).toBe(3);
    right.close();
  });
});

describe('the shared contact directory', () => {
  /**
   * A directory made by the old sequence: ATTACH … KEY on an unpinned connection.
   * The row lives in a table of its own so the real schema, which `attachSharedContacts`
   * applies on top with IF NOT EXISTS, can be the production one.
   */
  function createDirectoryWithoutThePin(path: string): void {
    const db = openTestDb(':memory:');
    db.prepare(`ATTACH DATABASE ? AS ${SHARED_SCHEMA} KEY ?`).run(path, KEY);
    db.exec(`CREATE TABLE ${SHARED_SCHEMA}.people (id TEXT PRIMARY KEY, email TEXT NOT NULL)`);
    db.prepare(`INSERT INTO ${SHARED_SCHEMA}.people (id, email) VALUES (?, ?)`).run('c1', 'kept@example.test');
    db.close();
  }

  const emails = (db: Database.Database): unknown[] =>
    db.prepare(`SELECT email FROM ${SHARED_SCHEMA}.people ORDER BY id`).all();

  // Breaks if ATTACH stops following the pin: ATTACH takes its settings from the
  // connection, so this connection is deliberately never keyed by the helper.
  it('opens a directory created without the pin, on a connection under a later library', () => {
    const path = join(dir, 'contacts.db');
    createDirectoryWithoutThePin(path);

    const db = openTestDb(':memory:');
    everyDefaultChanged(db);
    attachSharedContacts(db, path, KEY);
    expect(emails(db)).toEqual([{ email: 'kept@example.test' }]);
    db.close();
  });

  // Breaks multi-account: every mailbox's connection attaches the SAME file, so the
  // one pinned here and the one keyed the old way must read each other's writes.
  it('is shared by two accounts, one of which wrote before the pin', () => {
    const path = join(dir, 'contacts.db');
    createDirectoryWithoutThePin(path);

    const first = openTestDb(join(dir, 'acct1.db'));
    applyDbKey(first, KEY);
    first.exec('CREATE TABLE IF NOT EXISTS mailbox (x)');
    attachSharedContacts(first, path, KEY);

    const second = openTestDb(join(dir, 'acct2.db'));
    applyDbKey(second, KEY);
    second.exec('CREATE TABLE IF NOT EXISTS mailbox (x)');
    attachSharedContacts(second, path, KEY);

    first.prepare(`INSERT INTO ${SHARED_SCHEMA}.people (id, email) VALUES (?, ?)`).run('c2', 'from-first@example.test');
    expect(emails(second)).toEqual([{ email: 'kept@example.test' }, { email: 'from-first@example.test' }]);
    expect(countRows(first, 'mailbox')).toBe(0);

    first.close();
    second.close();
  });

  // Breaks the guarantee shared-contacts.ts makes: a wrong key throws at attach, and
  // never reads as an empty address book the enrichment schedulers then rebuild.
  it('throws on a wrong key and leaves the directory for the right one', () => {
    const path = join(dir, 'contacts.db');
    createDirectoryWithoutThePin(path);
    const before = sha256(path);

    const wrong = openTestDb(':memory:');
    expect(() => attachSharedContacts(wrong, path, WRONG_KEY)).toThrow(/file is not a database/);
    wrong.close();
    expect(sha256(path)).toBe(before);

    const right = openTestDb(':memory:');
    attachSharedContacts(right, path, KEY);
    expect(emails(right)).toEqual([{ email: 'kept@example.test' }]);
    right.close();
  });

  // Breaks an install that predates encryption: the plaintext directory has to come
  // out in the pinned format even if the library's default has moved by then, or
  // the file it rewrites can't be read by the very next connection.
  it('encrypts a plaintext directory in the pinned format', () => {
    const path = join(dir, 'contacts.db');
    const plain = openTestDb(path);
    plain.exec(`CREATE TABLE people (id TEXT PRIMARY KEY, email TEXT NOT NULL); INSERT INTO people VALUES ('c1', 'kept@example.test')`);
    plain.close();
    expect(isExistingPlaintextDb(path)).toBe(true);

    const db = openTestDb(':memory:');
    everyDefaultChanged(db);
    attachSharedContacts(db, path, KEY);
    db.close();
    expect(isExistingPlaintextDb(path)).toBe(false);

    const old = openTestDb(path);
    keyLikeBeforeThePin(old);
    expect(countRows(old, 'people')).toBe(1);
    old.close();
  });

  // Breaks an install from before at-rest encryption, where the mailbox goes first:
  // a plaintext directory attaches with no key onto a connection that already has one.
  it('encrypts a plaintext directory attached to a keyed mailbox, under a later library', () => {
    const path = join(dir, 'contacts.db');
    const plain = openTestDb(path);
    plain.exec(`CREATE TABLE people (id TEXT PRIMARY KEY, email TEXT NOT NULL); INSERT INTO people VALUES ('c1', 'kept@example.test')`);
    plain.close();

    const db = openTestDb(join(dir, 'acct.db'));
    everyDefaultChanged(db);
    applyDbKey(db, KEY);
    db.exec('CREATE TABLE mailbox (x)');
    attachSharedContacts(db, path, KEY);
    expect(emails(db)).toEqual([{ email: 'kept@example.test' }]);
    expect(countRows(db, 'mailbox')).toBe(0);
    db.close();

    expect(isExistingPlaintextDb(path)).toBe(false);
    const old = openTestDb(path);
    keyLikeBeforeThePin(old);
    expect(countRows(old, 'people')).toBe(1);
    old.close();
  });

  // Breaks a keyless test or tool connection: with no key there is nothing to pin,
  // and the file has to stay plaintext.
  it('leaves a keyless directory plaintext', () => {
    const path = join(dir, 'contacts.db');
    const db = openTestDb(':memory:');
    attachSharedContacts(db, path);
    db.close();
    expect(isExistingPlaintextDb(path)).toBe(true);
  });
});

describe('encryptPlaintextDb', () => {
  function createPlaintext(path: string): void {
    const db = openTestDb(path);
    db.pragma('journal_mode = WAL');
    db.exec(`CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT); INSERT INTO t (v) VALUES ('a'), ('b')`);
    db.close();
  }

  // Breaks a mailbox from before at-rest encryption: rekey is irreversible, and has
  // to leave every row readable by a connection that never saw this one.
  it('migrates in place in the pinned format, keeping every row', () => {
    const path = join(dir, 'plain.db');
    createPlaintext(path);

    const db = openTestDb(path);
    everyDefaultChanged(db);
    encryptPlaintextDb(db, KEY);
    db.close();
    expect(isExistingPlaintextDb(path)).toBe(false);

    const old = openTestDb(path);
    keyLikeBeforeThePin(old);
    expect(countRows(old)).toBe(2);
    old.close();
  });

  // Breaks if a key containing a quote can terminate the pragma's string literal.
  it("escapes a key's quotes, in both directions", () => {
    const path = join(dir, 'plain.db');
    createPlaintext(path);
    const quoted = "quo'te";

    const db = openTestDb(path);
    encryptPlaintextDb(db, quoted);
    db.close();

    const reopened = openTestDb(path);
    applyDbKey(reopened, quoted);
    expect(countRows(reopened)).toBe(2);
    reopened.close();
  });
});

describe('the committed fixture', () => {
  // Breaks if the fixture is touched: its value is that it was never regenerated.
  it('still has the bytes the old library wrote', () => {
    const bytes = readFileSync(FIXTURE);
    expect(bytes.subarray(0, 15).toString('latin1')).not.toBe('SQLite format 3');
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(FIXTURE_SHA256);
  });
});
