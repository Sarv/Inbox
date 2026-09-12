/**
 * Deciding whether a SQLite file on disk is still PLAINTEXT.
 *
 * Both databases this package opens — the per-account mailbox and the shared
 * contact directory — can predate at-rest encryption, and both are migrated in
 * place by `PRAGMA rekey`. That decision has to be made from the FILE, before
 * the connection is opened or attached, because an encrypted database has an
 * opaque header and a brand-new one has no header at all: once SQLite has
 * created the file, "plaintext" and "new" are indistinguishable.
 *
 * Getting it wrong is not a soft failure. Attaching an existing plaintext file
 * WITH a key fails outright (`SQLITE_NOTADB`, "file is not a database"), and
 * rekeying a file that was never plaintext would encrypt ciphertext.
 */
import { closeSync, existsSync, openSync, readSync, statSync } from 'fs';

/** Every SQLite database begins with this NUL-terminated string. */
const SQLITE_HEADER = 'SQLite format 3';

/**
 * True only when `path` is an existing, NON-empty, PLAINTEXT SQLite database.
 *
 * Returns false for an absent file, an empty one, an encrypted one, and for
 * anything unreadable — every case where the caller should open with `key=`
 * rather than migrate with `rekey=`.
 */
export function isExistingPlaintextDb(path: string): boolean {
  try {
    if (!path || !existsSync(path) || statSync(path).size < 16) return false;
    const fd = openSync(path, 'r');
    try {
      const buf = Buffer.alloc(16);
      readSync(fd, buf, 0, 16, 0);
      return buf.toString('latin1').startsWith(SQLITE_HEADER);
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
