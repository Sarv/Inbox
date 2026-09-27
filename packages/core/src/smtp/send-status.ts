/**
 * What a row in the outbox MEANS, as one pure function.
 *
 * Three different things park a send with a future `next_retry_at`: the undo
 * window, a user-chosen delivery time, and the retry backoff after a failure.
 * The row alone can't tell them apart, so the main process and the renderer
 * would each have to guess — and the moment their guesses differ, the Outbox
 * shows "Scheduled for 9am" for a mail that is really retrying, or hides a
 * scheduled mail in a "Queued" list with no way to cancel it.
 *
 * So: one classifier, imported by both sides. Pure, no Date.now() of its own —
 * the caller passes the clock so tests can pin it.
 */

/** The shape every outbox surface shares; extra fields are ignored. */
export interface SendRowLike {
  status: string;
  /** UTC epoch SECONDS the user asked for, or null when this was never scheduled. */
  scheduledAt?: number | null;
  /** UTC epoch SECONDS before which the drain must not touch this row. */
  nextRetryAt?: number | null;
  retryCount?: number;
  /** True once SMTP accepted the message — it is with the server for good. */
  smtpAccepted?: boolean;
}

export type SendKind =
  /** Delivered: SMTP took it. Only the Sent-folder copy may still be outstanding. */
  | 'sent'
  /** Waiting for a delivery time the user picked. Cancellable, movable. */
  | 'scheduled'
  /** Held for the undo window, or backing off after a transient failure. */
  | 'waiting'
  /** The drain has it, mid-transmission. */
  | 'sending'
  /** Dead-lettered. Nothing will happen to it without the user. */
  | 'failed'
  /** Due now, waiting only on the next drain. */
  | 'queued';

/**
 * @param nowSeconds UTC epoch seconds (`Math.floor(Date.now() / 1000)`).
 */
export function classifySend(send: SendRowLike, nowSeconds: number): SendKind {
  // SMTP has accepted it: the mail is on its way to the recipient and the local
  // Sent copy was already written. What keeps the row alive is the Sent-folder
  // APPEND, which retries on its own. This outranks every other reading —
  // calling such a row "queued" (or "failed") describes the copy, not the mail,
  // and tells the user a message they have already received hasn't gone out.
  if (send.smtpAccepted || send.status === 'append_pending') return 'sent';
  if (send.status === 'failed') return 'failed';
  // 'executing' = the drain has it mid-transmission; too late to change.
  if (send.status === 'executing') return 'sending';

  const waitsUntil = send.nextRetryAt ?? null;
  if (waitsUntil === null || waitsUntil <= nowSeconds) return 'queued';

  // A scheduled send that has started retrying is no longer "scheduled": its
  // delivery time passed and the wait is now the backoff. clearSendHold drops
  // scheduled_at at release for exactly this reason; the retry check is the
  // belt to that braces, for rows written before it did.
  return send.scheduledAt != null && !send.retryCount ? 'scheduled' : 'waiting';
}

/** True when the user can still cancel or move this send's delivery time. */
export function isScheduled(send: SendRowLike, nowSeconds: number): boolean {
  return classifySend(send, nowSeconds) === 'scheduled';
}

/**
 * When this send will be transmitted, as UTC epoch MILLISECONDS — for rendering
 * in the reader's own zone. Null when there is no meaningful future time (due
 * now, in flight, or dead-lettered).
 */
export function sendDeliveryTimeMs(send: SendRowLike, nowSeconds: number): number | null {
  const kind = classifySend(send, nowSeconds);
  if (kind !== 'scheduled' && kind !== 'waiting') return null;
  return (send.nextRetryAt ?? 0) * 1000;
}

export interface NextDrainOptions {
  /** Cap, so an outbox holding only far-future sends still ticks over. */
  maxDelayMs?: number;
  /** Fire a beat AFTER the due second — a timer landing a millisecond early
   *  finds nothing due and would then wait out the whole backstop interval. */
  slackMs?: number;
}

/**
 * How long until the outbox next has something to do, in MILLISECONDS — the
 * delay for a one-shot wake-up timer.
 *
 * A fixed drain interval makes a send the user asked for at 13:08 leave at
 * 13:08:59, which reads as the schedule simply not working. So: wake ON the
 * earliest future due time instead, and keep the interval only as a backstop.
 *
 * Rows that are already due are deliberately ignored — they are the current
 * drain's business, and waking at 0ms for a row the drain cannot clear (SMTP
 * offline, a deferred Sent APPEND) would spin. So the result is always > 0.
 */
export function nextDrainDelayMs(
  sends: SendRowLike[],
  nowMs: number,
  { maxDelayMs = 60_000, slackMs = 500 }: NextDrainOptions = {},
): number {
  const nowSeconds = Math.floor(nowMs / 1000);
  const delays = sends
    .map((send) => sendDeliveryTimeMs(send, nowSeconds))
    .filter((dueMs): dueMs is number => dueMs !== null && dueMs > nowMs)
    .map((dueMs) => dueMs - nowMs);
  if (delays.length === 0) return maxDelayMs;
  return Math.min(maxDelayMs, Math.min(...delays) + slackMs);
}
