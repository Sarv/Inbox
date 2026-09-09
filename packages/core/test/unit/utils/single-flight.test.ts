import { describe, expect, it, vi } from 'vitest';

import { createSingleFlight } from '../../../src/utils/single-flight';

/** A promise plus its resolvers, so a test can hold an operation open. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('createSingleFlight', () => {
  // Regression: two callers asking for the same thing at once must start the
  // work ONCE. If this fails, a startup mount + focus + StrictMode double-invoke
  // each open their own IMAP connection and they tear each other down.
  it('runs the operation once for concurrent calls under the same key', async () => {
    const flight = createSingleFlight<string>();
    const gate = deferred<string>();
    const start = vi.fn(() => gate.promise);

    const first = flight.run('acct-a', start);
    const second = flight.run('acct-a', start);

    expect(start).toHaveBeenCalledTimes(1);
    gate.resolve('connected');
    await expect(first).resolves.toBe('connected');
    // The joiner gets the SAME settlement, not a second attempt's.
    await expect(second).resolves.toBe('connected');
  });

  // Regression: coalescing must be keyed by identity. If different keys joined,
  // connecting account B would silently return account A's result.
  it('runs both operations when the keys differ', async () => {
    const flight = createSingleFlight<string>();
    const start = vi.fn((value: string) => async () => value);

    const [a, b] = await Promise.all([
      flight.run('acct-a', start('a')),
      flight.run('acct-b', start('b')),
    ]);

    expect(a).toBe('a');
    expect(b).toBe('b');
    expect(flight.size).toBe(0);
  });

  // Regression: an entry that outlives its operation would block every later
  // attempt forever — a single connect failure would mean "never reconnect".
  it('clears the entry once the operation settles, so a later call runs again', async () => {
    const flight = createSingleFlight<number>();
    const start = vi.fn(async () => 1);

    await flight.run('acct-a', start);
    expect(flight.size).toBe(0);
    expect(flight.pending('acct-a')).toBeUndefined();

    await flight.run('acct-a', start);
    expect(start).toHaveBeenCalledTimes(2);
  });

  // Regression: a rejection must clear the entry too, and must reach BOTH the
  // caller that started it and the one that joined — a joiner that never sees
  // the failure would report a connection that does not exist.
  it('propagates a rejection to every caller and still clears the entry', async () => {
    const flight = createSingleFlight<string>();
    const gate = deferred<string>();
    const first = flight.run('acct-a', () => gate.promise);
    const second = flight.run('acct-a', () => gate.promise);

    gate.reject(new Error('connect refused'));

    await expect(first).rejects.toThrow('connect refused');
    await expect(second).rejects.toThrow('connect refused');
    expect(flight.size).toBe(0);
  });

  // Regression: the entry is deleted only if it is still the one this run
  // installed. Without that identity check, an earlier run settling late would
  // evict the newer run's entry and a third caller would start a duplicate.
  it('does not let a late settlement evict a newer run under the same key', async () => {
    const flight = createSingleFlight<string>();
    const firstGate = deferred<string>();
    const secondGate = deferred<string>();

    const first = flight.run('acct-a', () => firstGate.promise);
    firstGate.resolve('first');
    await first;

    const second = flight.run('acct-a', () => secondGate.promise);
    // Let any stale cleanup from the first run flush before checking.
    await Promise.resolve();
    await Promise.resolve();

    expect(flight.pending('acct-a')).toBe(second);

    secondGate.resolve('second');
    await expect(second).resolves.toBe('second');
    expect(flight.size).toBe(0);
  });

  // Regression: a synchronous throw from start() must reject the returned
  // promise rather than escape past the bookkeeping and strand a phantom entry.
  it('rejects — and leaves nothing in flight — when start() throws synchronously', async () => {
    const flight = createSingleFlight<string>();

    await expect(
      flight.run('acct-a', () => {
        throw new Error('no credentials');
      }),
    ).rejects.toThrow('no credentials');

    expect(flight.size).toBe(0);
    expect(flight.pending('acct-a')).toBeUndefined();
  });

  // Regression: pending() is how a caller can tell "already running" from "not
  // running" without starting anything — the guard the connect path relies on.
  it('exposes the in-flight promise through pending() while it runs', async () => {
    const flight = createSingleFlight<string>();
    const gate = deferred<string>();

    expect(flight.pending('acct-a')).toBeUndefined();
    const run = flight.run('acct-a', () => gate.promise);
    expect(flight.pending('acct-a')).toBe(run);
    expect(flight.size).toBe(1);

    gate.resolve('done');
    await run;
    expect(flight.pending('acct-a')).toBeUndefined();
  });
});
