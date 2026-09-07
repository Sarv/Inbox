import { describe, it, expect, vi } from 'vitest';

import {
  describeStall,
  EVENT_LOOP_STALL_THRESHOLD_MS,
  EVENT_LOOP_TICK_MS,
  stallDuration,
  startEventLoopMonitor,
} from '../../../../electron/services/event-loop-monitor';

/**
 * This detector is the only thing that distinguishes "the main thread was frozen"
 * (beachball, a real perf bug) from "we were waiting on IMAP" (normal) — both of
 * which look identical as a gap between log lines. If its maths is wrong it
 * either cries wolf on ordinary timer jitter, or stays silent through the exact
 * freeze it exists to catch.
 */
describe('stallDuration', () => {
  // A tick that fires on time is not a stall. If this reported one, every healthy
  // app would spam a warning twice a second and the signal would be worthless.
  it('reports no stall for an on-time tick', () => {
    expect(stallDuration(500, 500, 250)).toBeNull();
  });

  // Ordinary jitter/GC below the threshold must stay quiet for the same reason.
  it('reports no stall for lateness under the threshold', () => {
    expect(stallDuration(700, 500, 250)).toBeNull();
  });

  // THE POINT: a tick that fired far late means the loop could not run anything
  // for that long — the UI was frozen. Missing this defeats the whole file.
  it('reports the LATENESS (not the elapsed time) for a real stall', () => {
    // 3000ms elapsed on a 500ms timer = 2500ms of frozen loop, not 3000.
    expect(stallDuration(3000, 500, 250)).toBe(2500);
  });

  // Boundary: exactly at the threshold counts, so a threshold of 250 can't be
  // silently a 251 in practice.
  it('counts lateness exactly at the threshold', () => {
    expect(stallDuration(750, 500, 250)).toBe(250);
  });

  it('does not count lateness one ms below the threshold', () => {
    expect(stallDuration(749, 500, 250)).toBeNull();
  });

  // An EARLY tick (clock stepped backwards via NTP, or a test's fake timers)
  // yields negative lateness. It must never surface as a stall — and must never
  // be reported as a negative duration, which would be nonsense in the log.
  it('never reports a stall for an early tick or a backwards clock', () => {
    expect(stallDuration(100, 500, 250)).toBeNull();
    expect(stallDuration(-1000, 500, 250)).toBeNull();
  });

  // The shipped defaults have to be sane: a sub-second freeze is worth knowing
  // about, and the threshold must exceed nothing-happened jitter.
  it('ships defaults that are finite and in a useful range', () => {
    expect(EVENT_LOOP_TICK_MS).toBeGreaterThan(0);
    expect(EVENT_LOOP_STALL_THRESHOLD_MS).toBeGreaterThan(0);
    expect(stallDuration(EVENT_LOOP_TICK_MS, EVENT_LOOP_TICK_MS, EVENT_LOOP_STALL_THRESHOLD_MS)).toBeNull();
    expect(stallDuration(EVENT_LOOP_TICK_MS + 2000, EVENT_LOOP_TICK_MS, EVENT_LOOP_STALL_THRESHOLD_MS)).toBe(2000);
  });
});

