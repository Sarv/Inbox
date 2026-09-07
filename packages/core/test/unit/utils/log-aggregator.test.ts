import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LogAggregator } from '../../../src/utils/log-aggregator';

// The whole point of this helper is that a burst of N events costs ONE log line
// and ONE timer. Every test here is about that arithmetic: what gets emitted,
// how often, and that nothing is emitted when nothing happened (an aggregator
// that logs an empty summary every window is worse than the per-item logs it
// replaced).

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('LogAggregator', () => {
  it('emits ONE summary per window no matter how many events land in it', () => {
    const emit = vi.fn();
    const agg = new LogAggregator({ windowMs: 1_000, emit });

    for (let i = 0; i < 500; i++) agg.note('acct-a');

    expect(emit).not.toHaveBeenCalled();      // nothing until the window closes
    vi.advanceTimersByTime(1_000);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith('acct-a x500');
  });

  it('keeps separate keys distinguishable in one summary', () => {
    const emit = vi.fn();
    const agg = new LogAggregator({ windowMs: 1_000, emit });

    agg.note('exists');
    agg.note('flags');
    agg.note('flags');

    vi.advanceTimersByTime(1_000);
    // A single occurrence prints bare; repeats carry a count.
    expect(emit).toHaveBeenCalledWith('exists; flags x2');
  });

  it('starts a FRESH window after each emit rather than latching', () => {
    const emit = vi.fn();
    const agg = new LogAggregator({ windowMs: 1_000, emit });

    agg.note('a');
    vi.advanceTimersByTime(1_000);
    agg.note('a');
    agg.note('a');
    vi.advanceTimersByTime(1_000);

    expect(emit.mock.calls.map(([s]) => s)).toEqual(['a', 'a x2']);
  });

  it('stays silent through an idle window', () => {
    const emit = vi.fn();
    new LogAggregator({ windowMs: 1_000, emit });

    vi.advanceTimersByTime(60_000);

    expect(emit).not.toHaveBeenCalled();
  });

  it('passes the FIRST sample of each key to a custom formatter', () => {
    const emit = vi.fn();
    const agg = new LogAggregator<{ uid: number }>({
      windowMs: 500,
      emit,
      format: (entries) => entries
        .map((e) => `${e.key}: ${e.count} msg(s), first uid=${e.sample?.uid}`)
        .join(' | '),
    });

    agg.note('acct-a', { uid: 11 });
    agg.note('acct-a', { uid: 12 });   // later samples don't displace the first
    agg.note('acct-b', { uid: 99 });

    vi.advanceTimersByTime(500);
    expect(emit).toHaveBeenCalledWith('acct-a: 2 msg(s), first uid=11 | acct-b: 1 msg(s), first uid=99');
  });

  it('a formatter that returns nothing emits nothing', () => {
    const emit = vi.fn();
    const agg = new LogAggregator({ windowMs: 100, emit, format: () => '' });

    agg.note('a');
    vi.advanceTimersByTime(100);

    expect(emit).not.toHaveBeenCalled();
  });

  it('flush() emits early and cancels the pending window', () => {
    const emit = vi.fn();
    const agg = new LogAggregator({ windowMs: 10_000, emit });

    agg.note('a');
    agg.flush();
    expect(emit).toHaveBeenCalledTimes(1);

    // The cancelled timer must not fire a second, empty summary.
    vi.advanceTimersByTime(10_000);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('flush() with nothing pending is a no-op, so a shutdown path can call it blindly', () => {
    const emit = vi.fn();
    const agg = new LogAggregator({ windowMs: 1_000, emit });

    agg.flush();
    agg.flush();

    expect(emit).not.toHaveBeenCalled();
  });

  it('reset() drops the pending summary WITHOUT emitting', () => {
    const emit = vi.fn();
    const agg = new LogAggregator({ windowMs: 1_000, emit });

    agg.note('a');
    expect(agg.pending).toBe(true);
    agg.reset();
    expect(agg.pending).toBe(false);

    vi.advanceTimersByTime(5_000);
    expect(emit).not.toHaveBeenCalled();
  });

  it('reports pending only while something is collected', () => {
    const agg = new LogAggregator({ windowMs: 1_000, emit: () => {} });

    expect(agg.pending).toBe(false);
    agg.note('a');
    expect(agg.pending).toBe(true);
    vi.advanceTimersByTime(1_000);
    expect(agg.pending).toBe(false);
  });

  // A summary line is never worth keeping the app alive for.
  it('unrefs its timer', () => {
    const unref = vi.fn();
    vi.spyOn(global, 'setTimeout').mockReturnValue({ unref } as never);

    new LogAggregator({ windowMs: 1_000, emit: () => {} }).note('a');

    expect(unref).toHaveBeenCalled();
  });
});
