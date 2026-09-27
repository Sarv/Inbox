import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Outbox's IPC surface — specifically, what a send row looks like by the
 * time the renderer sees it.
 *
 * The regression this exists for: `smtp_accepted` (SMTP took the message; only
 * its Sent-folder copy is outstanding) was dropped by this mapper, so the
 * Outbox had no way to tell a message already sitting in the recipient's inbox
 * from one still waiting to go out — and listed it as "Queued", with a Discard
 * bin beside it.
 */

const h = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  sends: [] as Array<Record<string, unknown>>,
  storageThrows: false,
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => {
      h.handlers.set(channel, fn);
    },
  },
}));

vi.mock('../../../../electron/services/outbox-service', () => ({
  drainOutbox: vi.fn(async () => ({ sent: 0, queued: 0, failed: 0 })),
  notifyOutboxChanged: vi.fn(),
}));

vi.mock('../../../../electron/shared', () => ({
  requireStorage: () => {
    if (h.storageThrows) throw new Error('Storage not initialized');
    return { getAllSends: async () => h.sends };
  },
  getSyncEngine: () => null,
  getSmtpClient: () => null,
}));

const call = async (channel: string, ...args: unknown[]) => {
  const handler = h.handlers.get(channel);
  if (!handler) throw new Error(`no handler for ${channel}`);
  return handler({}, ...args) as Promise<{ success: boolean; data?: unknown; error?: string }>;
};

beforeEach(async () => {
  h.handlers.clear();
  h.sends = [];
  h.storageThrows = false;
  const { registerQueueHandlers } = await import('../../../../electron/ipc/queue-handlers');
  registerQueueHandlers();
});

describe('outbox:list', () => {
  it('carries the durability flags, so a delivered send can be told apart', async () => {
    h.sends = [{
      id: 7,
      payload: { to: ['friend@example.test'], subject: 'hi' },
      status: 'append_pending',
      retryCount: 0,
      lastError: null,
      nextRetryAt: null,
      scheduledAt: null,
      smtpAccepted: true,
      sentAppendPending: true,
      createdAt: 1_700_000_000,
      updatedAt: 1_700_000_000,
    }];

    const res = await call('outbox:list');
    expect(res.success).toBe(true);
    expect((res.data as Array<Record<string, unknown>>)[0]).toMatchObject({
      id: 7,
      to: 'friend@example.test',
      subject: 'hi',
      status: 'append_pending',
      smtpAccepted: true,
      sentAppendPending: true,
    });
  });

  // An ordinary queued send must NOT arrive looking delivered: the flags are
  // absent on older rows, and `undefined` would read as "not accepted" only by
  // luck.
  it('reports a plain queued send as neither accepted nor pending-append', async () => {
    h.sends = [{
      id: 8,
      payload: { to: 'solo@example.test' },
      status: 'pending',
      retryCount: 0,
      lastError: null,
      nextRetryAt: null,
      createdAt: 1_700_000_000,
      updatedAt: 1_700_000_000,
    }];

    const [row] = (await call('outbox:list')).data as Array<Record<string, unknown>>;
    expect(row).toMatchObject({ to: 'solo@example.test', subject: '', smtpAccepted: false, sentAppendPending: false });
  });

  it('reports a storage failure instead of throwing at the renderer', async () => {
    h.storageThrows = true;
    expect(await call('outbox:list')).toEqual({ success: false, error: 'Storage not initialized' });
  });
});
