/**
 * Auth-header backfill (main process).
 *
 * Every message synced before the client kept `Authentication-Results` has
 * `auth_status = NULL`, so its shield reads "Unverified" no matter what the
 * receiving server actually recorded. On the reporting mailbox that was 5,768
 * of 5,872 messages — the whole history, grey. This walks that backlog and
 * re-reads JUST the authentication headers for each message: a few hundred
 * bytes, no body, ~200 messages per IMAP round-trip. A 6,000-message mailbox
 * finishes in a couple of minutes on a healthy connection.
 *
 * Rules it borrows from the body-prefetch scheduler, for the same reasons:
 *   - one tick in flight; a fire while running is a no-op,
 *   - every connected account, each on its own pool connection,
 *   - skip a connection that is churning rather than pile on,
 *   - stop() prevents any further tick, including a re-arm from a tick that
 *     was mid-flight.
 *
 * What it deliberately does NOT do: retry a message the server returned with
 * no authentication header. That is a real, final answer ("nothing recorded"),
 * stored as an all-unknown verdict so the row leaves the backlog and the
 * shield says Unverified for the right reason. NULL therefore means exactly
 * "not checked yet", and the progress line can be honest.
 */

import { createLogger, parseAuthenticationHeaders } from '@sarvinbox/core';

import { getStorage, getSyncEngine, getMainWindow, getAllAccountRuntimes } from '../shared';

import { isConnectionRecentlyUnstable } from './connection-health';

const logger = createLogger('auth-header-backfill');

/** Let initial sync and the body prefetch's first tick settle first. */
export const FIRST_DELAY_MS = 45_000;
/** Gap between batches while there is a backlog — enough to interleave with user fetches. */
export const ACTIVE_INTERVAL_MS = 1_500;
/** Sleep once everything has a verdict; new mail gets its verdict at sync, not here. */
export const IDLE_INTERVAL_MS = 30 * 60_000;
/** UIDs per FETCH. One round-trip; well under the 500 the flag sync uses. */
export const BATCH_SIZE = 200;
/** Folders per tick per account, so one huge Archive cannot starve INBOX. */
const FOLDERS_PER_TICK = 3;

export interface AuthBackfillState {
  remaining: number;
  done: number;
  running: boolean;
  drained: boolean;
}

let timer: NodeJS.Timeout | null = null;
let inFlight = false;
let stopped = false;
let doneThisSession = 0;
let lastRemaining = 0;
let lastDrained = false;

/**
 * Group a backlog slice into per-folder UID lists — one FETCH per folder.
 * Pure, so the batching is testable without a socket.
 */
export function groupByFolder(
  rows: Array<{ id: string; uid: number; folderPath: string }>,
): Map<string, Array<{ id: string; uid: number }>> {
  const byFolder = new Map<string, Array<{ id: string; uid: number }>>();
  for (const r of rows) {
    const list = byFolder.get(r.folderPath) ?? [];
    list.push({ id: r.id, uid: r.uid });
    byFolder.set(r.folderPath, list);
  }
  return byFolder;
}

/**
 * Turn one folder's fetch result into rows to write.
 *
 * A uid ABSENT from `fetched` was not returned by the server this time
 * (connection trouble, or the message was expunged) — it stays NULL and is
 * retried on a later tick. A uid PRESENT with `undefined` is a real answer:
 * the server recorded no authentication header, stored as an all-unknown
 * verdict so the row leaves the backlog. Pure, for the same reason.
 */
export function verdictRows(
  wanted: Array<{ id: string; uid: number }>,
  fetched: ReadonlyMap<number, string | undefined>,
): Array<{ id: string; authStatus: string }> {
  const out: Array<{ id: string; authStatus: string }> = [];
  for (const w of wanted) {
    if (!fetched.has(w.uid)) continue;
    out.push({ id: w.id, authStatus: JSON.stringify(parseAuthenticationHeaders(fetched.get(w.uid))) });
  }
  return out;
}

export function getAuthBackfillState(): AuthBackfillState {
  return { remaining: lastRemaining, done: doneThisSession, running: inFlight, drained: lastDrained };
}

function emitProgress(): void {
  const win = getMainWindow();
  if (win && !win.isDestroyed()) win.webContents.send('auth-backfill:progress', getAuthBackfillState());
}

/** Start the loop. Idempotent. Called from main.ts once storage + sync are wired. */
export function startAuthHeaderBackfill(): void {
  if (timer) return;
  stopped = false;
  timer = setTimeout(runTick, FIRST_DELAY_MS);
  logger.info(`[AuthBackfill] scheduled: first tick in ${FIRST_DELAY_MS / 1000}s`);
}

