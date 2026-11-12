import { describe, expect, it } from 'vitest';

import { CI_SLOWDOWN, DEFAULT_TEST_TIMEOUT_MS, ciTimeout } from '../../../src/test-support/ci-timeout';
import {
  COST_CLOCK,
  cappedGrowthLimit,
  costClock,
  costRatio,
  fastestCosts,
  growthRatio,
  linearGrowthLimit,
  threadCpuClock,
} from '../../../src/test-support/complexity';

// Every ReDoS / complexity guard in the suite asserts through these helpers.
// If they stop telling linear cost from quadratic, those guards pass whatever
// the code does, and nobody notices until an email freezes the app.

/** A clock that moves only when a workload says it spent time. */
function fakeClock() {
  let now = 0;
  return {
    clock: () => now,
    spend: (ms: number) => { now += ms; },
  };
}

describe('threadCpuClock / costClock', () => {
  // Breaks: thread CPU time is read where it ticks in ~15.6 ms steps (Windows),
  // so every fast workload measures 0 and every ratio is NaN or Infinity.
  it('refuses Windows and a Node without threadCpuUsage, and falls back to the wall clock', () => {
    expect(threadCpuClock({ platform: 'win32', threadCpuUsage: () => ({ user: 1, system: 1 }) })).toBeNull();
    expect(threadCpuClock({ platform: 'linux' })).toBeNull();

    const wall = costClock({ platform: 'win32' });
    const before = performance.now();
    const reading = wall();
    expect(reading).toBeGreaterThanOrEqual(before);
    expect(reading).toBeLessThanOrEqual(performance.now());
  });

  // Breaks: the clock reads only user time (system time is CPU spent on this
  // thread too), or reads microseconds as milliseconds.
  it('reads user + system microseconds as milliseconds', () => {
    let usage = { user: 1_500, system: 500 };
    const proc = { platform: 'linux', threadCpuUsage: () => usage };
    const clock = threadCpuClock(proc)!;
    expect(clock()).toBe(2);
    usage = { user: 4_000, system: 1_000 };
    expect(clock()).toBe(5);
    expect(costClock(proc)()).toBe(5);
  });

  // Breaks: the default clock does not advance with work done on this thread.
  it('advances the default clock with work done on this thread', () => {
    const start = COST_CLOCK();
    let x = 0;
    for (let i = 0; i < 2_000_000; i += 1) x += Math.sqrt(i);
    expect(x).toBeGreaterThan(0);
    expect(COST_CLOCK()).toBeGreaterThan(start);
  });
});

describe('fastestCosts', () => {
  // Breaks: one slow round (a GC pause, a busy neighbour) decides the cost.
  it('takes the fastest round of each workload', () => {
    const { clock, spend } = fakeClock();
    const costs = [5, 2, 9];
    let round = 0;
    const [cost] = fastestCosts([() => spend(costs[round++])], { clock, rounds: 3, minSampleMs: 1, budgetMs: 1e9 });
    expect(cost).toBe(2);
  });

  // Breaks: the workloads are timed back to back, so a burst of load lands on
  // one side of the ratio only.
  it('interleaves the workloads, round by round', () => {
    const { clock, spend } = fakeClock();
    const order: string[] = [];
    fastestCosts(
      [() => { order.push('a'); spend(3); }, () => { order.push('b'); spend(3); }],
      { clock, rounds: 3, minSampleMs: 1, budgetMs: 1e9 },
    );
    expect(order.join('')).toBe('ababab');
  });

  // Breaks: a call shorter than the clock's resolution is timed alone, so the
  // small side of a ratio is noise.
  it('repeats a fast workload until the sample is long enough, and averages it', () => {
    const { clock, spend } = fakeClock();
    let calls = 0;
    const [cost] = fastestCosts([() => { calls += 1; spend(0.5); }], { clock, rounds: 1, minSampleMs: 2 });
    expect(cost).toBe(0.5);
    expect(calls).toBe(7); // batches of 1, 2 and 4 calls: 3.5 ms
  });

  // Breaks: a regression that costs seconds per call runs every round, so the
  // failing test hangs CI for minutes instead of failing fast.
  it('starts no round past the budget, but always finishes one', () => {
    const { clock, spend } = fakeClock();
    let calls = 0;
    const work = () => { calls += 1; spend(3); };
    fastestCosts([work], { clock, rounds: 10, minSampleMs: 1, budgetMs: 5 });
    expect(calls).toBe(2); // 3 ms, then 6 ms: past 5, so no third round
    calls = 0;
    expect(fastestCosts([work], { clock, rounds: 10, minSampleMs: 1, budgetMs: 0 })).toEqual([3]);
    expect(calls).toBe(1);
  });

  // Breaks: a default stops being what the guards were sized for.
  it('defaults to seven rounds', () => {
    let calls = 0;
    const slow = () => {
      calls += 1;
      const until = COST_CLOCK() + 3;
      while (COST_CLOCK() < until) { /* spend 3 ms of this thread's CPU */ }
    };
    fastestCosts([slow]);
    expect(calls).toBe(7);
  });
});

