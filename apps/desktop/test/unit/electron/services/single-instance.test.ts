import { describe, it, expect } from 'vitest';

import {
  decideLockContention,
  decideSecondInstanceAction,
  DEV_MAIN_PROCESS_TITLE,
  isHeartbeatStale,
  isOrphanedFromLauncher,
  MAIN_PROCESS_TITLE,
  mainProcessTitle,
  shouldTagMainProcess,
  selectReclaimablePids,
  shouldKillLauncherOnQuit,
} from '../../../../electron/services/single-instance';

/**
 * The single-instance lock is the guardrail that stops a second Sarv Inbox
 * process from opening a duplicate set of IMAP connections against the same
 * account (doubling our footprint against Gmail's ~15-connection cap). The
 * Electron plumbing lives in main.ts; this suite pins the pure branch table
 * that decides what a duplicate-launch attempt does in the primary.
 */
describe('decideSecondInstanceAction', () => {
  // Regression: a second launch while a window is open must SURFACE that window,
  // never spawn a second process/window. If this returns anything but 'focus'
  // the user gets a duplicate window (and duplicate connections).
  it('focuses the existing window when one is open', () => {
    expect(decideSecondInstanceAction({ hasWindow: true, isReady: true })).toBe('focus');
  });

  // hasWindow wins regardless of readiness — a live window is always the thing
  // to surface. Guards against the ordering of the checks silently flipping.
  it('focuses the existing window even if isReady reads false', () => {
    expect(decideSecondInstanceAction({ hasWindow: true, isReady: false })).toBe('focus');
  });

  // Regression: macOS keep-alive can leave the app running with NO window after
  // the last window is closed. A re-launch then must recreate the window
  // (mirroring the 'activate' handler), not silently do nothing.
  it('recreates the window when none is open but the app is ready', () => {
    expect(decideSecondInstanceAction({ hasWindow: false, isReady: true })).toBe('create');
  });

  // Regression: during initial startup (not yet ready, no window) the normal
  // whenReady path is about to create the first window. Creating one here too
  // would double it — so this case must be a no-op.
  it('ignores the event during startup (no window, not ready yet)', () => {
    expect(decideSecondInstanceAction({ hasWindow: false, isReady: false })).toBe('ignore');
  });

  // Regression: a window that exists but whose renderer CRASHED (or was destroyed)
  // must be RECREATED on a second launch, not focused — focusing a dead frame
  // leaves the user staring at a blank/frozen window they can't recover.
  it('recreates the window when it exists but is unusable (crashed/destroyed)', () => {
    expect(decideSecondInstanceAction({ hasWindow: true, windowUsable: false, isReady: true })).toBe('create');
  });

  // A usable window (explicit) is still focused — the crash-recovery branch must not
  // regress the normal case.
  it('focuses a usable window when windowUsable is explicitly true', () => {
    expect(decideSecondInstanceAction({ hasWindow: true, windowUsable: true, isReady: true })).toBe('focus');
  });

  // An unusable window during startup (not ready) still can't create a duplicate —
  // falls through to ignore so the normal startup path owns window creation.
  it('ignores an unusable window when the app is not ready yet', () => {
    expect(decideSecondInstanceAction({ hasWindow: true, windowUsable: false, isReady: false })).toBe('ignore');
  });
});

/**
 * The dev ppid watchdog is the backstop that stops a Ctrl+C'd `pnpm dev` from
 * leaving an orphaned app in the dock. This suite pins WHEN the running instance
 * decides it has been orphaned and should self-quit.
 */
