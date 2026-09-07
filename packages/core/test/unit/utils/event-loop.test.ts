import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_YIELD_BUDGET_MS,
  type PacerOptions,
  createLoopYielder,
  createPacer,
  sleep,
  yieldToEventLoop,
} from '../../../src/utils/event-loop';

describe('yieldToEventLoop', () => {
  // Regression: if this ever resolves synchronously (a microtask instead of a
  // macrotask), every loop built on it silently stops handing the thread back —
  // which is exactly the 25s main-thread freeze this helper exists to prevent.
  it('resolves on a macrotask, after pending immediates are queued', async () => {
    const order: string[] = [];
    const pending = yieldToEventLoop().then(() => order.push('yield'));
    order.push('sync-after-call');
    await Promise.resolve().then(() => order.push('microtask'));
    await pending;
    expect(order).toEqual(['sync-after-call', 'microtask', 'yield']);
  });
});

describe('createLoopYielder', () => {
  // Build a yielder over a clock we control, so the budget logic is asserted
  // exactly rather than raced against the real scheduler.
  function fixture(budgetMs?: number) {
    let clock = 1_000;
    const yieldFn = vi.fn(async () => { clock += 50; }); // yields are not free
    const breathe = createLoopYielder({
      budgetMs,
      now: () => clock,
      yieldFn,
    });
    return { breathe, yieldFn, advance: (ms: number) => { clock += ms; }, now: () => clock };
  }

  // Regression: the whole point of the helper. If it yielded on every call the
  // loop would crawl; if it never yielded we are back to the freeze.
  it('does not yield until the time budget is spent, then yields once', async () => {
    const { breathe, yieldFn, advance } = fixture(8);

    expect(await breathe()).toBe(false); // 0ms elapsed
    advance(7);
    expect(await breathe()).toBe(false); // still inside the budget
    expect(yieldFn).not.toHaveBeenCalled();

    advance(1); // exactly at the budget
    expect(await breathe()).toBe(true);
    expect(yieldFn).toHaveBeenCalledTimes(1);

    expect(await breathe()).toBe(false); // budget reset by the yield
  });

  // Regression: this is the bug the helper replaces. A row-COUNT yield holds the
  // thread for however long the rows take; a TIME budget must yield on the very
  // next item after one slow item blew the budget, no matter how few items ran.
  it('yields on the next call after a single item overruns the budget', async () => {
    const { breathe, yieldFn, advance } = fixture(8);

    expect(await breathe()).toBe(false);
    advance(25_000); // one pathologically slow item (the profiled full-table scan)
    expect(await breathe()).toBe(true);
    expect(yieldFn).toHaveBeenCalledTimes(1);
  });

  // Regression: the clock must be re-read AFTER the yield. If the yield's own
  // duration were charged to the next budget, a loop on a busy event loop would
  // yield on every single item and never make progress.
  it('starts the next budget when the yield returns, not when it began', async () => {
    const { breathe, yieldFn, advance } = fixture(8);

    advance(8);
    expect(await breathe()).toBe(true); // the yieldFn itself advances the clock 50ms

    // Those 50ms belong to the yield, not to the loop: the budget is fresh.
    advance(7);
    expect(await breathe()).toBe(false);
    advance(1);
    expect(await breathe()).toBe(true);
    expect(yieldFn).toHaveBeenCalledTimes(2);
  });

  // A budget of 0 must mean "yield every time" (maximum responsiveness), not
  // "never yield" — the `<` vs `<=` boundary in the implementation.
  it('yields on every call with a zero budget', async () => {
    const { breathe, yieldFn } = fixture(0);

    expect(await breathe()).toBe(true);
    expect(await breathe()).toBe(true);
    expect(yieldFn).toHaveBeenCalledTimes(2);
  });

  it('defaults to the shared budget and a real macrotask yield', async () => {
    expect(DEFAULT_YIELD_BUDGET_MS).toBe(8);

    // No injected clock or yieldFn: proves the defaults are wired and that
    // awaiting the yielder is safe on the real scheduler.
    const breathe = createLoopYielder();
    expect(await breathe()).toBe(false);
    const start = Date.now();
    while (Date.now() - start <= DEFAULT_YIELD_BUDGET_MS) { /* burn the budget */ }
    expect(await breathe()).toBe(true);
  });
});