describe('costRatio / growthRatio', () => {
  // Breaks: the ratio is upside down, so a slower workload reads as faster.
  it('divides the first workload by the second', () => {
    const { clock, spend } = fakeClock();
    expect(costRatio(() => spend(12), () => spend(3), { clock, rounds: 2, minSampleMs: 1 })).toBe(4);
  });

  // Breaks: building the input is timed with the work, or the large input is
  // not `factor` times the small one.
  it('builds each input once, before timing, at size and size × factor', () => {
    const { clock, spend } = fakeClock();
    const built: number[] = [];
    const input = (n: number) => { built.push(n); return n; };
    const linear = growthRatio(input, (n) => spend(n), { size: 10, clock, rounds: 2, minSampleMs: 1 });
    expect(built).toEqual([10, 80]);
    expect(linear).toBe(8);
    const quadratic = growthRatio((n) => n, (n) => spend((n * n) / 100), { size: 10, factor: 4, clock, rounds: 2, minSampleMs: 1 });
    expect(quadratic).toBe(16);
  });

  // Breaks: the limits stop sitting between the costs they separate.
  it('puts each limit at the geometric midpoint of the costs it separates', () => {
    expect(linearGrowthLimit()).toBeCloseTo(22.627, 3);
    expect(linearGrowthLimit(4)).toBe(8);
    expect(cappedGrowthLimit()).toBeCloseTo(2.828, 3);
    expect(cappedGrowthLimit(4)).toBe(2);
  });

  // Breaks: on a real clock the helper cannot tell linear work from quadratic,
  // and every guard built on it passes vacuously. Both workloads are plain
  // loops, far from either side of the limit.
  it('tells linear from quadratic work on the real clock', () => {
    const linear = growthRatio(
      (n) => Float64Array.from({ length: n }, (_, i) => i),
      (values) => { let sum = 0; for (const v of values) sum += v; return sum; },
      { size: 20_000 },
    );
    const quadratic = growthRatio(
      (n) => n,
      (n) => { let sum = 0; for (let i = 0; i < n; i += 1) for (let j = 0; j < n; j += 1) sum += i ^ j; return sum; },
      { size: 200 },
    );
    expect(linear).toBeLessThan(linearGrowthLimit());
    expect(quadratic).toBeGreaterThan(linearGrowthLimit());
  });
});

describe('ciTimeout', () => {
  // Breaks: a heavy test's timeout is sized for a laptop again, and the first
  // busy CI run times it out.
  it('scales the local time by the CI slowdown, rounded up to a second, never under the default', () => {
    expect(CI_SLOWDOWN).toBe(25);
    expect(ciTimeout(540)).toBe(14_000); // 13.5 s
    expect(ciTimeout(1_000)).toBe(25_000);
    expect(ciTimeout(10)).toBe(DEFAULT_TEST_TIMEOUT_MS);
    expect(DEFAULT_TEST_TIMEOUT_MS).toBe(5_000);
  });
});
