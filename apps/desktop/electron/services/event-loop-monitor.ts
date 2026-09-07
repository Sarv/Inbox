/**
 * Main-process event-loop stall detector.
 *
 * Almost everything expensive in this app is SYNCHRONOUS on the main process's
 * single JS thread: better-sqlite3 has no async API, mailparser/html-to-text run
 * inline, and every IPC reply the renderer is waiting on is queued behind them.
 * So one long uninterruptible block doesn't just slow a query down — it freezes
 * the entire UI, which macOS surfaces as the spinning beachball. That failure
 * mode has been hit repeatedly here (see the yield loops in contacts-handlers,
 * body-reheal-scheduler, sqlite-storage, read-model-maintainer, and the inline
 * agent:setConfig freeze), and every time it was diagnosed by hand from gaps
 * between unrelated log lines — which can't tell a CPU block from an IMAP wait.
 *
 * This turns that guesswork into a log line. A timer that should fire every
 * `tickMs` measures how late it ACTUALLY fired; lateness beyond `thresholdMs` is
 * time the loop spent unable to run anything, i.e. time the UI was frozen. The
 * stall is reported when it ENDS, so the next lines in app.log name whatever was
 * running — that adjacency is the attribution.
 *
 * Deliberately NOT a hot-path log: it emits only when a stall exceeds the
 * threshold, so a healthy app is silent and this costs one timer callback per
 * tick. `perf_hooks.monitorEventLoopDelay` would give a nicer histogram but only
 * aggregate percentiles — it can't tell you WHEN a block happened, which is the
 * only thing that identifies the cause.
 *
 * Timers and the clock are injected so the detection maths is unit-testable
 * without waiting in real time (same split as `single-instance.ts`).
 */

/** How often the probe timer fires. */
export const EVENT_LOOP_TICK_MS = 500;

/**
 * Lateness that counts as a stall. Below ~100ms a UI feels responsive and
 * ordinary timer jitter/GC would produce constant noise; a quarter second is
 * already a visible hitch, and anything near a second is a beachball.
 */
export const EVENT_LOOP_STALL_THRESHOLD_MS = 250;

/**
 * How late did this tick fire, and does it count as a stall?
 *
 * Returns the stall duration in ms, or `null` when the tick was on time. Pure so
 * the boundary conditions can be pinned without timers.
 *
 * `elapsedMs` under `tickMs` (an EARLY tick — clock adjustment, fake timers) is
 * never a stall: lateness can't be negative.
 */
export function stallDuration(
  elapsedMs: number,
  tickMs: number,
  thresholdMs: number,
): number | null {
  const lateness = elapsedMs - tickMs;
  return lateness >= thresholdMs ? lateness : null;
}

/**
 * Human-readable stall report. Says how long the UI was frozen and points at the
 * adjacent log lines, because the stall itself can't name its own cause.
 */
export function describeStall(stallMs: number): string {
  return `[EventLoop] main process blocked for ${Math.round(stallMs)}ms — the UI was frozen (beachball) for that long; whatever logs immediately after this line is the likely cause`;
}

export type EventLoopMonitorDeps = {
  /** Called when a stall ends, with its duration in ms. */
  onStall: (stallMs: number) => void;
  tickMs?: number;
  thresholdMs?: number;
  /** Monotonic-ish clock; injected for tests. */
  now?: () => number;
  schedule?: (callback: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
};

/**
 * Start watching the loop. Returns a stop function; calling it twice is safe.
 *
 * The timer is unref'd where the runtime supports it so it can never be the
 * reason the process stays alive at shutdown.
 */
export function startEventLoopMonitor(deps: EventLoopMonitorDeps): () => void {
  const tickMs = deps.tickMs ?? EVENT_LOOP_TICK_MS;
  const thresholdMs = deps.thresholdMs ?? EVENT_LOOP_STALL_THRESHOLD_MS;
  const now = deps.now ?? Date.now;
  const schedule = deps.schedule ?? ((callback, ms) => setInterval(callback, ms));
  const cancel = deps.cancel ?? ((handle) => clearInterval(handle as NodeJS.Timeout));

  let last = now();
  const handle = schedule(() => {
    const current = now();
    const stall = stallDuration(current - last, tickMs, thresholdMs);
    // Advance the baseline BEFORE reporting, so a throw from onStall (or a slow
    // logger write) can't be re-counted as the next tick's stall.
    last = current;
    if (stall !== null) deps.onStall(stall);
  }, tickMs);

  (handle as { unref?: () => void })?.unref?.();

  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    cancel(handle);
  };
}
