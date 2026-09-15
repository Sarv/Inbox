/**
 * VACUUM an account database on a worker thread.
 *
 * WHY A WORKER. better-sqlite3 is synchronous, and VACUUM rebuilds the ENTIRE
 * file — every page decrypted, re-encrypted and rewritten. On the 10 GB account
 * that is minutes. Run on the main thread it would block Electron outright: no
 * IPC, no window repaints, a beachball until it finished. Here it blocks only
 * this thread, which is what the thread is for.
 *
 * The caller must have CLOSED the app's own handle on this database first —
 * VACUUM takes an exclusive lock and cannot run alongside a live connection.
 *
 * The key arrives in `workerData` and is never logged, never returned, and never
 * put in an error message.
 */
import { parentPort, workerData } from 'node:worker_threads';

import type { DatabasePageStats } from '@sarvinbox/core';
import Database from 'better-sqlite3';

export interface CompactWorkerInput {
  dbPath: string;
  /** SQLCipher passphrase. Same value the app opens this file with. */
  key: string;
}

export interface RebuildOutcome {
  before: DatabasePageStats;
  after: DatabasePageStats;
  /**
   * `auto_vacuum` as the rebuilt file actually reports it: 0 NONE, 1 FULL,
   * 2 INCREMENTAL. Read back rather than assumed — the mode only converts
   * during a VACUUM, so this is the one moment it can be verified.
   */
  autoVacuum: number;
  /**
   * `emails` row count on either side of the rebuild — the proof, in the only
   * currency the user cares about, that nothing was lost. Null when the count
   * could not be taken (no such table), which is not itself a failure.
   */
  rowsBefore: number | null;
  rowsAfter: number | null;
}

export type CompactWorkerResult = ({ ok: true } & RebuildOutcome) | { ok: false; error: string };

/**
 * The subset of a better-sqlite3 handle this rebuild uses. Narrow on purpose:
 * the sequence below is the part that has to be right, and against this shape
 * it can be exercised without a keyed database or a worker thread.
 */
export interface CompactableDb {
  pragma(source: string, options?: { simple?: boolean }): unknown;
  exec(source: string): unknown;
  prepare(source: string): { get(): unknown };
}

/** Read the three occupancy pragmas as one snapshot. */
function readPageStats(db: CompactableDb): DatabasePageStats {
  const pragmaValue = (name: string): number => Number(db.pragma(name, { simple: true })) || 0;
  return {
    pageSize: pragmaValue('page_size'),
    pageCount: pragmaValue('page_count'),
    freelistCount: pragmaValue('freelist_count'),
  };
}

/**
 * Count the rows the user would call "my mail", so the before/after can be
 * compared. Best-effort by design: a missing table is not a reason to fail a
 * rebuild that has already succeeded, it just means we cannot make the claim.
 */
function countEmails(db: CompactableDb): number | null {
  try {
    const row = db.prepare('SELECT COUNT(*) AS n FROM emails').get() as { n?: number } | undefined;
    return typeof row?.n === 'number' ? row.n : null;
  } catch {
    return null;
  }
}

/**
 * The rebuild itself, against an open handle. Order is the whole content of
 * this function — see the comments on each step for what breaks if it moves.
 */
