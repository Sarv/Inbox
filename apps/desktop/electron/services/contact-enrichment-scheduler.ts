/**
 * Contact Enrichment Scheduler (main process)
 *
 * Owns the queue of contacts that need enrichment. Ticks periodically,
 * asks the storage layer for candidates, and hands the batch to the
 * renderer — which runs the LLM calls SERIALLY (one-by-one) per the
 * product requirement.
 *
 * Key design points:
 *   - Eligibility is data-driven: candidate rows have `enriched_through_email_at`
 *     older than the newest email from that sender. The 90-day cadence is
 *     checked against that watermark, NOT `Date.now()`.
 *   - Only one batch in flight at a time. We mark `batchInFlight = true`
 *     when we dispatch and flip it off when the renderer acks
 *     `report-batch-done`. A stale-lock timeout prevents a crashed
 *     renderer from starving the queue forever.
 *   - No daily cap — process every eligible contact. Pacing is done
 *     renderer-side (2s between LLM calls).
 */

import { getEventBus, createLogger } from '@sarvinbox/core';

import { getMainWindow, getStorage, getAllAccountRuntimes } from '../shared';
const logger = createLogger('contact-enrichment-scheduler');

const TICK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const INITIAL_DELAY_MS = 60_000;             // 1 minute after startup
const STALE_BATCH_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour — if the renderer never acks, unblock
const BATCH_SIZE = 50;                       // contacts per batch dispatch
const MIN_AGE_DAYS = 90;                     // re-enrich cadence (days since last watermark)
// Debounce for the new-mail trigger: a burst of arriving mail collapses into a
// single tick ~1 min later, so a brand-new sender gets enriched within a minute
// instead of waiting up to 6h — without firing a tick per message.
const NEW_MAIL_DEBOUNCE_MS = 60_000;

// Round-robin cursor over connected accounts — one account is served per tick
// (the single-batch-in-flight model), so this spreads enrichment across every
// account without spiking the LLM for all of them at once.
const FOLLOWUP_DELAY_MS = 3000; // after a batch acks, quickly serve the next account with work

let tickInterval: NodeJS.Timeout | null = null;
let initialTimer: NodeJS.Timeout | null = null;
let newMailTimer: NodeJS.Timeout | null = null;
let followupTimer: NodeJS.Timeout | null = null;
let unsubscribeEvents: (() => void) | null = null;
let batchInFlight = false;
let batchStartedAt = 0;
let accountCursor = 0;

export function startContactEnrichmentScheduler(): void {
  if (tickInterval) return;
  logger.info('[EnrichmentScheduler] Starting (6h interval + on new mail)');

  // Tracked so stop() can cancel it — otherwise the first tick fires
  // after storage close on a fast quit.
  initialTimer = setTimeout(() => {
    initialTimer = null;
    runTick().catch((e) => logger.error('[EnrichmentScheduler] tick error:', e));
  }, INITIAL_DELAY_MS);

  tickInterval = setInterval(() => {
    runTick().catch((e) => logger.error('[EnrichmentScheduler] tick error:', e));
  }, TICK_INTERVAL_MS);

  // Enrich new senders shortly after their first mail arrives, instead of
  // waiting for the 6h tick. Debounced (one tick per burst); the eligibility
  // is still gated by the 90-day cadence + automated-sender skips + the
  // single-batch-in-flight lock, so this can't hammer the LLM.
  try {
    const eventBus = getEventBus();
    const offSynced = eventBus.on('email:synced' as any, (event: any) => {
      if (!event?.isNew) return;
      scheduleNewMailTick();
    });
    // Also enrich the moment a body is FETCHED. Enrichment mines the signature,
    // which only exists once the body lands — and body-fetch is async AFTER
    // sync. Triggering on sync alone raced ahead of the body for a brand-new
    // contact (their first mail), found no signals, and bumped the watermark so
    // the contact was never enriched. body-ready fires when the signature is
    // actually present, so a new sender's card populates as soon as their first
    // mail is fetched. Debounced + cadence-gated, so it can't hammer the LLM.
    const offBodyReady = eventBus.on('email:body-ready' as any, () => {
      scheduleNewMailTick();
    });
    unsubscribeEvents = () => {
      try { offSynced(); } catch { /* ignore */ }
      try { offBodyReady(); } catch { /* ignore */ }
    };
  } catch (err) {
    logger.warn('[EnrichmentScheduler] Could not subscribe to email events:', err);
  }
}

/** Debounced tick request driven by incoming mail. */
function scheduleNewMailTick(): void {
  if (newMailTimer || batchInFlight) return;
  newMailTimer = setTimeout(() => {
    newMailTimer = null;
    runTick().catch((e) => logger.error('[EnrichmentScheduler] new-mail tick error:', e));
  }, NEW_MAIL_DEBOUNCE_MS);
}

export function stopContactEnrichmentScheduler(): void {
  if (initialTimer) {
    clearTimeout(initialTimer);
    initialTimer = null;
  }
  if (newMailTimer) {
    clearTimeout(newMailTimer);
    newMailTimer = null;
  }
  if (followupTimer) {
    clearTimeout(followupTimer);
    followupTimer = null;
  }
  if (unsubscribeEvents) {
    try { unsubscribeEvents(); } catch { /* ignore */ }
    unsubscribeEvents = null;
  }
  if (tickInterval) {
    clearInterval(tickInterval);
    tickInterval = null;
    logger.info('[EnrichmentScheduler] Stopped');
  }
}

