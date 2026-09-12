/**
 * Historical Backfill Scheduler (main process) — Phase 2 of large-mailbox sync.
 *
 * After the recent window is synced live, this slowly downloads ALL OLDER mail
 * so full-mailbox search works, paging each folder DOWNWARD by UID one bounded
 * chunk at a time (see SyncEngine.backfillOlderChunk / FolderSyncer.backfillChunk).
 * It also runs the deferred whole-folder DELETION reconcile that the hot-path
 * sync skips on large mailboxes (Phase 1), now safe to run off the hot path.
 *
 * Design goals (all enforced here + in the engine):
 *   - NEVER blocks the event loop: header-only fetches, chunked+yielding inserts,
 *     one folder advanced per tick.
 *   - ALWAYS yields to live mail: the engine bails a chunk while a foreground sync
 *     is running, and inserts are `quiet` (no categorisation / no prefetch wake).
 *   - Resumes across restarts: progress is persisted per folder
 *     (folders.backfill_oldest_uid / backfill_complete).
 *
 * Pacing:
 *   - First tick:  30 s after start (let initial sync + body-prefetch settle)
 *   - Active tick: 15 s while any folder still has history to pull
 *   - Idle tick:   30 min once every folder's backfill is complete
 */

import { getStorage, getSyncEngine, getAllAccountRuntimes, getCurrentAccountId, sendToWindow } from '../shared';
import { buildStandardFolderAliasMap, createLogger, getEventBus, isTrashFolder, isSpamFolder, isAllMailSuperset, LARGE_MAILBOX_THRESHOLD } from '@sarvinbox/core';
import { maybeBackfillBulk } from './bulk-backfill';
import { isConnectionRecentlyUnstable } from './connection-health';
import { recordThreadRepairPass, threadRepairWindowStart } from './thread-repair-watermark';

const logger = createLogger('backfill-scheduler');

const FIRST_DELAY_MS = 30_000;
const IDLE_INTERVAL_MS = 30 * 60_000;
// How often to run the deferred FULL deletion reconcile for a large folder.
const DELETION_RECONCILE_MS = 15 * 60_000;

// Adaptive pacing. When the machine is quiet — no new mail and no foreground sync
// for IDLE_THRESHOLD_MS — backfill RACES: a short interval, many chunks per tick,
// sweeping every folder. The moment activity resumes it drops back to the gentle
// cadence so it never competes with live mail or the user. (The engine also bails
// any chunk while a foreground sync runs, so live sync always wins regardless.)
const IDLE_THRESHOLD_MS = 60_000;
const GENTLE_INTERVAL_MS = 15_000;
const GENTLE_CHUNKS_PER_TICK = 4;   // one folder advanced per tick
const FAST_INTERVAL_MS = 3_000;
const FAST_CHUNKS_PER_TICK = 24;    // sweep all folders, big chunks

let timer: NodeJS.Timeout | null = null;
let inFlight = false;
let stopped = false;
let unsubscribeEvents: (() => void) | null = null;
// Wall-clock of the last "activity" (new mail landing). Foreground sync is
// covered separately by the engine's per-chunk isSyncing() bail. Seeded to now at
// start so we don't sprint during the initial-sync settle window.
let lastActivityAt = 0;

// storage -> (folderPath -> last full-deletion-reconcile ms). WeakMap so a
// removed account's entry is GC'd with its storage; keyed per account so two
// accounts' "INBOX" don't share a throttle.
const lastDeletionReconcile = new WeakMap<object, Map<string, number>>();

// Post-backfill thread repair, tracked per account (WeakSet → GC'd with storage).
// `backfillObserved` marks accounts we saw with PENDING backfill this session;
// `threadRepaired` marks the ones whose one-time repair has already run. Together
// they fire the repair exactly ONCE, when an account transitions pending → done —
// i.e. on a fresh add / re-add whose full history just finished downloading, not
// on every launch of an already-archived account.
const backfillObserved = new WeakSet<object>();
const threadRepaired = new WeakSet<object>();
// Accounts whose Gmail label repair has already run this session. The repair is
// labels-only (no message re-download) but it walks the whole All Mail mailbox,
// so once per launch is the right cadence: new mail gets its labels from the
// normal fetch, and only pre-existing rows need the sweep.
const gmailLabelsRepaired = new WeakSet<object>();