// What breaks if this fails: the app is unusable for the length of a migration,
// or the migration never finishes. Both are silent — no error, no crash.
//
// A yielder alone was measured holding 79% of wall clock on the main thread: it
// hands the thread back for one turn and the loop takes it straight back. The
// pacer bounds the SHARE. Its failure modes are all quiet: rest too little and
// the app beachballs; rest too much (or forever, from a divide-by-zero duty
// cycle) and the backfill looks dead; return synchronously and the loop starves
// the event loop exactly as before.
describe('createPacer', () => {
  function fixture(options: Partial<PacerOptions> = {}) {
    let clock = 1_000;
    const slept: number[] = [];
    const yieldFn = vi.fn(async () => { clock += 1; });
    const sleepFn = vi.fn(async (ms: number) => { slept.push(ms); clock += ms; });
    const pace = createPacer({ now: () => clock, sleepFn, yieldFn, ...options });
    return { pace, slept, sleepFn, yieldFn, work: (ms: number) => { clock += ms; } };
  }

  // The core arithmetic: at 25% duty, 100ms of work owes 300ms of rest, so the
  // work is 100 of every 400ms. Get the factor inverted and the pass either
  // hogs the thread or crawls.
  it('rests in proportion to the work, to hit the duty cycle', async () => {
    const { pace, slept, work } = fixture({ dutyCycle: 0.25 });

    work(100);
    expect(await pace.rest()).toBe(300);

    work(40);
    await pace.rest();
    expect(slept).toEqual([300, 120]);
  });

  // Regression: charging the rest to the next unit of work would make every
  // subsequent rest compound — the pass would slow to a halt over a long run.
  it('does not charge its own rest to the next unit of work', async () => {
    const { pace, slept, work } = fixture({ dutyCycle: 0.5 });

    work(100);
    await pace.rest(); // sleeps 100, advancing the clock
    await pace.rest(); // no work since: nothing owed

    expect(slept).toEqual([100]);
  });

  // A chunk that takes pathologically long (a 21 MB body) must not park the pass
  // for a minute — the cap keeps the worst case bounded.
  it('caps the rest however slow one unit of work was', async () => {
    const { pace, slept, work } = fixture({ dutyCycle: 0.1, maxRestMs: 500 });

    work(10_000); // would owe 90 seconds
    await pace.rest();

    expect(slept).toEqual([500]);
  });

  // THE starvation regression: on a mailbox of tiny rows the work rounds to 0ms
  // and there is nothing to rest for — but if `rest()` then returned without
  // awaiting a macrotask, the loop would hold the thread forever and we are back
  // to the beachball this helper was written to remove.
  it('still yields one turn when no rest is owed', async () => {
    const { pace, yieldFn, sleepFn } = fixture({ dutyCycle: 0.5 });

    expect(await pace.rest()).toBe(0);

    expect(yieldFn).toHaveBeenCalledOnce();
    expect(sleepFn).not.toHaveBeenCalled();
  });

  // A duty cycle of 0 means `1/0 - 1` = Infinity: an infinite rest, i.e. a pass
  // that silently never runs again. NaN (a bad config value) is the same class of
  // bug. Both must degrade to "no pacing", never to "no progress".
  it.each([
    ['zero', 0],
    ['negative', -1],
    ['NaN', Number.NaN],
    ['above one', 5],
  ])('treats a %s duty cycle as unpaced rather than stalling', async (_label, dutyCycle) => {
    const { pace, slept, work } = fixture({ dutyCycle });

    work(100);
    await pace.rest();

    expect(slept).toEqual([]); // full speed, and crucially NOT an infinite sleep
  });

  // Proves the real defaults are wired: an unconfigured pacer rests on the real
  // timer without being handed a clock or a sleep function.
  it('works on the real scheduler with no injection', async () => {
    const pace = createPacer({ dutyCycle: 0.5, maxRestMs: 20 });
    const start = Date.now();
    while (Date.now() - start < 5) { /* do 5ms of "work" */ }

    const rested = await pace.rest();

    expect(rested).toBeGreaterThan(0);
    expect(rested).toBeLessThanOrEqual(20);
  });
});

describe('sleep', () => {
  // It must be a real timer, not setImmediate: the whole point is to release the
  // thread for a measurable stretch, not for one turn.
  it('resolves after roughly the requested delay', async () => {
    const start = Date.now();
    await sleep(15);
    expect(Date.now() - start).toBeGreaterThanOrEqual(10);
  });
});
