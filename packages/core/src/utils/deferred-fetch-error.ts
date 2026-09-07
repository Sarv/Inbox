/**
 * The "ask me again later" error for body fetching.
 *
 * There are exactly two kinds of answer a body fetch can give, and conflating
 * them is what makes mail permanently body-less:
 *
 *   VERDICT   — the server was asked and had nothing for us (no message at that
 *               UID, a message with no body part). Evidence about the MESSAGE.
 *               Only a verdict may ever accrue a strike toward `|nobody|`.
 *   DEFERRED  — we never asked, or never got an answer: the folder wouldn't
 *               SELECT right now, the email has tripped the engine's retry cap,
 *               the socket blipped, we timed out. Evidence about the CONNECTION.
 *
 * The engine used to signal several DEFERRED conditions by resolving `null` —
 * the same value it uses for a verdict. The prefetch scheduler, which is careful
 * to never strike on a throw, then struck on those nulls and tagged good mail
 * `|nobody|` three ticks later. One transient `NO SELECT INBOX` laundered this
 * way marked 505 emails un-fetchable in a single day.
 *
 * So a deferred condition THROWS this, and callers treat any throw as transient.
 *
 * The message text matters: the renderer's store scans body-fetch error text for
 * "not found" / "deleted" / "moved" / "no such message" / "invalid uid" to decide
 * whether a message looks gone from the server. Never put those words in here.
 */

export const BODY_FETCH_DEFERRED = 'BODY_FETCH_DEFERRED';

export type DeferredFetchError = Error & { code: string };

/**
 * Build the deferred-fetch error. `reason` is operator-facing detail for the
 * log; it is appended to a fixed, keyword-safe prefix.
 */
export function createDeferredFetchError(reason: string): DeferredFetchError {
  const err = new Error(`Body fetch deferred (${reason}) — will retry`) as DeferredFetchError;
  err.code = BODY_FETCH_DEFERRED;
  return err;
}

/** True when `err` is a deferred-fetch signal — i.e. retry, never a strike. */
export function isDeferredFetchError(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === BODY_FETCH_DEFERRED;
}