/**
 * Force a tick right now — used by the "Run enrichment" IPC. Returns
 * how many candidates were queued (0 if a batch is already running).
 */
export async function triggerEnrichmentNow(): Promise<number> {
  return runTick(true);
}

/**
 * Renderer signals per-contact completion. We don't persist this; the
 * actual results went to the contact row via `contacts:applyEnrichment`.
 * Kept for logging / future telemetry.
 */
export function reportContactEnrichmentProgress(payload: {
  contactId: string;
  ok: boolean;
  reason?: string | null;
}): void {
  if (!payload.ok) {
    logger.info(`[EnrichmentScheduler] contact=${payload.contactId} skipped: ${payload.reason || 'unknown'}`);
  }
}

/**
 * Renderer signals that the batch is drained — unblock the scheduler
 * so the next tick can dispatch.
 */
export function reportBatchDone(): void {
  if (!batchInFlight) return;
  logger.info('[EnrichmentScheduler] batch done');
  releaseBatchLock();
  // Continue the rotation: serve the next account with pending work shortly.
  scheduleFollowupTick();
}

/** Release the single-batch-in-flight lock. One place so every path resets both fields. */
function releaseBatchLock(): void {
  batchInFlight = false;
  batchStartedAt = 0;
}

async function runTick(manual = false): Promise<number> {
  // Stale-lock guard: if the renderer died mid-batch we'd be stuck forever.
  if (batchInFlight && Date.now() - batchStartedAt > STALE_BATCH_TIMEOUT_MS) {
    logger.warn('[EnrichmentScheduler] stale batch lock cleared');
    releaseBatchLock();
  }
  if (batchInFlight) {
    if (manual) logger.info('[EnrichmentScheduler] tick skipped — batch in flight');
    return 0;
  }

  // Claim the lock synchronously BEFORE the first await. Otherwise two
  // overlapping ticks (a manual trigger racing the 6h interval) could both
  // pass the check above and both dispatch the same batch, double-enriching
  // every contact. Every early-return/error path below MUST release it; only
  // a successful dispatch keeps it held until the renderer acks (or the
  // stale-lock timeout fires).
  batchInFlight = true;
  batchStartedAt = Date.now();

  const mainWindow = getMainWindow();
  if (!mainWindow) {
    releaseBatchLock();
    return 0;
  }

  // Every connected account (round-robin). Fall back to the active account for
  // the pre-multi-account default slot. Each account's candidates are read from
  // its OWN storage and the batch is tagged with its accountId so the renderer
  // reads/writes that account, not the active one.
  const runtimes = getAllAccountRuntimes();
  const accounts: Array<{ id: string | null; storage: any }> =
    runtimes.length > 0
      ? runtimes.map(([id, rt]) => ({ id, storage: rt.storage }))
      : [{ id: null, storage: getStorage() }];

  // Starting at the rotating cursor, dispatch the FIRST account that has
  // candidates; advance the cursor past it so the next tick serves the next
  // account. One account per tick keeps the single-batch-in-flight invariant.
  for (let i = 0; i < accounts.length; i++) {
    const idx = (accountCursor + i) % accounts.length;
    const { id, storage } = accounts[idx];
    if (!storage) continue;
    let candidates: Array<{ id: string }>;
    try {
      candidates = await (storage as any).getContactEnrichmentCandidates({
        minAgeDays: MIN_AGE_DAYS,
        limit: BATCH_SIZE,
      });
    } catch (e) {
      logger.error(`[EnrichmentScheduler] list candidates failed (acct=${id ?? 'active'}):`, e);
      continue;
    }
    if (candidates.length === 0) continue;

    accountCursor = (idx + 1) % accounts.length;
    // Lock already held from the claim above; refresh the start time so the
    // stale-lock timeout measures from the actual dispatch, not the claim.
    batchStartedAt = Date.now();
    logger.info(`[EnrichmentScheduler] dispatching batch of ${candidates.length} contacts (acct=${id ?? 'active'})`);
    mainWindow.webContents.send('contact-enrichment:run-batch', {
      contactIds: candidates.map((c) => c.id),
      accountId: id ?? undefined,
    });
    return candidates.length;
  }

  // No account had eligible contacts — release and stop the rotation (a later
  // interval / new-mail tick restarts it).
  if (manual) logger.info('[EnrichmentScheduler] no eligible contacts on any account');
  releaseBatchLock();
  return 0;
}

/**
 * After a batch acks, quickly serve the NEXT account that has work so a 10-
 * account rotation drains in minutes, not 10 x 6h. Self-limiting: a follow-up
 * tick that finds no candidates dispatches nothing (no ack → no further
 * follow-up), so this converges to idle. Tracked so stop() can cancel it.
 */
function scheduleFollowupTick(): void {
  if (followupTimer) return;
  followupTimer = setTimeout(() => {
    followupTimer = null;
    runTick().catch((e) => logger.error('[EnrichmentScheduler] follow-up tick error:', e));
  }, FOLLOWUP_DELAY_MS);
  followupTimer.unref?.();
}
