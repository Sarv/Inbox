import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  activeCacheAccount,
  createAccountScopedCache,
  resolveCacheAccount,
  setActiveCacheAccount,
  type AccountScopedCache,
} from '../../../../src/utils/account-scoped-cache';

/**
 * The per-account, observable copy of a main-process list that every
 * remote-image trust source is built on (the allowlist, trusted senders, the
 * people an account has emailed).
 *
 * What breaks if this file goes red: images load for the wrong mailbox (a list
 * answering for another account), an open message keeps its banner after the
 * list it needed has loaded (no notification), a transient IPC failure is
 * cached as "nobody is trusted" for the rest of the session, or a refused write
 * keeps applying as if it had been stored.
 */

const delays = [100, 200];
let lists: Record<string, string[]>;
let load: ReturnType<typeof vi.fn>;
let cache: AccountScopedCache<string>;

const make = () =>
  createAccountScopedCache<string>({
    name: 'test-list',
    load: load as unknown as (accountId: string | undefined) => Promise<string[]>,
    keyOf: (item) => item.trim().toLowerCase(),
    retryDelaysMs: delays,
  });

/** Let queued microtasks (the load's promise chain) run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  lists = { a: ['boss@a.test'], b: ['pal@b.test'], active: ['me@active.test'] };
  load = vi.fn(async (accountId?: string) => {
    const list = lists[accountId ?? 'active'];
    if (!list) throw new Error(`no list for ${accountId}`);
    return [...list];
  });
  setActiveCacheAccount(null);
  cache = make();
});

afterEach(() => {
  cache.clear();
  setActiveCacheAccount(null);
  vi.useRealTimers();
});

describe('reads', () => {
  // Breaks: the cold-cache bug — a read before the list loads must answer
  // "no" (conservative), start ONE load, and notify when it lands so the
  // message that asked re-decides.
  it('answers from an empty view while cold, loads once, and notifies when the list lands', async () => {
    const listener = vi.fn();
    cache.subscribe(listener);
    const before = cache.getVersion();

    expect(cache.has('a', 'boss@a.test')).toBe(false);
    expect(cache.has('a', 'boss@a.test')).toBe(false); // a second read does not start a second load
    await settle();

    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith('a');
    expect(cache.has('a', 'boss@a.test')).toBe(true);
    expect(cache.isLoaded('a')).toBe(true);
    expect(listener).toHaveBeenCalled();
    expect(cache.getVersion()).toBeGreaterThan(before);
  });

  // Multi-account: one account's list never answers for another's.
  it('keeps each account to itself', async () => {
    await cache.reload('a');
    await cache.reload('b');
    expect(cache.has('a', 'boss@a.test')).toBe(true);
    expect(cache.has('b', 'boss@a.test')).toBe(false);
    expect(cache.has('b', 'pal@b.test')).toBe(true);
    expect(cache.items('a')).toEqual(['boss@a.test']);
  });

  // Breaks: a read that names no account reads some other account's list
  // instead of the active one's.
  it('reads the active account when none is named, and asks main for it by id once known', async () => {
    await cache.reload();
    expect(load).toHaveBeenLastCalledWith(undefined); // id not known yet → main's active
    expect(cache.has(undefined, 'me@active.test')).toBe(true);

    setActiveCacheAccount('a');
    expect(activeCacheAccount()).toBe('a');
    expect(resolveCacheAccount()).toBe('a');
    expect(resolveCacheAccount('b')).toBe('b');
    await cache.reload();
    expect(load).toHaveBeenLastCalledWith('a');
    expect(cache.has(undefined, 'boss@a.test')).toBe(true);
    expect(cache.has(null, 'me@active.test')).toBe(false);
  });

  // Breaks: after an account switch, the list read while the active id was
  // still unknown keeps answering "active" reads for the new account.
  it('drops the unknown-active entry and notifies when the active account changes', async () => {
    await cache.reload();
    expect(cache.has(undefined, 'me@active.test')).toBe(true);
    const listener = vi.fn();
    cache.subscribe(listener);

    expect(setActiveCacheAccount('b')).toBe(true);
    expect(listener).toHaveBeenCalled();
    expect(cache.has(undefined, 'me@active.test')).toBe(false);
    expect(setActiveCacheAccount('b')).toBe(false); // no change, no churn
  });

  // Breaks: a refresh blanks the list while it is re-read, so every open
  // message flickers back to its banner (and a re-decision runs) mid-reload.
  it('keeps showing the previous list while a reload is in flight', async () => {
    await cache.reload('a');
    lists.a = ['boss@a.test', 'new@a.test'];
    const pending = cache.reload('a');
    expect(cache.has('a', 'boss@a.test')).toBe(true);
    await pending;
    expect(cache.has('a', 'new@a.test')).toBe(true);
  });

  // Breaks: an unmounted message keeps being told of changes (a leak, and
  // setState on an unmounted component).
  it('unsubscribes', async () => {
    const listener = vi.fn();
    const off = cache.subscribe(listener);
    off();
    await cache.reload('a');
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('a failed load is unknown, never empty', () => {
  // Breaks: THE old allowlist bug — an IPC error cached as an empty list, so
  // nothing auto-loaded until the next account switch.
  it('stays unloaded after a failure and retries on the backoff', async () => {
    vi.useFakeTimers();
    load.mockRejectedValueOnce(new Error('Storage not initialized'));
    expect(cache.has('a', 'boss@a.test')).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(cache.isLoaded('a')).toBe(false);

    // Reads during the backoff do not hammer the main process.
    cache.has('a', 'boss@a.test');
    await vi.advanceTimersByTimeAsync(50);
    expect(load).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(delays[0]);
    expect(load).toHaveBeenCalledTimes(2);
    expect(cache.has('a', 'boss@a.test')).toBe(true);
  });

  // Breaks: a store that stays down keeps a timer chain alive forever, or —
  // the opposite — is never asked again once the timed retries run out.
  it('stops timed retries after the backoff, then retries on a read once the last delay has passed', async () => {
    vi.useFakeTimers();
    load.mockRejectedValue(new Error('down'));
    cache.ensure('a');
    await vi.runAllTimersAsync(); // terminates: the retries are bounded
    const calls = load.mock.calls.length;
    expect(calls).toBe(1 + delays.length);

    cache.ensure('a'); // still cooling down
    await vi.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenCalledTimes(calls);

    await vi.advanceTimersByTimeAsync(delays[delays.length - 1]);
    load.mockImplementation(async () => ['boss@a.test']);
    expect(cache.has('a', 'boss@a.test')).toBe(false); // this read starts the retry
    await vi.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenCalledTimes(calls + 1);
    expect(cache.has('a', 'boss@a.test')).toBe(true);
  });

  // Breaks: a loader that throws before its first await wedged the entry with
  // a finished promise as "in flight", so no load ever started again.
  it('recovers from a loader that throws synchronously', async () => {
    let calls = 0;
    const throwing = createAccountScopedCache<string>({
      name: 'sync-throw',
      load: ((accountId?: string) => {
        calls += 1;
        if (calls === 1) throw new Error('bridge missing');
        return Promise.resolve([`x@${accountId}`]);
      }) as (accountId: string | undefined) => Promise<string[]>,
      keyOf: (item) => item,
      retryDelaysMs: [0],
    });
    await throwing.reload('a');
    expect(throwing.isLoaded('a')).toBe(false);
    await throwing.reload('a');
    expect(throwing.has('a', 'x@a')).toBe(true);
    throwing.clear();
  });

  // Breaks: a reload that was cleared out from under (account switch, reset)
  // writes its stale list back in.
  it('discards a load that lands after clear()', async () => {
    let release: (value: string[]) => void = () => {};
    load.mockImplementationOnce(() => new Promise<string[]>((resolve) => { release = resolve; }));
    const pending = cache.reload('a');
    await settle();
    cache.clear();
    release(['stale@a.test']);
    await pending;
    expect(cache.isLoaded('a')).toBe(false);
  });

  // Breaks: clear() leaves a retry timer that later loads into a dead entry.
  it('cancels pending retries on clear', async () => {
    vi.useFakeTimers();
    load.mockRejectedValueOnce(new Error('down'));
    cache.ensure('a');
    await vi.advanceTimersByTimeAsync(0);
    cache.clear();
    await vi.advanceTimersByTimeAsync(delays[0] * 2);
    expect(load).toHaveBeenCalledTimes(1);
  });
});

describe('optimistic writes', () => {
  // Breaks: "Load images" on one message does not apply to the next message
  // from that sender until the write round-trips (or at all, on a cold cache).
  it('applies an add at once, even on a cold cache, and keeps it once stored', async () => {
    let resolvePersist: (ok: boolean) => void = () => {};
    const write = cache.write('a', { add: 'New@A.test' }, () => new Promise<boolean>((resolve) => { resolvePersist = resolve; }));
    expect(cache.has('a', 'new@a.test')).toBe(true);
    resolvePersist(true);
    await expect(write).resolves.toBe(true);
    await settle();
    expect(cache.has('a', 'new@a.test')).toBe(true);
    expect(cache.has('a', 'boss@a.test')).toBe(true); // the cold read loaded the rest too
  });

  // Breaks: a write the main process refused keeps applying for the session —
  // images load for a sender who is not actually on the list.
  // Breaks: a write main refused (or an IPC that threw) keeps applying for the
  // session although the database never stored it.
  it('rolls back a refused or failing write', async () => {
    await cache.reload('a');
    await expect(cache.write('a', { add: 'x@a.test' }, async () => false)).resolves.toBe(false);
    expect(cache.has('a', 'x@a.test')).toBe(false);

    await expect(cache.write('a', { remove: 'boss@a.test' }, async () => { throw new Error('ipc gone'); })).resolves.toBe(false);
    expect(cache.has('a', 'boss@a.test')).toBe(true);
  });

  // Breaks: a revoke (Security page) keeps loading the sender's images on open
  // messages until the database answers, or comes back after it did.
  it('removes at once and keeps it removed once stored', async () => {
    await cache.reload('a');
    const done = cache.write('a', { remove: 'boss@a.test' }, async () => true);
    expect(cache.has('a', 'boss@a.test')).toBe(false);
    await done;
    expect(cache.has('a', 'boss@a.test')).toBe(false);
    expect(cache.items('a')).toEqual([]);
  });

  // Breaks: the race between a load and a write — a load that read the
  // database before the write landed erased the new entry when it arrived.
  it('keeps a write that was stored while a load that predates it was in flight', async () => {
    let release: (value: string[]) => void = () => {};
    load.mockImplementationOnce(() => new Promise<string[]>((resolve) => { release = resolve; }));
    const loading = cache.reload('a');
    await settle();
    await cache.write('a', { add: 'late@a.test' }, async () => true);
    release(['boss@a.test']); // read before the write
    await loading;
    expect(cache.has('a', 'late@a.test')).toBe(true);
    expect(cache.has('a', 'boss@a.test')).toBe(true);
  });

  // Breaks: "Load images" before the allowlist ever loaded — the allowance
  // vanished the moment its write was stored (nothing loaded to fold it into)
  // and only came back once some later read loaded the list.
  it('keeps a write stored before the first load visible, and folds it into that load', async () => {
    await cache.write('a', { add: 'early@a.test' }, async () => true);
    expect(cache.isLoaded('a')).toBe(false);
    expect(cache.items('a')).toEqual(['early@a.test']); // this read starts the first load
    lists.a = ['boss@a.test', 'early@a.test'];
    await settle();
    expect(cache.has('a', 'early@a.test')).toBe(true);
    expect(cache.has('a', 'boss@a.test')).toBe(true);
  });

  // Multi-account: a write lands in its own account only.
  it('writes to one account only', async () => {
    await cache.reload('a');
    await cache.reload('b');
    await cache.write('b', { add: 'boss@a.test' }, async () => true);
    expect(cache.has('b', 'boss@a.test')).toBe(true);
    await cache.write('a', { remove: 'boss@a.test' }, async () => true);
    expect(cache.has('a', 'boss@a.test')).toBe(false);
    expect(cache.has('b', 'boss@a.test')).toBe(true);
  });

  // Breaks: a blank key is stored as an entry, or a write that settles after
  // an account switch (clear) writes into the new account's fresh entry.
  it('ignores a write with no usable key, and survives a clear mid-write', async () => {
    await expect(cache.write('a', { add: '   ' }, async () => true)).resolves.toBe(false);
    let resolvePersist: (ok: boolean) => void = () => {};
    const write = cache.write('a', { add: 'x@a.test' }, () => new Promise<boolean>((resolve) => { resolvePersist = resolve; }));
    cache.clear();
    resolvePersist(true);
    await expect(write).resolves.toBe(true);
  });
});

describe('forget (a removed account)', () => {
  // Breaks: a removed account's list (and its pending retry) outlives it, so
  // the same address added again (the same id) starts from the old list, or a
  // retry keeps asking main for a database that no longer exists.
  it("drops one account's list and its retry, and leaves the others", async () => {
    vi.useFakeTimers();
    try {
      const load = vi.fn(async (accountId?: string) => {
        if (accountId === 'gone') throw new Error('Account gone is not available');
        return ['boss@a.test'];
      });
      const cache = createAccountScopedCache<string>({ name: 'test', load, keyOf: (k) => k });
      await cache.reload('a');
      await cache.reload('gone'); // fails: a retry is scheduled
      const listener = vi.fn();
      cache.subscribe(listener);

      cache.forget('gone');
      cache.forget('never-held'); // nothing held: no change, no notify
      expect(listener).toHaveBeenCalledTimes(1);
      load.mockClear();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(load).not.toHaveBeenCalled(); // the retry went with it
      expect(cache.has('a', 'boss@a.test')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
