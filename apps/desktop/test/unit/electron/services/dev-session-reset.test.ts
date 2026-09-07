import { describe, it, expect, vi, afterEach } from 'vitest';

import {
  DEV_SESSION_RESET_TIMEOUT_MS,
  describeDevSessionReset,
  resetDevSessionCaches,
} from '../../../../electron/services/dev-session-reset';

/**
 * The dev cache reset runs BEFORE the main window navigates, and the window is
 * created `show: false` — it only becomes visible on 'ready-to-show', which only
 * fires once a page loads. So anything that stops this reset from settling stops
 * the app from EVER showing UI, with no crash and no error in the log. That is
 * the regression this suite exists for: every outcome must resolve, promptly,
 * so the caller always reaches loadURL.
 */
describe('resetDevSessionCaches', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // The happy path still has to actually clear both caches — the whole point of
  // the reset is that a stale bundle can't shadow a fresh dev build. If this
  // stops calling both, dev picks up stale assets after a rebuild.
  it('runs both clears and reports "cleared" when they settle', async () => {
    const clearCache = vi.fn().mockResolvedValue(undefined);
    const clearStorageData = vi.fn().mockResolvedValue(undefined);

    await expect(resetDevSessionCaches({ clearCache, clearStorageData })).resolves.toBe('cleared');
    expect(clearCache).toHaveBeenCalledTimes(1);
    expect(clearStorageData).toHaveBeenCalledTimes(1);
  });

  // Both clears must be IN FLIGHT together, not awaited one after the other —
  // serializing them doubles the worst-case startup delay before the window
  // shows.
  it('starts both clears concurrently, not one after the other', async () => {
    const order: string[] = [];
    const clearCache = vi.fn(async () => { order.push('cache:start'); });
    const clearStorageData = vi.fn(async () => { order.push('storage:start'); });

    await resetDevSessionCaches({ clearCache, clearStorageData });

    expect(order).toEqual(['cache:start', 'storage:start']);
  });

  // THE BUG. A clear that never settles used to hang the `.then()` that called
  // loadURL, so no renderer was ever spawned and the window never appeared —
  // the app looked crashed while the main process happily kept syncing mail.
  // It must give up at the deadline and let the caller navigate.
  it('gives up with "timed-out" when a clear NEVER settles', async () => {
    vi.useFakeTimers();
    const clearCache = vi.fn(() => new Promise<void>(() => { /* never settles */ }));
    const clearStorageData = vi.fn().mockResolvedValue(undefined);

    const pending = resetDevSessionCaches({ clearCache, clearStorageData, timeoutMs: 5000 });
    await vi.advanceTimersByTimeAsync(5000);

    await expect(pending).resolves.toBe('timed-out');
  });

  // A hung clear must not be waited on past the deadline — the caller navigates
  // at the deadline, not whenever the OS eventually frees the cache directory.
  it('does not wait beyond the deadline for a hung clear', async () => {
    vi.useFakeTimers();
    const settled = vi.fn();
    const clearCache = vi.fn(() => new Promise<void>(() => { /* never settles */ }));

    void resetDevSessionCaches({
      clearCache,
      clearStorageData: () => Promise.resolve(),
      timeoutMs: 5000,
    }).then(settled);

    await vi.advanceTimersByTimeAsync(4999);
    expect(settled).not.toHaveBeenCalled(); // still inside the window — give it a chance
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toHaveBeenCalledWith('timed-out'); // and then stop waiting
  });

  // A PERMANENT failure (session already torn down, disk error) is a different
  // cause from a timeout but must be equally non-fatal: report it and let the
  // window load. A rejection escaping here would leave the same blank window.
  it('reports "failed" — never rejects — when a clear rejects outright', async () => {
    const clearCache = vi.fn().mockRejectedValue(new Error('session destroyed'));
    const clearStorageData = vi.fn().mockResolvedValue(undefined);

    await expect(resetDevSessionCaches({ clearCache, clearStorageData })).resolves.toBe('failed');
  });

  // The reject can come from EITHER clear; both must be caught. A rejection from
  // the second one used to be just as fatal as from the first.
  it('reports "failed" when the storage clear is the one that rejects', async () => {
    const clearCache = vi.fn().mockResolvedValue(undefined);
    const clearStorageData = vi.fn().mockRejectedValue(new Error('EIO'));

    await expect(resetDevSessionCaches({ clearCache, clearStorageData })).resolves.toBe('failed');
  });

  // A synchronous throw from the injected call is the same class of failure as a
  // rejected promise; it must not escape as an exception either.
  it('reports "failed" when a clear throws synchronously', async () => {
    const clearCache = vi.fn(() => { throw new Error('no default session'); });

    await expect(
      resetDevSessionCaches({ clearCache, clearStorageData: () => Promise.resolve() }),
    ).resolves.toBe('failed');
  });

  // The default must be a real, finite deadline. If this ever became undefined /
  // Infinity the original hang comes straight back.
  it('defaults to a finite deadline', async () => {
    vi.useFakeTimers();
    const pending = resetDevSessionCaches({
      clearCache: () => new Promise<void>(() => { /* never settles */ }),
      clearStorageData: () => Promise.resolve(),
    });

    expect(DEV_SESSION_RESET_TIMEOUT_MS).toBeGreaterThan(0);
    expect(Number.isFinite(DEV_SESSION_RESET_TIMEOUT_MS)).toBe(true);
    await vi.advanceTimersByTimeAsync(DEV_SESSION_RESET_TIMEOUT_MS);
    await expect(pending).resolves.toBe('timed-out');
  });

  // A slow-but-completing clear (loaded machine, cold disk) must still get a
  // clean cache rather than being cut off early — the deadline is a backstop for
  // a wedged clear, not a race the common case can lose.
  it('still reports "cleared" for a slow clear that finishes inside the deadline', async () => {
    vi.useFakeTimers();
    const clearCache = vi.fn(() => new Promise<void>((resolve) => { setTimeout(resolve, 3000); }));

    const pending = resetDevSessionCaches({
      clearCache,
      clearStorageData: () => Promise.resolve(),
      timeoutMs: 5000,
    });
    await vi.advanceTimersByTimeAsync(3000);

    await expect(pending).resolves.toBe('cleared');
  });

  // Window recreation (macOS keep-alive re-open, second-instance 'create') calls
  // this again in the same process. An earlier timeout must not poison the retry.
  it('is re-runnable — a timed-out run does not affect the next one', async () => {
    vi.useFakeTimers();
    const hung = resetDevSessionCaches({
      clearCache: () => new Promise<void>(() => { /* never settles */ }),
      clearStorageData: () => Promise.resolve(),
      timeoutMs: 1000,
    });
    await vi.advanceTimersByTimeAsync(1000);
    await expect(hung).resolves.toBe('timed-out');

    vi.useRealTimers();
    await expect(
      resetDevSessionCaches({
        clearCache: () => Promise.resolve(),
        clearStorageData: () => Promise.resolve(),
      }),
    ).resolves.toBe('cleared');
  });
});

describe('describeDevSessionReset', () => {
  // This exact string is what you grep for to tell "the dev app got as far as
  // navigating" from "it never did" — the incident that motivated the deadline
  // was diagnosed purely by its absence across 44 prior startups. Changing the
  // wording silently breaks that diagnostic.
  it('keeps the historical wording for the cleared case', () => {
    expect(describeDevSessionReset('cleared')).toBe('[Main] All caches cleared for development');
  });

  // A degraded reset must say so AND say the window is loading anyway, so the
  // next person reading the log doesn't chase a stale cache as the cause of a
  // rendering bug — nor think the app is wedged.
  it('names the cause and states the window loads anyway on timeout', () => {
    const message = describeDevSessionReset('timed-out');
    expect(message).toContain(String(DEV_SESSION_RESET_TIMEOUT_MS));
    expect(message).toContain('loading the window anyway');
  });

  it('distinguishes a permanent failure from a timeout', () => {
    const failed = describeDevSessionReset('failed');
    expect(failed).toContain('failed');
    expect(failed).toContain('loading the window anyway');
    expect(failed).not.toBe(describeDevSessionReset('timed-out'));
  });
});
