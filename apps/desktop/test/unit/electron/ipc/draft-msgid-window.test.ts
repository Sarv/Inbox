import { beforeEach, describe, expect, it, vi } from 'vitest';

// What breaks if this file fails: locating a draft on the server costs one
// envelope per message in the Drafts folder. On a big folder that full `1:*`
// fetch runs past the IMAP client's 60s op timeout, the client recycles the
// connection as wedged, and the EXPUNGE that was about to run on it dies with
// it — so the draft survives on the server and the next sync pulls it back as a
// brand-new row. The fix is a bounded window that WIDENS when it misses: too
// narrow and an old draft is silently left behind (a miss here costs a draft
// that comes back, unlike the Sent dedupe where a miss costs a duplicate), too
// wide and we are back to the timeout.

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

import { registerDraftHandlers, resolveDraftServerUids } from '../../../../electron/ipc/draft-handlers';
import { resolveAccountTarget } from '../../../../electron/services/account-target';

/**
 * A connection whose Message-ID scan answers from `windowed` when a window was
 * asked for and from `whole` when the whole mailbox was asked for — exactly the
 * distinction the real client draws, so a test can tell which scan ran.
 */
function scannerOver(windowed: Array<[string, number]>, whole = windowed) {
  return {
    fetchMessageIdToUidMap: vi.fn(
      async (_path?: string, options?: { recent?: number }) =>
        new Map(options?.recent ? windowed : whole),
    ),
  };
}

describe('resolveDraftServerUids — bounding the Drafts Message-ID scan', () => {
  // Breaks: THE regression. An unbounded `1:*` envelope fetch on a large Drafts
  // folder times out, the connection is recycled underneath the EXPUNGE, and the
  // draft is never removed from the server.
  it('asks for a bounded window first', async () => {
    const conn = scannerOver([['d1@x', 88]]);

    const result = await resolveDraftServerUids(conn, [{ message_id: '<d1@x>', uid: 0 }]);

    expect(result).toMatchObject({ uids: [88], scanned: true, widened: false, unresolved: 0 });
    expect(conn.fetchMessageIdToUidMap).toHaveBeenCalledTimes(1);
    const [, options] = conn.fetchMessageIdToUidMap.mock.calls[0];
    expect(options?.recent).toBeGreaterThan(0);
  });

  // Breaks: a draft older than the window is silently left on the server — the
  // narrowing trades one bug for a worse one, because the removal still reports
  // success and the draft re-syncs.
  it('widens to the whole mailbox when the window did not answer', async () => {
    const conn = scannerOver([], [['old@x', 12]]);

    const result = await resolveDraftServerUids(conn, [{ message_id: '<old@x>', uid: 0 }]);

    expect(result).toMatchObject({ uids: [12], scanned: true, widened: true, unresolved: 0 });
    expect(conn.fetchMessageIdToUidMap).toHaveBeenCalledTimes(2);
    expect(conn.fetchMessageIdToUidMap.mock.calls[1][1]).toBeUndefined();
  });

  // Breaks: the widen fires on every delete, so the common case pays the full
  // envelope fetch anyway and nothing was actually bounded.
  it('does not widen when the window resolved every row', async () => {
    const conn = scannerOver([['a@x', 1], ['b@x', 2]]);

    const result = await resolveDraftServerUids(conn, [
      { message_id: '<a@x>', uid: 0 },
      { message_id: '<b@x>', uid: 0 },
    ]);

    expect(result.uids.sort()).toEqual([1, 2]);
    expect(result.widened).toBe(false);
    expect(conn.fetchMessageIdToUidMap).toHaveBeenCalledTimes(1);
  });

  // Breaks: an ordinary discard (every row already carries its UID) pays for an
  // envelope fetch it never needed, on a connection the sync engine wants back.
  it('scans nothing when every row already carries a UID', async () => {
    const conn = scannerOver([['d1@x', 88]]);

    const result = await resolveDraftServerUids(conn, [{ message_id: '<d1@x>', uid: 41 }]);

    expect(result).toMatchObject({ uids: [41], scanned: false, widened: false, unresolved: 0 });
    expect(conn.fetchMessageIdToUidMap).not.toHaveBeenCalled();
  });

  // Breaks: a removal that found nothing is reported as a completed removal, so
  // nobody can tell it apart from a real delete and no retry is scheduled.
  it('reports a row the full scan still could not find', async () => {
    const conn = scannerOver([], [['someone-else@x', 5]]);

    const result = await resolveDraftServerUids(conn, [{ message_id: '<gone@x>', uid: 0 }]);

    expect(result).toMatchObject({ uids: [], scanned: true, widened: true, unresolved: 1 });
  });

  // Breaks: a client with no scan at all (older pooled connection, a fake)
  // reports the UID-less row as removed instead of admitting it cannot look.
  it('reports every UID-less row when the connection cannot scan', async () => {
    const result = await resolveDraftServerUids({}, [
      { message_id: '<d1@x>', uid: 0 },
      { message_id: '<d2@x>', uid: 7 },
    ]);

    expect(result).toMatchObject({ uids: [7], scanned: false, widened: false, unresolved: 1 });
  });

  // Breaks: the map is keyed bracket-stripped and lower-cased; a lookup that
  // passes the stored `<Id@Host>` form through raw misses every time, so every
  // UID-less draft looks absent and widens pointlessly before being left behind.
  it('matches whatever bracket and case form the row was stored in', async () => {
    const conn = scannerOver([['d1@x', 88]]);

    const result = await resolveDraftServerUids(conn, [{ message_id: '  <D1@X>  ', uid: 0 }]);

    expect(result.uids).toEqual([88]);
    expect(result.widened).toBe(false);
  });

  // Breaks: a row saved offline (uid 0, no Message-ID yet) is counted as an
  // unresolved server copy, so an ordinary discard reports an incomplete
  // removal for a message that never reached the server.
  it('does not count a row that has no Message-ID to look up', async () => {
    const result = await resolveDraftServerUids({}, [{ message_id: '', uid: 0 }, { uid: 0 }]);

    expect(result).toMatchObject({ uids: [], scanned: false, unresolved: 0 });
  });

  // Breaks: a stored UID and a scanned UID for the same draft are both pushed
  // into the EXPUNGE, and a duplicate UID in the sequence set is a malformed
  // command on strict servers.
  it('never repeats a UID it resolved twice', async () => {
    const conn = scannerOver([['a@x', 5], ['b@x', 5]]);

    const result = await resolveDraftServerUids(conn, [
      { message_id: '<a@x>', uid: 5 },
      { message_id: '<b@x>', uid: 0 },
    ]);

    expect(result.uids).toEqual([5]);
  });

  // Breaks: a scan that died (the timeout that started all this) is swallowed,
  // the caller deletes whatever it happened to resolve and reports success —
  // instead of failing so the removal is queued for a live connection.
  it('lets a failed scan reach the caller', async () => {
    const conn = {
      fetchMessageIdToUidMap: vi.fn(async () => { throw new Error('IMAP FETCH msgid-map timed out'); }),
    };

    await expect(resolveDraftServerUids(conn, [{ message_id: '<d1@x>', uid: 0 }]))
      .rejects.toThrow(/timed out/);
  });

  // Breaks: nothing to delete throws on the empty list, taking the local
  // cleanup down with it.
  it('tolerates an empty row list', async () => {
    const conn = scannerOver([['a@x', 1]]);

    expect(await resolveDraftServerUids(conn, [])).toMatchObject({ uids: [], scanned: false, unresolved: 0 });
    expect(conn.fetchMessageIdToUidMap).not.toHaveBeenCalled();
  });
});

