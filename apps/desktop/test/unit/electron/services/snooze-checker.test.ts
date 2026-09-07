import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Snooze checker. It must fan out over EVERY initialized account (a mail snoozed
 * in a background account still has to wake), isolate one account's failure, and
 * report one aggregated wakeup to the renderer.
 */

interface FakeStorage {
  due: Array<{ emailId: string }>;
  unsnoozed: Array<[string, boolean]>;
  throwOnGet: boolean;
  throwOnUnsnooze: boolean;
  getDueSnoozedEmails: () => Promise<Array<{ emailId: string }>>;
  unsnoozeEmail: (id: string, markUnread: boolean) => Promise<void>;
}

const h = vi.hoisted(() => ({
  accountIds: [] as string[],
  storages: new Map<string, unknown>(),
  activeStorage: null as unknown,
  window: null as { sent: Array<{ channel: string; payload: unknown }> } | null,
}));

vi.mock('../../../../electron/shared', () => ({
  getStorage: () => h.activeStorage,
  getStorageFor: (id: string) => h.storages.get(id) ?? null,
  getAllAccountIds: () => h.accountIds,
  getMainWindow: () => (h.window ? { webContents: { send: (channel: string, payload: unknown) => h.window!.sent.push({ channel, payload }) } } : null),
}));

vi.mock('@sarvinbox/core', () => ({
  createLogger: () => ({
    info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {},
  }),
}));

import { startSnoozeChecker, stopSnoozeChecker } from '../../../../electron/services/snooze-checker';

const makeStorage = (due: string[] = [], opts: Partial<FakeStorage> = {}): FakeStorage => {
  const storage: FakeStorage = {
    due: due.map((emailId) => ({ emailId })),
    unsnoozed: [],
    throwOnGet: false,
    throwOnUnsnooze: false,
    getDueSnoozedEmails: async () => {
      if (storage.throwOnGet) throw new Error('db read failed');
      return storage.due;
    },
    unsnoozeEmail: async (id: string, markUnread: boolean) => {
      if (storage.throwOnUnsnooze) throw new Error('unsnooze failed');
      storage.unsnoozed.push([id, markUnread]);
    },
    ...opts,
  };
  return storage;
};

beforeEach(() => {
  vi.useFakeTimers();
  h.accountIds = [];
  h.storages.clear();
  h.activeStorage = null;
  h.window = { sent: [] };
});

afterEach(() => {
  stopSnoozeChecker();
  vi.useRealTimers();
});

describe('startSnoozeChecker', () => {
  it('checks immediately, then once a minute', async () => {
    const storage = makeStorage(['e1']);
    h.accountIds = ['acct-a'];
    h.storages.set('acct-a', storage);

    startSnoozeChecker();
    await vi.advanceTimersByTimeAsync(0);
    expect(storage.unsnoozed).toEqual([['e1', true]]);

    storage.due = [{ emailId: 'e2' }];
    await vi.advanceTimersByTimeAsync(60_000);
    expect(storage.unsnoozed).toEqual([['e1', true], ['e2', true]]);
  });

  it('is idempotent — a second start does not double the cadence', async () => {
    const storage = makeStorage();
    h.accountIds = ['acct-a'];
    h.storages.set('acct-a', storage);
    startSnoozeChecker();
    startSnoozeChecker();
    storage.due = [{ emailId: 'e1' }];
    await vi.advanceTimersByTimeAsync(60_000);
    expect(storage.unsnoozed).toEqual([['e1', true]]);
  });

  it('fans out across accounts and reports ONE aggregated wakeup', async () => {
    const a = makeStorage(['a1', 'a2']);
    const b = makeStorage(['b1']);
    h.accountIds = ['acct-a', 'acct-b', 'acct-missing'];
    h.storages.set('acct-a', a);
    h.storages.set('acct-b', b);

    startSnoozeChecker();
    await vi.advanceTimersByTimeAsync(0);

    expect(a.unsnoozed.map(([id]) => id)).toEqual(['a1', 'a2']);
    expect(b.unsnoozed.map(([id]) => id)).toEqual(['b1']);
    expect(h.window!.sent).toEqual([
      { channel: 'snooze:wakeup', payload: { count: 3, emailIds: ['a1', 'a2', 'b1'] } },
    ]);
  });

  it('falls back to the ACTIVE storage before any account runtime is registered', async () => {
    const active = makeStorage(['only']);
    h.activeStorage = active;
    startSnoozeChecker();
    await vi.advanceTimersByTimeAsync(0);
    expect(active.unsnoozed).toEqual([['only', true]]);
  });

  it('does nothing (and notifies nothing) with no storage at all', async () => {
    startSnoozeChecker();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.window!.sent).toEqual([]);
  });

  it('stays silent when nothing is due', async () => {
    h.accountIds = ['acct-a'];
    h.storages.set('acct-a', makeStorage([]));
    startSnoozeChecker();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.window!.sent).toEqual([]);
  });

  it('isolates one account failure — the others still wake', async () => {
    const broken = makeStorage(['x']);
    broken.throwOnGet = true;
    const ok = makeStorage(['good']);
    h.accountIds = ['broken', 'ok'];
    h.storages.set('broken', broken);
    h.storages.set('ok', ok);

    startSnoozeChecker();
    await vi.advanceTimersByTimeAsync(0);
    expect(ok.unsnoozed).toEqual([['good', true]]);
    expect(h.window!.sent[0].payload).toEqual({ count: 1, emailIds: ['good'] });
  });

  it('reports nothing for an account whose unsnooze write fails', async () => {
    const storage = makeStorage(['e1']);
    storage.throwOnUnsnooze = true;
    h.accountIds = ['acct-a'];
    h.storages.set('acct-a', storage);
    startSnoozeChecker();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.window!.sent).toEqual([]);
  });

  it('survives a missing window (headless / window closed) and still unsnoozes', async () => {
    h.window = null;
    const storage = makeStorage(['e1']);
    h.accountIds = ['acct-a'];
    h.storages.set('acct-a', storage);
    startSnoozeChecker();
    await vi.advanceTimersByTimeAsync(0);
    expect(storage.unsnoozed).toEqual([['e1', true]]);
  });
});

describe('stopSnoozeChecker', () => {
  it('cancels the interval so nothing fires afterwards', async () => {
    const storage = makeStorage();
    h.accountIds = ['acct-a'];
    h.storages.set('acct-a', storage);
    startSnoozeChecker();
    await vi.advanceTimersByTimeAsync(0);

    stopSnoozeChecker();
    storage.due = [{ emailId: 'late' }];
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(storage.unsnoozed).toEqual([]);
  });

  it('is safe to call when never started', () => {
    expect(() => { stopSnoozeChecker(); stopSnoozeChecker(); }).not.toThrow();
  });

  it('can be restarted after a stop', async () => {
    const storage = makeStorage(['again']);
    h.accountIds = ['acct-a'];
    h.storages.set('acct-a', storage);
    startSnoozeChecker();
    stopSnoozeChecker();
    startSnoozeChecker();
    await vi.advanceTimersByTimeAsync(0);
    expect(storage.unsnoozed.length).toBeGreaterThan(0);
  });
});