describe('startEventLoopMonitor', () => {
  /** Drives the monitor's timer by hand with a scripted clock. */
  const harness = (times: number[]) => {
    let index = 0;
    const stalls: number[] = [];
    let tick: (() => void) | null = null;
    const cancel = vi.fn();
    const stop = startEventLoopMonitor({
      onStall: (ms) => stalls.push(ms),
      tickMs: 500,
      thresholdMs: 250,
      now: () => times[Math.min(index++, times.length - 1)],
      schedule: (callback) => { tick = callback; return { unref: () => {} }; },
      cancel,
    });
    return { stalls, fire: () => tick?.(), stop, cancel };
  };

  // A healthy app must produce NO warnings at all — otherwise the log noise
  // trains everyone to ignore the one line that matters.
  it('stays silent while ticks are on time', () => {
    const h = harness([0, 500, 1000, 1500]);
    h.fire();
    h.fire();
    h.fire();
    expect(h.stalls).toEqual([]);
  });

  // The freeze this exists to catch: a 3s block shows up as one 2500ms stall.
  it('reports a stall once, with the frozen duration', () => {
    const h = harness([0, 3000]);
    h.fire();
    expect(h.stalls).toEqual([2500]);
  });

  // Regression: the baseline must advance to the CURRENT tick, not the last
  // on-time one. Otherwise one stall makes every subsequent tick look stalled
  // too and a single freeze reports forever.
  it('does not re-report a past stall on later healthy ticks', () => {
    const h = harness([0, 3000, 3500, 4000]);
    h.fire(); // the stall
    h.fire(); // on time again
    h.fire(); // still fine
    expect(h.stalls).toEqual([2500]);
  });

  // Two separate freezes are two separate findings — collapsing them would hide
  // a repeating per-folder block (exactly the sync case being investigated).
  it('reports each distinct stall', () => {
    const h = harness([0, 2000, 2500, 5000]);
    h.fire();
    h.fire();
    h.fire();
    expect(h.stalls).toEqual([1500, 2000]);
  });

  // Teardown must actually cancel the timer; a monitor left running during the
  // synchronous parts of shutdown reports noise, or keeps the process alive.
  it('cancels the timer on stop, and tolerates a double stop', () => {
    const h = harness([0, 500]);
    h.stop();
    h.stop();
    expect(h.cancel).toHaveBeenCalledTimes(1);
  });

  // A throwing/slow logger must not corrupt the baseline — the next tick has to
  // measure from the tick that threw, not from before it.
  it('keeps measuring correctly when onStall throws', () => {
    const times = [0, 3000, 3500];
    let index = 0;
    let tick: (() => void) | null = null;
    const seen: number[] = [];
    startEventLoopMonitor({
      onStall: (ms) => { seen.push(ms); throw new Error('logger blew up'); },
      tickMs: 500,
      thresholdMs: 250,
      now: () => times[Math.min(index++, times.length - 1)],
      schedule: (callback) => { tick = callback; return {}; },
      cancel: () => {},
    });

    expect(() => tick?.()).toThrow('logger blew up');
    expect(() => tick?.()).not.toThrow(); // baseline advanced → next tick is on time
    expect(seen).toEqual([2500]);
  });

  // The timer must be unref'd so it can never be the reason the app won't exit.
  it('unrefs its timer so it never holds the process open', () => {
    const unref = vi.fn();
    startEventLoopMonitor({
      onStall: () => {},
      schedule: () => ({ unref }),
      cancel: () => {},
    });
    expect(unref).toHaveBeenCalled();
  });

  // A runtime whose timer handle has no unref (or is a bare number) must not
  // crash startup — the monitor is diagnostic, never load-bearing.
  it('does not throw when the timer handle has no unref', () => {
    expect(() => startEventLoopMonitor({
      onStall: () => {},
      schedule: () => 1,
      cancel: () => {},
    })).not.toThrow();
  });

  // The DEFAULTS are what actually ship — main.ts passes only `onStall`. If the
  // real setInterval/clearInterval/Date.now wiring is wrong, every test above
  // still passes against injected fakes while production detects nothing.
  it('works on its real defaults: detects a stall and stops cleanly', async () => {
    vi.useFakeTimers();
    try {
      const stalls: number[] = [];
      const stop = startEventLoopMonitor({ onStall: (ms) => stalls.push(ms) });

      // On-time ticks under the default threshold stay silent...
      await vi.advanceTimersByTimeAsync(EVENT_LOOP_TICK_MS * 2);
      expect(stalls).toEqual([]);

      // ...while a frozen loop (clock jumps, timer fires late) is caught. Fake
      // timers move Date.now in lockstep, so stepping the clock without firing
      // the timer is exactly what a blocked loop looks like.
      vi.setSystemTime(Date.now() + 3000);
      await vi.advanceTimersByTimeAsync(EVENT_LOOP_TICK_MS);
      expect(stalls).toHaveLength(1);
      expect(stalls[0]).toBeGreaterThanOrEqual(3000);

      // And the real clearInterval must stop it: no further reports.
      stop();
      vi.setSystemTime(Date.now() + 5000);
      await vi.advanceTimersByTimeAsync(EVENT_LOOP_TICK_MS * 2);
      expect(stalls).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('describeStall', () => {
  // The message has to say it was a UI freeze AND point at the adjacent lines —
  // the stall cannot name its own cause, so the log has to tell the reader where
  // to look or the finding is useless.
  it('states the duration and where to look for the cause', () => {
    const message = describeStall(2500);
    expect(message).toContain('2500ms');
    expect(message).toContain('beachball');
    expect(message).toContain('after this line');
  });

  // Sub-millisecond precision in a log line is noise; a stall is a coarse thing.
  it('rounds fractional durations', () => {
    expect(describeStall(1234.56)).toContain('1235ms');
  });
});
