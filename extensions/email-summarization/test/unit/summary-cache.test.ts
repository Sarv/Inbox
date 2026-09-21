import { describe, expect, it, vi } from 'vitest';

import {
  MAX_CACHED_SUMMARIES,
  contentKey,
  createSummaryCache,
  mergeTables,
  pruneTable,
  sanitizeTable,
  type SummaryTable,
} from '../../src/summary-cache';

describe('contentKey', () => {
  // Regression: the key IS the correctness argument for having no TTL. Identical
  // text must map to the same key forever, and a thread that gained a reply must
  // not.
  it('is stable for identical text and different for anything else', () => {
    expect(contentKey('hello')).toBe(contentKey('hello'));
    expect(contentKey('hello')).not.toBe(contentKey('hello '));
    expect(contentKey('thread:a')).not.toBe(contentKey('email:a'));
  });

  // Regression: the key is a JSON property name stored 200 times over; an
  // unbounded one bloats the file it lives in.
  it('is a short hex string', () => {
    expect(contentKey('anything')).toMatch(/^[0-9a-f]{16}$/);
  });

  // Regression: non-ASCII bodies are ordinary mail; a hash that throws on them
  // breaks summarization for whole languages.
  it('handles non-ASCII text', () => {
    expect(contentKey('निवेदन 请回复 مرحبا')).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('sanitizeTable', () => {
  // Regression: the store is plain JSON in the user's data directory. A crash
  // mid-write truncates it, and an entry with no value is served as a summary
  // of `undefined`.
  it('drops anything that is not a usable entry', () => {
    const table = sanitizeTable({
      good: { value: { summary: 'ok' }, usedAt: 10 },
      noValue: { usedAt: 10 },
      nullValue: { value: null, usedAt: 10 },
      notAnObject: 'nope',
      arrayEntry: [1, 2],
      '': { value: 1, usedAt: 1 },
    });
    expect(Object.keys(table)).toEqual(['good']);
  });

  // Regression: a NaN usedAt makes the recency sort incoherent, so pruning
  // starts evicting arbitrary entries.
  it('repairs an unusable usedAt rather than dropping the summary', () => {
    const table = sanitizeTable({ a: { value: 'x', usedAt: Number.NaN }, b: { value: 'y' } });
    expect(table.a).toEqual({ value: 'x', usedAt: 0 });
    expect(table.b).toEqual({ value: 'y', usedAt: 0 });
  });

  // Regression: a missing or corrupt file must read as an empty cache, never
  // throw during activation.
  it('treats non-objects as empty', () => {
    expect(sanitizeTable(undefined)).toEqual({});
    expect(sanitizeTable('[]')).toEqual({});
    expect(sanitizeTable([1, 2])).toEqual({});
  });
});

describe('pruneTable', () => {
  // Regression: an unbounded cache is a JSON file that is read in full on every
  // launch and rewritten on every flush.
  it('keeps the most recently used entries', () => {
    const table: SummaryTable = {};
    for (let index = 0; index < 10; index += 1) {
      table[`k${index}`] = { value: index, usedAt: index };
    }
    const pruned = pruneTable(table, 3);
    expect(Object.keys(pruned).sort()).toEqual(['k7', 'k8', 'k9']);
  });

  // Regression: pruning a table that already fits must not reorder or rebuild it.
  it('returns the table untouched when it fits', () => {
    const table: SummaryTable = { a: { value: 1, usedAt: 1 } };
    expect(pruneTable(table, MAX_CACHED_SUMMARIES)).toBe(table);
  });
});

describe('mergeTables', () => {
  // Regression: a summary computed while the stored table was still loading has
  // already cost an AI call; assigning over it throws that call away.
  it('keeps live entries over stored ones', () => {
    const merged = mergeTables(
      { a: { value: 'stored', usedAt: 1 }, b: { value: 'only-stored', usedAt: 1 } },
      { a: { value: 'live', usedAt: 2 } }
    );
    expect(merged.a.value).toBe('live');
    expect(merged.b.value).toBe('only-stored');
  });
});

describe('createSummaryCache', () => {
  function harness(stored: unknown = undefined) {
    const saves: SummaryTable[] = [];
    const errors: unknown[] = [];
    let clock = 1_000;
    const cache = createSummaryCache({
      load: async () => stored,
      save: async (table) => {
        saves.push({ ...table });
      },
      now: () => (clock += 10),
      onError: (error) => errors.push(error),
    });
    return { cache, saves, errors, tick: () => (clock += 1_000) };
  }

  // Regression: a miss must be distinguishable from a cached "the model had
  // nothing to say", or every unusable answer is retried forever at full cost.
  it('tells a miss apart from a cached null', async () => {
    const { cache } = harness();
    await cache.ready;

    expect(cache.get('absent')).toBeUndefined();
    cache.set('known-bad', null);
    expect(cache.get('known-bad')).toBeNull();
  });

  // Regression: a summary that survives a restart is the whole point; one that
  // is never written back is an AI call paid for twice.
  it('reads the stored table and writes changes on dispose', async () => {
    const { cache, saves } = harness({ old: { value: 'from disk', usedAt: 5 } });
    await cache.ready;

    expect(cache.get<string>('old')).toBe('from disk');
    cache.set('new', 'fresh');
    await cache.dispose();

    expect(saves).toHaveLength(1);
    expect(saves[0].new.value).toBe('fresh');
    expect(saves[0].old.value).toBe('from disk');
  });

  // Regression: a summary computed before the stored table landed was silently
  // discarded when the load assigned over the table.
  it('keeps a summary written while the load was still in flight', async () => {
    let release: ((value: unknown) => void) | undefined;
    const saves: SummaryTable[] = [];
    const cache = createSummaryCache({
      load: () => new Promise((resolve) => { release = resolve; }),
      save: async (table) => { saves.push({ ...table }); },
    });

    cache.set('during-load', 'computed');
    release?.({ stored: { value: 'from disk', usedAt: 1 } });
    await cache.ready;

    expect(cache.get<string>('during-load')).toBe('computed');
    expect(cache.get<string>('stored')).toBe('from disk');
  });

  // Regression: without this, pruning evicts the threads somebody actually
  // reads in favour of whatever was summarized most recently.
  it('counts a read as a use', async () => {
    const { cache } = harness({ a: { value: 1, usedAt: 0 } });
    await cache.ready;

    cache.get('a');
    expect(cache.snapshot().a.usedAt).toBeGreaterThan(0);
  });

  // Regression: an unreadable cache file must never stop the extension
  // activating — the next summary simply recomputes.
  it('activates with an empty cache when the load fails', async () => {
    const errors: unknown[] = [];
    const cache = createSummaryCache({
      load: async () => { throw new Error('unreadable'); },
      save: async () => undefined,
      onError: (error) => errors.push(error),
    });
    await cache.ready;

    expect(errors).toHaveLength(1);
    expect(cache.snapshot()).toEqual({});
    cache.set('a', 1);
    expect(cache.get('a')).toBe(1);
  });

  // Regression: a failed write must be reported and retried, not swallowed —
  // the symptom is otherwise just a cache that never persists.
  it('reports a failed write and keeps the entries in memory', async () => {
    const errors: unknown[] = [];
    const cache = createSummaryCache({
      load: async () => undefined,
      save: async () => { throw new Error('disk full'); },
      onError: (error) => errors.push(error),
    });
    await cache.ready;

    cache.set('a', 1);
    await cache.flush();

    expect(errors).toHaveLength(1);
    expect(cache.get('a')).toBe(1);
  });

  // Regression: writing per summary reinstates the synchronous whole-file write
  // this cache exists to avoid.
  it('does not write on every set', async () => {
    const { cache, saves } = harness();
    await cache.ready;

    for (let index = 0; index < 20; index += 1) cache.set(`k${index}`, index);
    expect(saves).toHaveLength(0);

    await cache.flush();
    expect(saves).toHaveLength(1);
  });

  // Regression: an unbounded table reaches the write path whole; pruning has to
  // happen there, not only in the helper.
  it('prunes when it writes', async () => {
    const saves: SummaryTable[] = [];
    let clock = 0;
    const cache = createSummaryCache({
      load: async () => undefined,
      save: async (table) => { saves.push({ ...table }); },
      maxEntries: 3,
      now: () => (clock += 1),
    });
    await cache.ready;

    for (let index = 0; index < 10; index += 1) cache.set(`k${index}`, index);
    await cache.flush();

    expect(Object.keys(saves[0])).toHaveLength(3);
    expect(saves[0]).toHaveProperty('k9');
  });

  // Regression: a flush with nothing pending rewrites the whole file for no
  // reason, on a timer, forever.
  it('does not write when nothing changed', async () => {
    const { cache, saves } = harness();
    await cache.ready;

    await cache.flush();
    await cache.dispose();
    expect(saves).toHaveLength(0);
  });

  // Regression: the timer must not hold a torn-down extension alive or write
  // over what the next activation is building.
  it('stops scheduling after dispose', async () => {
    vi.useFakeTimers();
    try {
      const saves: SummaryTable[] = [];
      const cache = createSummaryCache({
        load: async () => undefined,
        save: async (table) => { saves.push({ ...table }); },
        flushIntervalMs: 1_000,
      });
      await cache.ready;
      await cache.dispose();

      cache.set('a', 1);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(saves).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
