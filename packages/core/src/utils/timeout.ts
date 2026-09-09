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

/** Options for `withStallTimeout`. */
export interface StallTimeoutOptions {
  /** Reject once `progress()` has not moved for this long. */
  stallMs: number;
  /** Absolute ceiling — reject even while progress is still being made. */
  maxMs: number;
  /**
   * Monotonic counter of work completed so far — e.g. bytes read off the IMAP
   * socket. Read repeatedly; only whether it CHANGED matters, so the unit and
   * the starting value are irrelevant. May throw or return a non-finite value
   * (an unreadable counter reads as "no progress").
   */
  progress: () => number;
  /** Called each time progress is observed — e.g. the pool's `touch`. */
  onProgress?: () => void;
  message: string;
}

/**
 * Race a promise against a STALL rather than against the clock.
 *
 * `withTimeout` gives an operation a fixed total budget, which is only correct
 * when the work is a fixed size. A body fetch is not: it downloads a whole
 * RFC822 message, so a flat 30s budget says "any message that takes longer than
 * 30s to transfer is broken". A large message on a slow link then fails, is
 * retried from byte zero, fails again at exactly the same point, and is retired
 * as un-fetchable — while every attempt abandons an in-flight FETCH and costs a
 * poisoned pool connection. It can never succeed no matter how many retries it
 * gets, which is what left three INBOX messages permanently body-less.
 *
 * The distinction that actually matters is "hung" vs "slow", and bytes arriving
 * is what separates them. So: reject only when NOTHING has arrived for
 * `stallMs` (a dead socket still fails as fast as before), keep going while the
 * transfer is progressing, and stop unconditionally at `maxMs` so nothing can
 * run forever.
 *
 * Progress is sampled on an interval and measured in ticks rather than wall
 * clock, so a suspended machine — whose timers simply don't fire — resumes with
 * its budget intact instead of waking to an already-blown deadline.
 */
export function withStallTimeout<T>(promise: Promise<T>, opts: StallTimeoutOptions): Promise<T> {
  const { stallMs, maxMs, progress, onProgress, message } = opts;
  const tickMs = Math.max(250, Math.min(stallMs, 5_000));

  let timer: ReturnType<typeof setInterval> | undefined;
  let sinceProgressMs = 0;
  let elapsedMs = 0;
  let lastProgress = readProgress(progress);

  const timeout = new Promise<never>((_, reject) => {
    timer = setInterval(() => {
      elapsedMs += tickMs;
      const current = readProgress(progress);
      // A finite reading that differs from the last one is progress. A
      // non-finite reading never counts, so an unreadable counter degrades to
      // the plain `withTimeout` behaviour instead of stalling forever.
      if (Number.isFinite(current) && current !== lastProgress) {
        lastProgress = current;
        sinceProgressMs = 0;
        try { onProgress?.(); } catch { /* advisory only — never fail the op */ }
      } else {
        sinceProgressMs += tickMs;
      }

      if (sinceProgressMs >= stallMs) {
        reject(new TimeoutError(`${message} (no data for ${Math.round(sinceProgressMs / 1000)}s)`));
      } else if (elapsedMs >= maxMs) {
        reject(new TimeoutError(`${message} (still running after ${Math.round(elapsedMs / 1000)}s)`));
      }
    }, tickMs);
  });

  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearInterval(timer);
  }) as Promise<T>;
}

/** Read a progress counter without letting it break the operation it measures. */
function readProgress(progress: () => number): number {
  try {
    return progress();
  } catch {
    return Number.NaN;
  }
}
