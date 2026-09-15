import { beforeEach, describe, expect, it, vi } from 'vitest';

// What breaks if this file fails: a discarded or sent draft is removed from the
// LOCAL database while its copy survives on the IMAP server. Nothing throws —
// the delete reports success — and then the next Drafts sync pulls that server
// copy back in as a brand-new row, which auto-opens in the composer. That is the
// "the draft came back" / "the draft was never deleted" report, and the only
// thing that can catch it is asserting the server removal was made DURABLE
// (queued in pending_operations) whenever it could not run in-line.

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

import { registerDraftHandlers, serverDeletableUids } from '../../../../electron/ipc/draft-handlers';
import { resolveAccountTarget } from '../../../../electron/services/account-target';

describe('serverDeletableUids', () => {
  // Breaks: rows whose draft really is on the server are skipped, so nothing is
  // queued and the server copy re-syncs — the exact bug this guards.
  it('returns every distinct real UID', () => {
    expect(serverDeletableUids([{ uid: 7 }, { uid: 12 }, { uid: 7 }])).toEqual([7, 12]);
  });

  // Breaks: a draft that never reached the server (offline save, failed APPEND
  // — its row keeps uid 0) gets a delete queued for a message that does not
  // exist, which fails on every retry and dead-letters.
  it('never queues a row that has no server copy', () => {
    expect(serverDeletableUids([{ uid: 0 }, { uid: null }, { uid: undefined }, {}])).toEqual([]);
  });

  // Breaks: a corrupt or partially-written uid column throws, or is coerced into
  // a nonsense UID that deletes an unrelated message in the Drafts folder.
  it('rejects negative, fractional and non-numeric uids', () => {
    expect(serverDeletableUids([{ uid: -3 }, { uid: 1.5 }, { uid: NaN }])).toEqual([]);
    expect(serverDeletableUids([{ uid: '9' as unknown as number }])).toEqual([9]);
  });

  // Breaks: the delete path throws before it ever reaches the local cleanup when
  // no draft rows were resolved at all.
  it('tolerates an empty or absent row list', () => {
    expect(serverDeletableUids([])).toEqual([]);
    expect(serverDeletableUids(null as unknown as [])).toEqual([]);
  });
});

