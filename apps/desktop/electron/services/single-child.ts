/**
 * Single-instance enforcement IO for BOTH builds. One name-based mechanism, two
 * policies layered on top:
 *
 * - DEV: there is no OS lock (it would fight vite's hot-restart), and the failure
 *   mode is an ORPHAN — a Ctrl+C'd launcher leaves the Electron child re-parented
 *   to launchd. So dev ALWAYS wins on startup: find every process carrying our dev
 *   main-process title and kill it before we open the DB or a socket.
 *
 * - PROD: the OS single-instance lock (`requestSingleInstanceLock`) is the fast
 *   path and a HEALTHY primary must be PRESERVED, not killed. The only failure the
 *   lock can't recover from is a WEDGED primary (beachballed main thread) that
 *   keeps the lock but can't surface its window. We detect that via a liveness
 *   heartbeat and reclaim ONLY that case (see `evaluateLockContention` +
 *   `decideLockContention`). Everything else defers to the lock — never worse than
 *   today.
 *
 * The kill primitive (`reclaimPids` / `killWithGrace`), the process tagging, and
 * the identity/liveness probes are shared so dev and prod use ONE implementation.
 * Every OS interaction is injected via deps so the orchestration is unit-testable
 * without spawning or signalling a real process.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  decideLockContention,
  DEV_MAIN_PROCESS_TITLE,
  isHeartbeatStale,
  MAIN_PROCESS_TITLE,
  selectReclaimablePids,
  type InstanceHeartbeat,
  type LockContentionAction,
} from './single-instance';

/** How long to wait for a graceful SIGTERM exit before escalating to SIGKILL. */
const RECLAIM_GRACE_MS = 2000;
const RECLAIM_POLL_MS = 100;

/** PROD heartbeat cadence + how long a gap counts as "wedged". */
export const HEARTBEAT_INTERVAL_MS = 5_000;
// 6 missed beats. Generous on purpose: a healthy primary ticks every 5s, so this
// only trips on a sustained block — never on a brief busy spell — which keeps us
// from ever force-killing a merely-busy (not wedged) primary.
export const HEARTBEAT_STALE_MS = 30_000;

/** File under userData holding the current primary's {@link InstanceHeartbeat}. */
const HEARTBEAT_FILE = 'instance-heartbeat.json';

/** Signalling + timing primitives shared by every reclaim path. */
export interface KillDeps {
  isAlive: (pid: number) => boolean;
  kill: (pid: number, signal: NodeJS.Signals) => void;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  logInfo: (message: string) => void;
  logWarn: (message: string) => void;
}

/** DEV reclaim deps: find orphans by title, then kill via {@link KillDeps}. */
export interface DevReclaimDeps extends KillDeps {
  ourPid: number;
  listPidsByTitle: () => number[];
}

/** PROD contention deps: read the heartbeat + probe the recorded holder. */
export interface HeartbeatDeps {
  readHeartbeat: () => InstanceHeartbeat | null;
  isAlive: (pid: number) => boolean;
  isOurApp: (pid: number) => boolean;
  now: () => number;
}

/**
 * Stamp the current main process with a distinctive title so the NEXT launch can
 * find it by name. Call once, as early as possible. Wrapped because `process.title`
 * can throw on exotic platforms; a failure just means the next launch can't
 * name-reclaim us (dev falls back to the ppid watchdog; prod to the lock).
 */
export function tagMainProcess(title: string): void {
  try {
    process.title = title;
  } catch {
    // Non-fatal.
  }
}

/**
 * Kill `pid` gracefully (SIGTERM), polling for it to exit, then escalate to
 * SIGKILL if it is still alive after the grace window — the escalation is what
 * ends a WEDGED process that never processes the SIGTERM.
 */
async function killWithGrace(pid: number, deps: KillDeps): Promise<void> {
  try {
    deps.kill(pid, 'SIGTERM');
  } catch {
    // Already gone between the listing and here — nothing to do.
    return;
  }
  const deadline = deps.now() + RECLAIM_GRACE_MS;
  while (deps.now() < deadline) {
    await deps.sleep(RECLAIM_POLL_MS);
    if (!deps.isAlive(pid)) {
      deps.logInfo(`[Main] reclaim: pid=${pid} exited after SIGTERM`);
      return;
    }
  }
  try {
    deps.kill(pid, 'SIGKILL');
    deps.logWarn(`[Main] reclaim: pid=${pid} did not exit — SIGKILLed`);
  } catch {
    // Raced us to exit; fine.
  }
}

/**
 * Kill every target pid concurrently (skipping our own / malformed pids), each via
 * the SIGTERM→grace→SIGKILL ladder. Concurrent so one wedged victim can't hold up
 * the others' grace windows. Returns the pids we actually targeted.
 */
export async function reclaimPids(targetPids: number[], ourPid: number, deps: KillDeps): Promise<number[]> {
  const victims = selectReclaimablePids(targetPids, ourPid);
  if (victims.length === 0) return [];
  deps.logWarn(`[Main] reclaim: taking over from ${victims.length} instance(s) [${victims.join(', ')}]`);
  await Promise.all(victims.map((pid) => killWithGrace(pid, deps)));
  return victims;
}

/**
 * DEV single-child guarantee: kill every previous dev main process (found by
 * title), skipping our own. Runs before the DB or any IMAP connection opens so a
 * Ctrl+C orphan can't stack Gmail connections against the new run.
 */
export async function reclaimSingleDevInstance(deps: DevReclaimDeps): Promise<void> {
  await reclaimPids(deps.listPidsByTitle(), deps.ourPid, deps);
}

