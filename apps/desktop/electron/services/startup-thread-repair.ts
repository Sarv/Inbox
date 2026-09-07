/**
 * One-time thread RE-THREAD after a resolver-logic upgrade (main process).
 *
 * repairThreading only runs on a fresh account's pending->done backfill transition
 * (see backfill-scheduler). So an ALREADY-ARCHIVED account never benefits when the
 * thread-resolver rules improve — its old fragmented conversations stay fragmented
 * (the reported "same email split into many threads, still same after the fix").
 *
 * This sweep fixes that: for each connected account whose history is fully
 * downloaded, if its stored threading-logic version is behind the current one, it
 * runs repairThreading ONCE and stamps the version — so the re-thread happens
 * exactly once per logic upgrade, never every launch. Kept OUT of the backfill
 * tick so it's independent of that scheduler's tested behavior.
 */

import { createLogger } from '@sarvinbox/core';

import { getStorage, getSyncEngine, getAllAccountRuntimes, getCurrentAccountId } from '../shared';
import { getMeta, setMeta } from './core-db';
import { resolveAccountEmail } from './accounts-registry';
import {
  THREADING_REPAIR_VERSION,
  recordThreadRepairPass,
  threadRepairWindowStart,
} from './thread-repair-watermark';

const logger = createLogger('thread-repair');

// Re-exported so callers (and the tests) keep one import site for the version.
export { THREADING_REPAIR_VERSION };
const KEY = 'threading-repair-version:';
const FIRST_DELAY_MS = 45_000;   // after initial sync + backfill settle
const RETRY_MS = 60_000;         // re-check accounts that weren't ready yet
// While an account's history is still downloading, RE-run the repair no more often
// than this so newly-backfilled (header-less) mail keeps converging without a heavy
// full pass every tick. The repair itself is async + event-loop-yielding, so this
// only bounds redundant work, not responsiveness.
const REPAIR_INTERVAL_MS = 10 * 60_000;

let timer: NodeJS.Timeout | null = null;
let stopped = false;
// Accounts FULLY handled this session: version stamped once backfill is complete.
// WeakSet → GC'd with storage. An account still downloading history is NOT added,
// so it's re-repaired (throttled) until complete.
const done = new WeakSet<object>();
// Last repair time per account storage — throttles the during-backfill re-runs.
const lastRepairAt = new WeakMap<object, number>();

/** True when every subscribed, non-Trash/Spam folder has finished its backfill. */
function allBackfilled(folders: any[]): boolean {
  return folders.every((f) => {
    if (f?.subscribed === false) return true;
    const p = (f?.path || '').toLowerCase();
    if (p.includes('trash') || p.includes('spam') || p.includes('junk')) return true;
    return f?.backfillComplete === true;
  });
}