describe('drafts:delete — durability of the server removal', () => {
  const rows = [{ message_id: '<d1@x>', uid: 41 }];

  const makeStorage = () => ({
    db: {
      prepare: (sql: string) => ({
        all: () => (/SELECT message_id/.test(sql) ? rows : []),
        get: () => rows[0],
        run: () => ({ changes: rows.length }),
      }),
    },
    getFolders: async () => [{ id: 'f1', name: 'Drafts', path: 'Drafts', type: 'drafts' }],
  });

  beforeEach(() => {
    h.handlers.clear();
    vi.clearAllMocks();
    registerDraftHandlers();
  });

  const callDelete = (opts: Record<string, unknown>) =>
    h.handlers.get('drafts:delete')!({}, opts) as Promise<any>;

  // Breaks: THE regression. Discarding or sending while IMAP is down deleted the
  // local row and reported success, leaving the server copy to re-sync as a
  // fresh draft the moment connectivity returned.
  it('queues a durable server delete when IMAP is offline', async () => {
    const deleteEmail = vi.fn(async () => ({ success: true }));
    vi.mocked(resolveAccountTarget).mockResolvedValue({
      storage: makeStorage(),
      syncEngine: { isConnected: () => false, deleteEmail },
    } as any);

    const res = await callDelete({ threadId: 't-1', accountId: 'acct-1' });

    expect(deleteEmail).toHaveBeenCalledWith('Drafts', 41);
    expect(res).toMatchObject({ success: true, imap: false, queued: 1 });
  });

  // Breaks: the connection dies mid-delete (the common case — the Drafts folder
  // select collides with sync) and the failure is swallowed as success, so the
  // server copy survives with nothing scheduled to remove it.
  it('queues a durable server delete when the in-line IMAP delete throws', async () => {
    const deleteEmail = vi.fn(async () => ({ success: true }));
    vi.mocked(resolveAccountTarget).mockResolvedValue({
      storage: makeStorage(),
      syncEngine: {
        isConnected: () => true,
        deleteEmail,
        getClient: () => ({
          selectFolder: async () => { throw new Error('Connection not available'); },
        }),
      },
    } as any);

    const res = await callDelete({ threadId: 't-1', accountId: 'acct-1' });

    expect(deleteEmail).toHaveBeenCalledWith('Drafts', 41);
    expect(res).toMatchObject({ success: true, imap: false, queued: 1 });
  });

  // Breaks: the happy path starts paying for the queue too — every ordinary
  // discard would enqueue a redundant delete for a message already expunged,
  // filling pending_operations with work that can only fail.
  it('does not queue anything when the in-line delete removes the message', async () => {
    const deleteEmail = vi.fn(async () => ({ success: true }));
    const deleteAndExpunge = vi.fn(async () => {});
    vi.mocked(resolveAccountTarget).mockResolvedValue({
      storage: makeStorage(),
      syncEngine: {
        isConnected: () => true,
        deleteEmail,
        getClient: () => ({ selectFolder: async () => {}, deleteAndExpunge }),
      },
    } as any);

    const res = await callDelete({ threadId: 't-1', accountId: 'acct-1' });

    expect(deleteAndExpunge).toHaveBeenCalledWith([41]);
    expect(deleteEmail).not.toHaveBeenCalled();
    expect(res).toMatchObject({ success: true, imap: true, deleted: 1, unscannable: false });
  });

  // Breaks: a draft with no stored UID (offline save, or a row predating the
  // uid write) is silently reported as deleted on a client that cannot scan
  // Message-ID→UID, so nobody can tell a real removal from a no-op.
  it('reports that a UID-less row could not be resolved on the server', async () => {
    rows[0] = { message_id: '<d1@x>', uid: 0 };
    vi.mocked(resolveAccountTarget).mockResolvedValue({
      storage: makeStorage(),
      syncEngine: {
        isConnected: () => true,
        deleteEmail: vi.fn(),
        // No fetchMessageIdToUidMap — nothing can locate the server copy.
        getClient: () => ({ selectFolder: async () => {}, search: async () => [] }),
      },
    } as any);

    const res = await callDelete({ threadId: 't-1', accountId: 'acct-1' });

    expect(res).toMatchObject({ success: true, imap: true, deleted: 0, unscannable: true });
    rows[0] = { message_id: '<d1@x>', uid: 41 };
  });

  // Breaks: the Message-ID scan locates a draft that was appended before its UID
  // was written back; skipping it leaves the server copy to re-sync.
  it('deletes a UID-less row located by the Message-ID scan', async () => {
    rows[0] = { message_id: '<d1@x>', uid: 0 };
    const deleteAndExpunge = vi.fn(async () => {});
    vi.mocked(resolveAccountTarget).mockResolvedValue({
      storage: makeStorage(),
      syncEngine: {
        isConnected: () => true,
        deleteEmail: vi.fn(),
        getClient: () => ({
          selectFolder: async () => {},
          fetchMessageIdToUidMap: async () => new Map([['d1@x', 88]]),
          deleteAndExpunge,
        }),
      },
    } as any);

    const res = await callDelete({ threadId: 't-1', accountId: 'acct-1' });

    expect(deleteAndExpunge).toHaveBeenCalledWith([88]);
    expect(res).toMatchObject({ success: true, imap: true, deleted: 1, unscannable: false });
    rows[0] = { message_id: '<d1@x>', uid: 41 };
  });

  // Breaks: an account with no engine at all (still initialising, removed
  // mid-flight) throws out of the handler and the local cleanup is lost too.
  it('still succeeds locally when there is no sync engine to queue against', async () => {
    vi.mocked(resolveAccountTarget).mockResolvedValue({
      storage: makeStorage(),
      syncEngine: null,
    } as any);

    const res = await callDelete({ threadId: 't-1', accountId: 'acct-1' });

    expect(res).toMatchObject({ success: true, imap: false, queued: 0 });
  });
});
