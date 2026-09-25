import { describe, it, expect, vi } from 'vitest';

import {
  evaluateLockContention,
  reclaimPids,
  readDevInstancePid,
  reclaimSingleDevInstance,
  startDevInstanceRecord,
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
    // Default: nothing recorded (a clean first launch). Each test opts in.
    readRecordedPid: () => null,
    isOurApp: () => true,
    ...overrides,
  };
  return { deps, killed };
}

/**
 * The dev reclaim guarantees a single dev child: on launch it reads the pid the
 * previous dev main recorded under userData and kills it (a Ctrl+C orphan still
 * holding Gmail connections) BEFORE this run opens the DB or a socket.
 *
 * CHANGED: this used to sweep the process table for the dev process title. It
 * targets the recorded pid instead — exact, works on Windows, and it frees macOS
 * from carrying a title AppKit would draw in the menu bar.
 */
describe('reclaimSingleDevInstance', () => {
  // Regression: a clean first launch (or one after a clean quit, which removes the
  // record) must NOT signal anything — a stray kill here would make the app
  // suicide on startup.
  it('does nothing when no previous instance recorded a pid', async () => {
    const { deps, killed } = makeDevDeps({ readRecordedPid: () => null });
    await reclaimSingleDevInstance(deps);
    expect(killed).toEqual([]);
  });

  // The core case: a leftover orphan exits promptly on SIGTERM, so we never
  // escalate to SIGKILL. If SIGTERM weren't sent the orphan keeps its Gmail
  // connections and the new run stacks on top of it.
  it('SIGTERMs the recorded previous instance when it exits gracefully', async () => {
    let probes = 0;
    const { deps, killed } = makeDevDeps({
      readRecordedPid: () => 999,
      // Alive for the pre-kill liveness probe, gone by the first poll after SIGTERM.
      isAlive: () => probes++ === 0,
    });
    await reclaimSingleDevInstance(deps);
    expect(killed).toEqual([[999, 'SIGTERM']]);
  });

  // Regression for the WEDGED orphan — a beachballed main thread never processes
  // SIGTERM, so we MUST escalate to SIGKILL after the grace window. This is the
  // whole reason kill-old-on-startup beats a self-quit watchdog.
  it('escalates to SIGKILL when the recorded instance stays alive (wedged)', async () => {
    const { deps, killed } = makeDevDeps({
      readRecordedPid: () => 999,
      isAlive: () => true, // never dies on its own
    });
    await reclaimSingleDevInstance(deps);
    expect(killed).toContainEqual([999, 'SIGTERM']);
    expect(killed).toContainEqual([999, 'SIGKILL']);
  });

  // Regression: a record left by a process that already exited is the ordinary
  // case after a crash. Nothing to signal — and the pid may since have been
  // recycled, so signalling it anyway would be actively dangerous.
  it('does not signal a recorded pid that is no longer alive', async () => {
    const isOurApp = vi.fn(() => true);
    const { deps, killed } = makeDevDeps({
      readRecordedPid: () => 999,
      isAlive: () => false,
      isOurApp,
    });
    await reclaimSingleDevInstance(deps);
    expect(killed).toEqual([]);
    // Dead pid → we never pay for the `ps`/`tasklist` identity probe.
    expect(isOurApp).not.toHaveBeenCalled();
  });

  // THE pid-reuse regression, and the reason this path verifies identity at all:
  // the recorded number is alive but belongs to an unrelated process. Killing it
  // would destroy someone else's work.
  it('never kills a live recorded pid that is not our app', async () => {
    const { deps, killed } = makeDevDeps({
      readRecordedPid: () => 999,
      isAlive: () => true,
      isOurApp: () => false,
    });
    await reclaimSingleDevInstance(deps);
    expect(killed).toEqual([]);
  });

  // Self-suicide guard: a record holding our OWN pid (a crash mid-launch, or a
  // recycled number that landed on us) must never make the app signal itself.
  it('never signals our own pid', async () => {
    const { deps, killed } = makeDevDeps({
      ourPid: 1000,
      readRecordedPid: () => 1000,
      isAlive: () => true,
    });
    await reclaimSingleDevInstance(deps);
    expect(killed).toEqual([]);
  });

  // A pid that vanished between the probe and the signal (ESRCH) makes kill()
  // throw; that must be swallowed and must NOT escalate to SIGKILL on a dead pid.
  it('tolerates a previous instance that dies before we signal it', async () => {
    const isAlive = vi.fn(() => true);
    const { deps, killed } = makeDevDeps({
      readRecordedPid: () => 999,
      isAlive,
      kill: (_pid, _signal) => { throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' }); },
    });
    await reclaimSingleDevInstance(deps);
    expect(killed).toEqual([]); // kill threw → nothing recorded, no escalation
    // Only the single pre-kill liveness probe ran; the grace loop never polled.
    expect(isAlive).toHaveBeenCalledTimes(1);
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

/**
 * The dev pid record is the whole basis of the dev reclaim: written on startup,
 * read by the NEXT launch, removed on a clean quit. If the round trip breaks, dev
 * silently loses its single-child guarantee — two mains, two IMAP connection sets.
 */
describe('startDevInstanceRecord / readDevInstancePid', () => {
  // Regression: the record must be readable by pid the moment it is written (the
  // next launch can come seconds later), and stop() must remove it so a cleanly
  // quit run leaves no pid for the next launch to probe and possibly mis-kill.
  it('records our pid immediately and removes it on stop', () => {
    const os = require('node:os');
    const fs = require('node:fs');
    const path = require('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sarv-dev-'));
    try {
      const stop = startDevInstanceRecord(dir);
      expect(readDevInstancePid(dir)).toBe(process.pid);
      // A separate file from the prod heartbeat: dev and prod userData dirs differ,
      // but the two records must never be able to alias each other.
      expect(fs.existsSync(path.join(dir, 'instance-heartbeat.json'))).toBe(false);
      stop();
      expect(readDevInstancePid(dir)).toBeNull();
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  // Regression for the vite hot-restart handover: the replacement dev main writes
  // its record while THIS one is still tearing down. Removing a record that no
  // longer names us would leave the launch after that with nothing to reclaim.
  it('leaves a record rewritten by a replacement process alone', () => {
    const os = require('node:os');
    const fs = require('node:fs');
    const path = require('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sarv-dev-'));
    try {
      const stop = startDevInstanceRecord(dir);
      // Stand in for the incoming process claiming the record.
      fs.writeFileSync(path.join(dir, 'dev-instance.json'), JSON.stringify({ pid: process.pid + 1, ts: Date.now() }));
      stop();
      expect(readDevInstancePid(dir)).toBe(process.pid + 1);
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  // Defensive: a truncated or hand-edited record must read as "no record" (defer to
  // the ppid watchdog), never as a pid to signal.
  it('reads a missing or corrupt record as no pid', () => {
    const os = require('node:os');
    const fs = require('node:fs');
    const path = require('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sarv-dev-'));
    try {
      expect(readDevInstancePid(dir)).toBeNull();
      fs.writeFileSync(path.join(dir, 'dev-instance.json'), '{ "pid": ');
      expect(readDevInstancePid(dir)).toBeNull();
      fs.writeFileSync(path.join(dir, 'dev-instance.json'), '{"pid":"nope","ts":1}');
      expect(readDevInstancePid(dir)).toBeNull();
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});
