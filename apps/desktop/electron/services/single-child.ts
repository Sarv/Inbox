/**
 * Single-instance enforcement IO for BOTH builds. One mechanism — each running main
 * process records its pid in a file under userData — with two policies layered on
 * top:
 *
 * - DEV: there is no OS lock (it would fight vite's hot-restart), and the failure
 *   mode is an ORPHAN — a Ctrl+C'd launcher leaves the Electron child re-parented
 *   to launchd. So dev ALWAYS wins on startup: read the pid the previous run
 *   recorded, verify it is still our app, and kill it before we open the DB or a
 *   socket.
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
import { basename, join } from 'node:path';

import {
  decideLockContention,
  DEV_MAIN_PROCESS_TITLE,
  isHeartbeatStale,
  MAIN_PROCESS_TITLE,
  selectReclaimablePids,
  shouldReclaimRecordedDevPid,
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

/**
 * File under the DEV userData dir holding the running dev main's pid, so the NEXT
 * dev launch can reclaim exactly it. Same {pid, ts} record as the prod heartbeat —
 * dev simply ignores the timestamp, because a dev orphan is reclaimed whether it is
 * wedged or perfectly healthy (there is only ever meant to be one dev child).
 */
const DEV_INSTANCE_FILE = 'dev-instance.json';

/** Signalling + timing primitives shared by every reclaim path. */
export interface KillDeps {
  isAlive: (pid: number) => boolean;
  kill: (pid: number, signal: NodeJS.Signals) => void;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  logInfo: (message: string) => void;
  logWarn: (message: string) => void;
}

/**
 * DEV reclaim deps: read the pid the previous dev main recorded, prove it is still
 * our app, then kill it via {@link KillDeps} (whose `isAlive` doubles as the
 * liveness probe).
 */