// Per-account (by storage) set of folder paths whose MISSING-message drain is fully
// caught up this session — so caught-up folders aren't re-scanned (a SEARCH ALL) every
// tick. A drained folder stays current via forward sync, so it's safe to skip until the
// next launch. NOT gated on the stored serverMessageCount (which can be stale/0);
// drainFolderChunk computes the real gap live and reports `done`.
const drainDoneByStorage = new WeakMap<object, Set<string>>();

/**
 * A fresh account backfills OLDER parents after their recent replies, so
 * conversations can fragment during download (a reply threaded standalone before
 * its parent landed). The cascade reattach at insert fixes most of it; this pass —
 * run once the whole history is local — collapses any residual (references-only /
 * subject-fallback cases that can only resolve once every message is present).
 * Deferred off the tick and isolated; logs its cost.
 *
 * Bounded by the PERSISTED repair watermark, so it is a full-table pass only until
 * one has ever completed. It used to be unbounded, and the `threadRepaired`
 * WeakSet that was supposed to make it once-per-account died with the process: on
 * an account whose history never finishes downloading, every launch saw the
 * pending→done transition again and paid another whole-mailbox walk (measured:
 * 26.5s, 0 emails retargeted).
 */
async function repairThreadsAfterBackfill(storage: any, accountId: string): Promise<void> {
  try {
    const t0 = Date.now();
    const sinceCreatedAt = threadRepairWindowStart(accountId);
    const result = await storage.repairThreading?.({ dryRun: false, sinceCreatedAt });
    recordThreadRepairPass(accountId, t0);
    if (result) {
      logger.info(
        `[Backfill] Post-backfill thread repair (${sinceCreatedAt === undefined ? 'full' : 'incremental'}): ` +
        `${result.emailsRetargeted} email(s) retargeted, ` +
        `${result.threadsBefore}→${result.threadsAfter} threads, ${result.iterations} iter, ${Date.now() - t0}ms`,
      );
    }
  } catch (e) {
    logger.warn(`[Backfill] Post-backfill thread repair failed (isolated): ${(e as Error).message}`);
  }
}

/** Start the backfill loop. Idempotent. Called from main.ts once sync is wired. */
export function startBackfillScheduler(): void {
  if (timer) return;
  stopped = false;
  lastActivityAt = Date.now(); // treat launch as recent activity — settle first
  logger.info('[Backfill] Starting (first tick in 30s)');
  timer = setTimeout(runTick, FIRST_DELAY_MS);

  // New mail landing = activity → drop out of fast mode so backfill yields to the
  // live-mail flow. (The engine's isSyncing() bail already stops mid-sync.)
  try {
    unsubscribeEvents = getEventBus().on('email:synced' as any, (event: any) => {
      if (event?.isNew) lastActivityAt = Date.now();
    });
  } catch (err) {
    logger.warn('[Backfill] Could not subscribe to email:synced:', err);
  }
}

/**
 * Wake the backfill loop NOW instead of waiting out its interval (up to 30 min
 * when idle). Call after a (re)connect so downloading RESUMES promptly the moment
 * the connection is back, rather than sitting on a stale idle timer — the "it just
 * stays stuck when the connection comes back" case. No-op if a tick is already in
 * flight (it will pick up the now-connected accounts) or the loop hasn't started.
 */
export function kickBackfillScheduler(): void {
  if (!timer || inFlight || stopped) return;
  clearTimeout(timer);
  timer = setTimeout(runTick, 1_000);
}

/** Stop the loop. Called on app shutdown. */
export function stopBackfillScheduler(): void {
  stopped = true;
  if (timer) {
    clearTimeout(timer);
    timer = null;
    logger.info('[Backfill] Stopped');
  }
  if (unsubscribeEvents) {
    try { unsubscribeEvents(); } catch { /* ignore */ }
    unsubscribeEvents = null;
  }
}

/** Trash/Spam hold deleted/junk mail — no point archiving them for search. */
function isExcludedFolder(folder: any): boolean {
  return isTrashFolder(folder) || isSpamFolder(folder);
}