export function rebuildInPlace(db: CompactableDb): RebuildOutcome {
  // VACUUM builds the rebuilt database in a TEMPORARY file, then copies it
  // back. The app opens its own connections with `temp_store = MEMORY` (good
  // for the sort/group temp b-trees it runs); inheriting that habit here would
  // ask SQLite to hold a multi-gigabyte rebuild in RAM. Pin it to disk.
  db.pragma('temp_store = FILE');

  // Fold the WAL back into the main file first. Pages still living only in the
  // WAL are not part of what VACUUM rebuilds, so without this the sidecar
  // survives the rebuild and some of the reclaimed space comes straight back.
  db.pragma('wal_checkpoint(TRUNCATE)');

  const before = readPageStats(db);
  const rowsBefore = countEmails(db);

  // Switch the file to INCREMENTAL auto-vacuum, so this rebuild is a one-off
  // rather than something the user has to remember every few months.
  //
  // This pragma HAS to sit here, immediately before the VACUUM. Changing
  // auto_vacuum on an existing database does nothing on its own — SQLite only
  // converts the file during a VACUUM, because the mode changes the page
  // layout (it adds the pointer-map pages that let freed pages be moved to the
  // end of the file and truncated away). Set it after, and it is silently
  // ignored until the next full rebuild; set it here and the rebuild we are
  // already paying for does the conversion for free.
  //
  // INCREMENTAL, not FULL, deliberately: FULL truncates on every single commit,
  // which puts the cost on the hot write path for a mail client that commits
  // constantly. INCREMENTAL keeps the pointer maps up to date and lets a future
  // maintenance pass call `incremental_vacuum(N)` to hand pages back to the OS
  // in bounded chunks, off the hot path.
  db.pragma('auto_vacuum = INCREMENTAL');

  db.exec('VACUUM');

  // And AGAIN afterwards — this one is the important one. In WAL mode VACUUM
  // writes the whole rebuilt database THROUGH the WAL, so the moment it
  // finishes the sidecar is as large as the new main file. Measured on the
  // 9.8 GB account: the file came down to 1.7 GB and left a 1.7 GB `-wal` next
  // to it, halving the space the user was told they got back. Closing the last
  // connection would normally checkpoint it away, but that only holds if this
  // IS the last connection — anything that reopened the account mid-rebuild
  // pins the WAL at full size indefinitely.
  db.pragma('wal_checkpoint(TRUNCATE)');

  // Read the after-stats past the checkpoint so the figure reported to the
  // user is the settled file, not a snapshot with gigabytes still in flight.
  const after = readPageStats(db);
  const rowsAfter = countEmails(db);

  // Read the mode back off the rebuilt file instead of trusting the pragma we
  // just set. If the conversion did not take, the caller needs to know it will
  // have to do this again — silently believing it worked is how the bloat comes
  // back with nobody expecting it.
  const autoVacuum = Number(db.pragma('auto_vacuum', { simple: true })) || 0;

  return { before, after, autoVacuum, rowsBefore, rowsAfter };
}

/**
 * Open exactly the way `SQLiteStorage` does: a bare `new Database`, then `key`
 * as the very FIRST statement.
 *
 * This is not cosmetic. VACUUM rewrites every page through whatever cipher
 * settings the connection is holding, so opening with a different configuration
 * would produce a rebuilt file the app can no longer decrypt — the whole account
 * lost. Matching the app's open sequence is the guarantee that it can.
 */
function openKeyed(dbPath: string, key: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma(`key='${key.replace(/'/g, "''")}'`);
  return db;
}

function compact(input: CompactWorkerInput): CompactWorkerResult {
  let db: Database.Database | null = null;
  try {
    db = openKeyed(input.dbPath, input.key);

    const rebuilt = rebuildInPlace(db);

    db.close();
    db = null;

    // Prove the rebuilt file still opens with the SAME key before the app is
    // told to reopen it. A VACUUM that silently re-encrypted under different
    // settings would otherwise surface as an unopenable account at reopen, with
    // the original file already replaced. Cheap: reads the schema page only.
    const verify = openKeyed(input.dbPath, input.key);
    try {
      verify.prepare('SELECT COUNT(*) AS n FROM sqlite_master').get();
    } finally {
      verify.close();
    }

    return { ok: true, ...rebuilt };
  } catch (error) {
    // Deliberately only the message — an error object from the SQL layer can
    // carry the failing statement, and the keying pragma contains the key.
    return { ok: false, error: (error as Error)?.message ?? 'unknown error' };
  } finally {
    try {
      db?.close();
    } catch {
      /* already closed, or never opened */
    }
  }
}

/** Does `workerData` actually carry this worker's input contract? */
function isCompactInput(value: unknown): value is CompactWorkerInput {
  const input = value as CompactWorkerInput | null;
  return typeof input?.dbPath === 'string' && typeof input?.key === 'string';
}

// Only rebuild when this module was started as THIS worker, with THIS input.
//
// The obvious `parentPort?.postMessage(compact(workerData))` is wrong twice
// over: `compact` is an argument, so it is evaluated before `?.` can
// short-circuit and opens `undefined`; and `parentPort` on its own is not the
// test either, because vitest runs every test file inside a worker thread of
// its own — importing this module there found a live parent port and posted a
// compaction result onto it, which vitest reports as an unexpected message and
// fails the run. Checking the input shape is the honest guard.
if (parentPort && isCompactInput(workerData)) {
  parentPort.postMessage(compact(workerData));
}