describe('isOrphanedFromLauncher', () => {
  // Regression: while the launcher is alive and still our parent, we are NOT
  // orphaned — self-quitting here would kill a perfectly healthy dev app.
  it('is not orphaned while the launcher is still the parent', () => {
    expect(isOrphanedFromLauncher(4242, 4242)).toBe(false);
  });

  // Regression: Ctrl+C kills the launcher and the OS re-parents us to launchd
  // (pid 1). If this isn't detected as orphaned, the app lingers in the dock
  // holding Gmail connections — the exact bug this fixes.
  it('is orphaned when re-parented to init/launchd (ppid 1)', () => {
    expect(isOrphanedFromLauncher(4242, 1)).toBe(true);
  });

  // Any change of parent away from the recorded launcher means the launcher is
  // gone — treat it as orphaned even if the new ppid isn't 1 (e.g. re-parented to
  // some other subreaper).
  it('is orphaned when the parent changes to a different pid', () => {
    expect(isOrphanedFromLauncher(4242, 9999)).toBe(true);
  });

  // Guards against a false positive on vite hot-restart: the new child is spawned
  // by the SAME launcher, so its ppid still matches and it must NOT self-quit.
  it('is not orphaned when a hot-restart keeps the same launcher ppid', () => {
    const launcher = 5555;
    expect(isOrphanedFromLauncher(launcher, launcher)).toBe(false);
  });
});

/**
 * `selectReclaimablePids` is the safety core of the kill-old-on-startup reclaim:
 * given every pid carrying our dev main-process title, it decides which we may
 * signal. The one rule that matters is never signalling ourselves.
 */
describe('selectReclaimablePids', () => {
  // Regression: we carry the SAME title as the orphan, so our own pid is always in
  // the candidate list. Killing it would make the app suicide on launch.
  it('never includes our own pid', () => {
    expect(selectReclaimablePids([100, 200, 300], 200)).toEqual([100, 300]);
  });

  // The normal reclaim case: one leftover orphan, one us → kill the orphan.
  it('returns the single previous instance when only we and it exist', () => {
    expect(selectReclaimablePids([777, 12345], 12345)).toEqual([777]);
  });

  // Multiple orphans can pile up across several crashed runs — reclaim ALL of
  // them, not just the first, or connections keep stacking.
  it('returns every previous instance, not just the first', () => {
    expect(selectReclaimablePids([11, 22, 33, 44], 44)).toEqual([11, 22, 33]);
  });

  // Fresh launch with no leftovers: only our own pid is listed → nothing to kill.
  it('returns nothing when we are the only instance', () => {
    expect(selectReclaimablePids([999], 999)).toEqual([]);
  });

  // Defensive: a malformed pid from the process listing (0, negative, NaN) must
  // never be signalled — process.kill(0/-1, ...) has dangerous group-signal
  // semantics.
  it('drops malformed pids (zero, negative, NaN)', () => {
    expect(selectReclaimablePids([0, -1, Number.NaN, 42], 7)).toEqual([42]);
  });
});

/**
 * The reverse teardown makes closing the app also close the terminal's dev server,
 * mirroring how Ctrl+C closes the app. This suite pins the one guard that keeps a
 * vite hot-restart from tearing down the dev server on every code edit.
 */
describe('shouldKillLauncherOnQuit', () => {
  // The intended case: user quits from the app (Cmd+Q / window close, no signal),
  // in dev → also bring down `pnpm dev:desktop`.
  it('kills the launcher on a genuine in-app quit in dev', () => {
    expect(shouldKillLauncherOnQuit({ isDev: true, quitBySignal: false })).toBe(true);
  });

  // Regression: a vite hot-restart quits us via SIGTERM. Killing the launcher here
  // would tear down the dev server on every edit — must NOT happen.
  it('does NOT kill the launcher on a signal-driven quit (hot-restart)', () => {
    expect(shouldKillLauncherOnQuit({ isDev: true, quitBySignal: true })).toBe(false);
  });

  // Packaged builds have no launcher to kill — never signal an unrelated parent.
  it('never kills a launcher outside dev', () => {
    expect(shouldKillLauncherOnQuit({ isDev: false, quitBySignal: false })).toBe(false);
    expect(shouldKillLauncherOnQuit({ isDev: false, quitBySignal: true })).toBe(false);
  });
});

/** dev and prod must carry DISTINCT titles so a reclaim never crosses builds. */
describe('mainProcessTitle', () => {
  it('returns the dev title in dev and the prod title in prod, and they differ', () => {
    expect(mainProcessTitle(true)).toBe(DEV_MAIN_PROCESS_TITLE);
    expect(mainProcessTitle(false)).toBe(MAIN_PROCESS_TITLE);
    expect(DEV_MAIN_PROCESS_TITLE).not.toBe(MAIN_PROCESS_TITLE);
  });
});

