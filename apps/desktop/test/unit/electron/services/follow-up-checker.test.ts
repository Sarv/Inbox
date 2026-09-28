import type { FollowUp, FollowUpStatus } from '@sarvinbox/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Follow-up checker. It must fan out over EVERY account (a reminder on a
 * background account still fires), isolate one account's failure, notify each
 * reminder exactly once as it falls due, never override a dismiss that lands
 * mid-pass, and tell the renderer only when something changed.
 */

const h = vi.hoisted(() => ({
  accountIds: [] as string[],
  storages: new Map<string, unknown>(),
  activeStorage: null as unknown,
  window: null as { sent: Array<{ channel: string; payload: unknown }>; sendThrows?: boolean } | null,
  notified: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../../../electron/shared', () => ({
  getStorage: () => h.activeStorage,
  getStorageFor: (id: string) => h.storages.get(id) ?? null,
  getAllAccountIds: () => h.accountIds,
  getMainWindow: () =>
    h.window
      ? {
          webContents: {
            send: (channel: string, payload: unknown) => {
              if (h.window!.sendThrows) throw new Error('window closing');
              h.window!.sent.push({ channel, payload });
            },
          },
        }
      : null,
}));
vi.mock('../../../../electron/services/notification-service', () => ({
  notifyFollowUpDue: (notice: Record<string, unknown>) => h.notified.push(notice),
}));
vi.mock('@sarvinbox/core', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

import {
  checkFollowUpsForAccount,
  followUpStores,
  runFollowUpCheck,
  startFollowUpChecker,
  stopFollowUpChecker,
} from '../../../../electron/services/follow-up-checker';

const NOW = 1_790_000_000;

const followUp = (id: string, over: Partial<FollowUp> = {}): FollowUp => ({
  id,
  messageId: `<${id}@x>`,
  subject: `Subject ${id}`,
  recipients: 'alice@example.com',
  fromAddress: 'me@example.com',
  sentAt: NOW - 86_400,
  dueAt: NOW - 1,
  status: 'pending',
  resolvedAt: null,
  emailId: `e-${id}`,
  threadId: `t-${id}`,
  ...over,
});

interface FakeStore {
  open: FollowUp[];
  replied: Set<string>;
  refuse: Set<string>;
  writes: Array<[string, FollowUpStatus]>;
  listThrows?: boolean;
  listOpenFollowUps: () => Promise<FollowUp[]>;
  followUpHasReply: (f: Pick<FollowUp, 'messageId'>) => Promise<boolean>;
  setFollowUpStatus: (id: string, status: FollowUpStatus) => Promise<boolean>;
}

const makeStore = (open: FollowUp[], over: Partial<FakeStore> = {}): FakeStore => {
  const store: FakeStore = {
    open,
    replied: new Set(),
    refuse: new Set(),
    writes: [],
    listOpenFollowUps: async () => {
      if (store.listThrows) throw new Error('database is locked');
      return store.open;
    },
    followUpHasReply: async (f) => store.replied.has(f.messageId),
    setFollowUpStatus: async (id, status) => {
      if (store.refuse.has(id)) return false;
      store.writes.push([id, status]);
      return true;
    },
    ...over,
  };
  return store;
};

beforeEach(() => {
  h.accountIds = [];
  h.storages.clear();
  h.activeStorage = null;
  h.window = { sent: [] };
  h.notified.length = 0;
});

afterEach(() => {
  stopFollowUpChecker();
  vi.useRealTimers();
});

describe('checkFollowUpsForAccount', () => {
  // The core pass: past-due and unanswered -> due; answered -> replied; not yet -> untouched.
  it('marks due, ends replied, and leaves future reminders', async () => {
    const store = makeStore([followUp('due'), followUp('answered'), followUp('later', { dueAt: NOW + 60 })]);
    store.replied.add('<answered@x>');
    const result = await checkFollowUpsForAccount('acct-a', store, NOW);
    expect(result.due.map((f) => [f.id, f.status, f.accountId])).toEqual([['due', 'due', 'acct-a']]);
    expect(result.replied).toBe(1);
    expect(store.writes).toEqual([['due', 'due'], ['answered', 'replied']]);
  });

  // A dismiss between our read and write wins: no notification for it.
  it('does not notify a reminder whose status write was refused', async () => {
    const store = makeStore([followUp('dismissed-meanwhile')]);
    store.refuse.add('dismissed-meanwhile');
    expect(await checkFollowUpsForAccount('acct-a', store, NOW)).toEqual({ due: [], replied: 0 });
  });

  // A locked DB skips this account this minute instead of throwing.
  it('reports nothing when the store fails', async () => {
    const store = makeStore([followUp('x')], { listThrows: true });
    expect(await checkFollowUpsForAccount('acct-a', store, NOW)).toEqual({ due: [], replied: 0 });
  });
});

describe('followUpStores', () => {
  // Every registered account is checked, and an uninitialised one is skipped.
  it('lists every account that has storage', () => {
    h.accountIds = ['acct-a', 'acct-b', 'acct-gone'];
    h.storages.set('acct-a', makeStore([]));
    h.storages.set('acct-b', makeStore([]));
    expect(followUpStores().map((t) => t.accountId)).toEqual(['acct-a', 'acct-b']);
  });

  // Before any account runtime exists, the active storage is the only one.
  it('falls back to the active storage with no accounts registered', () => {
    expect(followUpStores()).toEqual([]);
    h.activeStorage = makeStore([]);
    expect(followUpStores()).toEqual([{ accountId: '', store: h.activeStorage }]);
  });
});

describe('runFollowUpCheck', () => {
  // Multi-account: each due reminder notifies once, tagged with ITS account,
  // one failing account does not stop the other, and the renderer is told once.
  it('notifies across accounts and signals the renderer', async () => {
    h.accountIds = ['acct-a', 'acct-b'];
    h.storages.set('acct-a', makeStore([followUp('a1')], { listThrows: true }));
    const storeB = makeStore([followUp('b1'), followUp('b2')]);
    storeB.replied.add('<b2@x>');
    h.storages.set('acct-b', storeB);

    expect(await runFollowUpCheck()).toBe(1);
    expect(h.notified).toEqual([expect.objectContaining({ id: 'b1', accountId: 'acct-b', threadId: 't-b1' })]);
    expect(h.window!.sent).toEqual([{ channel: 'follow-ups:changed', payload: { due: 1, replied: 1 } }]);
  });

  // An idle pass must not wake the renderer every minute.
  it('stays quiet when nothing changed', async () => {
    h.activeStorage = makeStore([followUp('later', { dueAt: Date.now() / 1000 + 3600 })]);
    expect(await runFollowUpCheck()).toBe(0);
    expect(h.window!.sent).toEqual([]);
  });

  // A closing window must not turn a successful pass into a failure.
  it('survives a window that is closing', async () => {
    h.activeStorage = makeStore([followUp('due')]);
    h.window!.sendThrows = true;
    await expect(runFollowUpCheck()).resolves.toBe(1);
  });

  it('does nothing with no storage at all', async () => {
    await expect(runFollowUpCheck()).resolves.toBe(0);
  });
});

describe('start / stop', () => {
  // Runs at once (a reminder that fell due while the app was closed fires on
  // launch), then every minute; a second start must not double the timer.
  it('runs immediately, then each minute, once', async () => {
    vi.useFakeTimers();
    const store = makeStore([]);
    const list = vi.spyOn(store, 'listOpenFollowUps');
    h.activeStorage = store;
    startFollowUpChecker();
    startFollowUpChecker();
    await vi.advanceTimersByTimeAsync(0);
    expect(list).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(list).toHaveBeenCalledTimes(2);
    stopFollowUpChecker();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(list).toHaveBeenCalledTimes(2);
  });
});
