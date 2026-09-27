// Outbox — crash-safe, persist-first retry queue for SMTP sends.
//
// Mirrors the IMAP OperationQueue: every send is written to pending_sends BEFORE
// the SMTP submit, so an offline or failed send is never lost. On success the row
// is deleted; on a transient failure it is rescheduled with exponential backoff;
// after maxRetries (or on a permanent failure) it becomes a 'failed' dead-letter
// the user can see and retry manually.
//
// The queue is transport-agnostic: it is given a `sendFn` (the main process wires
// this to sendEmailFromMain) and an `isConnected` probe, so it stays pure and
// unit-testable with no Electron/SMTP dependency.

import type { SendEmailOptions, SendResult } from '../types/smtp';
import type { IEmailStorage } from '../types/storage';
import { logger } from '../utils/logger';

export type SendFn = (payload: SendEmailOptions) => Promise<SendResult>;

/**
 * Uploads a copy of an already-sent message into the IMAP Sent folder and
 * reconciles the local Sent row's UID by Message-ID. Injected by the main
 * process (it needs the IMAP connection), so the queue stays transport-agnostic.
 * Must be idempotent: it may be called again after a crash, so it should dedupe
 * by Message-ID before appending. Throws if the append could not be completed
 * (e.g. IMAP offline) so the marker is kept and retried.
 */
export type AppendSentFn = (rawMime: string, messageId: string, payload: SendEmailOptions) => Promise<void>;

export interface SendQueueConfig {
  maxRetries: number;
  baseRetryDelayMs: number;
  maxRetryDelayMs: number;
}

const DEFAULT_CONFIG: SendQueueConfig = {
  maxRetries: 5,
  baseRetryDelayMs: 15_000, // 15s, doubling each attempt
  maxRetryDelayMs: 15 * 60_000, // capped at 15m
};

export type SendQueueStatus = 'success' | 'queued' | 'failed';

export interface SendQueueResult {
  status: SendQueueStatus;
  messageId?: string;
  error?: string;
}

export class SendQueue {
  private config: SendQueueConfig;
  private storage: IEmailStorage | null = null;
  private sendFn: SendFn | null = null;
  private appendSentFn: AppendSentFn | null = null;
  private isConnected: () => boolean = () => false;
  private processing = false;

