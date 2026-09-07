import { describe, expect, it } from 'vitest';

import { SizeBudgetedLru } from '../../../src/utils/lru-cache';

// What breaks if this file fails: memory, quietly. Both callers hold a small
// number of very large strings (a resolved inline image is 1 KB to several MB),
// so the failure modes are a cache that never evicts — the main process grows
// until the OS kills it — or one that evicts the entry it is about to be asked
// for again, turning every message in a thread into a fresh decode of the same
// sender logo. Neither throws.

describe('SizeBudgetedLru', () => {
  it('stores and returns values', () => {
    const cache = new SizeBudgetedLru<string>({ maxEntries: 4, maxSize: 1000 });
    cache.set('a', 'hello');

    expect(cache.get('a')).toBe('hello');
    expect(cache.has('a')).toBe(true);
    expect(cache.size).toBe(1);
    expect(cache.bytes).toBe(5);
    expect(cache.get('missing')).toBeUndefined();
  });

  it('evicts the oldest entry once the entry cap is exceeded', () => {
    const cache = new SizeBudgetedLru<string>({ maxEntries: 2, maxSize: 1000 });
    cache.set('a', 'A');
    cache.set('b', 'B');
    cache.set('c', 'C');

    expect(cache.has('a')).toBe(false);
    expect(cache.size).toBe(2);
  });

  // The reason the budget is in characters and not entries: an entry cap alone
  // is meaningless when one entry is 2 MB and another 200 bytes.
  it('evicts on the size budget even when the entry cap is far off', () => {
    const cache = new SizeBudgetedLru<string>({ maxEntries: 100, maxSize: 10 });
    cache.set('a', 'aaaaa');
    cache.set('b', 'bbbbb');
    cache.set('c', 'ccccc');

    expect(cache.has('a')).toBe(false);
    expect(cache.bytes).toBeLessThanOrEqual(10);
  });

  // Without recency refresh the cache is FIFO, and a long thread evicts the logo
  // it is about to ask for again on the very next message.
  it('a hit refreshes recency, so a hot entry survives eviction', () => {
    const cache = new SizeBudgetedLru<string>({ maxEntries: 2, maxSize: 1000 });
    cache.set('a', 'A');
    cache.set('b', 'B');
    expect(cache.get('a')).toBe('A'); // 'a' is now the most recent
    cache.set('c', 'C');

    expect(cache.has('a')).toBe(true);
    expect(cache.has('b')).toBe(false);
  });

  // `has` is used by tests and metrics; if it refreshed recency it would change
  // the eviction order just by being observed.
  it('has() does not disturb recency', () => {
    const cache = new SizeBudgetedLru<string>({ maxEntries: 2, maxSize: 1000 });
    cache.set('a', 'A');
    cache.set('b', 'B');
    cache.has('a');
    cache.set('c', 'C');

    expect(cache.has('a')).toBe(false);
  });

  // Admitting an outlier would flush every useful entry and then sit there as
  // the sole occupant. A miss and a re-derive is strictly cheaper.
  it('refuses a value larger than the whole budget rather than flushing the cache', () => {
    const cache = new SizeBudgetedLru<string>({ maxEntries: 10, maxSize: 8 });
    cache.set('keep', 'abcd');
    cache.set('huge', 'x'.repeat(100));

    expect(cache.has('huge')).toBe(false);
    expect(cache.get('keep')).toBe('abcd');
  });

  // Overwriting must not double-count the old value's size — that leak shows up
  // as a cache that evicts everything after enough re-saves of one draft.
  it('accounts correctly when a key is overwritten', () => {
    const cache = new SizeBudgetedLru<string>({ maxEntries: 4, maxSize: 1000 });
    cache.set('a', 'aaaaa');
    cache.set('a', 'bb');

    expect(cache.get('a')).toBe('bb');
    expect(cache.size).toBe(1);
    expect(cache.bytes).toBe(2);
  });

  it('clear() empties both the entries and the byte tally', () => {
    const cache = new SizeBudgetedLru<string>({ maxEntries: 4, maxSize: 1000 });
    cache.set('a', 'aaa');
    cache.clear();

    expect(cache.size).toBe(0);
    expect(cache.bytes).toBe(0);
    expect(cache.get('a')).toBeUndefined();
  });

  it('honours a caller-supplied sizeOf', () => {
    const cache = new SizeBudgetedLru<{ weight: number }>({
      maxEntries: 10,
      maxSize: 10,
      sizeOf: (value) => value.weight,
    });
    cache.set('a', { weight: 6 });
    cache.set('b', { weight: 6 });

    expect(cache.has('a')).toBe(false);
    expect(cache.bytes).toBe(6);
  });

  // A zero or negative budget from a config mistake must not make set() an
  // infinite eviction loop.
  it('clamps a nonsensical budget instead of looping', () => {
    const cache = new SizeBudgetedLru<string>({ maxEntries: 0, maxSize: 0 });
    cache.set('a', 'a');
    expect(cache.size).toBeLessThanOrEqual(1);
  });
});
