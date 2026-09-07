// Async timeout helpers

/**
 * Error thrown when `withTimeout` loses the race. Distinguishable from a
 * command-level rejection (server NO/BAD) so callers can react specifically to
 * a timeout — e.g. the IMAP connection pool poisons a connection on timeout,
 * because the underlying command is still in-flight on the socket and reusing
 * that connection would overlap commands and corrupt the pipeline.
 */
export class TimeoutError extends Error {
  readonly isTimeout = true;
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}

/** True if `err` was produced by `withTimeout` losing its race. */
export function isTimeoutError(err: unknown): err is TimeoutError {
  return err instanceof TimeoutError || (err as { isTimeout?: boolean })?.isTimeout === true;
}

/**
 * Race a promise against a timeout. If `promise` doesn't settle within `ms`,
 * the returned promise rejects with a `TimeoutError(message)`. The timer is
 * always cleared once the race settles (win or lose), so callers don't leak
 * timers.
 *
 * Centralizes the `Promise.race([p, setTimeout(reject)])` pattern used across
 * the IMAP connect / NOOP / fetch / reconnect paths — several of the hand-rolled
 * copies forgot to clear the timer.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}

/** Handle returned by `withStartGatedTimeout`. */
export interface StartGatedTimeout<T> {
  /** Await this instead of the original promise. */
  readonly result: Promise<T>;
  /**
   * Signal that the work actually STARTED. Swaps the queue clock for the run
   * clock. Only the FIRST call counts — see `withStartGatedTimeout`.
   */
  readonly start: () => void;
}

/**
 * Two-phase timeout for work that is QUEUED before it RUNS.
 *
 * `withTimeout` starts its clock at the call site, which is wrong whenever the
 * callee queues the work behind other items: the deadline then measures "how
 * busy the queue is", not "how slow this one operation is". Submit N items at
 * once against a queue that drains C-wide and the tail is guaranteed to expire
 * before it ever gets a turn — the caller cancels its own in-flight work and
 * (if it re-submits the same items next round) never makes progress. That is
 * exactly what starved the body-fetch backlog on a slow IMAP server.
 *
 * So: allow `queueMs` to be dequeued, then `runMs` to actually finish, and let
 * the callee move the boundary by calling `start()` when it picks the item up.
 *
 * `start()` is honoured once. A callee that internally re-queues and retries
 * must not keep pushing the deadline out — the caller's budget would become
 * unbounded — so later calls are ignored and the first attempt's clock stands.
 */
export function withStartGatedTimeout<T>(
  promise: Promise<T>,
  opts: { queueMs: number; runMs: number; message: string },
): StartGatedTimeout<T> {
  const { queueMs, runMs, message } = opts;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let started = false;
  let settled = false;
  let fire: () => void = () => { /* set synchronously by the executor below */ };

  const timeout = new Promise<never>((_, reject) => {
    fire = () => reject(new TimeoutError(message));
    timer = setTimeout(fire, queueMs);
  });

  const result = Promise.race([promise, timeout]).finally(() => {
    settled = true;
    if (timer) clearTimeout(timer);
  }) as Promise<T>;

  // Re-arm on the first start() only. Guarded on `settled` so a late signal
  // (the race already won/lost) can't arm a timer nothing will clear.
  const start = (): void => {
    if (started || settled) return;
    started = true;
    if (timer) clearTimeout(timer);
    timer = setTimeout(fire, runMs);
  };

  return { result, start };
}