  constructor(config: Partial<SendQueueConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  initialize(deps: {
    storage: IEmailStorage;
    sendFn: SendFn;
    isConnected: () => boolean;
    /** Optional Sent-folder APPEND (durable Sent copy). When omitted, sends are
     *  submitted as before with no Sent APPEND. */
    appendSentFn?: AppendSentFn;
  }): void {
    this.storage = deps.storage;
    this.sendFn = deps.sendFn;
    this.appendSentFn = deps.appendSentFn ?? null;
    this.isConnected = deps.isConnected;
  }

  /**
   * Exponential backoff (in ms) for the delay BEFORE the next attempt, given the
   * number of attempts already made. Capped; no jitter needed since a single
   * client drains serially.
   */
  private backoffMs(attemptsMade: number): number {
    const delay = this.config.baseRetryDelayMs * 2 ** attemptsMade;
    return Math.min(delay, this.config.maxRetryDelayMs);
  }

  /**
   * Persist-first enqueue + immediate attempt. This is the smtp:send path:
   * - always persisted first (never lost)
   * - if offline, left pending (due now) to drain on reconnect → 'queued'
   * - otherwise sent immediately → 'success' | 'queued' (retry) | 'failed'
   */
  async enqueueAndSend(payload: SendEmailOptions): Promise<SendQueueResult> {
    if (!this.storage || !this.sendFn) {
      throw new Error('SendQueue not initialized');
    }

    const id = await this.storage.savePendingSend(payload);

    if (!this.isConnected()) {
      logger.info(`[Outbox] Offline — send ${id} queued`);
      return { status: 'queued' };
    }

    return this.attempt(id, payload, 0);
  }

  /**
   * Persist a send but HOLD its transmission for `holdMs` (the undo window). The
   * mail is durable in the outbox immediately — a crash during the hold can only
   * DELAY delivery (the next drain after `holdMs` sends it), never lose it. This
   * replaces the old renderer-memory-only 5s delay where a quit/crash lost the
   * whole email. Returns the persisted rowid so the caller can commit or cancel.
   */
  async enqueueHeld(payload: SendEmailOptions, holdMs: number): Promise<{ id: number }> {
    if (!this.storage) throw new Error('SendQueue not initialized');
    const nextRetryAt = Math.floor(Date.now() / 1000) + Math.ceil(holdMs / 1000);
    const id = await this.storage.savePendingSend(payload, nextRetryAt);
    logger.info(`[Outbox] Send ${id} persisted, held ${holdMs}ms for undo`);
    return { id };
  }

  /**
   * The undo window elapsed: release the hold and drain now so the held send is
   * transmitted immediately. Reuses the normal drain (attempt + Sent-append +
   * dead-letter), so held sends get every crash-safety guarantee.
   */
  async commitHeld(id: number): Promise<{ sent: number; queued: number; failed: number }> {
    if (!this.storage) throw new Error('SendQueue not initialized');
    await this.storage.clearSendHold(id);
    return this.processQueue();
  }

  /**
   * User pressed Undo within the window: drop the still-held send. Returns false
   * when it was already committed/executing (too late to unsend) — the caller
   * then leaves the optimistic UI as sent.
   */
  async cancelHeld(id: number): Promise<boolean> {
    if (!this.storage) throw new Error('SendQueue not initialized');
    const cancelled = await this.storage.cancelHeldSend(id);
    logger.info(`[Outbox] Undo send ${id}: ${cancelled ? 'cancelled (was held)' : 'too late (already committed)'}`);
    return cancelled;
  }

  /**
   * Persist a send the user asked to deliver LATER. Same durability as the undo
   * hold — the row exists before this resolves — but it also records the intent
   * in `scheduled_at`, so a 30-second schedule can still be told apart from a
   * 30-second undo window (both are just "a future next_retry_at" otherwise).
   *
   * `sendAt` is a UTC epoch in SECONDS. A time already in the past is not an
   * error: the drain picks it up on the next pass and the mail goes now, which
   * is what "send it at 9am" means when it is already 10am.
   */
  async scheduleSend(payload: SendEmailOptions, sendAt: number): Promise<{ id: number }> {
    if (!this.storage) throw new Error('SendQueue not initialized');
    const id = await this.storage.scheduleSend(payload, Math.floor(sendAt));
    logger.info(`[Outbox] Send ${id} scheduled for ${new Date(sendAt * 1000).toISOString()}`);
    return { id };
  }

  /**
   * Move a still-waiting scheduled send to a new time. Returns false when the
   * drain already has it — at that point the mail is on its way and a new
   * delivery time would be a lie.
   */
  async rescheduleSend(id: number, sendAt: number): Promise<boolean> {
    if (!this.storage) throw new Error('SendQueue not initialized');
    const moved = await this.storage.rescheduleSend(id, Math.floor(sendAt));
    logger.info(
      moved
        ? `[Outbox] Send ${id} rescheduled for ${new Date(sendAt * 1000).toISOString()}`
        : `[Outbox] Reschedule of send ${id} ignored: no longer waiting`,
    );
    return moved;
  }

  /**
   * Execute one attempt for a persisted send and update its row accordingly.
   */
  private async attempt(id: number, payload: SendEmailOptions, attemptsMade: number): Promise<SendQueueResult> {
    try {
      await this.storage!.updatePendingSendStatus(id, 'executing');
      const result = await this.sendFn!(payload);

      if (result.success) {
        // Durable Sent-folder APPEND. SMTP has accepted the message, so we must
        // NOT re-send it — only upload the Sent copy. Persist the raw MIME + a
        // marker BEFORE deleting the row: a crash between here and the APPEND
        // leaves smtp_accepted=1 + sent_append_pending=1, and the copy is
        // completed on the next drain/restart (never re-sent). Providers that
        // auto-file to Sent (Gmail) set needsSentAppend=false → plain delete.
        if (this.appendSentFn && result.needsSentAppend && result.rawMessage) {
          const messageId = result.messageId ?? '';
          await this.storage!.markSendAppendPending(id, result.rawMessage, messageId);
          try {
            await this.appendSentFn(result.rawMessage, messageId, payload);
            await this.storage!.deletePendingSend(id);
          } catch (appendErr) {
            // The SEND fully succeeded — report success. The append marker stays
            // so processQueue/restart completes the Sent copy later, on the same
            // backoff as every other deferred append.
            await this.deferAppend(id, 0, (appendErr as Error)?.message ?? String(appendErr));
          }
          logger.info(`[Outbox] Send ${id} succeeded (messageId=${messageId || 'n/a'})`);
          return { status: 'success', messageId: result.messageId };
        }

        await this.storage!.deletePendingSend(id);
        logger.info(`[Outbox] Send ${id} succeeded (messageId=${result.messageId ?? 'n/a'})`);
        return { status: 'success', messageId: result.messageId };
      }

      return this.handleFailure(id, attemptsMade, result.error ?? 'Unknown send error', result.transient ?? false);
    } catch (error) {
      // sendFn is not expected to throw, but if it does treat it as transient so
      // the send is retried rather than lost.
      const msg = (error as Error)?.message ?? String(error);
      return this.handleFailure(id, attemptsMade, msg, true);
    }
  }

  /**
   * Decide, after a failed attempt, whether to reschedule (transient, under the
   * retry cap) or dead-letter (permanent, or cap reached).
   */
  private async handleFailure(id: number, attemptsMade: number, error: string, transient: boolean): Promise<SendQueueResult> {
    if (!transient) {
      await this.storage!.markPendingSendFailed(id, error);
      logger.warn(`[Outbox] Send ${id} permanently failed: ${error}`);
      return { status: 'failed', error };
    }

    const nextAttempt = attemptsMade + 1;
    if (nextAttempt > this.config.maxRetries) {
      await this.storage!.markPendingSendFailed(id, `${error} (gave up after ${this.config.maxRetries} retries)`);
      logger.warn(`[Outbox] Send ${id} dead-lettered after ${this.config.maxRetries} retries: ${error}`);
      return { status: 'failed', error };
    }

    const nextRetryAt = Math.floor(Date.now() / 1000) + Math.floor(this.backoffMs(attemptsMade) / 1000);
    await this.storage!.updatePendingSendAttempt(id, nextAttempt, error, nextRetryAt);
    logger.info(`[Outbox] Send ${id} scheduled for retry ${nextAttempt}/${this.config.maxRetries}: ${error}`);
    return { status: 'queued', error };
  }

  /**
   * Drain all sends that are due now. Called on (re)connect and on a periodic
   * timer. Guarded so overlapping calls don't double-send.
   */
  async processQueue(): Promise<{ sent: number; queued: number; failed: number }> {
    const result = { sent: 0, queued: 0, failed: 0 };
    if (this.processing || !this.storage || !this.sendFn || !this.isConnected()) {
      return result;
    }

    this.processing = true;
    try {
      // First, finish any Sent-folder APPENDs left pending by a crash between
      // SMTP-accept and the upload. These already reached the server — they are
      // ONLY appended here, never re-sent.
      await this.drainAppendPending();

      const now = Math.floor(Date.now() / 1000);
      const due = await this.storage.getDueSends(now);
      if (due.length === 0) return result;

      logger.info(`[Outbox] Draining ${due.length} due send(s)`);
      for (const send of due) {
        // Connection can drop mid-drain — stop attempting and leave the rest due.
        if (!this.isConnected()) {
          result.queued++;
          continue;
        }
        const r = await this.attempt(send.id, send.payload as SendEmailOptions, send.retryCount);
        if (r.status === 'success') result.sent++;
        else if (r.status === 'failed') result.failed++;
        else result.queued++;
      }
      logger.info(`[Outbox] Drain complete: ${result.sent} sent, ${result.queued} queued, ${result.failed} failed`);
    } finally {
      this.processing = false;
    }

    return result;
  }

  /**
   * Complete every send whose SMTP submission already succeeded but whose Sent
   * APPEND is still pending (crash between accept and upload, or a prior append
   * that failed because IMAP was offline). Append-only — these are NEVER
   * re-sent (smtp_accepted is set). Best-effort per row; a failure leaves the
   * marker so a later drain retries it.
   *
   * A failure also BACKS OFF, on the same doubling curve as a send retry. An
   * append that fails for a standing reason fails again a minute later, and one
   * that fails by wedging an IMAP command costs a connection each time it is
   * tried — which is how a single undeliverable Sent copy came to recycle the
   * account's IMAP connection every 60 seconds for as long as the app was open.
   * Retrying more slowly finishes the copy just as surely and stops the rest of
   * the app paying for it.
   */
  private async drainAppendPending(): Promise<void> {
    if (!this.storage || !this.appendSentFn || !this.isConnected()) return;
    let pending;
    try {
      pending = await this.storage.getAppendPendingSends(Math.floor(Date.now() / 1000));
    } catch (e) {
      logger.error('[Outbox] Failed to load append-pending sends:', e);
      return;
    }
    if (pending.length === 0) return;
    logger.info(`[Outbox] Completing ${pending.length} pending Sent APPEND(s)`);
    for (const row of pending) {
      if (!this.isConnected()) break;
      const rawMime = row.rawMime;
      if (!rawMime) {
        // No MIME to append — nothing recoverable; drop the marker so it doesn't
        // loop forever. (Shouldn't happen: the marker is only set with the MIME.)
        await this.storage.deletePendingSend(row.id);
        continue;
      }
      try {
        await this.appendSentFn(rawMime, row.messageId ?? '', row.payload as SendEmailOptions);
        await this.storage.deletePendingSend(row.id);
        logger.info(`[Outbox] Completed deferred Sent APPEND for send ${row.id}`);
      } catch (e) {
        await this.deferAppend(row.id, row.retryCount ?? 0, (e as Error)?.message ?? String(e));
      }
    }
  }

  /**
   * One deferral rule for both append sites: log it, and park the row until the
   * backoff has elapsed so the next drain skips it. `attemptsMade` is the row's
   * retry count, which a send-accepted row no longer uses for anything else.
   *
   * Never throws and never drops the marker: whatever happens here, the Sent
   * copy stays owed. A store that cannot park it (no deferAppendPending) simply
   * retries on the next drain, as before.
   */
  private async deferAppend(id: number, attemptsMade: number, error: string): Promise<void> {
    const backoff = this.backoffMs(attemptsMade);
    logger.warn(`[Outbox] Sent APPEND for send ${id} deferred ${Math.round(backoff / 1000)}s: ${error}`);
    if (typeof this.storage?.deferAppendPending !== 'function') return;
    try {
      const nextRetryAt = Math.floor(Date.now() / 1000) + Math.floor(backoff / 1000);
      await this.storage.deferAppendPending(id, nextRetryAt, attemptsMade + 1, error);
    } catch (e) {
      logger.warn(`[Outbox] Could not park the deferred Sent APPEND for send ${id}: ${(e as Error)?.message ?? e}`);
    }
  }

  /**
   * On startup, reset any send stuck in 'executing' (crashed mid-send) back to
   * 'pending' so it is retried. NOTE: this is at-least-once — a send that
   * actually reached the server just before a crash could be re-sent. Matches
   * the IMAP OperationQueue's crash-recovery choice (losing a send is worse than
   * a rare duplicate).
   */
  async loadFromStorage(): Promise<void> {
    if (!this.storage) return;
    try {
      const all = await this.storage.getAllSends();
      let reset = 0;
      for (const s of all) {
        if (s.status === 'executing') {
          await this.storage.updatePendingSendStatus(s.id, 'pending');
          reset++;
        }
      }
      const pending = all.filter(s => s.status !== 'failed').length;
      if (pending > 0) {
        logger.info(`[Outbox] Loaded ${pending} pending send(s) from storage${reset ? ` (reset ${reset} crashed mid-send)` : ''}`);
      }
    } catch (error) {
      logger.error('[Outbox] Failed to load pending sends from storage:', error);
    }
  }
}