/**
 * The regression: the shipped macOS app showed "sarvinbox-main" as its menu-bar
 * name, beside a window correctly titled "Sarv Inbox". On macOS process.title is
 * also handed to LaunchServices as the display name, and AppKit draws the first
 * menu from that, overriding the label main.ts asks for. So the packaged mac
 * build must not be tagged -- and every other build still must be, because that
 * is how a wedged instance is found and reclaimed.
 */
describe('shouldTagMainProcess', () => {
  it('skips only the packaged macOS build', () => {
    expect(shouldTagMainProcess({ platform: 'darwin', isDev: false })).toBe(false);

    // Dev on macOS keeps it: dev runs a shared Electron binary whose helpers
    // carry the same product name, so the title is the only marker that finds
    // the main process without sweeping the helpers in too.
    expect(shouldTagMainProcess({ platform: 'darwin', isDev: true })).toBe(true);

    // Linux finds the process by title (process.title rewrites argv), and
    // Windows keeps it harmlessly -- there it never reaches any visible name.
    for (const platform of ['linux', 'win32']) {
      expect(shouldTagMainProcess({ platform, isDev: false }), platform).toBe(true);
      expect(shouldTagMainProcess({ platform, isDev: true }), platform).toBe(true);
    }
  });
});

/**
 * Heartbeat staleness is the prod wedge oracle: a fresh beat means the primary's
 * main thread is ticking; a stale one means it's blocked (wedged).
 */
describe('isHeartbeatStale', () => {
  // Regression: a beat inside the threshold is a HEALTHY primary — must not be
  // judged stale, or we'd reclaim a working app.
  it('is not stale within the threshold', () => {
    expect(isHeartbeatStale(1000, 1000 + 29_000, 30_000)).toBe(false);
  });

  // Beyond the threshold the main thread has been blocked too long → wedged.
  it('is stale once the gap exceeds the threshold', () => {
    expect(isHeartbeatStale(1000, 1000 + 31_000, 30_000)).toBe(true);
  });

  // Exactly at the threshold is NOT yet stale (strict >) — avoids a boundary
  // flap killing an app that just barely made its deadline.
  it('is not stale exactly at the threshold', () => {
    expect(isHeartbeatStale(1000, 1000 + 30_000, 30_000)).toBe(false);
  });

  // A corrupt/non-finite timestamp is treated as stale defensively (but the
  // caller's presence check + identity guard still prevent a wrongful kill).
  it('treats a non-finite timestamp as stale', () => {
    expect(isHeartbeatStale(Number.NaN, 1000, 30_000)).toBe(true);
  });
});

/**
 * `decideLockContention` is the prod safety gate: it may only say 'reclaim' when
 * ALL THREE conditions hold, so a healthy or unidentifiable holder is never killed.
 */
describe('decideLockContention', () => {
  const wedgedOurs = { heartbeatPresent: true, heartbeatStale: true, holderAlive: true, holderIsOurApp: true };

  // The one and only case that kills: a stale, alive, verified-ours holder.
  it('reclaims a wedged holder that is alive and ours', () => {
    expect(decideLockContention(wedgedOurs)).toBe('reclaim');
  });

  // No heartbeat → nothing to judge → defer (first run / older version).
  it('defers when there is no heartbeat', () => {
    expect(decideLockContention({ ...wedgedOurs, heartbeatPresent: false })).toBe('defer');
  });

  // Regression: a HEALTHY primary (fresh heartbeat) must never be reclaimed.
  it('defers when the heartbeat is fresh', () => {
    expect(decideLockContention({ ...wedgedOurs, heartbeatStale: false })).toBe('defer');
  });

  // Stale but the recorded pid is dead → nothing to kill → defer.
  it('defers when the holder is not alive', () => {
    expect(decideLockContention({ ...wedgedOurs, holderAlive: false })).toBe('defer');
  });

  // PID-REUSE guard: stale + alive but NOT our app → an unrelated process reused
  // the pid; killing it would be data loss → defer.
  it('defers when the alive holder is not our app', () => {
    expect(decideLockContention({ ...wedgedOurs, holderIsOurApp: false })).toBe('defer');
  });
});
