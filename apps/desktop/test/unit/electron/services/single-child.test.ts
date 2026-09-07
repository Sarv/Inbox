import { describe, it, expect, vi } from 'vitest';

import {
  evaluateLockContention,
  reclaimPids,
  reclaimSingleDevInstance,
  startHeartbeat,
  tagMainProcess,
  type DevReclaimDeps,
  type HeartbeatDeps,
  type KillDeps,
} from '../../../../electron/services/single-child';
import {
  DEV_MAIN_PROCESS_TITLE,
  MAIN_PROCESS_TITLE,
  type InstanceHeartbeat,
} from '../../../../electron/services/single-instance';

/**
 * These tests drive the single-instance IO with injected deps + a fake clock so no
 * real process is ever listed, signalled, or killed.
 */

interface KillHarness {
  base: KillDeps;
  killed: Array<[number, NodeJS.Signals]>;
}

function makeKillDeps(overrides: Partial<KillDeps> = {}): KillHarness {
  let clock = 0;
  const killed: Array<[number, NodeJS.Signals]> = [];
  const base: KillDeps = {
    isAlive: () => false,
    kill: (pid, signal) => { killed.push([pid, signal]); },
    now: () => clock,
    // Advancing the clock inside sleep() is what lets the grace loop terminate
    // deterministically without real timers.
    sleep: async (ms) => { clock += ms; },
    logInfo: () => {},
    logWarn: () => {},
    ...overrides,
  };
  return { base, killed };
}

function makeDevDeps(overrides: Partial<DevReclaimDeps> = {}): { deps: DevReclaimDeps; killed: Array<[number, NodeJS.Signals]> } {
  const { base, killed } = makeKillDeps(overrides);
  const deps: DevReclaimDeps = {
    ...base,
    ourPid: 1000,
    listPidsByTitle: () => [1000],
    ...overrides,
  };
  return { deps, killed };
}

/**
 * The dev reclaim guarantees a single dev child: on launch it kills any previous
 * instance (a Ctrl+C orphan still holding Gmail connections) BEFORE this run opens
 * the DB or a socket.
 */
