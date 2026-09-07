/**
 * Body Prefetch Scheduler (main process)
 *
 * Drains the backlog of emails that have headers synced but no body
 * downloaded yet, so the AI categorization, conversation extraction,
 * contact enrichment, and agent scoring pipelines have real content
 * to work on instead of queuing up metadata-only rows forever.
 *
 * Scope is thread-driven, not unread-only. The user-facing intent is
 * "the latest N threads should be fully downloaded": that means every
 * email in those threads (read or unread, older or newer) needs its
 * body. Seed-by-newest pulls down whatever's freshest, and the
 * sibling-expansion drags in the rest of each thread so conversation
 * Phase 1 / 2 don't have to fall back to DOM cleaning forever on a
 * pre-existing thread the user opens later. Trash/Spam/Junk are still
 * excluded — no point fetching deleted mail.
 *
 * Pacing:
 *   - First tick:  20 s after app start (let initial sync settle)
 *   - Steady tick: 60 s when there's a backlog
 *   - Idle tick:  10 min when the queue drained on the previous tick
 *   - Per tick:   up to TOTAL_CAP_PER_TICK bodies (sized so an inbox
 *                 with a few thousand pending bodies drains in tens of
 *                 minutes, not hours)
 *
 * One tick in flight at a time. If the previous tick is still running
 * when the timer fires, we skip — the existing run will continue.
 */

import { getEventBus, fetchBodyQueued, createLogger } from '@sarvinbox/core';

import { getStorage, getSyncEngine, getMainWindow, getAllAccountRuntimes } from '../shared';

import { isConnectionRecentlyUnstable } from './connection-health';
const logger = createLogger('body-prefetch-scheduler');

// Per-body deadline lives in `fetchBodyQueued` (core): a queue-wait window, then
// a tight run window once the engine actually starts the FETCH. A flat timeout
// measured from enqueue is what made a whole sub-batch expire while the first
// few downloaded — the tick then reported "0 fetched, N retry later" and asked
// for the very same rows again.
const FIRST_DELAY_MS = 20_000;
// Wall-clock ceiling on ONE account's tick. Bodies are issued in sub-batches and
// each can sit out its full deadline on a stalled server, so without this a
// single account could hold the tick for tens of minutes — long past the point
// where the cadence logic should have backed off and moved on. Whatever is left
// is not silently dropped: it's logged and picked up by the next tick.
const TICK_BUDGET_MS = 5 * 60_000;
export const ACTIVE_INTERVAL_MS = 60_000;
export const IDLE_INTERVAL_MS = 10 * 60_000;
// A "starved" tick is one that HAD bodies to fetch but downloaded none because
// every fetch timed out / re-queued — the operation-layer signature of a server
// that's throttling FETCH throughput (Gmail does this to a big mailbox after
// connection churn, independent of the connect-level cap). Re-firing a full
// burst every flat ACTIVE_INTERVAL into that throttle just prolongs it (the same
// mistake the connect-timeout ladder fixes at the connect layer). So consecutive
// starved ticks back off 2m -> 4m -> 8m, capped at the idle interval, and snap
// straight back to the active cadence the moment one body downloads again.
export const STARVED_BACKOFF_CAP_MS = IDLE_INTERVAL_MS;
// Seed = newest emails (any read state) missing a body. Each tick we
// also expand to ALL siblings in the seeds' threads so conversation
// extraction sees the complete thread — a thread with 1 fresh unread
// + 4 older read messages should get all 5 bodies fetched, not just
// the unread one. Total cap per tick keeps IMAP load bounded.
const SEED_PER_TICK = 80;            // newest pending bodies
const TOTAL_CAP_PER_TICK = 200;      // seeds + thread siblings combined
const SIBLING_FETCH_LIMIT = 400;     // sibling SELECT row cap (DB side)

