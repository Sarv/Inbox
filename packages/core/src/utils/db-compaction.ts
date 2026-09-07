/**
 * Sizing the "Compress database" maintenance action.
 *
 * SQLite never returns space to the OS on its own. A deleted row's pages go on
 * an internal freelist to be reused by later writes, and with `auto_vacuum = 0`
 * — which is what these DBs run — they stay inside the file forever. Routine
 * sync reuses what it frees, so it stays balanced; what unbalances it is a bulk
 * one-off that frees far more at once than anything will reuse: the migration
 * that moved every body into `email_bodies` and nulled the originals, the
 * inline-image pass that rewrote every `raw_body` again, a full-mailbox
 * re-ingest. After enough of those the file is mostly holes, and only a VACUUM
 * (a full rebuild into a fresh file) hands the space back.
 *
 * This module is the pure arithmetic behind that decision — the figures shown to
 * the user, the "worth doing" hint, and the disk-headroom guard — so all three
 * can be unit-tested without a database or an Electron main process.
 */

/** The three pragmas that describe a SQLite file's occupancy. */
export interface DatabasePageStats {
  /** `PRAGMA page_size` — bytes per page. */
  pageSize: number;
  /** `PRAGMA page_count` — total pages in the file, live and free. */
  pageCount: number;
  /** `PRAGMA freelist_count` — pages that hold nothing but are still in the file. */
  freelistCount: number;
}

export interface CompactionEstimate {
  /** Size of the file on disk today. */
  fileBytes: number;
  /** Bytes a VACUUM would hand back to the OS. */
  freeBytes: number;
  /** Roughly what the file becomes after a rebuild. */
  liveBytes: number;
  /** `freeBytes / fileBytes`, 0 when the file is empty. */
  freeRatio: number;
}

/** Non-negative integer or 0 — pragma values arrive from SQL and may be null. */
function safeCount(value: number | null | undefined): number {
  return Number.isFinite(value) && (value as number) > 0 ? Math.floor(value as number) : 0;
}

/**
 * What a VACUUM would reclaim, from the three occupancy pragmas.
 *
 * `freelistCount` is clamped to `pageCount`: the two are read as separate
 * pragmas, so a write landing between them can briefly make the free count the
 * larger of the two, and an unclamped subtraction would report a negative live
 * size to the UI.
 */
export function compactionEstimate(stats: DatabasePageStats): CompactionEstimate {
  const pageSize = safeCount(stats.pageSize);
  const pageCount = safeCount(stats.pageCount);
  const freePages = Math.min(safeCount(stats.freelistCount), pageCount);

  const fileBytes = pageSize * pageCount;
  const freeBytes = pageSize * freePages;

  return {
    fileBytes,
    freeBytes,
    liveBytes: fileBytes - freeBytes,
    freeRatio: fileBytes > 0 ? freeBytes / fileBytes : 0,
  };
}

export interface CompactionThresholds {
  /** Share of the file that must be free before a rebuild is worth its cost. */
  minFreeRatio?: number;
  /** Absolute floor, so a tiny DB that is 90% holes doesn't nag. */
  minFreeBytes?: number;
}

/**
 * Whether a rebuild would earn its keep.
 *
 * A VACUUM is minutes of full-file rewrite through SQLCipher and an exclusive
 * lock for the duration, so a few free pages are never worth it — SQLite will
 * reuse those itself on the next writes. Both conditions must hold: the ratio
 * alone would flag a 20 MB database, and the absolute size alone would flag a
 * healthy 40 GB one.
 */
export function isCompactionWorthwhile(
  estimate: CompactionEstimate,
  thresholds: CompactionThresholds = {},
): boolean {
  const { minFreeRatio = 0.25, minFreeBytes = 100 * 1024 * 1024 } = thresholds;
  return estimate.freeRatio >= minFreeRatio && estimate.freeBytes >= minFreeBytes;
}

/**
 * Whether the disk can hold the rebuild.
 *
 * VACUUM writes a COMPLETE second copy of the database and only swaps it in at
 * the end, so the peak requirement is the current file size again — not the
 * post-compaction size. Running out midway leaves the original intact but wastes
 * the whole run, so this is checked up front rather than discovered.
 *
 * @param marginRatio headroom multiplier over the file size; the default leaves
 *   20% so the rebuild isn't racing every other write on the volume to the last
 *   free byte.
 */
export function hasCompactionHeadroom(
  fileBytes: number,
  freeDiskBytes: number,
  marginRatio = 1.2,
): boolean {
  const needed = safeCount(fileBytes) * marginRatio;
  return safeCount(freeDiskBytes) >= needed;
}