/**
 * PROD contention: given a failed lock acquire, read the heartbeat and decide
 * whether the current holder is healthy (defer) or wedged (reclaim). Returns the
 * holder pid so the caller can target exactly it — never a title sweep, which in
 * prod could in theory catch a helper — keeping the kill precise.
 */
export function evaluateLockContention(deps: HeartbeatDeps): {
  action: LockContentionAction;
  holderPid: number | null;
} {
  const heartbeat = deps.readHeartbeat();
  if (!heartbeat) return { action: 'defer', holderPid: null };

  const holderAlive = deps.isAlive(heartbeat.pid);
  const action = decideLockContention({
    heartbeatPresent: true,
    heartbeatStale: isHeartbeatStale(heartbeat.ts, deps.now(), HEARTBEAT_STALE_MS),
    holderAlive,
    // Only probe identity when it can matter (alive + otherwise reclaimable).
    holderIsOurApp: holderAlive && deps.isOurApp(heartbeat.pid),
  });
  return { action, holderPid: heartbeat.pid };
}

// ---------------------------------------------------------------------------
// Default (side-effecting) dep factories for the running Electron main process.
// ---------------------------------------------------------------------------

// signal 0 tests for existence without delivering a signal. ESRCH = gone;
// EPERM = exists but owned by another user (still alive).
function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

/** True if `pid`'s command line / image name contains ANY of `markers`. */
function processMatchesAny(pid: number, markers: string[]): boolean {
  try {
    if (process.platform === 'win32') {
      const out = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' });
      const text = out.stdout ?? '';
      return markers.some((marker) => text.includes(marker));
    }
    const out = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
    const text = out.stdout ?? '';
    return markers.some((marker) => text.includes(marker));
  } catch {
    return false; // can't verify → treat as not-ours → never kill
  }
}

/** Real {@link KillDeps} for the given logger. */
export function defaultKillDeps(logger: { info: (m: string) => void; warn: (m: string) => void }): KillDeps {
  return {
    isAlive: processIsAlive,
    kill: (pid, signal) => process.kill(pid, signal),
    now: () => Date.now(),
    sleep: (ms) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }),
    logInfo: (message) => logger.info(message),
    logWarn: (message) => logger.warn(message),
  };
}

/** Real DEV reclaim deps (title sweep via pgrep on posix; skipped on Windows). */
export function defaultDevReclaimDeps(logger: { info: (m: string) => void; warn: (m: string) => void }): DevReclaimDeps {
  return {
    ...defaultKillDeps(logger),
    ourPid: process.pid,
    listPidsByTitle: () => {
      try {
        if (process.platform === 'win32') {
          // process.title doesn't change the tasklist image name on Windows, so a
          // title sweep can't work there — rely on the ppid watchdog instead.
          return [];
        }
        const out = spawnSync('pgrep', ['-f', DEV_MAIN_PROCESS_TITLE], { encoding: 'utf8' });
        return (out.stdout ?? '')
          .split('\n')
          .map((line) => Number.parseInt(line.trim(), 10))
          .filter((pid) => Number.isInteger(pid) && pid > 0);
      } catch {
        return [];
      }
    },
  };
}

/**
 * Real PROD contention deps. Identity is confirmed against our unique main-process
 * title AND the packaged product name — either alone is enough, which is what lets
 * a platform skip one of them:
 * - Linux: the title (process.title rewrites argv there).
 * - Windows: the product name; process.title does not change the tasklist image
 *   name, but the exe is "Sarv Inbox.exe", so the image name matches.
 * - macOS: the product name. The title is deliberately NOT set on a packaged mac
 *   build (it would rename the app in the menu bar — see shouldTagMainProcess),
 *   and the main process runs as ".../Sarv Inbox.app/Contents/MacOS/Sarv Inbox",
 *   so the product name is already in its command line.
 */
export function defaultHeartbeatDeps(userDataDir: string, productName: string): HeartbeatDeps {
  const file = join(userDataDir, HEARTBEAT_FILE);
  return {
    readHeartbeat: () => readHeartbeatFile(file),
    isAlive: processIsAlive,
    isOurApp: (pid) => processMatchesAny(pid, [MAIN_PROCESS_TITLE, productName]),
    now: () => Date.now(),
  };
}

// ---------------------------------------------------------------------------
// PROD heartbeat file lifecycle (only the lock-holding primary writes it).
// ---------------------------------------------------------------------------

function readHeartbeatFile(file: string): InstanceHeartbeat | null {
  try {
    if (!existsSync(file)) return null;
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<InstanceHeartbeat>;
    if (Number.isInteger(parsed?.pid) && Number.isFinite(parsed?.ts)) {
      return { pid: parsed.pid as number, ts: parsed.ts as number };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Start writing our liveness heartbeat every {@link HEARTBEAT_INTERVAL_MS} while we
 * hold the lock. Returns a stop function that clears the timer AND removes the file
 * (a clean exit leaves nothing behind; a crash/wedge leaves a stale file the next
 * launch judges). `.unref()` so the timer never keeps the process alive.
 */
export function startHeartbeat(userDataDir: string): () => void {
  const file = join(userDataDir, HEARTBEAT_FILE);
  const write = () => {
    try {
      writeFileSync(file, JSON.stringify({ pid: process.pid, ts: Date.now() }));
    } catch {
      // Non-fatal: a missing heartbeat just makes the next launch defer to the lock.
    }
  };
  write(); // stamp immediately so a fast relaunch sees a fresh beat
  const timer = setInterval(write, HEARTBEAT_INTERVAL_MS);
  timer.unref?.();
  return () => {
    clearInterval(timer);
    try {
      if (existsSync(file)) rmSync(file);
    } catch {
      // Best-effort.
    }
  };
}
