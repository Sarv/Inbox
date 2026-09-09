import { describe, it, expect, vi } from 'vitest';

import {
  attributeGap,
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

/**
 * Sleep attribution. A suspended machine cannot fire a timer, so the wall-clock
 * gap across sleep is not a freeze — but it was reported as one, and it buried
 * the real findings: one afternoon of macOS Power Naps produced 21 "the UI was
 * frozen (beachball)" warnings of which only 3 were genuine.
 *
 * The rule must not become "long gaps are sleep". An iCloud-synced checkout in
 * this very app made `stat()` block for 989 SECONDS, and that warning is what
 * found the bug — a duration ceiling would have hidden it. Hence positive
 * attribution from the suspend flag only.
 */
describe('attributeGap', () => {
  // The ordinary freeze: awake before and after. Getting this wrong silences
  // the detector completely.
  it('calls a gap with no suspension a freeze', () => {
    expect(attributeGap(false, false)).toBe('freeze');
  });

  // macOS DarkWake (Power Nap) fires no Electron `resume`, so the flag stays
  // true across a run of brief wakes. These were the bulk of the false warnings.
  it('calls a gap a sleep gap while still suspended (the DarkWake case)', () => {
    expect(attributeGap(true, true)).toBe('sleep');
  });

  // On a real user wake the resume handler clears the flag and races the tick
  // that reports the gap; they land in the same second. The "before" sample,
  // taken while asleep, is the only thing that catches this one.
  it('calls a gap a sleep gap when resume cleared the flag before the report', () => {
    expect(attributeGap(true, false)).toBe('sleep');
  });

  // Suspend observed only after the gap: still sleep, not a freeze.
  it('calls a gap a sleep gap when the suspend was seen only afterwards', () => {
    expect(attributeGap(false, true)).toBe('sleep');
  });
});

describe('describeStall', () => {
  // The exact defect being fixed: a sleep gap must NOT claim the UI froze.
  it('does not claim a freeze or a beachball for a sleep gap', () => {
    const message = describeStall(900_000, 'sleep');
    expect(message).not.toMatch(/frozen|beachball|blocked/i);
    expect(message).toMatch(/asleep/i);
    expect(message).toContain('900000');
  });

  // A real freeze keeps the wording that makes it findable in app.log, and the
  // pointer to the following lines that is its only attribution.
  it('still names the freeze and points at the next log lines', () => {
    const message = describeStall(2500, 'freeze');
    expect(message).toMatch(/blocked for 2500ms/);
    expect(message).toMatch(/beachball/);
    expect(message).toMatch(/immediately after/);
  });

  // main.ts is not the only caller; an omitted cause must stay a freeze so a
  // future caller can never accidentally downgrade a real one to sleep.
  it('defaults to freeze when no cause is given', () => {
    expect(describeStall(2500)).toBe(describeStall(2500, 'freeze'));
  });

  it('rounds fractional durations in both wordings', () => {
    expect(describeStall(2500.4, 'freeze')).toContain('2500ms');
    expect(describeStall(2500.6, 'sleep')).toContain('2501ms');
  });
});

describe('startEventLoopMonitor — sleep attribution', () => {
  /**
   * Harness with a scripted clock and a scripted suspend flag.
   *
   * `suspendedByTick` omitted entirely means no `isSuspended` dep at all — the
   * no-power-signal platform. `throws` makes the probe blow up instead.
   */
  const harness = (
    times: number[],
    suspendedByTick?: boolean[],
    opts: { throws?: boolean } = {},
  ) => {
    let timeIndex = 0;
    let flagIndex = 0;
    const reports: Array<{ ms: number; cause: string }> = [];
    const fired: Array<() => void> = [];
    const isSuspended = opts.throws
      ? () => { throw new Error('powerMonitor blew up'); }
      : suspendedByTick
        ? () => suspendedByTick[Math.min(flagIndex++, suspendedByTick.length - 1)] ?? false
        : undefined;
    startEventLoopMonitor({
      onStall: (ms, cause) => reports.push({ ms, cause }),
      tickMs: 500,
      thresholdMs: 250,
      now: () => times[Math.min(timeIndex++, times.length - 1)],
      ...(isSuspended ? { isSuspended } : {}),
      schedule: (callback) => { fired.push(callback); return {}; },
      cancel: () => {},
    });
    return { reports, fire: () => fired.forEach((f) => f()) };
  };

  // End to end for the DarkWake series: the flag is true at start-up sampling
  // and at the tick, so the multi-minute gap is a sleep gap.
  it('attributes a gap during suspension to sleep, not a freeze', () => {
    const h = harness([0, 900_000], [true, true]);
    h.fire();
    expect(h.reports).toEqual([{ ms: 899_500, cause: 'sleep' }]);
  });

  // The wake race, end to end: suspended when the monitor sampled before sleep,
  // cleared by the time the reporting tick reads it.
  it('attributes the wake gap to sleep even though resume already cleared the flag', () => {
    const h = harness([0, 400_000], [true, false]);
    h.fire();
    expect(h.reports).toEqual([{ ms: 399_500, cause: 'sleep' }]);
  });

  // THE regression that must not come back: a genuine block while awake — the
  // iCloud stat() case — has to keep reporting as a freeze.
  it('still reports a real freeze while awake, however long it is', () => {
    const h = harness([0, 989_000], [false, false]);
    h.fire();
    expect(h.reports).toEqual([{ ms: 988_500, cause: 'freeze' }]);
  });

  // A stale suspend must not shield later freezes. Once a tick has been seen
  // awake, the next block is attributed to the app again.
  it('goes back to reporting freezes after the machine wakes', () => {
    //          sleep gap        awake tick     real freeze
    const h = harness([0, 900_000, 900_500, 903_500], [true, false, false, false]);
    h.fire(); // the sleep gap
    h.fire(); // on time, awake
    h.fire(); // a real block
    expect(h.reports).toEqual([
      { ms: 899_500, cause: 'sleep' },
      { ms: 2500, cause: 'freeze' },
    ]);
  });

  // No power signal at all (headless Linux, or the dep omitted) must behave
  // exactly as before this change: everything is a freeze, nothing is hidden.
  it('reports every gap as a freeze when no suspend signal is available', () => {
    const h = harness([0, 900_000]); // no isSuspended dep at all
    h.fire();
    expect(h.reports).toEqual([{ ms: 899_500, cause: 'freeze' }]);
  });

  // A throwing flag reader must not take the monitor down with it, and must
  // fail toward "freeze" so a real block is never swallowed by a broken probe.
  it('survives a throwing suspend probe and treats the gap as a freeze', () => {
    const h = harness([0, 3000], undefined, { throws: true });
    expect(() => h.fire()).not.toThrow();
    expect(h.reports).toEqual([{ ms: 2500, cause: 'freeze' }]);
  });
});
