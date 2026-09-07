/**
 * Cooperative yielding for long loops that run on the Electron main thread.
 *
 * better-sqlite3 is synchronous, so every `await` around a query resolves as a
 * microtask and the queue drains without ever reaching libuv's poll phase. A
 * loop that never hands the thread back therefore freezes EVERYTHING: IMAP
 * socket reads, ImapFlow's own timeouts, and every renderer IPC reply — which
 * macOS shows as the spinning beachball, and which the log shows as body-fetch
 * timeouts and poisoned pool connections that look like network faults but are
 * not. `yieldToEventLoop` is the single primitive that gives the thread back.
 *
 * `createLoopYielder` exists because the row-COUNT yield this replaces is the
 * bug, not the fix. `if (++n % 500 === 0) await yield()` silently assumes a
 * fixed per-row cost: when a row got expensive (a per-row query whose plan
 * degraded to a full table scan), 500 rows became 25 SECONDS of uninterruptible
 * work — measured in the field 2026-08-26, one 500-row chunk per beachball. A
 * time budget cannot be wrong that way: however slow one item turns out to be,
 * the thread comes back within roughly `budgetMs`, so a future regression is a
 * slowdown instead of a freeze.
 *
 * Deliberately NOT reaching for a library: this is two lines of platform
 * primitive (`setImmediate`, `Date.now`) with no edge cases a package would
 * handle better, and it must not add a dependency to the storage hot path.
 */

/**
 * How long a loop may hold the thread before yielding. One frame at 120Hz is
 * ~8ms; staying under that keeps the UI drawing and lets IMAP sockets and IPC
 * replies through, while still amortising the yield over enough work that the
 * loop makes real progress.
 */
export const DEFAULT_YIELD_BUDGET_MS = 8;

/**
 * Hand the thread back to libuv for one turn.
 *
 * `setImmediate` (the check phase) rather than `setTimeout(0)` (the timer
 * phase): it runs after the poll phase, so pending I/O is serviced BEFORE the
 * loop resumes, and it does not incur the timer's minimum clamp.
 */
export function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

export type LoopYielderOptions = {
  /** Milliseconds of work allowed between yields. */
  budgetMs?: number;
  /** Clock, injected for tests. */
  now?: () => number;
  /** Yield primitive, injected for tests. */
  yieldFn?: () => Promise<void>;
};

/**
 * Build a yielder to `await` on EVERY iteration of a long loop. It returns
 * without yielding while the time budget holds, so the cost in the common case
 * is one `Date.now()` per item; once the budget is spent it yields and resets.
 *
 * Resolves to `true` when it actually yielded, which lets a caller re-check
 * cancellation or log progress only on real yield points.
 *
 *     const breathe = createLoopYielder();
 *     for (const row of rows) {
 *       await breathe();
 *       expensiveSyncWork(row);
 *     }
 */
/**
 * How much of the wall clock a background pass may spend on the main thread.
 *
 * A yielder is not enough on its own, and a CPU profile of the running app said
 * so: with the wasteful query removed, the inline-image pass still held 79% of
 * wall-clock in JS, because yielding hands the thread back for ONE turn and the
 * loop immediately takes it again. Nothing else — IMAP reads, IPC replies, the
 * renderer — gets a look in, so the app beachballs for the whole migration.
 *
 * A duty cycle bounds the SHARE instead of the slice: work for as long as the
 * chunk takes, then rest proportionally. The pass takes longer in wall-clock and
 * that is the correct trade for work nobody is waiting on — a 13-minute migration
 * that makes the app unusable is worse than a 50-minute one nobody notices.
 */
export const DEFAULT_DUTY_CYCLE = 0.25;

export type PacerOptions = {
  /** Share of wall clock the caller's work may occupy, in (0, 1]. */
  dutyCycle?: number;
  /** Never rest longer than this, however slow one unit of work was. */
  maxRestMs?: number;
  /** Clock, injected for tests. */
  now?: () => number;
  /** Sleep primitive, injected for tests. */
  sleepFn?: (ms: number) => Promise<void>;
  /** Yield primitive for the no-rest-needed case, injected for tests. */
  yieldFn?: () => Promise<void>;
};

/** Sleep for real — the timer phase, so the thread is genuinely released. */
export function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    // Never hold the process open on a background pass's rest interval.
    (timer as unknown as { unref?: () => void }).unref?.();
  });
}

/**
 * Build a pacer whose `rest()` is awaited after each unit of work, keeping that
 * work under `dutyCycle` of the wall clock.
 *
 *     const pace = createPacer({ dutyCycle: 0.25 });
 *     for (;;) {
 *       const chunk = runChunk();      // holds the thread; a transaction cannot yield
 *       if (!chunk.visited) break;
 *       await pace.rest();             // rests ~3x however long that took
 *     }
 *
 * Returns the milliseconds actually rested, which lets a caller log its own
 * pacing without measuring it twice.
 *
 * `rest()` ALWAYS awaits something. When the work was fast enough to need no
 * rest it still yields one turn, so this is a strict replacement for a yielder at
 * the same call site rather than something to layer on top of one — a pacer that
 * could return synchronously would starve the loop on a mailbox of tiny rows.
 */
export function createPacer(options: PacerOptions = {}): { rest: () => Promise<number> } {
  const dutyCycle = options.dutyCycle ?? DEFAULT_DUTY_CYCLE;
  const maxRestMs = options.maxRestMs ?? 2_000;
  const now = options.now ?? Date.now;
  const sleepFn = options.sleepFn ?? sleep;
  const yieldFn = options.yieldFn ?? yieldToEventLoop;
  // Clamp rather than trust: a caller passing 0 (or a negative, or NaN from a
  // config value) would compute an infinite rest and stall the pass forever,
  // which looks exactly like the backfill silently dying.
  const share = Number.isFinite(dutyCycle) && dutyCycle > 0 ? Math.min(dutyCycle, 1) : 1;
  const restFactor = 1 / share - 1;

  let workStartedAt = now();

  return {
    rest: async (): Promise<number> => {
      const workedMs = Math.max(0, now() - workStartedAt);
      const restMs = Math.min(Math.round(workedMs * restFactor), maxRestMs);
      if (restMs >= 1) await sleepFn(restMs);
      else await yieldFn();
      // Re-read the clock AFTER resting, so the rest itself is not charged to the
      // next unit of work — the same reason createLoopYielder re-reads.
      workStartedAt = now();
      return restMs;
    },
  };
}

export function createLoopYielder(options: LoopYielderOptions = {}): () => Promise<boolean> {
  const budgetMs = options.budgetMs ?? DEFAULT_YIELD_BUDGET_MS;
  const now = options.now ?? Date.now;
  const yieldFn = options.yieldFn ?? yieldToEventLoop;

  let lastYieldAt = now();

  return async (): Promise<boolean> => {
    // `<` not `<=`: a budget of 0 must yield on every call (used by tests and by
    // callers that want maximum responsiveness over throughput).
    if (now() - lastYieldAt < budgetMs) return false;
    await yieldFn();
    // Re-read the clock AFTER yielding: the yield itself can take a while (that
    // is the point — other work runs), and charging that time to the next
    // budget would make the loop yield on every single item.
    lastYieldAt = now();
    return true;
  };
}
