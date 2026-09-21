import { describe, it, expect, vi } from 'vitest';

import {
  createProfileStore,
  mergeProfiles,
  pruneTable,
  sanitizeTable,
  type ProfileTable,
} from '../../src/profile-store';
import type { SenderObservation, SenderProfile } from '../../src/relationship';

const NOW = 1_700_000_000_000;

function profile(overrides: Partial<SenderProfile> = {}): SenderProfile {
  return { received: 1, replied: 0, sent: 0, starred: 0, direct: 1, firstSeen: NOW, lastSeen: NOW, ...overrides };
}

const observation: SenderObservation = {
  inbound: true,
  answered: true,
  starred: false,
  direct: true,
  at: NOW,
};

describe('sanitizeTable', () => {
  // Regression: this file is plain JSON in the user's data directory. A crash
  // mid-write truncates it and a hand edit can put anything in it. A NaN count
  // poisons every score that sender ever gets, silently.
  it.each([
    ['null', null],
    ['a string', 'nonsense'],
    ['an array', [1, 2, 3]],
  ])('returns an empty table for %s', (_label, raw) => {
    expect(sanitizeTable(raw)).toEqual({});
  });

  it('drops entries with malformed counters', () => {
    const table = sanitizeTable({
      good: profile(),
      nan: { ...profile(), received: Number.NaN },
      negative: { ...profile(), replied: -1 },
      missing: { received: 1 },
      notAnObject: 'x',
    });
    expect(Object.keys(table)).toEqual(['good']);
  });

  // Regression: a table written before `sent` existed is still months of real
  // history. Disqualifying it over one missing field throws that away.
  it('defaults a missing sent counter instead of dropping the entry', () => {
    const { received, replied, starred, direct, firstSeen, lastSeen } = profile();
    const table = sanitizeTable({ ada: { received, replied, starred, direct, firstSeen, lastSeen } });
    expect(table.ada.sent).toBe(0);
  });
});

describe('pruneTable', () => {
  // Regression: a mailbox holds tens of thousands of distinct senders and the
  // whole table is one JSON file read in full on every load. Unbounded growth
  // turns activation into a slow synchronous parse.
  it('keeps the most recently active senders', () => {
    const table: ProfileTable = {
      old: profile({ lastSeen: NOW - 1000 }),
      newer: profile({ lastSeen: NOW }),
      oldest: profile({ lastSeen: NOW - 5000 }),
    };
    expect(Object.keys(pruneTable(table, 2)).sort()).toEqual(['newer', 'old']);
  });

  // Regression: pruning by volume rather than recency would keep bulk senders
  // and evict the people you actually deal with.
  it('returns the table unchanged when it is under the cap', () => {
    const table: ProfileTable = { ada: profile() };
    expect(pruneTable(table, 10)).toBe(table);
  });
});

describe('mergeProfiles', () => {
  // Regression: loading the table is asynchronous while observing a message is
  // not. Without merging, every message synced during activation is discarded
  // and the counters simply come out low, with nothing to show anything was
  // lost.
  it('sums counters and spans both time ranges', () => {
    const merged = mergeProfiles(
      profile({ received: 2, replied: 1, sent: 3, starred: 1, direct: 2, firstSeen: NOW - 100, lastSeen: NOW - 50 }),
      profile({ received: 4, replied: 2, sent: 1, starred: 0, direct: 4, firstSeen: NOW - 20, lastSeen: NOW })
    );
    expect(merged).toEqual({
      received: 6,
      replied: 3,
      sent: 4,
      starred: 1,
      direct: 6,
      firstSeen: NOW - 100,
      lastSeen: NOW,
    });
  });
});