/**
 * Drop mailboxes the server published twice (Sarv lists both `Sent` and
 * `Sent Mail` for one store). Backfilling an alias pages thousands of messages
 * that are already on disk under the canonical name, into a folder the sidebar
 * never shows — pure cost, and a second `backfill_complete` that never settles.
 */
function backfillableFolders(all: any[]): any[] {
  const aliases = buildStandardFolderAliasMap(all);
  return aliases.size === 0 ? all : all.filter((f) => !aliases.has(f.path));
}

/**
 * Advance one account's historical backfill by (at most) one folder this tick,
 * plus a throttled deletion reconcile for large folders. Returns the number of
 * folders still needing backfill for this account (0 = fully archived).
 */
async function backfillAccount(
  storage: any,
  engine: any,
  chunksPerTick: number,
  sweepAllFolders: boolean,
): Promise<{ remaining: number; inserted: number }> {
  const folders: any[] = backfillableFolders((await storage.getFolders?.()) ?? []);
  // Gmail-style accounts: an All-Mail superset means we only need to backfill that
  // one folder for complete search coverage (see isAllMailSuperset). Other
  // providers have disjoint folders → backfill them all.
  const superset = folders.find(isAllMailSuperset);
  const candidates = superset ? [superset] : folders;

  // Gmail only, once per session: give rows that were downloaded from the All
  // Mail superset BEFORE labels were fetched their real folder membership. Those
  // rows are tagged `|[Gmail]/All Mail|` and nothing else, so they sit on disk
  // while INBOX looks frozen. Labels-only, so it costs a fraction of a re-sync.
  // Fire-and-forget: it must never delay the history backfill below.
  if (superset && !gmailLabelsRepaired.has(storage)) {
    gmailLabelsRepaired.add(storage);
    void engine.repairGmailLabels?.(superset.path)
      ?.then((r: { scanned: number; updated: number } | null) => {
        if (r && r.updated > 0) {
          // The sidebar counts changed for folders we just filed mail into.
          sendToWindow('folders:updated', {});
        }
      })
      .catch(() => { /* isolated: logged inside the engine */ });
  }
  let drainDone = drainDoneByStorage.get(storage);
  if (!drainDone) { drainDone = new Set<string>(); drainDoneByStorage.set(storage, drainDone); }

  // 1) FAST DRAIN of MISSING messages, FIRST (before the downward backfill, whose
  // early-return could otherwise skip it). The server holds UIDs the DB lacks —
  // count-capped initial sync, mid-range holes the downward backfill can't fill, failed
  // inserts. Runs on the pool for any not-yet-caught-up folder REGARDLESS of
  // backfillComplete, computing the real gap live (drainFolderChunk) — NOT from the
  // stale stored serverMessageCount. A folder that reports `done` is marked so it isn't
  // re-scanned every tick (forward sync keeps it current afterward).
  let anyShort = false;
  // Count rows inserted this tick so the caller can nudge the renderer to refresh
  // the sidebar counts live. `recountPaths` = backfill-touched folders that need a
  // scoped recount (drainFolderChunk recomputes its own counts; backfill does not).
  let insertedTotal = 0;
  const recountPaths = new Set<string>();
  let touchedSuperset = false;
  const drainable = candidates
    .filter((f) => f.subscribed !== false && f.syncEnabled !== false && !isExcludedFolder(f) && !drainDone!.has(f.path))
    .sort((a, b) => (a.path === 'INBOX' ? -1 : b.path === 'INBOX' ? 1 : 0));
  for (const folder of drainable) {
    let progressedDrain = false;
    for (let c = 0; c < chunksPerTick; c++) {
      const r = await engine.drainFolderChunk?.(folder.path);
      if (!r) { anyShort = true; break; }                       // couldn't run; retry next tick
      insertedTotal += r.inserted ?? 0;                         // drain recomputes its own scoped counts
      if (r.done || r.remaining === 0) { drainDone.add(folder.path); break; } // caught up
      anyShort = true;
      progressedDrain = true;
    }
    if (progressedDrain && !sweepAllFolders) break; // gentle: one folder per tick
  }

  // 2) Downward historical backfill (older-than-oldest) for folders not yet fully paged.
  const pending = candidates
    .filter((f) => f.subscribed !== false && f.syncEnabled !== false && !isExcludedFolder(f) && !f.backfillComplete)
    // INBOX first (most valuable), then biggest folders (most history to recover).
    .sort((a, b) => {
      const ai = a.path === 'INBOX' ? 0 : 1;
      const bi = b.path === 'INBOX' ? 0 : 1;
      if (ai !== bi) return ai - bi;
      return (b.serverMessageCount ?? 0) - (a.serverMessageCount ?? 0);
    });
  for (const folder of pending) {
    let progressed = false;
    for (let c = 0; c < chunksPerTick; c++) {
      const r = await engine.backfillOlderChunk(folder.path);
      if (!r) break;   // couldn't run this folder this tick; try the next one
      if ((r.inserted ?? 0) > 0) {
        insertedTotal += r.inserted;
        recountPaths.add(folder.path);
        // Rows inserted into the All-Mail SUPERSET carry arbitrary INBOX/label
        // tags, so a recount scoped to the superset path alone leaves those label
        // folders under-counted. Mark for a full recount below in that case.
        if (isAllMailSuperset(folder)) touchedSuperset = true;
      }
      progressed = true;
      if (r.done) break;
    }
    // Gentle mode: one folder advanced per tick (fair round-robin, light load).
    if (progressed && !sweepAllFolders) break;
  }

  // 3) FULL reconcile (addition + whole-folder deletion) for LARGE folders, run
  // REGARDLESS of backfillComplete. On a large mailbox the hot-path syncFlags is
  // windowed (no mid-range fill, no deletion sweep), so this is the ONLY thing
  // that fills mid-range holes and detects server-side deletions of old mail.
  // It used to be called only inside the backfill loop above (folders with
  // !backfillComplete), so the moment downward paging finished it stopped forever
  // — stranding mid-range gaps (the "Gmail stuck at ~8.6k, never finishes") and
  // letting old-mail deletions go undetected. It's throttled per folder
  // (DELETION_RECONCILE_MS) and no-ops on small folders, so sweeping every
  // candidate here is cheap and self-limiting.
  for (const folder of candidates) {
    if (folder.subscribed === false || folder.syncEnabled === false || isExcludedFolder(folder)) continue;
    await maybeReconcileDeletions(storage, engine, folder);
  }

  // Backfill inserts rows WITHOUT recomputing folder counts (unlike drain), so an
  // unread backfilled message would leave the badge under-counted. Refresh once per
  // tick: a full recount when the All-Mail superset was touched (its rows carry
  // arbitrary label tags, so a scoped recount would miss those folders), else a
  // cheap recount scoped to just the touched folders.
  try {
    if (touchedSuperset) await storage.recalculateFolderCounts();
    else if (recountPaths.size > 0) await storage.recalculateFolderCounts([...recountPaths]);
  } catch { /* best-effort */ }

  // Stay active while ANYTHING is behind: history still paging (backfillComplete=false)
  // OR messages still missing (anyShort). Only back off to idle once fully caught up.
  const after: any[] = backfillableFolders((await storage.getFolders?.()) ?? []);
  const afterSuperset = after.find(isAllMailSuperset);
  const afterCandidates = afterSuperset ? [afterSuperset] : after;
  const stillPending = afterCandidates.filter((f) => f.subscribed !== false && f.syncEnabled !== false && !isExcludedFolder(f) && !f.backfillComplete).length;
  return { remaining: stillPending + (anyShort ? 1 : 0), inserted: insertedTotal };
}