async function handleAccount(storage: any, accountId: string): Promise<void> {
  // 1) Register the owner's own address FIRST so it's in effect for BOTH the
  // repair below and every subsequent insert-time thread resolution this session.
  try {
    const self = resolveAccountEmail(storage);
    if (self && typeof storage?.setSelfAddresses === 'function') storage.setSelfAddresses([self]);
  } catch { /* self is best-effort; the resolver falls back to owner-inclusive */ }

  const key = KEY + accountId;
  let stored = 0;
  try { stored = Number(getMeta(key) || '0'); } catch { done.add(storage); return; }
  if (stored >= THREADING_REPAIR_VERSION) { done.add(storage); return; } // already re-threaded
  if (typeof storage?.repairThreading !== 'function') { done.add(storage); return; }

  // Throttle RE-runs (the first run has no lastRepairAt → proceeds immediately).
  const now = Date.now();
  const last = lastRepairAt.get(storage) ?? 0;
  if (last > 0 && now - last < REPAIR_INTERVAL_MS) return;
  lastRepairAt.set(storage, now);

  // A full pass runs only until ONE has completed under the current resolver
  // version; after that every pass is windowed to the rows stored since the last
  // one. The resolver never SPLITS a thread, so an old row's answer can only
  // change when a NEW row arrives to join it to, and that new row is itself in
  // the window. The watermark is PERSISTED (see thread-repair-watermark): it used
  // to be this session's `lastRepairAt`, so a relaunch forgot it had ever looked
  // and walked all 26k rows again — a ~26s pass, retargeting nothing, on every
  // single launch.
  const sinceCreatedAt = threadRepairWindowStart(accountId);

  // ALWAYS run regardless of backfill state — repairThreading is idempotent and
  // only JOINS (never splits), so re-threading whatever is present now is safe. We
  // previously GATED the run on "backfill complete", which blocked it forever on a
  // still-draining folder (the reported "still 1 mail separate"). Instead we run
  // now (fixing the current state) and only STAMP the version once history is fully
  // local — so during a long multi-session backfill it keeps re-converging the
  // newly-downloaded (header-less) mail, then settles into "done" at the end.
  try {
    const t0 = Date.now();
    const r = await storage.repairThreading({ dryRun: false, sinceCreatedAt });
    // Stamped on SUCCESS only, and from the pass's start time, so a failure
    // leaves the window where it was rather than skipping the rows it missed.
    recordThreadRepairPass(accountId, t0);
    if (r) {
      const scope = sinceCreatedAt === undefined ? 'full' : 'incremental';
      logger.info(`[ThreadRepair] ${accountId}: ${scope}, ${r.emailsRetargeted} retargeted, ${r.threadsBefore}->${r.threadsAfter} threads, ${r.iterations} iter (${Date.now() - t0}ms)`);
    }
  } catch (e) {
    // Leave it OUT of `done` (and unstamped) and clear the throttle so it retries
    // promptly on the next tick rather than waiting out REPAIR_INTERVAL_MS.
    lastRepairAt.delete(storage);
    logger.warn(`[ThreadRepair] ${accountId} failed (will retry): ${(e as Error).message}`);
    return;
  }

  // Stamp + finish ONLY when the whole mailbox is local; otherwise re-run later so
  // mail that backfills after this pass still gets folded in. When backfill state
  // is unknown (no folder info), treat as complete so we don't loop forever.
  let complete = true;
  try {
    const folders: any[] = (await storage.getFolders?.()) ?? [];
    if (folders.length > 0) complete = allBackfilled(folders);
  } catch { /* unknown → treat as complete */ }
  if (complete) {
    setMeta(key, String(THREADING_REPAIR_VERSION));
    done.add(storage);
  }
}

function tick(): void {
  if (stopped) return;
  try {
    const seen = new Set<object>();
    const targets: Array<{ storage: any; accountId: string }> = [];
    const active = getStorage() as any;
    const activeEngine = getSyncEngine() as any;
    if (active && activeEngine?.isConnected?.() && !done.has(active)) {
      targets.push({ storage: active, accountId: getCurrentAccountId() || 'active' });
      seen.add(active);
    }
    for (const [acctId, rt] of getAllAccountRuntimes()) {
      if (rt.storage && !seen.has(rt.storage) && (rt.syncEngine as any)?.isConnected?.() && !done.has(rt.storage)) {
        targets.push({ storage: rt.storage, accountId: acctId });
        seen.add(rt.storage);
      }
    }
    for (const t of targets) void handleAccount(t.storage, t.accountId);
  } catch (e) {
    logger.warn(`[ThreadRepair] tick failed (isolated): ${(e as Error).message}`);
  } finally {
    if (!stopped) timer = setTimeout(tick, RETRY_MS);
  }
}

/** Start the one-time re-thread sweep. Idempotent. */
export function startStartupThreadRepair(): void {
  if (timer) return;
  stopped = false;
  timer = setTimeout(tick, FIRST_DELAY_MS);
}

/** Stop the sweep (app shutdown). */
export function stopStartupThreadRepair(): void {
  stopped = true;
  if (timer) { clearTimeout(timer); timer = null; }
}