describe('createProfileStore', () => {
  // Regression: the storage backend rewrites the WHOLE storage.json
  // synchronously on every set, on the main thread. A write per message turns a
  // large first sync into quadratic main-thread I/O and freezes the window.
  it('does not write once per observation', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const store = createProfileStore({ load: async () => ({}), save, flushIntervalMs: 60_000 });
    await store.ready;

    for (let index = 0; index < 100; index++) {
      store.observe(`sender-${index}@example.com`, observation);
    }

    expect(save).not.toHaveBeenCalled();
  });

  // Regression: observations must still reach disk. A store that never flushes
  // loses everything on quit and the extension relearns from nothing forever.
  it('writes everything learned on a flush', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const store = createProfileStore({ load: async () => ({}), save, flushIntervalMs: 60_000 });
    await store.ready;

    store.observe('ada@example.com', observation);
    await store.flush();

    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0][0]['ada@example.com']).toMatchObject({ received: 1, replied: 1 });
  });

  // Regression: flushing an unchanged table is a whole-file synchronous write
  // for nothing, repeated every interval for as long as the app is open.
  it('skips the write when nothing changed', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const store = createProfileStore({ load: async () => ({}), save });
    await store.ready;

    await store.flush();
    expect(save).not.toHaveBeenCalled();
  });

  // Regression: a failed write must not silently discard everything learned
  // since the last successful one — the next flush has to retry.
  it('retries after a failed write', async () => {
    const save = vi.fn().mockRejectedValueOnce(new Error('disk full')).mockResolvedValue(undefined);
    const errors: unknown[] = [];
    const store = createProfileStore({
      load: async () => ({}),
      save,
      onError: (error) => errors.push(error),
    });
    await store.ready;

    store.observe('ada@example.com', observation);
    await store.flush();
    await store.flush();

    expect(save).toHaveBeenCalledTimes(2);
    expect(errors).toHaveLength(1);
  });

  // Regression: an unreadable table is an empty one, not a reason to fail
  // activation. The extension relearns from the next sync.
  it('activates with an empty table when the load fails', async () => {
    const errors: unknown[] = [];
    const store = createProfileStore({
      load: async () => {
        throw new Error('unreadable');
      },
      save: async () => undefined,
      onError: (error) => errors.push(error),
    });
    await store.ready;

    expect(store.snapshot()).toEqual({});
    expect(errors).toHaveLength(1);
  });

  // Regression: a message observed before the stored table finished loading
  // must survive the load. Assigning rather than merging silently dropped
  // every message synced during activation.
  it('keeps observations made while the load was still in flight', async () => {
    let releaseLoad: (value: ProfileTable) => void = () => undefined;
    const loaded = new Promise<ProfileTable>((resolve) => {
      releaseLoad = resolve;
    });
    const store = createProfileStore({ load: () => loaded, save: async () => undefined });

    store.observe('ada@example.com', observation);
    releaseLoad({ 'ada@example.com': profile({ received: 5, replied: 5 }) });
    await store.ready;

    expect(store.get('ada@example.com')).toMatchObject({ received: 6, replied: 6 });
  });

  // Regression: the table on disk must be honoured, or every restart starts
  // the learning over and no sender ever accumulates enough evidence.
  it('loads an existing table', async () => {
    const store = createProfileStore({
      load: async () => ({ 'ada@example.com': profile({ received: 9 }) }),
      save: async () => undefined,
    });
    await store.ready;

    expect(store.get('ada@example.com')?.received).toBe(9);
  });

  // Regression: quitting must not lose up to a full interval of counters.
  it('writes pending changes on dispose', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const store = createProfileStore({ load: async () => ({}), save, flushIntervalMs: 60_000 });
    await store.ready;

    store.observe('ada@example.com', observation);
    await store.dispose();

    expect(save).toHaveBeenCalledTimes(1);
  });

  // Regression: the scheduled flush must actually fire, otherwise the only
  // write ever made is the one on quit — and a crash loses everything.
  it('flushes on its own after the interval', async () => {
    vi.useFakeTimers();
    try {
      const save = vi.fn().mockResolvedValue(undefined);
      const store = createProfileStore({ load: async () => ({}), save, flushIntervalMs: 1_000 });
      await store.ready;

      store.observe('ada@example.com', observation);
      await vi.advanceTimersByTimeAsync(1_100);

      expect(save).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  // Regression: the table is pruned at flush time; growing past the cap without
  // pruning is how the file becomes megabytes of dead senders.
  it('prunes to the cap when it writes', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const store = createProfileStore({
      load: async () => ({}),
      save,
      maxSenders: 2,
      flushIntervalMs: 60_000,
    });
    await store.ready;

    store.observe('a@example.com', { ...observation, at: NOW - 3000 });
    store.observe('b@example.com', { ...observation, at: NOW - 2000 });
    store.observe('c@example.com', { ...observation, at: NOW });
    await store.flush();

    expect(Object.keys(save.mock.calls[0][0]).sort()).toEqual(['b@example.com', 'c@example.com']);
  });
});