// Give-up guard. An email whose body can NEVER be fetched — a ghost row whose
// server UID was expunged ("No message found for UID N") — would otherwise be
// re-seeded every tick forever (0/N fetched, backlog never drains, IMAP
// connections churned each minute). After this many consecutive failed attempts
// we tag it `|nobody|` (persisted) so the backlog queries stop returning it.
const MAX_BODY_FETCH_ATTEMPTS = 3;
// How often a retired (`|nobody|`) row gets another chance while the app keeps
// running. The tag was only ever cleared at STARTUP, so on a machine that never
// restarts — the normal case for a mail client — a row retired on a bad
// afternoon stayed excluded from every backlog query for days. Re-clearing only
// when the backlog is DRAINED means the retry costs nothing we'd otherwise spend
// and can't slow a real backlog down.
export const RETIRED_RECHECK_MS = 6 * 60 * 60_000;
// strikeKey(account, emailId) -> consecutive VERDICTS. Cleared on success; entry
// removed once the email is given up (the persisted tag then keeps it out of the
// seed).
const bodyFetchFailures = new Map<string, number>();

/**
 * Strikes are per ACCOUNT, not per email id. Email ids are derived from the
 * message (see the Message-ID keying fix), so the SAME id legitimately exists in
 * two accounts that both received the message. Keying on the id alone let one
 * account's verdicts count toward the other's give-up threshold — and then tag a
 * perfectly fetchable email `|nobody|` in the account that never failed.
 */
const strikeKey = (account: string, emailId: string): string => `${account}\u0000${emailId}`;

/**
 * Why one body-fetch attempt ended. The distinction is load-bearing: only
 * `unavailable` is evidence about the MESSAGE (the engine reached a verdict), so
 * only it may accrue a strike toward the permanent `|nobody|` tag. `transient`
 * means we never learned anything — a connection blip, a rate-limit backoff, an
 * auth pause or our own timeout while the engine still holds the item queued.
 */
type FetchStatus = 'fetched' | 'already' | 'transient' | 'unavailable';

/**
 * What one account's prefetch tick actually did. `attempted` is how many bodies
 * we tried this tick, `downloaded` how many landed, `transient` how many neither
 * succeeded nor reached a verdict (timeout / re-queue / blip). The aggregate of
 * these across accounts drives the adaptive cadence in `computeNextTickDelay`.
 */
interface AccountTickOutcome {
  remaining: number;
  attempted: number;
  downloaded: number;
  transient: number;
}
const EMPTY_TICK: AccountTickOutcome = { remaining: 0, attempted: 0, downloaded: 0, transient: 0 };

/**
 * Where each account's seed window starts, keyed by the account's label.
 *
 * Seeds are newest-first, so a head that can't be downloaded (server throttling
 * FETCH, a message that always times out) pins the window: the same rows are
 * requested every tick and the thousands behind them are never attempted. This
 * is the "5/80 fetched, 75 retry later" tick repeating with an unmoving backlog.
 *
 * So a starved tick rotates the window forward and a productive one snaps it
 * back to 0 — newest mail stays the priority the moment anything downloads at
 * all, and a stuck head costs one window instead of the whole backlog.
 */
const seedOffsets = new Map<string, number>();

/**
 * Pure rotation decision, kept separate from the I/O so it can be tested
 * directly: how far into the backlog should this account's NEXT tick start?
 *
 * - downloaded something  -> back to the newest (0)
 * - starved (tried, got nothing) -> advance one window
 * - nothing to try at this offset -> wrap to the newest
 */
export function computeNextSeedOffset(input: {
  offset: number;
  attempted: number;
  downloaded: number;
}): number {
  const { offset, attempted, downloaded } = input;
  if (downloaded > 0) return 0;
  if (attempted === 0) return 0;
  return offset + SEED_PER_TICK;
}

/**
 * Pure cadence decision: given the outcome of the tick that just ran, how long
 * until the next one, and what the new starved-streak is. Kept pure (no timers,
 * no module state) so the back-off ladder is unit-testable in isolation.
 *
 * - drained (all accounts empty)      -> long idle sleep, streak reset
 * - progressed (a body downloaded)    -> active cadence, streak reset
 * - starved (had work, got nothing)   -> escalate 2m/4m/8m…, capped
 * - no work but not drained           -> active cadence, streak reset
 *   (nothing connected yet, or every account skipped as churning — not a
 *    throttle, so don't penalise it)
 */
