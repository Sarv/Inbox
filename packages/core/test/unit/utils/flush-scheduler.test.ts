import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_FLUSH_INTERVAL_MS,
  createFlushScheduler,
} from '../../../src/utils/flush-scheduler';

describe('createFlushScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // Regression: a scheduler that writes on every markDirty reinstates the
  // whole-file-write-per-message stall this helper exists to remove.
  it('coalesces many changes into one write', async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const scheduler = createFlushScheduler({ write, intervalMs: 1_000 });

    for (let index = 0; index < 500; index += 1) scheduler.markDirty();
    expect(write).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(write).toHaveBeenCalledTimes(1);
  });

  // Regression: writing when nothing changed rewrites the file on a timer
  // forever, which is the same main-thread cost for no benefit.
  it('does not write when nothing changed', async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const scheduler = createFlushScheduler({ write, intervalMs: 1_000 });

    await scheduler.flush();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(write).not.toHaveBeenCalled();
    expect(scheduler.isDirty()).toBe(false);
  });

  // Regression: an explicit flush must not leave the timer armed, or the same
  // state is written twice.
  it('cancels the pending timer when flushed explicitly', async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const scheduler = createFlushScheduler({ write, intervalMs: 1_000 });

    scheduler.markDirty();
    await scheduler.flush();
    expect(write).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(write).toHaveBeenCalledTimes(1);
  });

  // Regression: a failed write that clears the dirty flag silently discards
  // everything learned since the last successful write — the failure mode is
  // invisible, the numbers simply come out low.
  it('stays dirty and retries after a failed write', async () => {
    const write = vi
      .fn()
      .mockRejectedValueOnce(new Error('disk full'))
      .mockResolvedValue(undefined);
    const onError = vi.fn();
    const scheduler = createFlushScheduler({ write, intervalMs: 1_000, onError });

    scheduler.markDirty();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(write).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(scheduler.isDirty()).toBe(true);

    await scheduler.flush();
    expect(write).toHaveBeenCalledTimes(2);
    expect(scheduler.isDirty()).toBe(false);
  });

  // Regression: a throwing write must not escape into the caller's sync path —
  // the scheduler fires from a timer, where an unhandled rejection is fatal.
  it('never throws out of a failed scheduled write', async () => {
    const scheduler = createFlushScheduler({
      write: () => Promise.reject(new Error('nope')),
      intervalMs: 1_000,
    });

    scheduler.markDirty();
    await expect(vi.advanceTimersByTimeAsync(1_000)).resolves.toBeDefined();
    await expect(scheduler.flush()).resolves.toBeUndefined();
  });

  // Regression: a change made while the write was in flight must survive. If
  // the dirty flag were cleared after the await, that change would be counted
  // as already written and lost.
  it('keeps a change made during an in-flight write', async () => {
    let release: (() => void) | undefined;
    const write = vi.fn().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );
    const scheduler = createFlushScheduler({ write, intervalMs: 1_000 });

    scheduler.markDirty();
    const inFlight = scheduler.flush();
    scheduler.markDirty();
    release?.();
    await inFlight;

    expect(scheduler.isDirty()).toBe(true);
  });

  // Regression: pending changes must reach disk when the app closes, otherwise
  // the last interval of work is lost on every quit.
  it('writes pending changes on dispose', async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const scheduler = createFlushScheduler({ write, intervalMs: 1_000 });

    scheduler.markDirty();
    await scheduler.dispose();

    expect(write).toHaveBeenCalledTimes(1);
  });

  // Regression: scheduling after dispose resurrects a timer on a torn-down
  // extension, which then writes over state the next activation is building.
  it('stops scheduling after dispose', async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const scheduler = createFlushScheduler({ write, intervalMs: 1_000 });

    await scheduler.dispose();
    scheduler.markDirty();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(write).not.toHaveBeenCalled();
    expect(scheduler.isDirty()).toBe(true);
  });

  // Regression: an unspecified interval must not default to something tight
  // enough to reintroduce per-message writes.
  it('defaults to the documented interval', async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const scheduler = createFlushScheduler({ write });

    scheduler.markDirty();
    await vi.advanceTimersByTimeAsync(DEFAULT_FLUSH_INTERVAL_MS - 1);
    expect(write).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(write).toHaveBeenCalledTimes(1);
  });
});
