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
let rendererReady = false;
let rendererSession: string | undefined;
let rendererProviderRevision: string | undefined;
let batchSequence = 0;
let tickGeneration = 0;
let activeBatch: { batchId: string; accountId?: string; contactIds: string[] } | null = null;
const retryAfter = new Map<string, { until: number; reason?: string | null }>();
const failures = new Map<string, number>();
const RETRY_DELAY_MS = 15 * 60_000;

/** The renderer calls after installing its listener and whenever AI readiness changes. */
export function setEnrichmentRendererReady(ready: boolean, sessionId?: string, providerRevision?: string): void {
  if (sessionId && rendererSession !== sessionId) {
    releaseBatchLock();
    rendererSession = sessionId;
  }
  if (providerRevision && providerRevision !== rendererProviderRevision) {
    for (const [key, retry] of retryAfter) {
      if (retry.reason === 'llm_failed') { retryAfter.delete(key); failures.delete(key); }
    }
    rendererProviderRevision = providerRevision;
  }
  if (ready && !rendererReady) {
    for (const [key, retry] of retryAfter) {
      if (retry.reason === 'no_provider' || retry.reason === 'ai_disabled' || retry.reason === 'onboarding') retryAfter.delete(key);
    }
  }
  rendererReady = ready;
  if (!ready && !activeBatch) releaseBatchLock();
  if (ready) scheduleNewMailTick();
}

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
      // New signatures can unblock header-only contacts immediately; provider
      // failures retain their cooldown so body bursts cannot buy repeated calls.
      for (const [key, retry] of retryAfter) {
        if (retry.reason === 'awaiting_body' || retry.reason === 'no_inbound_mail') retryAfter.delete(key);
      }
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
  rendererReady = false;
  rendererSession = undefined;
  releaseBatchLock();
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
  batchId?: string;
}): void {
  if (payload.batchId && payload.batchId !== activeBatch?.batchId) return;
  const key = `${activeBatch?.accountId ?? ''}:${payload.contactId}`;
  if (payload.ok) failures.delete(key);
  if (activeBatch?.contactIds.includes(payload.contactId) && !payload.ok && !['no_signals', 'automated_sender', 'unchanged_signature'].includes(payload.reason ?? '')) {
    // Temporary failures must not advance a durable source watermark, but must
    // leave room for other candidates rather than immediately buying a retry.
    const attempts = payload.reason === 'llm_failed' ? (failures.get(key) ?? 0) + 1 : 1;
    if (payload.reason === 'llm_failed') failures.set(key, attempts);
    const delay = Math.min(24 * 60 * 60_000, RETRY_DELAY_MS * 4 ** Math.min(attempts - 1, 4));
    retryAfter.set(key, { until: Date.now() + delay, reason: payload.reason });
  }
  if (!payload.ok) {
    logger.info(`[EnrichmentScheduler] contact=${payload.contactId} skipped: ${payload.reason || 'unknown'}`);
  }
}

/**
 * Renderer signals that the batch is drained — unblock the scheduler
 * so the next tick can dispatch.
 */
export function reportBatchDone(payload?: { batchId?: string; continue?: boolean }): void {
  if (!batchInFlight) return;
  if (payload?.batchId && payload.batchId !== activeBatch?.batchId) return;
  logger.info('[EnrichmentScheduler] batch done');
  releaseBatchLock();
  // Continue the rotation: serve the next account with pending work shortly.
  if (payload?.continue !== false && rendererReady) scheduleFollowupTick();
}

/** Release the single-batch-in-flight lock. One place so every path resets both fields. */
function releaseBatchLock(): void {
  batchInFlight = false;
  batchStartedAt = 0;
  activeBatch = null;
  tickGeneration++;
}

async function runTick(manual = false): Promise<number> {
  if (!rendererReady) return 0;
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
  const generation = ++tickGeneration;

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
    if (generation !== tickGeneration) return 0;
    const idx = (accountCursor + i) % accounts.length;
    const { id, storage } = accounts[idx];
    if (!storage) continue;
    let candidates: Array<{ id: string }>;
    try {
      const prefix = `${id ?? ''}:`;
      const excludeContactIds: string[] = [];
      for (const [key, retry] of retryAfter) {
        if (retry.until <= Date.now()) retryAfter.delete(key);
        else if (key.startsWith(prefix)) excludeContactIds.push(key.slice(prefix.length));
      }
      candidates = await (storage as any).getContactEnrichmentCandidates({
        minAgeDays: MIN_AGE_DAYS,
        limit: BATCH_SIZE,
        ...(excludeContactIds.length ? { excludeContactIds } : {}),
      });
    } catch (e) {
      logger.error(`[EnrichmentScheduler] list candidates failed (acct=${id ?? 'active'}):`, e);
      continue;
    }
    if (generation !== tickGeneration) return 0;
    if (candidates.length === 0) continue;
    // stop()/readiness may have changed while the candidate read awaited.
    if (generation !== tickGeneration || !rendererReady || !batchInFlight) return 0;
    // Fresh work must not inherit a long provider-retry wake. Its ack starts
    // the normal short drain, which re-arms the cooldown once the queue empties.
    if (followupTimer) { clearTimeout(followupTimer); followupTimer = null; }

    accountCursor = (idx + 1) % accounts.length;
    // Lock already held from the claim above; refresh the start time so the
    // stale-lock timeout measures from the actual dispatch, not the claim.
    batchStartedAt = Date.now();
    logger.info(`[EnrichmentScheduler] dispatching batch of ${candidates.length} contacts (acct=${id ?? 'active'})`);
    activeBatch = {
      batchId: `${Date.now()}-${++batchSequence}`,
      contactIds: candidates.map((c) => c.id),
      accountId: id ?? undefined,
    };
    try {
      mainWindow.webContents.send('contact-enrichment:run-batch', activeBatch);
    } catch (error) {
      releaseBatchLock();
      logger.error('[EnrichmentScheduler] dispatch failed:', error);
      return 0;
    }
    return candidates.length;
  }

  // No account had eligible contacts — release and stop the rotation (a later
  // interval / new-mail tick restarts it).
  if (generation !== tickGeneration) return 0;
  if (manual) logger.info('[EnrichmentScheduler] no eligible contacts on any account');
  releaseBatchLock();
  if (retryAfter.size && rendererReady) {
    const nextRetry = Math.min(...[...retryAfter.values()].map(retry => retry.until));
    scheduleFollowupTick(Math.max(FOLLOWUP_DELAY_MS, nextRetry - Date.now()));
  }
  return 0;
}

/**
 * After a batch acks, quickly serve the NEXT account that has work so a 10-
 * account rotation drains in minutes, not 10 x 6h. Self-limiting: a follow-up
 * tick that finds no candidates idles until new mail or the earliest temporary
 * failure cooldown. Tracked so stop() can cancel it.
 */
function scheduleFollowupTick(delay = FOLLOWUP_DELAY_MS): void {
  if (followupTimer) return;
  followupTimer = setTimeout(() => {
    followupTimer = null;
    runTick().catch((e) => logger.error('[EnrichmentScheduler] follow-up tick error:', e));
  }, delay);
  followupTimer.unref?.();
}