export interface DevReclaimDeps extends KillDeps {
  ourPid: number;
  readRecordedPid: () => number | null;
  isOurApp: (pid: number) => boolean;
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
 * DEV single-child guarantee: kill the previous dev main process, identified by the
 * pid it recorded under userData. Runs before the DB or any IMAP connection opens so
 * a Ctrl+C orphan can't stack Gmail connections against the new run.
 *
 * The probes are ordered cheapest-first and short-circuit: a dead pid (the ordinary
 * case after a clean quit) never pays for the `ps`/`tasklist` identity check.
 */
export async function reclaimSingleDevInstance(deps: DevReclaimDeps): Promise<void> {
  const recordedPid = deps.readRecordedPid();
  if (recordedPid === null) return;
  const pidAlive = deps.isAlive(recordedPid);
  const reclaimable = shouldReclaimRecordedDevPid({
    recordedPid,
    ourPid: deps.ourPid,
    pidAlive,
    pidIsOurApp: pidAlive && deps.isOurApp(recordedPid),
  });
  if (!reclaimable) return;
  await reclaimPids([recordedPid], deps.ourPid, deps);
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

/**
 * Real DEV reclaim deps. Works on all three platforms — the pid comes from our own
 * file, not from the process table — which is what the previous `pgrep -f <title>`
 * sweep could not do (Windows never sees `process.title`, so dev there had no
 * reclaim at all and relied solely on the ppid watchdog).
 *
 * Identity is confirmed against any of three markers, so no platform is left
 * without one:
 * - the Electron binary this run was started from (`process.execPath`), which in
 *   dev is the repo's own `node_modules/electron/...` — the macOS marker, since the
 *   dev main is no longer titled there,
 * - its bare file name, for Windows, where `tasklist` reports an image name
 *   (`electron.exe`) rather than a full path,
 * - the dev title, for Linux, where `process.title` rewrites argv so the command
 *   line reads `sarvinbox-dev-main` and the exec path may no longer appear.
 * Failing to match any of them means we leave the pid alone (see
 * {@link shouldReclaimRecordedDevPid}) — a recycled pid is never signalled.
 */
export function defaultDevReclaimDeps(
  logger: { info: (m: string) => void; warn: (m: string) => void },
  userDataDir: string,
): DevReclaimDeps {
  return {
    ...defaultKillDeps(logger),
    ourPid: process.pid,
    readRecordedPid: () => readDevInstancePid(userDataDir),
    isOurApp: (pid) => processMatchesAny(pid, [
      process.execPath,
      basename(process.execPath),
      DEV_MAIN_PROCESS_TITLE,
    ]),
  };
}

/** The pid recorded by the running/previous dev main, or null if there is none. */
export function readDevInstancePid(userDataDir: string): number | null {
  return readPidRecord(join(userDataDir, DEV_INSTANCE_FILE))?.pid ?? null;
}

/**
 * Real PROD contention deps. Identity is confirmed against our unique main-process
 * title AND the packaged product name — either alone is enough, which is what lets
 * a platform skip one of them:
 * - Linux: the title (process.title rewrites argv there).
 * - Windows: the product name; process.title does not change the tasklist image
 *   name, but the exe is "Sarv Inbox.exe", so the image name matches.
 * - macOS: the product name. The title is deliberately NOT set on mac at all
 *   (it would rename the app in its own menu bar — see shouldTagMainProcess),
 *   and the main process runs as ".../Sarv Inbox.app/Contents/MacOS/Sarv Inbox",
 *   so the product name is already in its command line.
 */
export function defaultHeartbeatDeps(userDataDir: string, productName: string): HeartbeatDeps {
  const file = join(userDataDir, HEARTBEAT_FILE);
  return {
    readHeartbeat: () => readPidRecord(file),
    isAlive: processIsAlive,
    isOurApp: (pid) => processMatchesAny(pid, [MAIN_PROCESS_TITLE, productName]),
    now: () => Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Pid-record file lifecycle. One implementation, two callers: the PROD heartbeat
// (written only by the lock-holding primary) and the DEV instance record.
// ---------------------------------------------------------------------------

function readPidRecord(file: string): InstanceHeartbeat | null {
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
 * launch judges).
 */
export function startHeartbeat(userDataDir: string): () => void {
  return startPidRecord(join(userDataDir, HEARTBEAT_FILE), HEARTBEAT_INTERVAL_MS);
}

/**
 * DEV counterpart: record THIS dev main's pid so the next dev launch can reclaim it.
 * Must be called AFTER {@link reclaimSingleDevInstance} has read the previous run's
 * record, or we would overwrite the very pid we are about to look for.
 *
 * Written ONCE, with no re-stamp timer: dev ignores the timestamp (an orphan is
 * reclaimed whether wedged or healthy), and a repeating write would be a liability
 * during a vite hot-restart — the outgoing process could re-stamp its own dying pid
 * over the record the incoming one just wrote, costing the launch after that its
 * reclaim.
 */
export function startDevInstanceRecord(userDataDir: string): () => void {
  return startPidRecord(join(userDataDir, DEV_INSTANCE_FILE), null);
}

/**
 * Write a {pid, ts} record to `file`, optionally re-stamping every `repeatEveryMs`.
 * Returns a stop function that clears the timer and removes the record.
 */
function startPidRecord(file: string, repeatEveryMs: number | null): () => void {
  const write = () => {
    try {
      writeFileSync(file, JSON.stringify({ pid: process.pid, ts: Date.now() }));
    } catch {
      // Non-fatal: a missing record just costs the next launch its reclaim —
      // prod defers to the lock, dev falls back to the ppid watchdog.
    }
  };
  write(); // stamp immediately so a fast relaunch sees the record, not an empty dir
  // `.unref()` so the timer never keeps the process alive.
  const timer = repeatEveryMs === null ? null : setInterval(write, repeatEveryMs);
  timer?.unref?.();
  return () => {
    if (timer) clearInterval(timer);
    removeOwnPidRecord(file);
  };
}

/**
 * Remove a pid record on the way out — but ONLY while it still names us.
 *
 * A clean exit must leave nothing behind (a stale record is what tells the next
 * launch the previous run died badly). The guard covers the handover window: a vite
 * hot-restart spawns the replacement process while this one is still tearing down,
 * so by the time we get here the file may already hold the NEW pid. Deleting that
 * would silently cost the launch after it its reclaim.
 */
function removeOwnPidRecord(file: string): void {
  try {
    if (readPidRecord(file)?.pid !== process.pid) return;
    rmSync(file);
  } catch {
    // Best-effort.
  }
}
