/**
 * How far the thread repair has ALREADY looked — persisted, per account.
 *
 * `repairThreading` accepts a `sinceCreatedAt` bound so a re-run only reconsiders
 * mail stored since the last pass (the resolver only ever JOINS, so an older row's
 * answer can change only when a NEWER row arrives to join it to — and that newer
 * row is itself inside the window). Both callers already used that bound, but each
 * kept its "when did we last look" marker in PROCESS memory, so every launch
 * started from scratch and paid a full-mailbox pass. Measured on a 26k mailbox:
 * `Post-backfill thread repair: 0 email(s) retargeted, 9943→9943 threads, 1 iter,
 * 26528ms` — repeated on each of five launches, 71.9% of main-thread JS while it
 * ran, to retarget nothing. Two callers meant TWO such passes per launch.
 *
 * Persisting the marker makes the full pass what its comments always claimed:
 * once per mailbox per resolver-logic version. The version is part of the KEY, so
 * bumping {@link THREADING_REPAIR_VERSION} expires every account's watermark and
 * the next launch does one full re-thread — no separate reset step to forget.
 */
import { getMeta, setMeta } from './core-db';

// Bump when the thread-resolver logic changes so existing mail is re-threaded once.
// v3: owner-aware same-subject overlap (self excluded → a mail sharing one real
// correspondent still merges).
export const THREADING_REPAIR_VERSION = 3;

/**
 * How far BEFORE the previous pass began the next one starts looking. That pass
 * read rows while sync was still inserting, so a row stored mid-pass may have been
 * examined before its parent arrived; re-examining a slice of overlap is cheap and
 * closes the race. Seconds — `created_at` is `unixepoch()`.
 */
export const INCREMENTAL_OVERLAP_SEC = 15 * 60;

const KEY_PREFIX = `threading-repair-scanned-through:v${THREADING_REPAIR_VERSION}:`;

/**
 * `sinceCreatedAt` for this account's next pass, or `undefined` for a FULL pass
 * because no pass has ever completed under the current resolver version.
 *
 * A stored value that isn't a usable timestamp (corrupt row, hand-edited meta)
 * degrades to `undefined` — a redundant full pass is slow but correct, whereas
 * trusting garbage could silently skip mail forever.
 */
export function threadRepairWindowStart(accountId: string): number | undefined {
  const raw = getMeta(KEY_PREFIX + accountId);
  if (!raw) return undefined;
  const scannedThrough = Number(raw);
  if (!Number.isFinite(scannedThrough) || scannedThrough <= 0) return undefined;
  return Math.max(0, Math.floor(scannedThrough) - INCREMENTAL_OVERLAP_SEC);
}

/**
 * Record that a pass which STARTED at `startedAtMs` completed successfully. The
 * start time, not the finish time: rows inserted while the pass was running may
 * not have been seen by it, so the next window must still include them.
 *
 * Only ever moves forward — an out-of-order or clock-skewed report cannot rewind
 * the watermark and re-trigger the whole-mailbox pass it exists to prevent.
 */
export function recordThreadRepairPass(accountId: string, startedAtMs: number): void {
  const startedAtSec = Math.floor(startedAtMs / 1000);
  if (!Number.isFinite(startedAtSec) || startedAtSec <= 0) return;
  const key = KEY_PREFIX + accountId;
  const previous = Number(getMeta(key));
  if (Number.isFinite(previous) && previous >= startedAtSec) return;
  setMeta(key, String(startedAtSec));
}
