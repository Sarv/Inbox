/**
 * "Compress database" — the user-triggered VACUUM behind Settings -> Advanced.
 *
 * SQLite never returns freed pages to the OS on its own (see
 * `@sarvinbox/core`'s db-compaction helpers for why these files end up mostly
 * holes). VACUUM is the only thing that does, and it is expensive enough that it
 * has to be deliberate: minutes of full-file rewrite, an exclusive lock, and a
 * complete second copy on disk while it runs.
 *
 * The sequence, and why each step is not optional:
 *
 *   1. Refuse if the account is mid-sync. The rebuild locks the file; a sync
 *      caught behind it stalls for minutes and its IMAP connections time out.
 *   2. Refuse without disk headroom. VACUUM writes the whole new file before
 *      swapping, so the peak requirement is the CURRENT size, not the shrunk one.
 *   3. Quiesce the account — disconnect IMAP, close the handle. An open
 *      connection blocks the exclusive lock outright.
 *   4. VACUUM on a worker thread, never here. better-sqlite3 is synchronous;
 *      on the main thread this is a multi-minute freeze of the whole app.
 *   5. Reopen the account in a `finally`. This is the important one: if the
 *      rebuild fails, throws, or the worker dies, the account must still come
 *      back. Anything else leaves the user with a mailbox that has silently
 *      stopped existing until they restart.
 */
import { statfs } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { Worker } from 'node:worker_threads';

import { app } from 'electron';

import {
  compactionEstimate,
  formatBytes,
  hasCompactionHeadroom,
  isCompactionWorthwhile,
  createLogger,
  type CompactionEstimate,
} from '@sarvinbox/core';

import {
  PRIMARY_DB_FILE,
  dbFileForAccount,
  ensureAccountRuntime,
  loadPrimaryAccountId,
  quiesceAccountRuntime,
  releaseAccountMaintenance,
} from './accounts-runtime';
import { getDbEncryptionKey } from './db-key-store';

import { getAccountRuntime } from '../shared';

import type { CompactWorkerResult } from '../workers/db-compact.worker';

const logger = createLogger('db-compact');

export interface CompactionReport extends CompactionEstimate {
  accountId: string;
  /** True when a rebuild would reclaim enough to be worth its cost. */
  worthwhile: boolean;
}

export interface CompactionOutcome {
  accountId: string;
  beforeBytes: number;
  afterBytes: number;
  reclaimedBytes: number;
  elapsedMs: number;
  /**
   * Emails counted in the rebuilt file. The UI states this back to the user —
   * "compressing" is a word people associate with lossy formats, and a number
   * they recognise is the most convincing possible answer to "did I lose mail?".
   */
  emailCount: number | null;
  /**
   * False when the before/after counts disagree — i.e. the rebuild did NOT
   * preserve every row. Never expected; surfaced loudly rather than swallowed.
   */
  rowsPreserved: boolean;
  /** True when the file is now on INCREMENTAL auto-vacuum and won't re-bloat. */
  autoVacuumEnabled: boolean;
}

/** `PRAGMA auto_vacuum` = 2. See the pragma comment in the worker. */
const AUTO_VACUUM_INCREMENTAL = 2;

/**
 * Only ONE compaction at a time, process-wide.
 *
 * Not merely tidiness: each concurrent rebuild needs a full second copy of its
 * database on disk at the same moment, so two large accounts at once can double
 * the headroom requirement that step 2 checked individually and run the volume
 * out of space mid-rebuild.
 */
let inFlightAccountId: string | null = null;

export function compactionInProgress(): string | null {
  return inFlightAccountId;
}

function accountDbPath(accountId: string): string {
  const dbFile = loadPrimaryAccountId() === accountId ? PRIMARY_DB_FILE : dbFileForAccount(accountId);
  return join(app.getPath('userData'), dbFile);
}

/**
 * How much a rebuild would reclaim, read from the LIVE handle.
 *
 * Three pragmas, no table access, no close — cheap enough to call whenever the
 * Advanced settings tab is opened.
 */
export function estimateCompaction(accountId: string): CompactionReport | null {
  const storage = getAccountRuntime(accountId)?.storage;
  if (!storage) return null;

  try {
    const estimate = compactionEstimate(storage.getPageStats());
    return { accountId, ...estimate, worthwhile: isCompactionWorthwhile(estimate) };
  } catch (error) {
    logger.warn(`[Compact] could not read page stats for ${accountId}`, error);
    return null;
  }
}

/** Free bytes on the volume holding the account databases, or 0 if unreadable. */
async function freeDiskBytes(): Promise<number> {
  try {
    const stats = await statfs(app.getPath('userData'));
    return stats.bsize * stats.bavail;
  } catch (error) {
    // Treat unknown as zero: `hasCompactionHeadroom` then refuses, which is the
    // safe direction — never start a multi-gigabyte rewrite on a volume whose
    // free space we could not read.
    logger.warn('[Compact] could not read free disk space', error);
    return 0;
  }
}

/**
 * Redirect a path inside `app.asar` to its unpacked twin, leaving any other
 * path untouched.
 *
 * `new Worker()` is not a plain fs read and cannot be relied on to see through
 * the archive the way `readFileSync` does, so anything spawned as a thread has
 * to be listed in `asarUnpack` and addressed here. Matching on the separator
 * (rather than the bare string) keeps a directory merely NAMED `app.asarX` from
 * being rewritten, and uses the platform separator so it works on Windows too.
 */
export function resolveUnpacked(path: string): string {
  return path.replace(`app.asar${sep}`, `app.asar.unpacked${sep}`);
}

/**
 * Where the built worker lives. vite-plugin-electron emits it beside the main
 * bundle, so in development this is simply `__dirname`.
 */
