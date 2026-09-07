/**
 * Single-instance guarantee for the Electron main process.
 *
 * Only ONE Sarv Inbox process may run per user. A second process would open its
 * own IMAP pool + IDLE connections against the SAME account, doubling our
 * footprint against the provider's per-account connection cap (Gmail ~15) — the
 * exact "too many simultaneous connections" failure we fight. Electron's
 * `app.requestSingleInstanceLock()` enforces the lock; the FIRST process owns
 * it and every later launch is routed to it via the `second-instance` event.
 *
 * The Electron API calls (requestSingleInstanceLock, window show/focus) are
 * orchestrated in main.ts; the pure DECISION of what a `second-instance` event
 * should do lives here so it is unit-testable in isolation.
 */

/** What the primary process should do when a duplicate launch is detected. */
export type SecondInstanceAction = 'focus' | 'create' | 'ignore';

/**
 * Decide how the PRIMARY instance responds to a second launch attempt.
 *
 * - `focus`  — a USABLE window exists: surface it (restore if minimized, show,
 *              focus).
 * - `create` — no usable window but the app is ready — either macOS keep-alive
 *              closed it, or the existing window was destroyed / its renderer
 *              CRASHED (a focus() on that would surface a dead frame). Recreate it,
 *              mirroring the `activate` behavior.
 * - `ignore` — no window and the app is not ready yet: the normal startup path
 *              will create the window, so do nothing (avoid a double window).
 *
 * `windowUsable` defaults to true so a bare `{ hasWindow, isReady }` (a live,
 * healthy window) still focuses; pass it false when the window exists but is
 * destroyed/crashed so a second launch RECOVERS it instead of focusing a corpse.
 *
 * Pure and side-effect-free so the branch table can be unit-tested without an
 * Electron app instance.
 */
export function decideSecondInstanceAction(state: {
  hasWindow: boolean;
  isReady: boolean;
  windowUsable?: boolean;
}): SecondInstanceAction {
  if (state.hasWindow && state.windowUsable !== false) return 'focus';
  if (state.isReady) return 'create';
  return 'ignore';
}

/**
 * DEV-ONLY orphan detection.
 *
 * In development the app is launched by a vite/pnpm parent process. Pressing
 * Ctrl+C in the terminal kills that launcher, but the OS does NOT kill this
 * Electron child — it RE-PARENTS it to init/launchd (pid 1). The result is an
 * ORPHANED app that lingers in the dock still holding its Gmail IMAP + IDLE
 * connections; the next `pnpm dev` then starts a SECOND copy, and the two stack
 * connections against the per-account cap → connect timeouts → back-off → the
 * app goes unusable. This is the "kill orphans" half of the single-process
 * guarantee (the packaged single-instance lock covers duplicate launches; in
 * dev the lock is disabled so it can't fight vite's hot-restart, so we need this
 * instead).
 *
 * The process is orphaned when its current parent pid no longer matches the
 * launcher that spawned it — either it flipped to 1 (re-parented to init/launchd
 * on macOS/Linux) or it simply changed. A vite hot-restart spawns the NEW child
 * from the SAME launcher, so its ppid still matches and this stays false — we
 * only self-terminate when the launcher itself is gone.
 *
 * Pure so the branch is unit-testable without spawning real processes.
 */
export function isOrphanedFromLauncher(launcherPid: number, currentPpid: number): boolean {
  return currentPpid === 1 || currentPpid !== launcherPid;
}

/**
 * Distinctive main-process title, set on the dev main process via `process.title`
 * so it can be found by NAME in the OS process table. We match on this instead of
 * tracking a pid file because:
 * - it survives a missing/stale pid file (an orphan that never recorded its pid is
 *   still found),
 * - it carries NO pid-reuse risk — an unrelated process can't accidentally own our
 *   app-specific title the way it can inherit a recycled pid number.
 *
 * Only the MAIN process is tagged; Electron's helper processes (GPU/renderer/
 * utility) keep the generic app name, so a title match never sweeps them in — and
 * killing the main takes its helpers down with it anyway.
 */
export const DEV_MAIN_PROCESS_TITLE = 'sarvinbox-dev-main';

/**
 * PROD counterpart of {@link DEV_MAIN_PROCESS_TITLE}. The packaged main process is
 * tagged with this so a wedged prod primary can be found and reclaimed by name —
 * the same name-based mechanism the user asked for, applied uniformly to both
 * builds (prod layers it UNDER the OS single-instance lock as a recovery path).
 */
export const MAIN_PROCESS_TITLE = 'sarvinbox-main';

