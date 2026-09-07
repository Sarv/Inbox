/**
 * Renderer-side bookkeeping for body fetches that came back without a body.
 *
 * Pure on purpose: both `fetchEmailBody` failure paths (a `{success:false}`
 * result and a thrown IPC error) used to hand-roll the same two decisions, and
 * they had already drifted apart — one treated "queue full" as retryable, the
 * other didn't know about the engine's deferred signal at all. An email parked
 * in `failedBodies` is skipped by every later fetch attempt, so getting this
 * wrong shows the user "Unable to load email content" until the app restarts.
 */

/** Cap on remembered failures, so a long session can't grow the set forever. */
export const MAX_FAILED_BODIES = 500;

/**
 * True when the error means "we never got an answer about this message" — as
 * opposed to a verdict about the message itself. Retryable errors must NOT be
 * remembered: the next attempt is expected to succeed.
 *
 * - `queue full`: the engine shed load to make room for a user-initiated fetch.
 * - `body fetch deferred`: the engine's explicit ask-me-again signal (the folder
 *   would not open, the email is cooling down after timeouts, the mailbox
 *   shifted mid-fetch). See `createDeferredFetchError` in core — matched on text
 *   because the renderer cannot import the core barrel (Node-only IMAP deps).
 */
export function isRetryableBodyFetchError(message?: string): boolean {
  const text = message?.toLowerCase() || '';
  return text.includes('queue full') || text.includes('body fetch deferred');
}

/**
 * True when the error text suggests the message is no longer where we think it
 * is. Only ever a HINT: it labels a log line and asks the guarded folder sync to
 * reconcile — never a delete on its own (a MOVE reads the same way, and
 * `emails.delete()` here once expunged live mail).
 */
export function looksGoneFromServer(message?: string): boolean {
  const text = message?.toLowerCase() || '';
  return text.includes('not found') || text.includes('deleted') ||
    text.includes('moved') || text.includes('no such message') ||
    text.includes('invalid uid');
}

/**
 * Remember `emailId` as body-less, evicting the older half once the cap is hit.
 * Returns a NEW set (zustand needs a fresh reference to re-render).
 */
export function withFailedBody(existing: Set<string>, emailId: string): Set<string> {
  let next = new Set(existing);
  if (next.size >= MAX_FAILED_BODIES) {
    const entries = Array.from(next);
    next = new Set(entries.slice(Math.floor(entries.length / 2)));
  }
  next.add(emailId);
  return next;
}