export function compactWorkerPath(): string {
  return resolveUnpacked(join(__dirname, 'db-compact.worker.js'));
}

function runCompactWorker(dbPath: string, key: string): Promise<CompactWorkerResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(compactWorkerPath(), {
      workerData: { dbPath, key },
    });

    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    worker.on('message', (result: CompactWorkerResult) => settle(() => resolve(result)));
    worker.on('error', (error) => settle(() => reject(error)));
    // A worker that exits without posting anything (OOM, hard crash) would
    // otherwise leave this promise pending forever, and the account closed with it.
    worker.on('exit', (code) =>
      settle(() => reject(new Error(`compaction worker exited unexpectedly (code ${code})`))),
    );
  });
}

/**
 * Rebuild one account's database, reclaiming its freelist.
 *
 * Throws with a user-readable message on every refusal (busy, mid-sync, no
 * headroom, nothing to reclaim) — the caller surfaces it verbatim.
 */
export async function compactAccountDatabase(accountId: string): Promise<CompactionOutcome> {
  if (!accountId) throw new Error('No account selected.');
  if (inFlightAccountId) {
    throw new Error(
      inFlightAccountId === accountId
        ? 'This database is already being compressed.'
        : 'Another database is being compressed. Wait for it to finish.',
    );
  }

  const runtime = getAccountRuntime(accountId);
  if (!runtime?.storage) throw new Error('This account is not open.');

  // Guard 1 — a rebuild holds an exclusive lock for minutes. A sync caught
  // behind it stalls and its IMAP connections time out.
  if (runtime.syncEngine?.isSyncing?.()) {
    throw new Error('Mail is syncing right now. Wait for the sync to finish, then try again.');
  }

  const estimate = compactionEstimate(runtime.storage.getPageStats());
  if (estimate.freeBytes <= 0) {
    throw new Error('This database has no wasted space to reclaim.');
  }

  // Guard 2 — VACUUM writes a COMPLETE second copy before swapping it in, so
  // the peak requirement is the current file size, not the compacted one.
  const freeDisk = await freeDiskBytes();
  if (!hasCompactionHeadroom(estimate.fileBytes, freeDisk)) {
    throw new Error(
      `Not enough free disk space. Compressing needs about ${formatBytes(estimate.fileBytes * 1.2)} free ` +
        `while it rebuilds; there is ${formatBytes(freeDisk)} available.`,
    );
  }

  inFlightAccountId = accountId;
  const startedAt = Date.now();
  const dbPath = accountDbPath(accountId);
  logger.info(
    `[Compact] starting ${accountId}: ${formatBytes(estimate.fileBytes)} file, ` +
      `${formatBytes(estimate.freeBytes)} reclaimable`,
  );

  try {
    // Guard 3 — the exclusive lock is unobtainable while our own handle is open.
    // `hold: true` keeps every other reopen path out for the whole rebuild.
    // Without it the renderer's sync tick reopened the account 2.7s into a 31s
    // VACUUM, which cost two `database is locked` failures and left the WAL
    // un-checkpointable at the size of the entire rebuilt database.
    await quiesceAccountRuntime(accountId, 'compact', { hold: true });

    const result = await runCompactWorker(dbPath, getDbEncryptionKey());
    if (!result.ok) throw new Error(result.error);

    const before = compactionEstimate(result.before);
    const after = compactionEstimate(result.after);
    const elapsedMs = Date.now() - startedAt;

    // Unknown on either side (no `emails` table) is not a mismatch — we simply
    // cannot make the claim. Only two KNOWN counts that differ are a problem.
    const rowsPreserved =
      result.rowsBefore === null || result.rowsAfter === null
        ? true
        : result.rowsBefore === result.rowsAfter;
    const autoVacuumEnabled = result.autoVacuum === AUTO_VACUUM_INCREMENTAL;

    logger.info(
      `[Compact] ${accountId} done in ${Math.round(elapsedMs / 1000)}s: ` +
        `${formatBytes(before.fileBytes)} -> ${formatBytes(after.fileBytes)}, ` +
        `${result.rowsAfter ?? '?'} emails, auto_vacuum=${result.autoVacuum}`,
    );
    if (!rowsPreserved) {
      // Should be impossible — VACUUM is a lossless rebuild. If it ever fires,
      // it is the single most important line in the log.
      logger.error(
        `[Compact] ROW COUNT CHANGED for ${accountId}: ${result.rowsBefore} emails before, ` +
          `${result.rowsAfter} after`,
      );
    }
    if (!autoVacuumEnabled) {
      // Not fatal — the space was still reclaimed — but the file will re-bloat
      // and need this again, so the next person reading the log should know.
      logger.warn(
        `[Compact] ${accountId} did NOT convert to incremental auto-vacuum ` +
          `(auto_vacuum=${result.autoVacuum}); it will bloat again`,
      );
    }

    return {
      accountId,
      beforeBytes: before.fileBytes,
      afterBytes: after.fileBytes,
      reclaimedBytes: Math.max(0, before.fileBytes - after.fileBytes),
      elapsedMs,
      emailCount: result.rowsAfter,
      rowsPreserved,
      autoVacuumEnabled,
    };
  } finally {
    // The account MUST come back, whatever happened above. A failed rebuild
    // leaves the original file intact, so reopening is always the right move —
    // and skipping it would leave the user's mailbox silently gone until restart.
    inFlightAccountId = null;
    // Release the hold BEFORE reopening: `ensureAccountRuntime` refuses a held
    // account, so leaving it set would turn our own reopen into a no-op and
    // strand the user with a mailbox that stays closed until restart.
    releaseAccountMaintenance(accountId);
    try {
      await ensureAccountRuntime(accountId);
    } catch (error) {
      logger.error(`[Compact] FAILED to reopen ${accountId} after compaction`, error);
    }
  }
}
