/**
 * Complexity checks for the tests that guard a slow pattern — a regex that
 * backtracks, a scan that went quadratic, a walk with no stop — written so they
 * hold on a loaded CI runner.
 *
 * Why not a wall-clock budget ("finishes in under 50 ms")? It measures the
 * runner as much as the code. CI runs every package's suite at once, with
 * coverage instrumentation, on shared vCPUs. On 2026-11-12 (PR #116, run
 * 43089649771) a call that takes 1.3 ms on a laptop measured 59 ms there,
 * fastest of three, and a test that takes 29 ms in a plain local run took
 * 2.4 s (82x). No fixed budget is both tight enough to catch a regression and
 * loose enough for that runner.
 *
 * What separates the bug from the fix on ANY machine is the shape of the cost:
 * how it grows with the input (8x the input costs ~8x when linear, ~64x when
 * quadratic, without bound when exponential), or how it compares with an
 * ordinary input of the same size. Both are ratios of two costs measured in the
 * same process at the same moment, so whatever slows the runner slows both
 * sides and cancels. Three measures keep the ratio honest under load:
 *
 * - The clock is this thread's CPU time (`process.threadCpuUsage`), so time the
 *   runner spends on OTHER processes, the bulk of CI noise, never reaches it.
 *   Where that clock is coarse (Windows counts it in ~15.6 ms ticks) or missing,
 *   it falls back to the wall clock.
 * - The workloads are measured INTERLEAVED, round by round, so a burst of load
 *   or a CPU frequency change lands on both sides rather than on one.
 * - Each workload's cost is its FASTEST round. Interference (a GC pause, JIT
 *   tier-up, caches flushed by a neighbour) only ever adds time, while a slow
 *   pattern is slow on every round, so the minimum is the honest cost.
 *
 * A regex cannot be interrupted, so size the inputs for the regression too: the
 * slow version should take seconds, not minutes, and the round budget below
 * stops after the first rounds that overrun it, so a regression fails fast.
 */

/** A monotonic reading in milliseconds. */
export type CostClock = () => number;

type ThreadCpuUsage = () => { user: number; system: number };

/**
 * This thread's CPU time, in ms, or null when the platform cannot give a
 * fine-grained one. `process.threadCpuUsage` needs Node 23.9+ / 22.19+; on
 * Windows it is backed by GetThreadTimes, which advances in scheduler ticks
 * (~15.6 ms) and so cannot time a call that takes 2 ms.
 */
export function threadCpuClock(
  proc: { platform: string; threadCpuUsage?: ThreadCpuUsage } = process,
): CostClock | null {
  const usage = proc.threadCpuUsage;
  if (proc.platform === 'win32' || typeof usage !== 'function') return null;
  return () => {
    const { user, system } = usage.call(proc);
    return (user + system) / 1000;
  };
}

const wallClock: CostClock = () => performance.now();

/** Thread CPU time where it is fine-grained, the wall clock anywhere else. */
export function costClock(
  proc: { platform: string; threadCpuUsage?: ThreadCpuUsage } = process,
): CostClock {
  return threadCpuClock(proc) ?? wallClock;
}

/** The clock the checks use by default. */
export const COST_CLOCK: CostClock = costClock();

export interface CostOptions {
  /** Rounds per workload; its cost is the fastest. Default 7. */
  rounds?: number;
  /**
   * A round repeats a fast workload until it has run at least this long, so the
   * clock's resolution and the cost of reading it stay a rounding error.
   * Default 2 ms.
   */
  minSampleMs?: number;
  /**
   * No new round starts once this much clock time is spent. A regression shows
   * on its first round, so this ends a run that would otherwise take minutes,
   * while a healthy workload never gets near it. Default 2,000 ms.
   */
  budgetMs?: number;
  /** For the helper's own tests. Default {@link COST_CLOCK}. */
  clock?: CostClock;
}

/** Keeps a workload's result reachable, so the call cannot be optimised away. */
let sink: unknown;

/** Cost of one call of `work`, averaged over a batch at least `minSampleMs` long. */
function sampleCost(work: () => unknown, minSampleMs: number, clock: CostClock): number {
  const start = clock();
  let calls = 0;
  // Double the batch between clock reads: a 10 µs call needs ~200 calls for a
  // 2 ms sample, but only ~8 readings of the clock.
  for (let batch = 1; ; batch *= 2) {
    for (let i = 0; i < batch; i += 1) sink = work();
    calls += batch;
    const elapsed = clock() - start;
    if (elapsed >= minSampleMs) return elapsed / calls;
  }
}

/**
 * The cost in ms of one call of each workload: the fastest of several rounds,
 * measured interleaved.
 */
export function fastestCosts(
  workloads: ReadonlyArray<() => unknown>,
  { rounds = 7, minSampleMs = 2, budgetMs = 2_000, clock = COST_CLOCK }: CostOptions = {},
): number[] {
  const best = workloads.map(() => Number.POSITIVE_INFINITY);
  const started = clock();
  for (let round = 0; round < rounds; round += 1) {
    workloads.forEach((work, i) => {
      best[i] = Math.min(best[i], sampleCost(work, minSampleMs, clock));
    });
    if (clock() - started >= budgetMs) break;
  }
  void sink;
  return best;
}

/** How many times costlier one call of `slow` is than one of `base`. */
export function costRatio(slow: () => unknown, base: () => unknown, options?: CostOptions): number {
  const [slowCost, baseCost] = fastestCosts([slow, base], options);
  return slowCost / baseCost;
}

export interface GrowthOptions extends CostOptions {
  /** The smaller input's size. */
  size: number;
  /** How much larger the second input is. Default 8. */
  factor?: number;
}

/**
 * How many times costlier `run` is on an input `factor` times larger: about
 * `factor` when its cost is linear, `factor²` when quadratic. Both inputs are
 * built before anything is timed.
 */
export function growthRatio<T>(
  input: (size: number) => T,
  run: (input: T) => unknown,
  { size, factor = 8, ...options }: GrowthOptions,
): number {
  const small = input(size);
  const large = input(size * factor);
  return costRatio(() => run(large), () => run(small), options);
}

/**
 * The highest growth ratio that still reads as linear: the geometric midpoint
 * between linear (`factor`) and quadratic (`factor²`), so noise has the same
 * room, factor^0.5, either way. At the default 8x that is 22.6, which a linear
 * cost would have to overrun by 2.8x to fail, and a quadratic one undercut by
 * 2.8x to pass.
 */
export function linearGrowthLimit(factor = 8): number {
  return factor ** 1.5;
}

/**
 * The highest growth ratio that still reads as capped — work that stops growing
 * once the input passes a size cap: the geometric midpoint between flat (1) and
 * linear (`factor`). At 8x that is 2.83.
 */
export function cappedGrowthLimit(factor = 8): number {
  return factor ** 0.5;
}
