/**
 * How every database in this app is encrypted: the settings, the one way a
 * connection gets its key, and whether a file on disk is still PLAINTEXT.
 *
 * Imported by the mailbox, the shared contact directory, the core DB and the
 * VACUUM worker, which is why it depends on nothing but `fs` (it has its own
 * package entry point, so the worker thread does not load the barrel).
 *
 * The plaintext question: both databases this package opens — the per-account
 * mailbox and the shared contact directory — can predate at-rest encryption, and
 * both are migrated in place by `PRAGMA rekey`. That decision has to be made from
 * the FILE, before the connection is opened or attached, because an encrypted
 * database has an opaque header and a brand-new one has no header at all: once
 * SQLite has created the file, "plaintext" and "new" are indistinguishable.
 *
 * Getting it wrong is not a soft failure. Attaching an existing plaintext file
 * WITH a key fails outright (`SQLITE_NOTADB`, "file is not a database"), and
 * rekeying a file that was never plaintext would encrypt ciphertext.
 */
import { closeSync, constants, fstatSync, openSync, readSync } from 'fs';

/** Every SQLite database begins with this NUL-terminated string. */
const SQLITE_HEADER = 'SQLite format 3';

/**
 * True only when `path` is an existing, NON-empty, PLAINTEXT SQLite database.
 *
 * Returns false for an absent file, an empty one, an encrypted one, and for
 * anything unreadable — every case where the caller should open with `key=`
 * rather than migrate with `rekey=`. That is the safe direction: a wrong
 * `false` makes a plaintext file fail to open (loudly, `SQLITE_NOTADB`); a
 * wrong `true` would rekey ciphertext. So every doubt answers `false`.
 *
 * Decided from ONE open handle: the size and the header come from the same
 * file, never from a path looked up twice (a file swapped in between would be
 * measured as one file and read as another). Opened with O_NONBLOCK so a FIFO
 * at the path cannot block the open, and with it startup; it is then refused as
 * not a regular file. A symlink is followed, as SQLite follows it when it
 * opens the same path.
 */
export function isExistingPlaintextDb(path: string): boolean {
  if (!path) return false;
  try {
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK || 0));
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size < 16) return false;
      const buf = Buffer.alloc(16);
      return readSync(fd, buf, 0, 16, 0) === 16 && buf.toString('latin1').startsWith(SQLITE_HEADER);
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
}

/**
 * Escape a key for interpolation into a `key=`/`rekey=` pragma.
 *
 * `PRAGMA key` takes a string literal, not a bound parameter, so the value has
 * to be inlined. The key is hex today, so this never triggers — which is
 * exactly why it must be here: the day it stops being hex, nothing else would
 * have caught it.
 */
export function escapeDbKey(key: string): string {
  return key.replace(/'/g, "''");
}

/** The slice of a better-sqlite3 handle that keying needs. */
export interface PragmaConnection {
  pragma(source: string, options?: { simple?: boolean }): unknown;
}

/**
 * Every setting that decides how a database's pages are encrypted. Each value is
 * what SQLite3 Multiple Ciphers 2.3.5 (better-sqlite3-multiple-ciphers 12.11.1)
 * defaults to, so it is what every existing database was written with.
 *
 * They are spelled out because those defaults belong to the library. If an
 * upgrade changed one, nothing would throw at the upgrade: `PRAGMA key` still
 * says "ok", and every existing database reads as "file is not a database" from
 * then on, which this app's swallowing reads turn into an empty mailbox.
 *
 * `legacy` and `plaintext_header_size` change the on-disk format just as `cipher`
 * and `kdf_iter` do (measured: flipping either default makes an existing file
 * unreadable). `legacy_page_size` is only read when `legacy` is on, and
 * `hmac_check` / `mc_legacy_wal` do not change how the file's pages are written,
 * so `db-encryption.test.ts` watches those instead of pinning them.
 *
 * ORDER MATTERS: the numeric settings apply to whichever cipher is selected at
 * that moment, so `cipher` comes first. The other way round, `kdf_iter` lands on
 * the old default cipher and the database does not open.
 */
export const DB_CIPHER_SETTINGS: ReadonlyArray<readonly [name: string, value: string]> = [
  ['cipher', 'chacha20'],
  ['legacy', '0'],
  ['plaintext_header_size', '0'],
  ['kdf_iter', '64007'],
];

/**
 * Pin {@link DB_CIPHER_SETTINGS} on a connection. Must run before the connection
 * first reads the file, which means before `key`: any statement that reads the
 * schema of an encrypted file fails with no key set.
 *
 * Applies to the whole connection, and to everything later attached to it or
 * rekeyed on it: without a schema name these pragmas set the connection's own
 * defaults (`sqlite3mc_config("default:…")`). They touch no file.
 *
 * Read back rather than trusted, because the library is quiet about a value it
 * did not take: an out-of-range number keeps the old one and an unknown name
 * returns nothing. Throws, and the message carries no key. A connection that
 * cannot be pinned must not go on to open a file, or to write a new one, under
 * settings nobody chose.
 */
export function pinDbCipher(db: PragmaConnection): void {
  for (const [name, value] of DB_CIPHER_SETTINGS) {
    db.pragma(name === 'cipher' ? `cipher='${value}'` : `${name}=${value}`);
  }
  for (const [name, value] of DB_CIPHER_SETTINGS) {
    const actual = db.pragma(name, { simple: true });
    if (String(actual) !== value) {
      throw new Error(`Could not pin the database encryption settings: ${name} is ${String(actual)}, expected ${value}.`);
    }
  }
}

/**
 * Key a freshly opened connection: the settings, then the key, as the first
 * statements it runs. A wrong key does not fail here. SQLite only finds out when
 * it first reads a page, so the caller's next statement that touches the file
 * throws `SQLITE_NOTADB`.
 */
export function applyDbKey(db: PragmaConnection, key: string): void {
  pinDbCipher(db);
  db.pragma(`key='${escapeDbKey(key)}'`);
}

/**
 * Encrypt a plaintext database IN PLACE: the main database, or an attached one
 * when `schema` is named. Leaves WAL first, because rekey rewrites every page and
 * doing that under a rollback journal is the recoverable path; the caller turns
 * WAL back on afterwards.
 */
export function encryptPlaintextDb(db: PragmaConnection, key: string, schema?: string): void {
  pinDbCipher(db);
  const qualifier = schema ? `${schema}.` : '';
  db.pragma(`${qualifier}journal_mode = DELETE`);
  db.pragma(`${qualifier}rekey='${escapeDbKey(key)}'`);
}