describe('drafts:delete — the scan it puts on the wire', () => {
  const rows = [{ message_id: '<d1@x>', uid: 0 }];

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

  const callDelete = () =>
    h.handlers.get('drafts:delete')!({}, { threadId: 't-1', accountId: 'acct-1' }) as Promise<any>;

  // Breaks: the handler still issues the unbounded fetch, so the timeout — and
  // the connection recycle that kills the EXPUNGE — is exactly as it was.
  it('bounds the scan it runs for the delete', async () => {
    const conn = { selectFolder: async () => {}, deleteAndExpunge: vi.fn(async () => {}), ...scannerOver([['d1@x', 88]]) };
    vi.mocked(resolveAccountTarget).mockResolvedValue({
      storage: makeStorage(),
      syncEngine: { isConnected: () => true, deleteEmail: vi.fn(), getClient: () => conn },
    } as any);

    const res = await callDelete();

    expect(conn.fetchMessageIdToUidMap.mock.calls[0][1]?.recent).toBeGreaterThan(0);
    expect(conn.deleteAndExpunge).toHaveBeenCalledWith([88]);
    expect(res).toMatchObject({ success: true, imap: true, deleted: 1, unscannable: false });
  });

  // Breaks: a draft older than the window is left on the server by the very
  // change that was supposed to make the removal reliable.
  it('still deletes a draft that only the widened scan can find', async () => {
    const conn = { selectFolder: async () => {}, deleteAndExpunge: vi.fn(async () => {}), ...scannerOver([], [['d1@x', 12]]) };
    vi.mocked(resolveAccountTarget).mockResolvedValue({
      storage: makeStorage(),
      syncEngine: { isConnected: () => true, deleteEmail: vi.fn(), getClient: () => conn },
    } as any);

    const res = await callDelete();

    expect(conn.fetchMessageIdToUidMap).toHaveBeenCalledTimes(2);
    expect(conn.deleteAndExpunge).toHaveBeenCalledWith([12]);
    expect(res).toMatchObject({ success: true, imap: true, deleted: 1 });
  });

  // Breaks: the scan times out and the failure is swallowed as a successful
  // removal, leaving the server copy with nothing scheduled to remove it.
  it('queues a durable removal when the scan times out', async () => {
    const deleteEmail = vi.fn(async () => ({ success: true }));
    rows[0] = { message_id: '<d1@x>', uid: 41 };
    vi.mocked(resolveAccountTarget).mockResolvedValue({
      storage: makeStorage(),
      syncEngine: {
        isConnected: () => true,
        deleteEmail,
        getClient: () => ({
          selectFolder: async () => {},
          // A row with a UID plus one without: the scan runs, and dies.
          fetchMessageIdToUidMap: async () => { throw new Error('IMAP FETCH msgid-map timed out'); },
        }),
      },
    } as any);
    rows.push({ message_id: '<d2@x>', uid: 0 });

    const res = await callDelete();

    expect(deleteEmail).toHaveBeenCalledWith('Drafts', 41);
    expect(res).toMatchObject({ success: true, imap: false, queued: 1 });
    rows.length = 1;
    rows[0] = { message_id: '<d1@x>', uid: 0 };
  });
});