describe('reclaimSingleDevInstance', () => {
  // Regression: a clean first launch (only our own pid carries the title) must NOT
  // signal anything — a stray kill here would make the app suicide on startup.
  it('does nothing when we are the only instance', async () => {
    const { deps, killed } = makeDevDeps({ listPidsByTitle: () => [1000] });
    await reclaimSingleDevInstance(deps);
    expect(killed).toEqual([]);
  });

  // The core case: a leftover orphan exits promptly on SIGTERM, so we never
  // escalate to SIGKILL. If SIGTERM weren't sent the orphan keeps its Gmail
  // connections and the new run stacks on top of it.
  it('SIGTERMs a previous instance that exits gracefully (no SIGKILL)', async () => {
    const { deps, killed } = makeDevDeps({
      listPidsByTitle: () => [999, 1000],
      isAlive: () => false, // already gone by the first poll after SIGTERM
    });
    await reclaimSingleDevInstance(deps);
    expect(killed).toEqual([[999, 'SIGTERM']]);
  });

  // Regression for the WEDGED orphan — a beachballed main thread never processes
  // SIGTERM, so we MUST escalate to SIGKILL after the grace window. This is the
  // whole reason kill-old-on-startup beats a self-quit watchdog.
  it('escalates to SIGKILL when a previous instance stays alive (wedged)', async () => {
    const { deps, killed } = makeDevDeps({
      listPidsByTitle: () => [999, 1000],
      isAlive: () => true, // never dies on its own
    });
    await reclaimSingleDevInstance(deps);
    expect(killed).toContainEqual([999, 'SIGTERM']);
    expect(killed).toContainEqual([999, 'SIGKILL']);
  });

  // Multiple orphans can accumulate across crashed runs; reclaim must clear ALL of
  // them or connections keep stacking against Gmail's cap.
  it('reclaims every previous instance, skipping our own pid', async () => {
    const { deps, killed } = makeDevDeps({
      ourPid: 1000,
      listPidsByTitle: () => [111, 222, 1000],
      isAlive: () => false,
    });
    await reclaimSingleDevInstance(deps);
    expect(killed).toEqual([[111, 'SIGTERM'], [222, 'SIGTERM']]);
  });

  // A pid that vanished between the listing and the signal (ESRCH) makes kill()
  // throw; that must be swallowed and must NOT escalate to SIGKILL on a dead pid.
  it('tolerates a previous instance that dies before we signal it', async () => {
    const isAlive = vi.fn(() => false);
    const { deps, killed } = makeDevDeps({
      listPidsByTitle: () => [999, 1000],
      isAlive,
      kill: (_pid, _signal) => { throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' }); },
    });
    await reclaimSingleDevInstance(deps);
    expect(killed).toEqual([]); // kill threw → nothing recorded, no escalation
    // We returned immediately on the throw rather than polling liveness.
    expect(isAlive).not.toHaveBeenCalled();
  });
});

/**
 * `reclaimPids` is the shared kill primitive prod uses to take over exactly one
 * wedged holder pid (not a title sweep). Pinning it directly guards the prod path.
 */
describe('reclaimPids', () => {
  // Prod reclaim targets the single wedged-holder pid from the heartbeat.
  it('kills the one targeted holder pid and returns it', async () => {
    const { base, killed } = makeKillDeps({ isAlive: () => false });
    const victims = await reclaimPids([54321], 1000, base);
    expect(victims).toEqual([54321]);
    expect(killed).toEqual([[54321, 'SIGTERM']]);
  });

  // Safety: even if the holder pid happens to equal ours, never signal ourselves.
  it('never signals our own pid', async () => {
    const { base, killed } = makeKillDeps();
    const victims = await reclaimPids([1000], 1000, base);
    expect(victims).toEqual([]);
    expect(killed).toEqual([]);
  });
});

/**
 * `evaluateLockContention` decides whether a prod launch that failed to get the
 * lock should surface the existing primary (defer) or reclaim a wedged one. The
 * dangerous mistake would be reclaiming a HEALTHY primary, so these lock down every
 * guard.
 */
describe('evaluateLockContention', () => {
  function makeHeartbeatDeps(
    heartbeat: InstanceHeartbeat | null,
    overrides: Partial<HeartbeatDeps> = {},
  ): HeartbeatDeps {
    return {
      readHeartbeat: () => heartbeat,
      isAlive: () => true,
      isOurApp: () => true,
      now: () => 1_000_000,
      ...overrides,
    };
  }

  // No heartbeat file → we can't judge the holder → defer to the lock (exit). This
  // is the first-run / older-version case and must never trigger a kill.
  it('defers when there is no heartbeat', () => {
    const result = evaluateLockContention(makeHeartbeatDeps(null));
    expect(result).toEqual({ action: 'defer', holderPid: null });
  });

  // Regression: a HEALTHY primary ticks its heartbeat, so a fresh timestamp must
  // NEVER be reclaimed — killing a working app is the worst outcome.
  it('defers to a healthy primary (fresh heartbeat)', () => {
    const deps = makeHeartbeatDeps({ pid: 4242, ts: 1_000_000 - 2_000 }); // 2s old
    expect(evaluateLockContention(deps)).toEqual({ action: 'defer', holderPid: 4242 });
  });

  // The target case: the primary's heartbeat is far stale (wedged), it's still
  // alive, and it's verified as our app → reclaim it, reporting its pid.
  it('reclaims a wedged primary (stale heartbeat, alive, ours)', () => {
    const deps = makeHeartbeatDeps({ pid: 4242, ts: 1_000_000 - 60_000 }); // 60s old
    expect(evaluateLockContention(deps)).toEqual({ action: 'reclaim', holderPid: 4242 });
  });

  // Stale but the recorded holder is already dead → nothing to reclaim; defer (the
  // lock will be free for the normal acquire path).
  it('defers when the stale holder is no longer alive', () => {
    const deps = makeHeartbeatDeps(
      { pid: 4242, ts: 1_000_000 - 60_000 },
      { isAlive: () => false },
    );
    expect(evaluateLockContention(deps)).toEqual({ action: 'defer', holderPid: 4242 });
  });

  // Regression / PID-REUSE guard: the pid is stale AND alive but is NOT our app —
  // some unrelated process reused the recorded pid. Killing it would be data loss,
  // so we must defer.
  it('defers when a stale, alive pid is NOT our app (pid reused)', () => {
    const deps = makeHeartbeatDeps(
      { pid: 4242, ts: 1_000_000 - 60_000 },
      { isOurApp: () => false },
    );
    expect(evaluateLockContention(deps)).toEqual({ action: 'defer', holderPid: 4242 });
  });
});

describe('tagMainProcess', () => {
  // The reclaim finds the previous instance by this title; if tagging silently
  // failed the next launch could never reclaim us. Also must never throw at startup.
  //
  // Asserts the ASSIGNMENT rather than reading process.title back: the OS is not
  // obliged to keep what we set. Linux only retains a title that fits the original
  // argv buffer, so under the CI runner the read-back returns 'node (vitest)' and a
  // read-back assertion fails on Linux while passing on macOS. What this module owes
  // its caller is that it assigns the title and swallows any failure.
  it('assigns the given main-process title without throwing', () => {
    const original = Object.getOwnPropertyDescriptor(process, 'title');
    const assigned: string[] = [];
    Object.defineProperty(process, 'title', {
      configurable: true,
      get: () => assigned[assigned.length - 1] ?? '',
      set: (value: string) => {
        assigned.push(value);
      },
    });

    try {
      expect(() => tagMainProcess(MAIN_PROCESS_TITLE)).not.toThrow();
      tagMainProcess(DEV_MAIN_PROCESS_TITLE);
    } finally {
      if (original) Object.defineProperty(process, 'title', original);
    }

    expect(assigned).toEqual([MAIN_PROCESS_TITLE, DEV_MAIN_PROCESS_TITLE]);
  });

  // The setter throws on some platforms; startup must survive it, so the catch in
  // tagMainProcess has to stay. Without it a failed tag would abort app launch.
  it('swallows a throwing process.title setter', () => {
    const original = Object.getOwnPropertyDescriptor(process, 'title');
    Object.defineProperty(process, 'title', {
      configurable: true,
      get: () => '',
      set: () => {
        throw new Error('EPERM');
      },
    });

    try {
      expect(() => tagMainProcess(MAIN_PROCESS_TITLE)).not.toThrow();
    } finally {
      if (original) Object.defineProperty(process, 'title', original);
    }
  });
});

describe('startHeartbeat', () => {
  // The prod primary must leave a FRESH beat immediately on startup so a fast
  // relaunch reads a healthy primary (and defers) rather than a stale one (and
  // reclaims). Then stop() must remove the file so a clean exit leaves nothing for
  // the next launch to misjudge.
  it('writes an immediate heartbeat and removes it on stop', () => {
    // Use the scratchpad-adjacent OS temp via a unique subdir under cwd's tmp.
    const os = require('node:os');
    const fs = require('node:fs');
    const path = require('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sarv-hb-'));
    const file = path.join(dir, 'instance-heartbeat.json');
    try {
      const stop = startHeartbeat(dir);
      expect(fs.existsSync(file)).toBe(true);
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      expect(parsed.pid).toBe(process.pid);
      expect(typeof parsed.ts).toBe('number');
      stop();
      expect(fs.existsSync(file)).toBe(false);
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});
