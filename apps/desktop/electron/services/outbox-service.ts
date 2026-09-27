/**
 * Outbox Service
 *
 * Owns the main-process SMTP SendQueue (outbox) singleton and its drain
 * lifecycle. The queue itself is transport-agnostic (in @sarvinbox/core); this
 * wires it to the app's storage, the live SMTP client's connection state, and
 * the actual send path (sendEmailFromMain, injected to avoid an import cycle).
 *
 * Drain triggers:
 *  - on startup (after loadFromStorage)
 *  - after a successful smtp:connect (see smtp-handlers)
 *  - on a one-shot timer armed for the EARLIEST due time, so a send scheduled
 *    for 13:08 leaves at 13:08 and not up to a minute later
 *  - on a periodic timer, as a backstop for retries whose backoff has elapsed
 */

import {
  SendQueue,
  nextDrainDelayMs,
  type SendFn,
  type AppendSentFn,
  type IEmailStorage,
  createLogger,
} from '@sarvinbox/core';

import { getStorage, getSmtpClient, getStorageFor, getSmtpClientFor, getMainWindow } from '../shared';
const logger = createLogger('outbox-service');

/**
 * Tell the renderer the outbox changed (enqueue / sent / failed / drained) so
 * the sidebar badge and Outbox tab update instantly instead of via polling.
 *
 * A change to the outbox is also exactly when the next due time can move
 * (a send scheduled, rescheduled, cancelled or drained), so the wake-up timer
 * is re-armed from the same point — there is no mutation site that pokes the
 * renderer and forgets the clock.
 */
export function notifyOutboxChanged(): void {
  try { getMainWindow()?.webContents.send('outbox:changed'); } catch { /* window gone */ }
  armOutboxWakeup();
}

const OUTBOX_DRAIN_INTERVAL_MS = 60_000;

let queue: SendQueue | null = null;
let drainTimer: NodeJS.Timeout | null = null;
let wakeupTimer: NodeJS.Timeout | null = null;

/**
 * Drain in the background and, if anything actually moved, tell the renderer at
 * once — a timed drain that sends the mail but leaves the Outbox showing
 * "Scheduled" until the next 30s poll looks exactly like a schedule that didn't
 * fire. Never throws: this runs from a timer with no caller to catch it.
 */
async function drainInBackground(reason: string): Promise<void> {
  try {
    const result = await getOutboxQueue().processQueue();
    if (result.sent || result.queued || result.failed) notifyOutboxChanged();
    else armOutboxWakeup();
  } catch (e) {
    logger.error(`[Outbox] ${reason} drain failed:`, e);
    armOutboxWakeup();
  }
}

/**
 * Arm a single timer for the earliest moment the outbox has work — the delivery
 * time of the soonest scheduled send, or the soonest retry backoff. Replaces
 * any timer already armed, so the nearest due time always wins.
 *
 * Fire-and-forget: reading the rows can fail (storage swapping during an account
 * switch), and the periodic backstop covers that case.
 */
export function armOutboxWakeup(): void {
  const storage = getStorage();
  if (!storage || !sendFnRef) return;
  void (async () => {
    let delayMs = OUTBOX_DRAIN_INTERVAL_MS;
    try {
      const sends = await (storage as unknown as IEmailStorage).getAllSends();
      delayMs = nextDrainDelayMs(sends, Date.now(), {
        maxDelayMs: OUTBOX_DRAIN_INTERVAL_MS,
      });
    } catch (e) {
      logger.warn('[Outbox] Could not read sends to arm the drain timer:', e);
      return; // the periodic backstop still runs
    }
    if (wakeupTimer) clearTimeout(wakeupTimer);
    wakeupTimer = null;
    // Nothing sooner than the backstop would fire anyway — arming here too would
    // just drain the same rows twice at the same moment.
    if (delayMs >= OUTBOX_DRAIN_INTERVAL_MS) return;
    wakeupTimer = setTimeout(() => { wakeupTimer = null; void drainInBackground('Scheduled'); }, delayMs);
    wakeupTimer.unref?.();
  })();
}

/**
 * The outbox singleton (lazily created). Always safe to call; enqueueAndSend
 * throws until initOutbox has wired its dependencies.
 */
export function getOutboxQueue(): SendQueue {
  if (!queue) queue = new SendQueue();
  return queue;
}

/**
 * Wire the outbox to storage + the SMTP client, recover any persisted sends,
 * and start the periodic drain. `sendFn` is injected (sendEmailFromMain) so this
 * module never imports the SMTP handlers back.
 */
