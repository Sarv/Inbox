import { beforeEach, describe, expect, it, vi } from 'vitest';

// What breaks if this file fails: the Drafts badge is counted from the
// read-model projection, and the draft rows are written and deleted on the raw
// database handle (`storage.db`). The table triggers dirty the thread either
// way, but nothing schedules the drain, so the corrected count only lands on
// the maintainer's 5-second safety pump: the discarded draft vanished from the
// list immediately and the badge sat on the old number for one to five seconds.

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));

vi.mock('electron', () => ({
  ipcMain: { handle: (name: string, fn: (...a: unknown[]) => unknown) => h.handlers.set(name, fn) },
  dialog: {},
  shell: {},
  app: { getPath: () => '/tmp' },
}));
vi.mock('../../../../electron/shared', () => ({
  requireStorage: vi.fn(),
  getStorage: vi.fn(),
  getStorageFor: vi.fn(),
  getSyncEngine: vi.fn(),
  getSyncEngineFor: vi.fn(),
  getSmtpClient: vi.fn(),
  getSmtpClientFor: vi.fn(),
  setSmtpClient: vi.fn(),
  setSmtpClientFor: vi.fn(),
  getMainWindow: vi.fn(),
  getCurrentAccountId: vi.fn(() => 'acct-1'),
  getAllAccountIds: vi.fn(() => ['acct-1']),
  sendToWindow: vi.fn(),
}));
vi.mock('../../../../electron/services/oauth-service', () => ({ getValidAccessToken: vi.fn() }));
vi.mock('../../../../electron/services/unified-pipeline-service', () => ({
  getPipelineUserName: vi.fn(() => 'Me'),
}));
vi.mock('../../../../electron/services/outbox-service', () => ({
  getOutboxQueue: vi.fn(),
  drainOutbox: vi.fn(),
  getOutboxQueueForAccount: vi.fn(),
  drainOutboxForAccount: vi.fn(),
  notifyOutboxChanged: vi.fn(),
}));
vi.mock('../../../../electron/services/accounts-runtime', () => ({ ensureAccountRuntime: vi.fn() }));
vi.mock('../../../../electron/services/account-target', () => ({ resolveAccountTarget: vi.fn() }));

import { registerDraftHandlers, deleteDraftsForThread } from '../../../../electron/ipc/draft-handlers';
import { resolveAccountTarget } from '../../../../electron/services/account-target';

/** A storage whose raw handle answers the draft queries, and which records the
 *  read-model catch-up the badge depends on. */
function makeStorage(rows: Array<{ message_id: string; uid: number }>) {
  return {
    scheduleReadModelDrain: vi.fn(),
    db: {
      prepare: (sql: string) => ({
        all: () => (/SELECT message_id/.test(sql) ? rows : []),
        get: () => rows[0],
        run: () => ({ changes: rows.length }),
      }),
    },
    getFolders: async () => [{ id: 'f1', name: 'Drafts', path: 'Drafts', type: 'drafts' }],
  };
}

const onlineEngine = (client: unknown) => ({
  isConnected: () => true,
  deleteEmail: vi.fn(async () => ({ success: true })),
  getClient: () => client,
});

describe('discarding a draft refreshes the folder badge', () => {
  beforeEach(() => {
    h.handlers.clear();
    vi.clearAllMocks();
    registerDraftHandlers();
  });

  const callDelete = () =>
    h.handlers.get('drafts:delete')!({}, { threadId: 't-1', accountId: 'acct-1' }) as Promise<unknown>;

  // Breaks: THE regression the user sees. The draft rows are deleted on the raw
  // handle, which the storage facade never sees, so nothing schedules the
  // read-model drain the badge is counted from — the row leaves the list at
  // once and the Drafts count stays on the old number until the maintainer's
  // 5-second safety pump gets to it.
  it('asks for the read-model catch-up after the local delete', async () => {
    const storage = makeStorage([{ message_id: '<d1@x>', uid: 7 }]);
    vi.mocked(resolveAccountTarget).mockResolvedValue({
      storage,
      syncEngine: onlineEngine({ selectFolder: async () => {}, deleteAndExpunge: vi.fn(async () => {}) }),
    } as never);

    await callDelete();

    expect(storage.scheduleReadModelDrain).toHaveBeenCalled();
  });

  // Breaks: the badge is left waiting on the network. The local rows are
  // already gone whatever the server does, so the count must be corrected even
  // when the IMAP half fails — offline, or on a connection that just died.
  it('asks for it even when the server copy cannot be removed', async () => {
    const storage = makeStorage([{ message_id: '<d1@x>', uid: 7 }]);
    vi.mocked(resolveAccountTarget).mockResolvedValue({
      storage,
      syncEngine: {
        isConnected: () => true,
        deleteEmail: vi.fn(async () => ({ success: true })),
        getClient: () => ({
          selectFolder: async () => { throw new Error('connection closed'); },
        }),
      },
    } as never);

    await callDelete();

    expect(storage.scheduleReadModelDrain).toHaveBeenCalled();
  });

  // Breaks: sending a reply clears the thread's draft behind the user's back —
  // same raw delete, same stale badge, with nobody around to blame it on.
  it('asks for it when the send path clears a thread\'s drafts', async () => {
    const storage = makeStorage([{ message_id: '<d1@x>', uid: 7 }]);
    vi.mocked(resolveAccountTarget).mockResolvedValue({
      storage,
      syncEngine: onlineEngine({ selectFolder: async () => {}, deleteAndExpunge: vi.fn(async () => {}) }),
    } as never);

    await deleteDraftsForThread('acct-1', 't-1');

    expect(storage.scheduleReadModelDrain).toHaveBeenCalled();
  });

  // Breaks: a storage predating the projection (or any double without the
  // method) makes a discard fail outright instead of just refreshing late.
  it('still completes the discard when the storage cannot drain', async () => {
    const storage = makeStorage([{ message_id: '<d1@x>', uid: 7 }]) as Partial<ReturnType<typeof makeStorage>>;
    delete storage.scheduleReadModelDrain;
    vi.mocked(resolveAccountTarget).mockResolvedValue({
      storage,
      syncEngine: onlineEngine({ selectFolder: async () => {}, deleteAndExpunge: vi.fn(async () => {}) }),
    } as never);

    await expect(callDelete()).resolves.toMatchObject({ success: true });
  });
});