export function computeNextTickDelay(input: {
  drained: boolean;
  starved: boolean;
  starvedStreak: number;
}): { delayMs: number; starvedStreak: number } {
  const { drained, starved, starvedStreak } = input;
  if (drained) return { delayMs: IDLE_INTERVAL_MS, starvedStreak: 0 };
  if (!starved) return { delayMs: ACTIVE_INTERVAL_MS, starvedStreak: 0 };
  const nextStreak = starvedStreak + 1;
  const delayMs = Math.min(ACTIVE_INTERVAL_MS * 2 ** nextStreak, STARVED_BACKOFF_CAP_MS);
  return { delayMs, starvedStreak: nextStreak };
}

let timer: NodeJS.Timeout | null = null;
// Consecutive starved ticks (had work, downloaded nothing). Drives the fetch-
// layer back-off ladder; reset the moment a tick drains or makes progress.
let starvedStreak = 0;
let inFlight = false;
let unsubscribeEvents: (() => void) | null = null;
// Set by stop(): a tick that was in flight when stop() ran must not re-arm
// itself from its finally block (it would loop forever against closed
// storage after shutdown).
let stopped = false;
// Timestamp (ms) until which background prefetch pauses. Set when the user is
// actively fetching a body (opening an email) so their download gets IMAP
// connection priority instead of racing the background backlog.
let deferUntil = 0;

/**
 * Start the prefetch loop. Idempotent — calling twice is a no-op.
 * Called from main.ts once IMAP storage + sync are wired up.
 */
export function startBodyPrefetchScheduler(): void {
  if (timer) return;
  stopped = false;
  starvedStreak = 0;
  seedOffsets.clear();   // a fresh session starts at the newest mail
  logger.info('[BodyPrefetch] Starting (first tick in 20s)');
  // Give every `|nobody|` row one more chance this session. That marker is a
  // cached verdict, and a verdict reached while the connection was flapping is
  // wrong — this is what un-sticks mail whose body "never downloads".
  clearUnfetchableMarkers();
  timer = setTimeout(runTick, FIRST_DELAY_MS);

  // Wake on every new email synced — IDLE pushes during a running
  // session land here so we don't sit on the 10-min idle interval
  // waiting to fetch their bodies. Idempotent against the timer-based
  // tick (kick is a no-op while a tick is in flight).
  try {
    const eventBus = getEventBus();
    unsubscribeEvents = eventBus.on('email:synced' as any, (event: any) => {
      if (!event?.isNew) return;
      kickBodyPrefetchScheduler();
    });
  } catch (err) {
    logger.warn('[BodyPrefetch] Could not subscribe to email:synced:', err);
  }
}

/**
 * Stop the loop. Called on app shutdown.
 */
export function stopBodyPrefetchScheduler(): void {
  stopped = true;
  if (timer) {
    clearTimeout(timer);
    timer = null;
    logger.info('[BodyPrefetch] Stopped');
  }
  if (unsubscribeEvents) {
    try { unsubscribeEvents(); } catch { /* ignore */ }
    unsubscribeEvents = null;
  }
}

/**
 * Wake the scheduler immediately. Use after IMAP sync settles, after
 * IDLE delivers a new email, or after reconnection — anywhere we know
 * the backlog likely just changed. Without this, freshly-arrived
 * emails could wait up to the full IDLE_INTERVAL_MS (10 min) for the
 * next tick, which is exactly the symptom of "downloads stop until I
 * restart" — restart triggers the renderer-side one-shot, but during
 * a running session the timer-only scheduler can sit on a stale
 * idle-interval long enough to look frozen.
 *
 * No-op if a tick is already in flight (it'll see the new work) or
 * the scheduler hasn't started yet.
 */
