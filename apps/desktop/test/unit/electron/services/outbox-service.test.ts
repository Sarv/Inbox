import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppendSentFn, SendFn } from '@sarvinbox/core';

/**
 * Outbox wiring (the SendQueue itself lives in @sarvinbox/core). What this module
 * owns, and what is pinned here:
 *   - the singleton is bound to the ACTIVE account's storage + SMTP client, and
 *     recovers persisted sends (loadFromStorage) BEFORE the first drain,
 *   - a per-account queue tags every send/append with its accountId so a
 *     cross-account send persists and drains against the right DB/SMTP,
 *   - drains never throw at the caller (they log), and every drain pokes the
 *     renderer so the badge updates without polling,
 *   - stopOutbox cancels the periodic drain.
 */

const h = vi.hoisted(() => {
  interface QueueRecord {
    initCalls: Array<{
      storage: unknown;
      sendFn: (opts: Record<string, unknown>) => Promise<unknown>;
      appendSentFn?: (raw: unknown, mid: unknown, opts: Record<string, unknown>) => Promise<unknown>;
      isConnected: () => boolean;
    }>;
    events: string[];
    loadRejects: boolean;
    processRejects: boolean;
    result: { sent: number; queued: number; failed: number };
  }

  const queues: QueueRecord[] = [];
  const state = {
    storage: null as unknown,
    storageFor: new Map<string, unknown>(),
    smtpConnected: false,
    smtpClient: true,
    smtpConnectedFor: new Map<string, boolean>(),
    window: null as { sent: string[]; sendThrows: boolean } | null,
    sendCalls: [] as Array<Record<string, unknown>>,
    appendCalls: [] as Array<Record<string, unknown>>,
  };

  class FakeSendQueue {
    record: QueueRecord = {
      initCalls: [],
      events: [],
      loadRejects: false,
      processRejects: false,
      result: { sent: 0, queued: 0, failed: 0 },
    };
    constructor() { queues.push(this.record); }
    initialize(opts: QueueRecord['initCalls'][number]): void {
      this.record.initCalls.push(opts);
      this.record.events.push('initialize');
    }
    async loadFromStorage(): Promise<void> {
      this.record.events.push('load');
      if (this.record.loadRejects) throw new Error('load failed');
    }
    async processQueue(): Promise<{ sent: number; queued: number; failed: number }> {
      this.record.events.push('process');
      if (this.record.processRejects) throw new Error('drain failed');
      return this.record.result;
    }
  }

  return { queues, state, FakeSendQueue };
});

vi.mock('@sarvinbox/core', () => ({
  SendQueue: h.FakeSendQueue,
  createLogger: () => ({
    info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {},
  }),
}));

vi.mock('../../../../electron/shared', () => ({
  getStorage: () => h.state.storage,
  getStorageFor: (id: string) => h.state.storageFor.get(id) ?? null,
  getSmtpClient: () => (h.state.smtpClient ? { isConnected: () => h.state.smtpConnected } : null),
  getSmtpClientFor: (id: string) =>
    h.state.smtpConnectedFor.has(id)
      ? { isConnected: () => h.state.smtpConnectedFor.get(id)! }
      : null,
  getMainWindow: () =>
    h.state.window
      ? {
          webContents: {
            send: (channel: string) => {
              if (h.state.window!.sendThrows) throw new Error('window gone');
              h.state.window!.sent.push(channel);
            },
          },
        }
      : null,
}));

type Service = typeof import('../../../../electron/services/outbox-service');

/** Fresh module — the singleton queue and drain timer are module state. */
const load = async (): Promise<Service> => {
  vi.resetModules();
  return import('../../../../electron/services/outbox-service');
};

// Cast through `unknown`: the fakes only need the shape the service passes on,
// not the full SMTP payload types.
const sendFn = (async (opts: Record<string, unknown>) => {
  h.state.sendCalls.push(opts);
  return { messageId: 'mid-1' };
}) as unknown as SendFn;

const appendSentFn = (async (raw: unknown, mid: unknown, opts: Record<string, unknown>) => {
  h.state.appendCalls.push({ raw, mid, ...opts });
}) as unknown as AppendSentFn;

beforeEach(() => {
  vi.useFakeTimers();
  h.queues.length = 0;
  h.state.storage = { tag: 'active-db' };
  h.state.storageFor.clear();
  h.state.smtpConnected = false;
  h.state.smtpClient = true;
  h.state.smtpConnectedFor.clear();
  h.state.window = { sent: [], sendThrows: false };
  h.state.sendCalls.length = 0;
  h.state.appendCalls.length = 0;
});