// The injected send function, kept so the queue can be re-pointed at a
// different account's storage on switch (see rebindOutboxStorage).
let sendFnRef: SendFn | null = null;
// The injected durable Sent-folder APPEND (uploads the Sent copy after SMTP
// accepts a message). Kept alongside sendFn so both the active and per-account
// queues get it. Resolves its target account from the payload's accountId.
let appendSentFnRef: AppendSentFn | null = null;

/** (Re)wire the outbox queue to the CURRENT account's storage + drain it. */
function wireOutboxQueue(): void {
  const storage = getStorage();
  if (!storage || !sendFnRef) {
    logger.warn('[Outbox] wireOutboxQueue: storage or sendFn not ready — skipping');
    return;
  }
  const q = getOutboxQueue();
  q.initialize({
    storage: storage as unknown as IEmailStorage,
    sendFn: sendFnRef,
    appendSentFn: appendSentFnRef ?? undefined,
    isConnected: () => getSmtpClient()?.isConnected() ?? false,
  });
  // Recover crashed/pending sends for this account, then attempt an initial drain.
  q.loadFromStorage()
    .then(() => q.processQueue())
    // Whatever is left after the startup drain — a send scheduled for this
    // afternoon, a backoff mid-flight — decides when we next wake.
    .then(() => armOutboxWakeup())
    .catch((e) => logger.error('[Outbox] Initial load/drain failed:', e));
}

/**
 * Re-point the outbox at the now-active account's storage. Called after an
 * account switch so pending sends drain from the correct per-account DB.
 */
export function rebindOutboxStorage(): void {
  wireOutboxQueue();
}

export function initOutbox(deps: { sendFn: SendFn; appendSentFn?: AppendSentFn }): void {
  sendFnRef = deps.sendFn;
  appendSentFnRef = deps.appendSentFn ?? null;
  if (!getStorage()) {
    logger.warn('[Outbox] initOutbox called before storage was ready — skipping');
    return;
  }

  wireOutboxQueue();

  if (drainTimer) clearInterval(drainTimer);
  drainTimer = setInterval(() => { void drainInBackground('Periodic'); }, OUTBOX_DRAIN_INTERVAL_MS);
  // Don't keep the process alive just for the drain timer.
  drainTimer.unref?.();
  armOutboxWakeup();

  logger.info('[Outbox] Initialized');
}

/**
 * Attempt to send everything currently due. Safe to call repeatedly (the queue
 * guards against overlapping drains and no-ops when disconnected).
 */
export async function drainOutbox(): Promise<{ sent: number; queued: number; failed: number }> {
  const r = await getOutboxQueue().processQueue();
  notifyOutboxChanged();
  return r;
}

// ===== Per-account outbox (cross-account send) ==============================
// The active account uses the singleton getOutboxQueue() above (unchanged). A
// send AS a non-active account routes here: its own SendQueue bound to that
// account's DB + SMTP client, so it persists to the right pending_sends and
// drains via the right SMTP.
const perAccountQueues = new Map<string, SendQueue>();

export function getOutboxQueueForAccount(accountId: string): SendQueue {
  let q = perAccountQueues.get(accountId);
  if (!q) {
    q = new SendQueue();
    perAccountQueues.set(accountId, q);
  }
  const storage = getStorageFor(accountId);
  if (storage && sendFnRef) {
    q.initialize({
      storage: storage as unknown as IEmailStorage,
      // Tag the payload so sendEmailFromMain routes to this account's client/DB.
      sendFn: (opts) => sendFnRef!({ ...opts, accountId }),
      // appendSentFn resolves the target account from payload.accountId, which we
      // tag above — so the same injected fn appends to the right Sent folder.
      appendSentFn: appendSentFnRef
        ? (raw, mid, opts) => appendSentFnRef!(raw, mid, { ...opts, accountId })
        : undefined,
      isConnected: () => getSmtpClientFor(accountId)?.isConnected() ?? false,
    });
  }
  return q;
}

/** Drain a specific account's outbox (e.g. right after its SMTP connects). */
export async function drainOutboxForAccount(accountId: string): Promise<void> {
  try {
    const q = getOutboxQueueForAccount(accountId);
    await q.loadFromStorage();
    await q.processQueue();
    notifyOutboxChanged();
  } catch (e) {
    logger.error('[Outbox] Per-account drain failed:', accountId, e);
  }
}

/**
 * Stop the periodic drain (on app quit).
 */
export function stopOutbox(): void {
  if (drainTimer) {
    clearInterval(drainTimer);
    drainTimer = null;
  }
  if (wakeupTimer) {
    clearTimeout(wakeupTimer);
    wakeupTimer = null;
  }
}