/** Throttled deferred full deletion reconcile for LARGE folders only. */
async function maybeReconcileDeletions(storage: any, engine: any, folder: any): Promise<void> {
  if ((folder.serverMessageCount ?? 0) <= LARGE_MAILBOX_THRESHOLD) return; // small: hot path handles it
  let perFolder = lastDeletionReconcile.get(storage);
  if (!perFolder) { perFolder = new Map(); lastDeletionReconcile.set(storage, perFolder); }
  if (Date.now() - (perFolder.get(folder.path) ?? 0) < DELETION_RECONCILE_MS) return;
  perFolder.set(folder.path, Date.now());
  try {
    const r = await engine.reconcileFolderDeletionsFull(folder.path);
    if (r && r.deleted > 0) {
      logger.info(`[Backfill] Deletion reconcile ${folder.path}: ${r.deleted} removed, ${r.updated} flags updated`);
    }
  } catch (e) {
    logger.warn(`[Backfill] Deletion reconcile ${folder.path} failed (isolated): ${(e as Error).message}`);
  }
}

async function runTick(): Promise<void> {
  if (stopped) return;
  if (inFlight) {
    timer = setTimeout(runTick, GENTLE_INTERVAL_MS);
    return;
  }
  inFlight = true;
  let drained = true;
  // Quiet machine (no new mail for a while) → race; otherwise stay gentle.
  const idle = Date.now() - lastActivityAt > IDLE_THRESHOLD_MS;
  const chunksPerTick = idle ? FAST_CHUNKS_PER_TICK : GENTLE_CHUNKS_PER_TICK;

  try {
    // ACTIVE account + every connected BACKGROUND account, each on its OWN engine
    // (no extra connections) — same enumeration the body-prefetch scheduler uses.
    const targets: Array<{ storage: any; engine: any; accountId: string }> = [];
    const seen = new Set<any>();
    const active = getStorage() as any;
    const activeEngine = getSyncEngine() as any;
    if (active && activeEngine?.isConnected?.()) { targets.push({ storage: active, engine: activeEngine, accountId: getCurrentAccountId() || 'active' }); seen.add(active); }
    for (const [acctId, rt] of getAllAccountRuntimes()) {
      if (rt.storage && !seen.has(rt.storage) && (rt.syncEngine as any)?.isConnected?.()) {
        targets.push({ storage: rt.storage, engine: rt.syncEngine, accountId: acctId });
        seen.add(rt.storage);
      }
    }
    if (targets.length === 0) { drained = false; return; } // nothing connected yet — retry

    for (const t of targets) {
      try {
        // Back off a CHURNING connection: piling backfill onto a socket the server
        // keeps dropping wastes the work and can provoke the next drop. A one-off
        // reconnect doesn't count as churn, so normal resume is unaffected. The
        // connection self-heals and the next tick picks it up.
        if (isConnectionRecentlyUnstable(t.engine)) {
          drained = false; // still has work; just deferred until it settles
          logger.info(`[Backfill] skipping ${t.accountId} — connection churning, letting it settle`);
          continue;
        }
        // One-time bulk backfill (idempotent, self-throttled, fire-and-forget) so
        // pre-feature mail gets its List-Id/Unsubscribe/Precedence classification —
        // runs off this tick and never blocks the history backfill below.
        void maybeBackfillBulk(t.storage, t.engine, t.accountId);

        const { remaining, inserted } = await backfillAccount(t.storage, t.engine, chunksPerTick, idle);
        // Live sidebar counts: mail landed this tick (DB counts already refreshed
        // above), so nudge the renderer to reload folders. The renderer coalesces
        // this into one reload per flush window, so firing every tick is cheap.
        if (inserted > 0) sendToWindow('folders:updated', { accountId: t.accountId });
        if (remaining > 0) {
          drained = false;
          backfillObserved.add(t.storage); // this account still has history to pull
        } else if (backfillObserved.has(t.storage) && !threadRepaired.has(t.storage)) {
          // Pending → done transition: history just finished downloading. Repair
          // threading ONCE (deferred so it doesn't extend this tick), then never
          // again this session. Guarded on `backfillObserved` so an already-
          // archived account on launch (remaining 0 from the first tick) doesn't
          // repair on every start.
          threadRepaired.add(t.storage);
          const storage = t.storage;
          const accountId = t.accountId;
          setTimeout(() => { void repairThreadsAfterBackfill(storage, accountId); }, 0);
        }
      } catch (e) {
        // One account's failure must never stop the others.
        logger.warn(`[Backfill] account tick failed (isolated): ${(e as Error).message}`);
        drained = false;
      }
    }
  } catch (err) {
    logger.error('[Backfill] Tick failed:', err);
    drained = false;
  } finally {
    inFlight = false;
    if (!stopped) {
      // Fully archived → long sleep. Otherwise fast when idle, gentle when active.
      const next = drained ? IDLE_INTERVAL_MS : (idle ? FAST_INTERVAL_MS : GENTLE_INTERVAL_MS);
      timer = setTimeout(runTick, next);
    }
  }
}