afterEach(() => { vi.useRealTimers(); });

describe('getOutboxQueue', () => {
  it('lazily creates exactly ONE queue and reuses it', async () => {
    const svc = await load();
    const first = svc.getOutboxQueue();
    expect(svc.getOutboxQueue()).toBe(first);
    expect(h.queues).toHaveLength(1);
  });
});

describe('initOutbox', () => {
  it('wires storage + SMTP, recovers persisted sends, then drains', async () => {
    const svc = await load();
    svc.initOutbox({ sendFn, appendSentFn });
    await vi.advanceTimersByTimeAsync(0);

    const [q] = h.queues;
    expect(q.events).toEqual(['initialize', 'load', 'process']);
    expect(q.initCalls[0].storage).toBe(h.state.storage);
    expect(q.initCalls[0].appendSentFn).toBe(appendSentFn);
  });

  it('reports SMTP connectivity live through the injected predicate', async () => {
    const svc = await load();
    svc.initOutbox({ sendFn });
    const { isConnected } = h.queues[0].initCalls[0];
    expect(isConnected()).toBe(false);
    h.state.smtpConnected = true;
    expect(isConnected()).toBe(true);
    h.state.smtpClient = false; // no client at all
    expect(isConnected()).toBe(false);
  });

  it('leaves appendSentFn undefined when none is injected', async () => {
    const svc = await load();
    svc.initOutbox({ sendFn });
    expect(h.queues[0].initCalls[0].appendSentFn).toBeUndefined();
  });

  it('SKIPS wiring (and the timer) when storage is not ready yet', async () => {
    h.state.storage = null;
    const svc = await load();
    svc.initOutbox({ sendFn });
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(h.queues).toHaveLength(0);
  });

  it('drains periodically as a retry backstop', async () => {
    const svc = await load();
    svc.initOutbox({ sendFn });
    await vi.advanceTimersByTimeAsync(0);
    const [q] = h.queues;
    const before = q.events.filter((e) => e === 'process').length;

    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(q.events.filter((e) => e === 'process').length).toBe(before + 2);
  });

  it('a failed initial load/drain is logged, not thrown', async () => {
    const svc = await load();
    const q = svc.getOutboxQueue();
    (q as unknown as { record: { loadRejects: boolean } }).record.loadRejects = true;
    expect(() => svc.initOutbox({ sendFn })).not.toThrow();
    await expect(vi.advanceTimersByTimeAsync(0)).resolves.toBeDefined();
  });

  it('a failed PERIODIC drain is logged, not thrown', async () => {
    const svc = await load();
    const q = svc.getOutboxQueue();
    svc.initOutbox({ sendFn });
    await vi.advanceTimersByTimeAsync(0);
    (q as unknown as { record: { processRejects: boolean } }).record.processRejects = true;
    await expect(vi.advanceTimersByTimeAsync(60_000)).resolves.toBeDefined();
  });

  it('re-initialising replaces the interval instead of stacking one', async () => {
    const svc = await load();
    svc.initOutbox({ sendFn });
    svc.initOutbox({ sendFn });
    await vi.advanceTimersByTimeAsync(0);
    const [q] = h.queues;
    const before = q.events.filter((e) => e === 'process').length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(q.events.filter((e) => e === 'process').length).toBe(before + 1);
  });
});

describe('rebindOutboxStorage', () => {
  it('re-points the SAME queue at the now-active account storage', async () => {
    const svc = await load();
    svc.initOutbox({ sendFn });
    await vi.advanceTimersByTimeAsync(0);

    const nextStorage = { tag: 'switched-db' };
    h.state.storage = nextStorage;
    svc.rebindOutboxStorage();
    await vi.advanceTimersByTimeAsync(0);

    expect(h.queues).toHaveLength(1); // same singleton
    const { initCalls } = h.queues[0];
    expect(initCalls[initCalls.length - 1].storage).toBe(nextStorage);
  });

  it('is a no-op warning when storage went away', async () => {
    const svc = await load();
    svc.initOutbox({ sendFn });
    await vi.advanceTimersByTimeAsync(0);
    const calls = h.queues[0].initCalls.length;

    h.state.storage = null;
    svc.rebindOutboxStorage();
    expect(h.queues[0].initCalls).toHaveLength(calls);
  });
});