/** The main-process title for the current build. */
export function mainProcessTitle(isDev: boolean): string {
  return isDev ? DEV_MAIN_PROCESS_TITLE : MAIN_PROCESS_TITLE;
}

/**
 * DEV-ONLY reclaim selection: given every pid currently carrying our main-process
 * title, which ones should this freshly-launched instance FORCE-KILL before it
 * starts?
 *
 * The reclaim (kill-old-then-take-over) is what guarantees a single dev child even
 * when a previous one is WEDGED (a beachballed main thread ignores both its own
 * ppid watchdog and Ctrl+C — only an external signal can end it). It runs before
 * we open the DB or any IMAP connection, so the new run never contends with, or
 * stacks Gmail connections on top of, the old one.
 *
 * The only safety rule needed is: never signal OURSELVES (we carry the same title),
 * and ignore any malformed pid. Identity is already guaranteed by the title match,
 * so — unlike a bare pid number — there is nothing else to verify.
 *
 * Pure so the selection is unit-testable without listing or signalling a process.
 */
export function selectReclaimablePids(candidatePids: number[], ourPid: number): number[] {
  return candidatePids.filter(
    (pid) => Number.isInteger(pid) && pid > 0 && pid !== ourPid,
  );
}

/**
 * DEV-ONLY reverse teardown: when the app quits from the APP side (Cmd+Q, window
 * close, the menu), should we also kill the vite/pnpm LAUNCHER so the terminal's
 * `pnpm dev:desktop` comes down too — closing "everything", the mirror of Ctrl+C
 * closing everything?
 *
 * The critical exclusion is `quitBySignal`: a vite hot-restart kills THIS process
 * with SIGTERM and immediately respawns a new one. That path must NOT kill the
 * launcher, or every code edit would tear down the dev server. So we kill the
 * launcher only on a genuine user-initiated quit (no terminating signal involved),
 * and only in dev (packaged builds have no launcher to kill).
 *
 * Pure so the guard is unit-testable without an Electron app or a real signal.
 */
export function shouldKillLauncherOnQuit(state: {
  isDev: boolean;
  quitBySignal: boolean;
}): boolean {
  return state.isDev && !state.quitBySignal;
}

/**
 * Liveness record the PROD primary writes periodically while it holds the
 * single-instance lock. A contending launch reads it to tell a HEALTHY primary
 * (fresh timestamp) from a WEDGED one (a beachballed main thread can't tick the
 * timer, so the timestamp goes stale) — the external oracle we need because a
 * wedged primary also can't answer an IPC ping or process the second-instance
 * event.
 */
export interface InstanceHeartbeat {
  pid: number;
  ts: number;
}

/**
 * A heartbeat is stale when it hasn't advanced within the threshold — i.e. the
 * primary's main thread has been blocked long enough to count as wedged. A missing
 * or malformed timestamp is treated as stale by the CALLER's presence check, not
 * here; here a non-finite ts is stale defensively.
 */
export function isHeartbeatStale(heartbeatTs: number, now: number, staleThresholdMs: number): boolean {
  if (!Number.isFinite(heartbeatTs)) return true;
  return now - heartbeatTs > staleThresholdMs;
}

/** What a contending PROD launch should do when it fails to get the lock. */
export type LockContentionAction = 'defer' | 'reclaim';

/**
 * PROD-ONLY: decide what a launch that FAILED to acquire the single-instance lock
 * should do. A failed acquire means a live holder exists right now; the only
 * question is whether that holder is HEALTHY (surface it and exit) or WEDGED
 * (reclaim it).
 *
 * `reclaim` requires ALL THREE independent conditions — a stale heartbeat AND the
 * recorded holder still alive AND verified to be our own app — so we never
 * force-kill:
 * - a HEALTHY primary (its heartbeat is fresh — it ticks every few seconds),
 * - a holder we can't positively identify (no heartbeat → nothing to judge → defer),
 * - or an UNRELATED process that reused the recorded pid (identity check fails).
 * Any doubt falls back to `defer`, which is exactly today's lock-only behavior — so
 * this can only ever be safer than the status quo, never worse.
 *
 * Pure so every guard is unit-testable without a lock, a heartbeat file, or a kill.
 */
export function decideLockContention(state: {
  heartbeatPresent: boolean;
  heartbeatStale: boolean;
  holderAlive: boolean;
  holderIsOurApp: boolean;
}): LockContentionAction {
  if (!state.heartbeatPresent) return 'defer';
  if (state.heartbeatStale && state.holderAlive && state.holderIsOurApp) return 'reclaim';
  return 'defer';
}
