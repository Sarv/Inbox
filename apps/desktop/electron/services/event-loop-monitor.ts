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
 * What produced a gap between ticks.
 *
 * `freeze` — the loop genuinely could not run: the beachball this file exists
 * to catch. `sleep` — the whole machine was suspended, so no timer could fire
 * and nothing was frozen; the gap is an artefact of measuring wall-clock time.
 */
export type GapCause = 'freeze' | 'sleep';

/**
 * Human-readable gap report. Says what happened and points at the adjacent log
 * lines, because the gap itself can't name its own cause.
 */
export function describeStall(stallMs: number, cause: GapCause = 'freeze'): string {
  const ms = Math.round(stallMs);
  if (cause === 'sleep') {
    return `[EventLoop] ${ms}ms gap while the system was asleep — not a UI freeze, no timer could fire`;
  }
  return `[EventLoop] main process blocked for ${ms}ms — the UI was frozen (beachball) for that long; whatever logs immediately after this line is the likely cause`;
}

/**
 * Attribute a gap using the suspend flag sampled before it and after it.
 *
 * Why attribution and not a duration rule: a gap of minutes looks like sleep,
 * but this app has produced genuine multi-minute blocks — an iCloud-synced
 * checkout made `stat()` block for 989 SECONDS, and that report is what
 * identified the bug. Any "too long to be real" ceiling would have hidden
 * exactly the freeze the detector earned its keep on. So only a positive signal
 * counts; everything else stays a freeze.
 *
 * Why BOTH samples matter, rather than just asking "are we suspended now":
 *
 *  - macOS DarkWake (Power Nap) fires no Electron `resume`, so the flag stays
 *    true across a whole series of brief wakes. Those gaps are caught by
 *    `after` (still true) — over one afternoon this app logged 8 suspends, 4
 *    resumes and 17 long gaps against 69 `pmset` wake events, all inside a few
 *    suspend→resume pairs.
 *  - On a real user wake, the resume handler clears the flag, and it races the
 *    tick that reports the gap — both land in the same second. `before` (true,
 *    sampled while asleep) is what catches that one.
 *
 * The narrow miss: a suspend with no tick at all between it and the machine
 * sleeping, whose resume also lands before the reporting tick, reads as a
 * freeze. It needs both races to go the same way inside 500ms while main.ts is
 * tearing IMAP down, so it is rare, and erring toward "freeze" is the safe
 * direction — a false freeze warning is noise, a missed one is a hidden bug.
 */
export function attributeGap(suspendedBefore: boolean, suspendedAfter: boolean): GapCause {
  return suspendedBefore || suspendedAfter ? 'sleep' : 'freeze';
}

export type EventLoopMonitorDeps = {
  /** Called when a gap ends, with its duration and what caused it. */
  onStall: (stallMs: number, cause: GapCause) => void;
  tickMs?: number;
  thresholdMs?: number;
  /** Monotonic-ish clock; injected for tests. */
  now?: () => number;
  schedule?: (callback: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
  /**
   * Is the machine currently between a suspend and a real user wake?
   *
   * main.ts passes `getSystemSuspended` from shared.ts — the flag its existing
   * powerMonitor handlers already maintain for exactly this window (and for the
   * same DarkWake reason). Reused rather than subscribing again here: one
   * listener, one source of truth, and this module stays free of `electron`,
   * which the main-process unit tests need since they run in a plain node env
   * where that import is undefined.
   *
   * Omitted — or on a platform with no power events at all, such as a headless
   * Linux box — every gap is reported as a freeze. That is the pre-existing
   * behaviour: noisier across sleep, but it never hides a real freeze.
   */
  isSuspended?: () => boolean;
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

  // Reading the flag must never be the reason a tick throws — the monitor is
  // diagnostic, never load-bearing. A failed read reads as "awake", which keeps
  // the old behaviour of reporting the gap as a freeze.
  const suspendedNow = (): boolean => {
    try {
      return deps.isSuspended?.() ?? false;
    } catch {
      return false;
    }
  };

  let last = now();
  // Sampled every tick so a gap can be judged on the state BEFORE it as well as
  // after — see attributeGap for why one sample is not enough.
  let wasSuspended = suspendedNow();

  const handle = schedule(() => {
    const current = now();
    const stall = stallDuration(current - last, tickMs, thresholdMs);
    // Advance the baseline BEFORE reporting, so a throw from onStall (or a slow
    // logger write) can't be re-counted as the next tick's stall.
    last = current;
    const suspended = suspendedNow();
    const before = wasSuspended;
    wasSuspended = suspended;
    if (stall !== null) deps.onStall(stall, attributeGap(before, suspended));
  }, tickMs);

  (handle as { unref?: () => void })?.unref?.();

  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    cancel(handle);
  };
}