describe('drainOutbox', () => {
  it('returns the queue result and pokes the renderer', async () => {
    const svc = await load();
    svc.initOutbox({ sendFn });
    const q = h.queues[0];
    q.result = { sent: 2, queued: 1, failed: 0 };

    await expect(svc.drainOutbox()).resolves.toEqual({ sent: 2, queued: 1, failed: 0 });
    expect(h.state.window!.sent).toContain('outbox:changed');
  });

  it('propagates a drain failure to the caller (it is an explicit request)', async () => {
    const svc = await load();
    svc.initOutbox({ sendFn });
    h.queues[0].processRejects = true;
    await expect(svc.drainOutbox()).rejects.toThrow('drain failed');
  });
});

describe('notifyOutboxChanged', () => {
  it('survives a missing window and a dead webContents', async () => {
    const svc = await load();
    h.state.window = null;
    expect(() => svc.notifyOutboxChanged()).not.toThrow();

    h.state.window = { sent: [], sendThrows: true };
    expect(() => svc.notifyOutboxChanged()).not.toThrow();
  });
});

describe('per-account outbox', () => {
  it('creates one queue per account and caches it', async () => {
    const svc = await load();
    h.state.storageFor.set('acct-a', { tag: 'a-db' });
    const q = svc.getOutboxQueueForAccount('acct-a');
    expect(svc.getOutboxQueueForAccount('acct-a')).toBe(q);
    expect(svc.getOutboxQueueForAccount('acct-b')).not.toBe(q);
  });

  it('TAGS the send and the Sent-append with the account id', async () => {
    const svc = await load();
    svc.initOutbox({ sendFn, appendSentFn });
    h.state.storageFor.set('acct-b', { tag: 'b-db' });
    h.state.smtpConnectedFor.set('acct-b', true);

    svc.getOutboxQueueForAccount('acct-b');
    const init = h.queues[h.queues.length - 1].initCalls[0];
    await init.sendFn({ to: 'x@y.com' });
    await init.appendSentFn!('raw-bytes', 'mid-1', { folder: 'Sent' });

    expect(h.state.sendCalls[0]).toEqual({ to: 'x@y.com', accountId: 'acct-b' });
    expect(h.state.appendCalls[0]).toEqual({
      raw: 'raw-bytes', mid: 'mid-1', folder: 'Sent', accountId: 'acct-b',
    });
    expect(init.isConnected()).toBe(true);
  });

  it('omits the append hook when none was injected, and reads per-account connectivity', async () => {
    const svc = await load();
    svc.initOutbox({ sendFn });
    h.state.storageFor.set('acct-c', { tag: 'c-db' });
    svc.getOutboxQueueForAccount('acct-c');
    const init = h.queues[h.queues.length - 1].initCalls[0];
    expect(init.appendSentFn).toBeUndefined();
    expect(init.isConnected()).toBe(false); // no SMTP client for that account
  });

  it('hands back an UNINITIALISED queue when the account has no storage / no sendFn', async () => {
    const svc = await load();
    // No initOutbox -> no sendFn; and no storage registered for the account.
    const q = svc.getOutboxQueueForAccount('acct-x');
    expect(q).toBeTruthy();
    expect(h.queues[h.queues.length - 1].initCalls).toHaveLength(0);
  });

  it('drainOutboxForAccount recovers then drains, and notifies once', async () => {
    const svc = await load();
    svc.initOutbox({ sendFn });
    h.state.storageFor.set('acct-a', { tag: 'a-db' });
    h.state.window!.sent.length = 0;

    await svc.drainOutboxForAccount('acct-a');
    const record = h.queues[h.queues.length - 1];
    expect(record.events).toEqual(['initialize', 'load', 'process']);
    expect(h.state.window!.sent).toEqual(['outbox:changed']);
  });

  it('drainOutboxForAccount swallows failures (background path)', async () => {
    const svc = await load();
    svc.initOutbox({ sendFn });
    h.state.storageFor.set('acct-a', { tag: 'a-db' });
    const q = svc.getOutboxQueueForAccount('acct-a');
    (q as unknown as { record: { processRejects: boolean } }).record.processRejects = true;

    await expect(svc.drainOutboxForAccount('acct-a')).resolves.toBeUndefined();
  });
});

describe('stopOutbox', () => {
  it('cancels the periodic drain so nothing fires after quit', async () => {
    const svc = await load();
    svc.initOutbox({ sendFn });
    await vi.advanceTimersByTimeAsync(0);
    const [q] = h.queues;
    const before = q.events.filter((e) => e === 'process').length;

    svc.stopOutbox();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(q.events.filter((e) => e === 'process').length).toBe(before);
  });

  it('is safe to call when never initialised, and twice', async () => {
    const svc = await load();
    expect(() => { svc.stopOutbox(); svc.stopOutbox(); }).not.toThrow();
  });
});