export function kickBodyPrefetchScheduler(opts?: { resetBackoff?: boolean }): void {
  if (!timer || inFlight) return;
  if (opts?.resetBackoff) {
    // A reconnect (or other genuine recovery): the throttle condition may have
    // cleared, so drop the fetch-layer back-off and retry promptly — this is
    // what makes downloads resume "the moment the link returns". The seed
    // rotation goes with it: a head that only looked un-fetchable because the
    // socket was sick deserves the newest-first window again.
    starvedStreak = 0;
    seedOffsets.clear();
  } else if (starvedStreak > 0) {
    // A plain new-mail / post-sync kick while backing off a throttled account:
    // ignore it. Pulling the timer forward on every IDLE-delivered new mail
    // would re-burst into the same throttle and defeat the back-off. The
    // already-scheduled tick still picks the mail up, just at the backed-off
    // cadence rather than immediately.
    return;
  }
  clearTimeout(timer);
  timer = setTimeout(runTick, 1_000);
}

/**
 * Pause background prefetch for `ms` so a user-initiated body fetch (opening
 * an email) gets IMAP connection priority. Called from the emails:fetchBody
 * IPC handler. An already in-flight tick finishes its current sub-batch;
 * subsequent ticks wait out the window.
 */
export function deferBodyPrefetch(ms = 15_000): void {
  deferUntil = Math.max(deferUntil, Date.now() + ms);
}

/**
 * Clear the persisted `|nobody|` markers for every connected account, and reset
 * the in-memory strike counters with them. Best-effort per account: an older
 * storage without `clearBodiesUnfetchable` is simply skipped.
 */
function clearUnfetchableMarkers(): void {
  bodyFetchFailures.clear();
  markersCleared = new WeakSet<object>();
  lastMarkerSweepAt = Date.now();
  const active = getStorage() as any;
  if (active) clearUnfetchableMarkersFor(active);
  for (const [, rt] of getAllAccountRuntimes()) {
    if (rt.storage) clearUnfetchableMarkersFor(rt.storage);
  }
}

/**
 * Storages whose `|nobody|` markers have already been cleared this session.
 * A WeakSet so a closed account DB can be collected.
 */
let markersCleared = new WeakSet<object>();

/** When the retired rows were last given another chance. */
let lastMarkerSweepAt = 0;

/**
 * Let every account's retired rows be re-tried again, at most every
 * RETIRED_RECHECK_MS and only once the backlog is drained. Returns true when the
 * sweep was armed (the clearing itself happens per account on the next tick).
 */
function maybeRearmMarkerSweep(drained: boolean, now: number): boolean {
  if (!drained || now - lastMarkerSweepAt < RETIRED_RECHECK_MS) return false;
  lastMarkerSweepAt = now;
  markersCleared = new WeakSet<object>();
  logger.info('[BodyPrefetch] backlog drained — giving previously un-fetchable bodies another chance');
  return true;
}

/**
 * Give one account's retired rows another chance — once per storage per session.
 *
 * Background accounts are registered AFTER the scheduler starts, so the
 * start-time sweep never saw them: whatever a previous session retired stayed
 * retired, and those bodies were excluded from every backlog query for the whole
 * run with nothing to put them back. Calling this as each account first appears
 * in a tick closes that hole. Best-effort: a storage without
 * `clearBodiesUnfetchable` is skipped, and a throwing one is retried next tick
 * (it is deliberately NOT recorded as cleared).
 */
function clearUnfetchableMarkersFor(store: any): void {
  if (!store || markersCleared.has(store)) return;
  try {
    const cleared = store.clearBodiesUnfetchable?.() ?? 0;
    markersCleared.add(store);
    if (cleared > 0) {
      logger.info(`[BodyPrefetch] cleared ${cleared} stale "un-fetchable" marker(s) — those bodies will be retried`);
    }
  } catch (e) {
    logger.warn('[BodyPrefetch] could not clear un-fetchable markers:', (e as Error).message);
  }
}