export function stopAuthHeaderBackfill(): void {
  stopped = true;
  if (timer) {
    clearTimeout(timer);
    timer = null;
    logger.info('[AuthBackfill] stopped');
  }
}

/** Pull the next tick forward — the Security page's "Run now". No-op mid-tick. */
export function kickAuthHeaderBackfill(): void {
  if (!timer || inFlight) return;
  clearTimeout(timer);
  timer = setTimeout(runTick, 250);
}

interface Target { storage: any; engine: any; label: string }

function connectedTargets(): Target[] {
  const targets: Target[] = [];
  const seen = new Set<unknown>();
  const active = getStorage() as any;
  const activeEngine = getSyncEngine() as any;
  if (active && activeEngine?.isConnected?.()) { targets.push({ storage: active, engine: activeEngine, label: 'active' }); seen.add(active); }
  for (const [accountId, rt] of getAllAccountRuntimes()) {
    if (rt.storage && !seen.has(rt.storage) && (rt.syncEngine as any)?.isConnected?.()) {
      targets.push({ storage: rt.storage, engine: rt.syncEngine, label: accountId });
      seen.add(rt.storage);
    }
  }
  return targets;
}

/** One account's tick: a few folders' worth of the backlog. Returns rows written. */
async function backfillAccount(t: Target): Promise<{ written: number; remaining: number }> {
  const storage = t.storage;
  if (typeof storage.getEmailsMissingAuthStatus !== 'function' || typeof t.engine.fetchAuthHeaders !== 'function') {
    return { written: 0, remaining: 0 }; // older storage/engine — nothing to do here
  }
  const slice = storage.getEmailsMissingAuthStatus(BATCH_SIZE * FOLDERS_PER_TICK) as Array<{ id: string; uid: number; folderPath: string }>;
  if (slice.length === 0) return { written: 0, remaining: 0 };

  let written = 0;
  let folders = 0;
  for (const [folderPath, wanted] of groupByFolder(slice)) {
    if (folders >= FOLDERS_PER_TICK) break;
    folders += 1;
    for (let i = 0; i < wanted.length; i += BATCH_SIZE) {
      const chunk = wanted.slice(i, i + BATCH_SIZE);
      const fetched: Map<number, string | undefined> = await t.engine.fetchAuthHeaders(folderPath, chunk.map((w) => w.uid));
      const rows = verdictRows(chunk, fetched);
      if (rows.length) written += storage.updateEmailAuthStatusBatch(rows);
    }
  }
  const remaining = storage.countEmailsMissingAuthStatus() as number;
  return { written, remaining };
}

async function runTick(): Promise<void> {
  if (stopped) return;
  if (inFlight) { timer = setTimeout(runTick, ACTIVE_INTERVAL_MS); return; }
  inFlight = true;
  let remaining = 0;
  let written = 0;
  let sawWork = false;
  try {
    const targets = connectedTargets();
    if (targets.length === 0) {
      // Nothing connected YET is not "drained" — the backlog is still there,
      // we just cannot see it. Treating this as drained parked the loop on the
      // 30-minute idle sleep at cold start, so an account that connected ten
      // seconds later waited half an hour for its first verdict. Keep the
      // active cadence and re-check.
      remaining = lastRemaining;
      sawWork = true;
      return;
    }
    for (const t of targets) {
      try {
        if (isConnectionRecentlyUnstable(t.engine)) {
          // Pile-on avoidance: come back when the socket has settled. Count
          // the account as not drained so we return at the active cadence.
          sawWork = true;
          continue;
        }
        const r = await backfillAccount(t);
        written += r.written;
        remaining += r.remaining;
        if (r.remaining > 0) sawWork = true;
      } catch (e) {
        // One account's failure must never stop the others.
        logger.warn(`[AuthBackfill] ${t.label}: tick failed (isolated): ${(e as Error).message}`);
        sawWork = true;
      }
    }
  } catch (err) {
    logger.error('[AuthBackfill] tick failed:', err);
  } finally {
    inFlight = false;
    doneThisSession += written;
    lastRemaining = remaining;
    lastDrained = !sawWork && remaining === 0;
    if (written > 0 || lastDrained) {
      logger.info(`[AuthBackfill] wrote ${written} verdict(s); ${remaining} remaining${lastDrained ? ' — drained' : ''}`);
    }
    emitProgress();
    if (!stopped) timer = setTimeout(runTick, lastDrained ? IDLE_INTERVAL_MS : ACTIVE_INTERVAL_MS);
  }
}