/**
 * Prefetch bodies for ONE account (its own storage + engine). Returns how many
 * body-less emails remain for that account (0 = drained). Shared by the ACTIVE
 * account AND every connected BACKGROUND account — background new mail is added
 * body-LESS by IDLE (fetchBody:false), so without this its body never lands and
 * it's never categorised/labelled. Uses the account's OWN engine → no extra
 * connections.
 */
async function prefetchAccountBodies(
  storage: any,
  syncEngine: any,
  label?: string,
  offset = 0,
): Promise<AccountTickOutcome> {
  const readSeeds = (from: number): string[] =>
    (storage.getSeedEmailIdsWithoutBody?.(SEED_PER_TICK, from) as string[] | undefined) ||
    (storage.getUnreadEmailIdsWithoutBody?.(SEED_PER_TICK) as string[] | undefined) ||
    [];

  let seedOffset = offset;
  let seedIds = readSeeds(seedOffset);
  // Rotated past the end of the backlog (it shrank, or we walked the whole way):
  // wrap instead of reporting an empty window, which the caller would read as
  // "this account is drained" and sleep on for the full idle interval.
  if (seedIds.length === 0 && seedOffset > 0) {
    seedOffset = 0;
    seedIds = readSeeds(0);
  }
  if (seedIds.length === 0) return EMPTY_TICK;

  const siblingIds: string[] = storage.getThreadSiblingsWithoutBody?.(seedIds, SIBLING_FETCH_LIMIT) || [];
  const ids = [...seedIds, ...siblingIds].slice(0, TOTAL_CAP_PER_TICK);
  logger.info(
    `[BodyPrefetch] Tick: ${seedIds.length} seeds${seedOffset > 0 ? ` (from #${seedOffset} — head is stuck)` : ''}`
    + ` + ${siblingIds.length} thread siblings → fetching ${ids.length} bodies`,
  );

  const mainWindow = getMainWindow();
  let downloaded = 0;
  let transient = 0;
  let attempted = 0;
  const SUB_BATCH = 10;
  const deadline = Date.now() + TICK_BUDGET_MS;
  for (let i = 0; i < ids.length; i += SUB_BATCH) {
    if (Date.now() >= deadline) {
      // Say what we dropped. A tick that quietly stops halfway reads as
      // "attempted everything, got little" and hides the stall it's reacting to.
      logger.warn(
        `[BodyPrefetch] ${label ?? 'account'}: tick budget (${TICK_BUDGET_MS / 60000}m) spent after `
        + `${attempted}/${ids.length} bodies — leaving ${ids.length - attempted} for the next tick`,
      );
      break;
    }
    const slice = ids.slice(i, i + SUB_BATCH);
    attempted += slice.length;
    const results = await Promise.allSettled(slice.map(async (emailId): Promise<{ id: string; status: FetchStatus }> => {
      try {
        const email = await storage.getEmail(emailId);
        // A row we can't even read, or one whose folder no longer exists, is not
        // evidence that the SERVER lost the message — don't let it accrue strikes.
        if (!email) return { id: emailId, status: 'transient' };
        if (email.rawBody) return { id: emailId, status: 'already' };
        const folder = await storage.getFolder(email.folderId);
        if (!folder) return { id: emailId, status: 'transient' };
        // A row can have NO uid — it was relinked to a new folder (e.g. a Gmail
        // category-label move) and never re-synced there, so its uid was cleared.
        // Do NOT skip it (the old `|| !email.uid` guard re-seeded these ghosts
        // every tick forever → 0/N fetched, backlog frozen). Pass 0; fetchBody
        // re-resolves a missing/stale uid from the message-id and repairs the row.
        // A row with neither uid NOR message-id resolves to null below (a real
        // "unavailable" verdict), so it still can't loop.
        // Queue-aware deadline: the clock that matters starts when the engine
        // dequeues this item, not when we asked. See `fetchBodyQueued`.
        const fetchResult: any = await fetchBodyQueued(syncEngine, emailId, folder.path, email.uid ?? 0);
        // RESOLVED null = the engine reached a verdict ("no message for this UID",
        // unselectable folder, engine-side retries exhausted). That is the only
        // outcome that counts as evidence the body is really unavailable.
        if (!fetchResult) return { id: emailId, status: 'unavailable' };
        const updated = { ...email, rawBody: fetchResult.rawBody, cleanBody: fetchResult.cleanBody, contentType: fetchResult.contentType };
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('body:fetched', updated);
        return { id: emailId, status: 'fetched' };
      } catch {
        // A THROW/TIMEOUT means we never got a verdict: on a connection error or
        // rate-limit the engine re-queues the item and leaves our promise pending
        // until this timeout fires, and an auth pause throws outright. Counting
        // those as strikes is what permanently tagged good mail `|nobody|` after
        // three connection blips — the body then never downloaded again.
        return { id: emailId, status: 'transient' };
      }
    }));
    const giveUp: string[] = [];
    for (const r of results) {
      if (r.status !== 'fulfilled') continue;
      const { id, status } = r.value;
      const key = strikeKey(label ?? 'account', id);
      if (status === 'unavailable') {
        // Only a verdict accrues a strike, so the give-up tag means what its
        // comment says: the server really has no message for this UID.
        const n = (bodyFetchFailures.get(key) ?? 0) + 1;
        if (n >= MAX_BODY_FETCH_ATTEMPTS) { bodyFetchFailures.delete(key); giveUp.push(id); }
        else bodyFetchFailures.set(key, n);
      } else if (status === 'transient') {
        transient++;   // retried next tick, strike count untouched
      } else {
        bodyFetchFailures.delete(key);
        if (status === 'fetched') downloaded++;
      }
    }
    if (giveUp.length > 0) {
      try { storage.markBodiesUnfetchable?.(giveUp); } catch (e) { logger.warn('[BodyPrefetch] markBodiesUnfetchable failed:', e); }
      logger.warn(`[BodyPrefetch] Gave up on ${giveUp.length} un-fetchable email(s) after ${MAX_BODY_FETCH_ATTEMPTS} attempts (likely expunged server UIDs): ${giveUp.slice(0, 5).join(', ')}${giveUp.length > 5 ? '…' : ''}`);
    }
  }

  const remaining = storage.countEmailsWithoutBody?.() ?? storage.countUnreadEmailsWithoutBody?.() ?? 0;
  // `remaining` is PER ACCOUNT (it queries this storage), so log which account it
  // came from: without it, alternating accounts look like one backlog bouncing
  // up and down (552 → 297 → 494 → …) and reads as "sync going backwards".
  // `retry later` separates "we learned nothing yet" from real failures.
  logger.info(
    `[BodyPrefetch] Tick complete${label ? ` [${label}]` : ''}: ${downloaded}/${attempted} bodies fetched`
    + `${transient > 0 ? `, ${transient} retry later` : ''}; ${remaining} emails still without body`,
  );
  // `nextSeedOffset` is decided here (not by the caller) because only this
  // function knows the window it actually read after any wrap.
  if (label) {
    seedOffsets.set(label, computeNextSeedOffset({ offset: seedOffset, attempted, downloaded }));
  }
  return { remaining, attempted, downloaded, transient };
}

async function runTick(): Promise<void> {
  if (stopped) return;
  if (inFlight) {
    // Previous run is still going — reschedule ourselves to check again
    // in a minute. Don't double-fetch.
    timer = setTimeout(runTick, ACTIVE_INTERVAL_MS);
    return;
  }
  // User is actively downloading a message — yield the connection pool and
  // re-check after the defer window instead of launching a background batch.
  const nowMs = Date.now();
  if (nowMs < deferUntil) {
    timer = setTimeout(runTick, deferUntil - nowMs + 250);
    return;
  }
  inFlight = true;
  let drained = false;
  // Aggregated across every account this tick — feeds the adaptive cadence.
  let totalAttempted = 0;
  let totalDownloaded = 0;
  let totalTransient = 0;

  try {
    // Prefetch bodies for the ACTIVE account AND every connected BACKGROUND
    // account. IDLE adds background new mail body-LESS (fetchBody:false); if we
    // only prefetched the active account, those bodies never landed → the mail
    // was never categorised/labelled (the whole "no Gmail label in background"
    // bug). Each account fetches from its OWN engine, so no extra connections.
    // `label` only ever reaches a log line — it's what tells one account's
    // backlog from another's in app.log.
    const targets: Array<{ storage: any; engine: any; label: string }> = [];
    const seen = new Set<any>();
    const active = getStorage() as any;
    const activeEngine = getSyncEngine();
    if (active && (activeEngine as any)?.isConnected?.()) { targets.push({ storage: active, engine: activeEngine, label: 'active' }); seen.add(active); }
    for (const [accountId, rt] of getAllAccountRuntimes()) {
      if (rt.storage && !seen.has(rt.storage) && (rt.syncEngine as any)?.isConnected?.()) {
        targets.push({ storage: rt.storage, engine: rt.syncEngine, label: accountId });
        seen.add(rt.storage);
      }
    }
    if (targets.length === 0) return; // nothing connected yet — retry later

    let allDrained = true;
    for (const t of targets) {
      try {
        // Back off a CHURNING connection: body prefetch runs many pooled FETCHes,
        // and hammering a socket the server keeps dropping wastes them (each poisons
        // a pooled connection) and can provoke the next drop. A one-off reconnect
        // isn't churn, so normal fetching is unaffected; the next tick resumes once
        // it settles. Treat as "not drained" so we come back promptly.
        if (isConnectionRecentlyUnstable(t.engine)) {
          allDrained = false;
          logger.info(`[BodyPrefetch] skipping ${t.label} — connection churning, letting it settle`);
          continue;
        }
        // First time we see this account this session, un-retire whatever a
        // previous run marked `|nobody|`. Background accounts connect long after
        // the start-time sweep, so this is the only thing that gives their
        // retired rows another chance.
        clearUnfetchableMarkersFor(t.storage);
        const outcome = await prefetchAccountBodies(t.storage, t.engine, t.label, seedOffsets.get(t.label) ?? 0);
        totalAttempted += outcome.attempted;
        totalDownloaded += outcome.downloaded;
        totalTransient += outcome.transient;
        if (outcome.remaining > 0) allDrained = false;
      } catch (e) {
        // One account's failure must never stop the others.
        logger.warn('[BodyPrefetch] account tick failed (isolated):', (e as Error).message);
        allDrained = false;
      }
    }
    drained = allDrained;
    // Drained means there is nothing left to fetch — the one moment when
    // re-trying rows we gave up on is free. Armed here; the actual clear happens
    // per account at the top of the next tick.
    maybeRearmMarkerSweep(drained, Date.now());
  } catch (err) {
    logger.error('[BodyPrefetch] Tick failed:', err);
  } finally {
    inFlight = false;
    // Reschedule — unless stop() ran while this tick was in flight.
    // Tighter cadence while there's work to do; long sleep when the queue is
    // empty; and back OFF when a connected account keeps timing out every fetch
    // (server-side throttle) instead of re-bursting into it every minute.
    if (!stopped) {
      const starved = totalAttempted > 0 && totalDownloaded === 0 && totalTransient > 0;
      const { delayMs, starvedStreak: nextStreak } = computeNextTickDelay({ drained, starved, starvedStreak });
      if (starved) {
        logger.warn(
          `[BodyPrefetch] all ${totalAttempted} fetch(es) timed out this tick (throttled) — `
          + `backing off ${Math.round(delayMs / 60000)}m before retrying (streak ${nextStreak})`,
        );
      }
      starvedStreak = nextStreak;
      timer = setTimeout(runTick, delayMs);
    }
  }
}
