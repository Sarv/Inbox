import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// emails:fetchBodiesBatch prefetches bodies for the visible rows. The behaviour
// under test: when the connection drops MID-BATCH, it must not spray one ERROR
// per email (that flood stalled the main thread) — it short-circuits and emits a
// SINGLE aggregated warn carrying the real reason. Bodies that did load are
// returned + streamed to the renderer; the rest simply load later on open.
//
// We capture the ipcMain handler at registration and drive it with immediate
// mocks (so ordering is deterministic), mocking only the module's own edges.

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...a: any[]) => any>(),
  logUserAction: vi.fn(),
  storage: {
    getEmail: vi.fn(),
    getFolder: vi.fn(),
    getFolders: vi.fn(),
    getEmailsByIds: vi.fn(),
    updateEmail: vi.fn(),
    bulkUpdateTags: vi.fn(),
    recalculateFolderCounts: vi.fn(),
    searchEmails: vi.fn(),
    upsertSenderStats: vi.fn(),
    deleteEmails: vi.fn(),
    deleteEmail: vi.fn(),
  },
  syncEngine: {
    isConnected: vi.fn(() => true),
    fetchBody: vi.fn(),
    bulkMarkAsRead: vi.fn(),
    bulkMarkAsUnread: vi.fn(),
    bulkStar: vi.fn(),
    bulkUnstar: vi.fn(),
    fetchUidByMessageId: vi.fn(),
    move: vi.fn(),
    bulkMoveToTrash: vi.fn(),
    bulkDelete: vi.fn(),
    bulkArchive: vi.fn(),
    markAsRead: vi.fn(),
    markAsUnread: vi.fn(),
    markAsStarred: vi.fn(),
    operationQueue: { moveToTrash: vi.fn(), archive: vi.fn(), delete: vi.fn() },
  },
  activeStorage: null as unknown,
  namedStorage: null as unknown,
  /** false ⇒ getSyncEngine() returns null (account still initialising). */
  engineAvailable: true,
  mainWindow: { webContents: { send: vi.fn() } } as any,
}));

vi.mock('electron', () => ({
  ipcMain: { handle: (name: string, fn: (...a: any[]) => any) => h.handlers.set(name, fn) },
  dialog: {}, shell: {}, app: { getPath: () => '/tmp' },
}));
vi.mock('../../../../electron/shared', () => ({
  requireStorage: () => h.activeStorage ?? h.storage,
  requireSyncEngine: () => h.syncEngine,
  getMainWindow: () => h.mainWindow,
  getSyncEngine: () => (h.engineAvailable ? h.syncEngine : null),
  getStorageFor: () => h.namedStorage,
  getSyncEngineFor: () => h.syncEngine,
  getCurrentAccountId: () => 'active-account',
}));
vi.mock('../../../../electron/services/body-prefetch-scheduler', () => ({ deferBodyPrefetch: vi.fn() }));
vi.mock('../../../../electron/services/accounts-runtime', () => ({ ensureAccountRuntime: vi.fn() }));
vi.mock('../../../../electron/ipc/agent-handlers', () => ({ logUserAction: h.logUserAction }));
vi.mock('../../../../electron/services/accounts-registry', () => ({ readRegistryAccounts: () => [{ id: 'active-account' }, { id: 'other-account' }] }));

import {
  CID_REPAIR_MEMORY,
  claimCidRepairAttempt,
  registerEmailHandlers,
  restoreEmailsFromTrash,
} from '../../../../electron/ipc/email-handlers';
import { isRetryableBodyFetchError, looksGoneFromServer } from '../../../../src/store/body-fetch-failures';

const fetchBodiesBatch = () => h.handlers.get('emails:fetchBodiesBatch')!;
const fetchBody = () => h.handlers.get('emails:fetchBody')!;
const spyConsoleWarn = () => vi.spyOn(console, 'warn').mockImplementation(() => {});
let warnSpy: ReturnType<typeof spyConsoleWarn>;
const batchWarns = () =>
  warnSpy.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('fetchBodiesBatch'));

beforeEach(() => {
  h.handlers.clear();
  h.activeStorage = null;
  h.namedStorage = null;
  h.logUserAction.mockReset().mockResolvedValue(undefined);
  h.storage.getEmail.mockReset();
  h.storage.getFolder.mockReset().mockResolvedValue({ path: 'INBOX' });
  h.storage.getFolders.mockReset().mockResolvedValue([]);
  h.storage.getEmailsByIds.mockReset().mockResolvedValue([]);
  h.storage.updateEmail.mockReset().mockResolvedValue(undefined);
  h.storage.bulkUpdateTags.mockReset().mockResolvedValue(undefined);
  h.storage.recalculateFolderCounts.mockReset().mockResolvedValue(undefined);
  h.storage.searchEmails.mockReset().mockResolvedValue([]);
  h.storage.upsertSenderStats.mockReset().mockResolvedValue(undefined);
  h.storage.deleteEmails.mockReset().mockResolvedValue(undefined);
  h.storage.deleteEmail.mockReset().mockResolvedValue(undefined);
  h.syncEngine.isConnected.mockReset().mockReturnValue(true);
  h.syncEngine.fetchBody.mockReset();
  h.syncEngine.fetchUidByMessageId.mockReset().mockResolvedValue(null);
  h.syncEngine.move.mockReset().mockResolvedValue('success');
  h.syncEngine.bulkMoveToTrash.mockReset().mockResolvedValue('success');
  h.syncEngine.bulkDelete.mockReset().mockResolvedValue('success');
  for (const method of ['bulkMarkAsRead', 'bulkMarkAsUnread', 'bulkStar', 'bulkUnstar', 'bulkArchive', 'markAsRead', 'markAsUnread', 'markAsStarred'] as const) {
    h.syncEngine[method].mockReset().mockResolvedValue(undefined);
  }
  for (const method of ['moveToTrash', 'archive', 'delete'] as const) h.syncEngine.operationQueue[method].mockReset().mockResolvedValue('success');
  h.engineAvailable = true;
  h.mainWindow.webContents.send.mockReset();
  warnSpy = spyConsoleWarn();
  registerEmailHandlers();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('restoreEmailsFromTrash', () => {
  const folders = [
    { id: 'inbox', path: 'INBOX', name: 'Inbox' },
    { id: 'all', path: '[Gmail]/All Mail', name: 'All Mail' },
    { id: 'trash', path: '[Gmail]/Trash', name: 'Trash', specialUse: '\\Trash' },
  ];

  it('moves a secondary Trash copy using its Trash UID and removes the hiding tag', async () => {
    h.storage.getFolders.mockResolvedValue(folders);
    h.storage.getEmail.mockResolvedValue({
      id: 'e1', folderId: 'all', uid: 77 as number | null, messageId: '<e1@example.com>',
      tags: '|[Gmail]/All Mail|[Gmail]/Trash|promotions|',
    });
    h.syncEngine.fetchUidByMessageId.mockResolvedValue(55);

    const result = await restoreEmailsFromTrash(h.storage as never, h.syncEngine as never, ['e1']);

    expect(result).toEqual({ restoredIds: ['e1'], failedIds: [] });
    expect(h.syncEngine.fetchUidByMessageId).toHaveBeenCalledWith('[Gmail]/Trash', 'e1@example.com');
    expect(h.syncEngine.move).toHaveBeenCalledWith('[Gmail]/Trash', 55, 'INBOX', 'e1');
    expect(h.storage.updateEmail).toHaveBeenCalledWith('e1', {
      folderId: 'inbox', tags: '|[Gmail]/All Mail|promotions|INBOX|', uid: null,
    });
  });

  it('has the row ready for the queue to remap and keeps the destination UID after success', async () => {
    h.storage.getFolders.mockResolvedValue(folders);
    const row = {
      id: 'e1', folderId: 'all', uid: 77 as number | null, messageId: '<e1@example.com>',
      tags: '|[Gmail]/All Mail|[Gmail]/Trash|',
    };
    h.storage.getEmail.mockImplementation(async () => ({ ...row }));
    h.storage.updateEmail.mockImplementation(async (_id: string, patch: any) => {
      // Folder changes leave UID NULL until the queue remaps by row identity.
      if (patch.folderId && patch.folderId !== row.folderId && patch.uid === undefined) row.uid = null;
      Object.assign(row, patch);
    });
    h.syncEngine.fetchUidByMessageId.mockResolvedValue(55);
    h.syncEngine.move.mockImplementation(async (_src: string, _sourceUid: number, _dest: string, emailId: string) => {
      if (row.folderId === 'inbox' && row.id === emailId) row.uid = 900;
      return 'success';
    });

    expect(await restoreEmailsFromTrash(h.storage as never, h.syncEngine as never, ['e1']))
      .toEqual({ restoredIds: ['e1'], failedIds: [] });
    expect(row.folderId).toBe('inbox');
    expect(row.uid).toBe(900); // queue's remap survived; no later patch overwrote it
    expect(row.tags).toBe('|[Gmail]/All Mail|INBOX|');
  });

  it('keeps a secondary Trash row in place when offline (its primary UID is not a Trash UID)', async () => {
    h.storage.getFolders.mockResolvedValue(folders);
    h.storage.getEmail.mockResolvedValue({
      id: 'e1', folderId: 'all', uid: 77, messageId: '<e1@example.com>',
      tags: '|[Gmail]/All Mail|[Gmail]/Trash|',
    });
    h.syncEngine.isConnected.mockReturnValue(false);

    expect(await restoreEmailsFromTrash(h.storage as never, h.syncEngine as never, ['e1']))
      .toEqual({ restoredIds: [], failedIds: ['e1'] });
    expect(h.syncEngine.move).not.toHaveBeenCalled();
    expect(h.storage.updateEmail).not.toHaveBeenCalled();
  });

  it('restores only Trash members and leaves a live sibling untouched', async () => {
    h.storage.getFolders.mockResolvedValue(folders);
    h.storage.getEmail.mockImplementation(async (id: string) => id === 'trash-mail'
      ? { id, folderId: 'trash', uid: 9, tags: '|[Gmail]/Trash|' }
      : { id, folderId: 'inbox', uid: 10, tags: '|INBOX|' });

    expect(await restoreEmailsFromTrash(h.storage as never, h.syncEngine as never, ['trash-mail', 'live-mail']))
      .toEqual({ restoredIds: ['trash-mail'], failedIds: ['live-mail'] });
    expect(h.syncEngine.move).toHaveBeenCalledTimes(1);
    expect(h.syncEngine.move).toHaveBeenCalledWith('[Gmail]/Trash', 9, 'INBOX', 'trash-mail');
    expect(h.storage.updateEmail).toHaveBeenCalledTimes(1);
  });

  it('restores the exact Trash placement when the server move fails', async () => {
    h.storage.getFolders.mockResolvedValue(folders);
    const row = { id: 'e1', folderId: 'trash', uid: 9, tags: '|[Gmail]/Trash|' };
    h.storage.getEmail.mockImplementation(async () => ({ ...row }));
    h.storage.updateEmail.mockImplementation(async (_id: string, patch: any) => { Object.assign(row, patch); });
    h.syncEngine.move.mockRejectedValue(new Error('NO permission'));

    expect(await restoreEmailsFromTrash(h.storage as never, h.syncEngine as never, ['e1']))
      .toEqual({ restoredIds: [], failedIds: ['e1'] });
    expect(h.storage.updateEmail).toHaveBeenCalledTimes(2); // local placement, then rollback
    expect(row).toEqual({ id: 'e1', folderId: 'trash', uid: 9, tags: '|[Gmail]/Trash|' });
  });

  it('keeps a queued restore in Inbox with no foreign Trash UID', async () => {
    h.storage.getFolders.mockResolvedValue(folders);
    const row = { id: 'e1', folderId: 'trash', uid: 9 as number | null, tags: '|[Gmail]/Trash|' };
    h.storage.getEmail.mockImplementation(async () => ({ ...row }));
    h.storage.updateEmail.mockImplementation(async (_id: string, patch: any) => { Object.assign(row, patch); });
    h.syncEngine.isConnected.mockReturnValue(false);
    h.syncEngine.move.mockResolvedValue('queued');

    expect(await restoreEmailsFromTrash(h.storage as never, h.syncEngine as never, ['e1']))
      .toEqual({ restoredIds: ['e1'], failedIds: [] });
    expect(h.syncEngine.move).toHaveBeenCalledWith('[Gmail]/Trash', 9, 'INBOX', 'e1');
    expect(row).toEqual({ id: 'e1', folderId: 'inbox', uid: null, tags: '|INBOX|' });
  });

  it.each([true, false])('does not locally restore a queued delete whose Trash UID is unresolved (connected=%s)', async (connected) => {
    h.storage.getFolders.mockResolvedValue(folders);
    h.storage.getEmail.mockResolvedValue({
      id: 'queued-delete', folderId: 'trash', uid: null,
      messageId: '<pending@example.com>', tags: '|[Gmail]/Trash|',
    });
    h.syncEngine.isConnected.mockReturnValue(connected);
    h.syncEngine.fetchUidByMessageId.mockResolvedValue(null);

    expect(await restoreEmailsFromTrash(h.storage as never, h.syncEngine as never, ['queued-delete']))
      .toEqual({ restoredIds: [], failedIds: ['queued-delete'] });
    expect(h.storage.updateEmail).not.toHaveBeenCalled();
    expect(h.syncEngine.move).not.toHaveBeenCalled();
  });
});

describe('emails:fetchBodiesBatch', () => {
  it('bails early when the connection is down', async () => {
    h.syncEngine.isConnected.mockReturnValue(false);
    await expect(fetchBodiesBatch()(null, ['a'])).resolves.toEqual({ success: false, error: 'Not connected to IMAP' });
    expect(h.syncEngine.fetchBody).not.toHaveBeenCalled();
  });

  it('fetches, streams body:fetched, and returns the fetched ids', async () => {
    h.storage.getEmail.mockImplementation(async (id: string) => ({ id, rawBody: null, folderId: 'f', uid: 1 }));
    h.syncEngine.fetchBody.mockResolvedValue({ rawBody: 'r', cleanBody: 'c', contentType: 'text/html' });

    const res = await fetchBodiesBatch()(null, ['a', 'b']);
    expect(res.success).toBe(true);
    expect([...res.data].sort()).toEqual(['a', 'b']);
    expect(h.mainWindow.webContents.send).toHaveBeenCalledTimes(2);
    expect(h.mainWindow.webContents.send).toHaveBeenCalledWith('body:fetched', expect.objectContaining({ id: 'a' }));
  });

  it('reuses an already-downloaded body without hitting the server', async () => {
    h.storage.getEmail.mockResolvedValue({ id: 'a', rawBody: 'already-here' });
    const res = await fetchBodiesBatch()(null, ['a']);
    expect(res.data).toEqual(['a']);
    expect(h.syncEngine.fetchBody).not.toHaveBeenCalled();
  });

  it('on a mid-batch connection drop: no bodies returned, ONE aggregated warn naming the cause', async () => {
    h.storage.getEmail.mockImplementation(async (id: string) => ({ id, rawBody: null, folderId: 'f', uid: 1 }));
    h.syncEngine.fetchBody.mockRejectedValue(new Error('Connection not available'));

    const res = await fetchBodiesBatch()(null, ['a', 'b', 'c']);
    expect(res.success).toBe(true);
    expect(res.data).toEqual([]); // nothing succeeded
    const warns = batchWarns();
    expect(warns).toHaveLength(1); // one aggregated line, NOT one per email
    expect(warns[0]).toContain('connection lost mid-batch');
    expect(warns[0]).toMatch(/3\/3/); // count surfaced
  });

  it('a non-connection failure aggregates too, but is NOT flagged as a connection drop', async () => {
    h.storage.getEmail.mockImplementation(async (id: string) => ({ id, rawBody: null, folderId: 'f', uid: 1 }));
    h.syncEngine.fetchBody.mockRejectedValue(new Error('parse failed'));

    const res = await fetchBodiesBatch()(null, ['a', 'b']);
    expect(res.data).toEqual([]);
    const warns = batchWarns();
    expect(warns).toHaveLength(1);
    expect(warns[0]).not.toContain('connection lost');
    expect(warns[0]).toContain('parse failed'); // the first real reason is surfaced
  });

  it('no warn at all when every body fetches cleanly', async () => {
    h.storage.getEmail.mockImplementation(async (id: string) => ({ id, rawBody: null, folderId: 'f', uid: 1 }));
    h.syncEngine.fetchBody.mockResolvedValue({ rawBody: 'r', cleanBody: 'c', contentType: 'text/html' });
    await fetchBodiesBatch()(null, ['a', 'b']);
    expect(batchWarns()).toHaveLength(0);
  });
});

describe('emails:bulkAction — deletion acknowledgements', () => {
  const bulkAction = () => h.handlers.get('emails:bulkAction')!;
  const folders = [
    { id: 'inbox', path: 'INBOX' },
    { id: 'all', path: '[Gmail]/All Mail' },
    { id: 'promotions', path: 'Sarv Inbox/Promotions' },
    { id: 'trash', path: '[Gmail]/Trash', specialUse: '\\Trash' },
  ];
  const seed = (rows: any[]) => {
    h.storage.getFolders.mockResolvedValue(folders);
    h.storage.getEmailsByIds.mockResolvedValue(rows);
  };

  it('acknowledges all 25 across immediate and queued source groups', async () => {
    const rows = [
      ...Array.from({ length: 10 }, (_, i) => ({ id: `a${i}`, folderId: 'all', uid: i + 1, tags: '|[Gmail]/All Mail|' })),
      ...Array.from({ length: 3 }, (_, i) => ({ id: `b${i}`, folderId: 'inbox', uid: i + 1, tags: '|INBOX|' })),
      ...Array.from({ length: 12 }, (_, i) => ({ id: `c${i}`, folderId: 'promotions', uid: i + 1, tags: '|Sarv Inbox/Promotions|' })),
    ];
    seed(rows);
    h.syncEngine.bulkMoveToTrash.mockImplementation(async (path: string) => path === '[Gmail]/All Mail' ? 'success' : 'queued');

    const result = await bulkAction()(null, rows.map((e) => e.id), 'delete');

    expect(result.success).toBe(true);
    expect(result.data.processedIds).toEqual(rows.map((e) => e.id));
    expect(result.data.queuedIds).toEqual(rows.slice(10).map((e) => e.id));
    expect(result.data.failedIds).toEqual([]);
    expect(h.syncEngine.bulkMoveToTrash).toHaveBeenCalledTimes(3);
    for (const row of rows.slice(10)) {
      expect(h.storage.updateEmail).toHaveBeenCalledWith(row.id, expect.objectContaining({ folderId: 'trash', uid: null }));
    }
  });

  it('reports missing, UID-less and unknown-folder rows instead of hiding them', async () => {
    seed([
      { id: 'ok', folderId: 'inbox', uid: 1, tags: '|INBOX|' },
      { id: 'no-uid', folderId: 'inbox', uid: null, tags: '|INBOX|' },
      { id: 'no-folder', folderId: 'gone', uid: 2, tags: '|gone|' },
    ]);
    const result = await bulkAction()(null, ['ok', 'no-uid', 'no-folder', 'missing'], 'delete');

    expect(result.success).toBe(false);
    expect(result.data.processedIds).toEqual(['ok']);
    expect(result.data.failedIds).toEqual(expect.arrayContaining(['missing', 'no-folder', 'no-uid']));
    expect(result.data.failedIds).toHaveLength(3);
    expect(h.syncEngine.bulkMoveToTrash).toHaveBeenCalledWith('INBOX', [1], ['ok']);
    expect(h.storage.updateEmail).toHaveBeenCalledTimes(1);
  });

  it('rolls back only the failed source group and continues the remaining group', async () => {
    const row = { id: 'failed', folderId: 'inbox', uid: 9, tags: '|INBOX|promotions|' };
    seed([row, { id: 'ok', folderId: 'all', uid: 10, tags: '|[Gmail]/All Mail|' }]);
    h.syncEngine.bulkMoveToTrash.mockImplementation(async (path: string) => {
      if (path === 'INBOX') throw new Error('queue write failed');
      return 'success';
    });

    const result = await bulkAction()(null, ['failed', 'ok'], 'delete');

    expect(result.data).toEqual({ processedIds: ['ok'], queuedIds: [], failedIds: ['failed'] });
    expect(h.storage.updateEmail).toHaveBeenCalledWith('failed', {
      folderId: 'inbox', uid: 9, tags: '|INBOX|promotions|',
    });
  });

  it('keeps the destination UID remapped by the queue', async () => {
    const row = { id: 'e1', folderId: 'inbox', uid: 9 as number | null, tags: '|INBOX|' };
    seed([row]);
    h.storage.updateEmail.mockImplementation(async (_id: string, patch: any) => { Object.assign(row, patch); });
    h.syncEngine.bulkMoveToTrash.mockImplementation(async (_path: string, _uids: number[], emailIds: string[]) => {
      if (row.folderId === 'trash' && row.id === emailIds[0]) row.uid = 500;
      return 'success';
    });

    expect((await bulkAction()(null, ['e1'], 'delete')).data.processedIds).toEqual(['e1']);
    expect(row).toEqual({ id: 'e1', folderId: 'trash', uid: 500, tags: '|[Gmail]/Trash|' });
  });

  it.each(['no engine', 'no trash folder'])('leaves rows in place with %s', async (condition) => {
    seed([{ id: 'e1', folderId: 'inbox', uid: 9, tags: '|INBOX|' }]);
    if (condition === 'no engine') h.engineAvailable = false;
    else h.storage.getFolders.mockResolvedValue(folders.filter((f) => f.id !== 'trash'));

    const result = await bulkAction()(null, ['e1'], 'delete');

    expect(result.data).toEqual({ processedIds: [], queuedIds: [], failedIds: ['e1'] });
    expect(h.storage.updateEmail).not.toHaveBeenCalled();
    expect(h.syncEngine.bulkMoveToTrash).not.toHaveBeenCalled();
  });

  it('leaves Trash intact when a confirmed permanent-delete enqueue fails', async () => {
    seed([{ id: 'e1', folderId: 'trash', uid: 9, tags: '|[Gmail]/Trash|' }]);
    h.syncEngine.bulkDelete.mockRejectedValue(new Error('queue write failed'));

    const result = await bulkAction()(null, ['e1'], 'delete', undefined, true);

    expect(result.data.failedIds).toEqual(['e1']);
    expect(h.storage.deleteEmails).not.toHaveBeenCalled();
  });

  it('keeps an accepted permanent delete acknowledged if local cleanup fails', async () => {
    seed([{ id: 'e1', folderId: 'trash', uid: 9, tags: '|[Gmail]/Trash|' }]);
    h.syncEngine.bulkDelete.mockResolvedValue('queued');
    h.storage.deleteEmails.mockRejectedValue(new Error('local write failed'));

    const result = await bulkAction()(null, ['e1'], 'delete', undefined, true);

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ processedIds: ['e1'], queuedIds: ['e1'], failedIds: [] });
  });

  it('does not do fallible UID cleanup after a queued trash request is accepted', async () => {
    seed([{ id: 'e1', folderId: 'inbox', uid: 9, tags: '|INBOX|' }]);
    h.syncEngine.bulkMoveToTrash.mockResolvedValue('queued');
    // A second write would have failed and rolled back a move already persisted.
    h.storage.updateEmail.mockResolvedValueOnce(undefined).mockRejectedValue(new Error('later write failed'));

    const result = await bulkAction()(null, ['e1'], 'delete');

    expect(result.data).toEqual({ processedIds: ['e1'], queuedIds: ['e1'], failedIds: [] });
    expect(h.storage.updateEmail).toHaveBeenCalledTimes(1);
    expect(h.storage.updateEmail).toHaveBeenCalledWith('e1', {
      folderId: 'trash', tags: '|[Gmail]/Trash|', uid: null,
    });
  });

  it('does not acknowledge a delete before its queue operation completes', async () => {
    seed([{ id: 'e1', folderId: 'inbox', uid: 9, tags: '|INBOX|' }]);
    let complete!: (result: string) => void;
    h.syncEngine.bulkMoveToTrash.mockReturnValue(new Promise((resolve) => { complete = resolve; }));
    let acknowledged = false;
    const pending = bulkAction()(null, ['e1', 'e1'], 'delete').then((result: any) => {
      acknowledged = true;
      return result;
    });
    await vi.waitFor(() => expect(h.syncEngine.bulkMoveToTrash).toHaveBeenCalled());
    expect(acknowledged).toBe(false);
    complete('queued');
    expect((await pending).data).toEqual({ processedIds: ['e1'], queuedIds: ['e1'], failedIds: [] });
  });

  it('reports all 25 local placements before the slow server move acknowledges them', async () => {
    const rows = Array.from({ length: 25 }, (_, index) => ({
      id: `e${index}`, folderId: 'inbox', uid: index + 1, tags: '|INBOX|promotions|',
    }));
    seed(rows);
    let complete!: (result: string) => void;
    h.syncEngine.bulkMoveToTrash.mockReturnValue(new Promise((resolve) => { complete = resolve; }));
    let progressWrites: Array<[string, any]> = [];
    let serverCallsAtProgress = -1;
    const send = vi.fn(() => {
      progressWrites = h.storage.updateEmail.mock.calls.map(([id, patch]) => [id, { ...patch }]);
      serverCallsAtProgress = h.syncEngine.bulkMoveToTrash.mock.calls.length;
    });
    let acknowledged = false;
    const pending = bulkAction()({ sender: { send } }, rows.map((row) => row.id), 'delete', undefined, false, 'bulk-25')
      .then((result: any) => {
        acknowledged = true;
        return result;
      });

    await vi.waitFor(() => expect(h.syncEngine.bulkMoveToTrash).toHaveBeenCalled());
    expect(send).toHaveBeenCalledExactlyOnceWith('emails:bulkActionProgress', {
      requestId: 'bulk-25', action: 'delete', accountId: undefined, emailIds: rows.map((row) => row.id),
    });
    expect(progressWrites).toEqual(rows.map((row) => [row.id, {
      folderId: 'trash', uid: null, tags: '|promotions|[Gmail]/Trash|',
    }]));
    expect(serverCallsAtProgress).toBe(0);
    expect(acknowledged).toBe(false);
    complete('queued');
    expect((await pending).data).toEqual({
      processedIds: rows.map((row) => row.id), queuedIds: rows.map((row) => row.id), failedIds: [],
    });
  });

  it('restores local rows when the server move fails after progress was reported', async () => {
    const originals = [
      { id: 'e1', folderId: 'inbox', uid: 9, tags: '|INBOX|promotions|' },
      { id: 'e2', folderId: 'inbox', uid: 10, tags: '|INBOX|promotions|' },
    ];
    seed(originals);
    const localRows = new Map(originals.map((row) => [row.id, { ...row }]));
    h.storage.updateEmail.mockImplementation(async (id: string, patch: any) => {
      Object.assign(localRows.get(id)!, patch);
    });
    let complete!: (result: string) => void;
    h.syncEngine.bulkMoveToTrash.mockReturnValue(new Promise((resolve) => { complete = resolve; }));
    const send = vi.fn();
    const pending = bulkAction()({ sender: { send } }, ['e1', 'e2'], 'delete', undefined, false, 'bulk-failed');

    await vi.waitFor(() => expect(send).toHaveBeenCalled());
    expect([...localRows.values()].map((row) => row.folderId)).toEqual(['trash', 'trash']);
    complete('failed');
    expect((await pending).data).toEqual({ processedIds: [], queuedIds: [], failedIds: ['e1', 'e2'] });
    expect([...localRows.values()]).toEqual(originals);
  });

  it('keeps an accepted move when the requesting renderer closes before progress delivery', async () => {
    seed([{ id: 'e1', folderId: 'inbox', uid: 9, tags: '|INBOX|promotions|' }]);
    const send = vi.fn(() => { throw new Error('WebContents was destroyed'); });

    const result = await bulkAction()({ sender: { send } }, ['e1'], 'delete', undefined, false, 'bulk-closed');

    expect(send).toHaveBeenCalledOnce();
    expect(result.data).toEqual({ processedIds: ['e1'], queuedIds: [], failedIds: [] });
    expect(h.syncEngine.bulkMoveToTrash).toHaveBeenCalledWith('INBOX', [9], ['e1']);
    expect(h.storage.updateEmail).toHaveBeenCalledTimes(1);
    expect(h.storage.updateEmail).toHaveBeenCalledWith('e1', {
      folderId: 'trash', uid: null, tags: '|promotions|[Gmail]/Trash|',
    });
  });

  it('only reports progress for a request that opts in and has a sender', async () => {
    seed([{ id: 'e1', folderId: 'inbox', uid: 9, tags: '|INBOX|' }]);
    const send = vi.fn();

    expect((await bulkAction()({ sender: { send } }, ['e1'], 'delete')).data.processedIds).toEqual(['e1']);
    expect(send).not.toHaveBeenCalled();
    expect((await bulkAction()(null, ['e1'], 'delete', undefined, false, 'bulk-no-sender')).data.processedIds).toEqual(['e1']);
  });
});

/**
 * emails:bulkAction — the FLAG ops (markRead / markUnread / star / unstar).
 *
 * What breaks if this block fails, REPORTED FROM THE FIELD: "I apply the unread
 * filter, mark 20+ mails as read, and when I come back many of them are unread
 * again."
 *
 * The four flag branches used to wrap their IMAP call in
 * `if (syncEngine?.isConnected())`. When that read false the local rows were
 * still marked read but NO `pending_operations` row was written, and that costs
 * twice over:
 *
 *   1. the flag never reaches the server, and
 *   2. syncFlags' pending-UID guard — the ONLY thing that protects a local flag
 *      from the server-wins CONDSTORE reconcile — never covers those UIDs.
 *
 * So the next reconcile authoritatively flipped all of them back to unread,
 * with no error and no log line anywhere. The queue already handles the offline
 * case itself (it persists the op and replays it on reconnect), so the gate
 * bought nothing. Every non-flag branch was fixed earlier; these four were
 * missed.
 */
describe('emails:bulkAction — flag ops must reach the operation queue', () => {
  const bulkAction = () => h.handlers.get('emails:bulkAction')!;

  const seed = (tags: string) => {
    h.storage.getFolders.mockResolvedValue([{ id: 'f1', path: 'INBOX' }]);
    h.storage.getEmailsByIds.mockResolvedValue([
      { id: 'e1', uid: 11, folderId: 'f1', tags, fromAddress: 'a@x.com' },
      { id: 'e2', uid: 12, folderId: 'f1', tags, fromAddress: 'b@x.com' },
    ]);
  };

  const cases = [
    { action: 'markRead', tags: '|INBOX|', engineMethod: 'bulkMarkAsRead' as const },
    { action: 'markUnread', tags: '|INBOX|read|', engineMethod: 'bulkMarkAsUnread' as const },
    { action: 'star', tags: '|INBOX|', engineMethod: 'bulkStar' as const },
    { action: 'unstar', tags: '|INBOX|starred|', engineMethod: 'bulkUnstar' as const },
  ];

  for (const { action, tags, engineMethod } of cases) {
    // Breaks: this action is applied locally and then silently reverted by the
    // next server reconcile — for star/unstar exactly as for read.
    it(`${action} enqueues the IMAP op even while DISCONNECTED`, async () => {
      seed(tags);
      h.syncEngine.isConnected.mockReturnValue(false);

      const res = await bulkAction()(null, ['e1', 'e2'], action);

      expect(res.success).toBe(true);
      expect(h.storage.bulkUpdateTags).toHaveBeenCalledTimes(1);      // local change applied
      expect(h.syncEngine[engineMethod]).toHaveBeenCalledWith('INBOX', [11, 12]);
    });

    // Breaks: the online path regresses while fixing the offline one.
    it(`${action} still enqueues the IMAP op while connected`, async () => {
      seed(tags);
      h.syncEngine.isConnected.mockReturnValue(true);

      await bulkAction()(null, ['e1', 'e2'], action);

      expect(h.syncEngine[engineMethod]).toHaveBeenCalledWith('INBOX', [11, 12]);
    });
  }

  // Breaks: a rejected queue push (a dead-lettered op, a closed DB) becomes an
  // unhandled rejection and the whole bulk action reports failure, even though
  // the local rows were already updated and the op is persisted for replay.
  it('a failing IMAP enqueue does not fail the action', async () => {
    seed('|INBOX|');
    h.syncEngine.isConnected.mockReturnValue(false);
    h.syncEngine.bulkMarkAsRead.mockRejectedValue(new Error('queue write failed'));

    const res = await bulkAction()(null, ['e1', 'e2'], 'markRead');

    expect(res.success).toBe(true);
  });

  // Breaks: with no engine at all (account still initialising) the handler
  // throws instead of at least applying the local change.
  it('applies the local change when there is no sync engine to enqueue onto', async () => {
    seed('|INBOX|');
    h.engineAvailable = false;

    const res = await bulkAction()(null, ['e1', 'e2'], 'markRead');

    expect(res.success).toBe(true);
    expect(h.storage.bulkUpdateTags).toHaveBeenCalledTimes(1);
  });
});

describe('manual mail actions teach from the captured mailbox and successful changes', () => {
  const bulk = () => h.handlers.get('emails:bulkAction')!;
  const folders = [
    { id: 'inbox', path: 'INBOX' }, { id: 'other', path: 'Other' },
    { id: 'archive', path: 'Archive', specialUse: '\\Archive' },
    { id: 'trash', path: 'Trash', specialUse: '\\Trash' },
  ];
  const row = (id: string, overrides: Record<string, unknown> = {}) => ({
    id, uid: 11, folderId: 'inbox', tags: '|INBOX|', threadId: `thread-${id}`, fromAddress: 'offers@example.test', ...overrides,
  });
  const seed = (rows: ReturnType<typeof row>[]) => {
    h.storage.getFolders.mockResolvedValue(folders);
    h.storage.getFolder.mockImplementation(async (id: string) => folders.find(folder => folder.id === id));
    h.storage.getEmailsByIds.mockResolvedValue(rows);
    h.storage.getEmail.mockImplementation(async (id: string) => rows.find(email => email.id === id));
  };

  it('logs each accepted bulk trash row once and skips missing, UID-less and failed groups', async () => {
    seed([row('ok'), row('queued', { folderId: 'other', tags: '|Other|' }), row('failed', { folderId: 'archive' }), row('no-uid', { uid: null })]);
    h.syncEngine.bulkMoveToTrash.mockImplementation(async (folder: string) => folder === 'Archive' ? 'failed' : folder === 'Other' ? 'queued' : 'success');
    await bulk()(null, ['ok', 'ok', 'queued', 'failed', 'no-uid', 'missing'], 'delete');
    expect(h.logUserAction.mock.calls.map(call => call.slice(0, 2))).toEqual([['ok', 'delete'], ['queued', 'delete']]);
    for (const call of h.logUserAction.mock.calls) {
      expect(call[2]).toMatchObject({ source: 'user', senderAddress: 'offers@example.test', actionValue: JSON.stringify({ destination: 'Trash' }) });
      expect(call[3]).toBe(h.storage);
    }
    // The central logger owns this aggregate. Updating it again here doubles
    // deletion counts and makes categorization learn from inflated evidence.
    expect(h.storage.upsertSenderStats).not.toHaveBeenCalled();
  });

  it('does not record a bulk delete before the server or durable queue accepts it', async () => {
    seed([row('e1')]);
    let accept!: (outcome: string) => void;
    h.syncEngine.bulkMoveToTrash.mockReturnValue(new Promise(resolve => { accept = resolve; }));
    const pending = bulk()(null, ['e1'], 'delete');
    await vi.waitFor(() => expect(h.syncEngine.bulkMoveToTrash).toHaveBeenCalled());
    expect(h.logUserAction).not.toHaveBeenCalled();
    accept('queued');
    await pending;
    expect(h.logUserAction).toHaveBeenCalledExactlyOnceWith('e1', 'delete', expect.objectContaining({ source: 'user' }), h.storage);
  });

  it('records an accepted permanent deletion before removing its source metadata', async () => {
    seed([row('e1', { folderId: 'trash', tags: '|Trash|' })]);
    await bulk()(null, ['e1', 'e1'], 'delete', undefined, true);
    expect(h.logUserAction).toHaveBeenCalledExactlyOnceWith('e1', 'delete', expect.objectContaining({ actionValue: JSON.stringify({ permanent: true, destination: 'Trash' }) }), h.storage);
    expect(h.logUserAction.mock.invocationCallOrder[0]).toBeLessThan(h.storage.deleteEmails.mock.invocationCallOrder[0]);
    expect(h.storage.upsertSenderStats).not.toHaveBeenCalled();
  });

  it('does not record a permanent deletion whose enqueue failed', async () => {
    seed([row('e1', { folderId: 'trash', tags: '|Trash|' })]);
    h.syncEngine.bulkDelete.mockRejectedValue(new Error('queue unavailable'));
    await bulk()(null, ['e1'], 'delete', undefined, true);
    expect(h.logUserAction).not.toHaveBeenCalled();
    expect(h.storage.deleteEmails).not.toHaveBeenCalled();
  });

  it('logs a real bulk archive in its named account even if the user switches during the queue request', async () => {
    seed([row('changed'), row('already-archived', { folderId: 'archive', tags: '|Archive|' })]);
    h.namedStorage = h.storage;
    let accept!: (outcome: string) => void;
    h.syncEngine.bulkArchive.mockReturnValue(new Promise(resolve => { accept = resolve; }));
    const pending = bulk()(null, ['changed', 'already-archived'], 'archive', 'other-account');
    await vi.waitFor(() => expect(h.syncEngine.bulkArchive).toHaveBeenCalled());
    h.activeStorage = { wrongMailbox: true };
    accept('queued');
    await pending;
    expect(h.logUserAction).toHaveBeenCalledExactlyOnceWith('changed', 'archive', expect.objectContaining({ source: 'user', actionValue: JSON.stringify({ destination: 'Archive' }) }), h.storage);
    expect(h.syncEngine.bulkArchive).toHaveBeenCalledOnce();
  });

  it.each(['failed enqueue', 'failed local update', 'missing destination'])('does not learn an archive with %s', async cause => {
    seed([row('e1')]);
    if (cause === 'failed enqueue') h.syncEngine.bulkArchive.mockResolvedValue('failed');
    if (cause === 'failed local update') h.storage.updateEmail.mockRejectedValue(new Error('write failed'));
    if (cause === 'missing destination') h.storage.getFolders.mockResolvedValue(folders.filter(folder => folder.id !== 'archive'));
    await bulk()(null, ['e1'], 'archive');
    expect(h.logUserAction).not.toHaveBeenCalled();
  });

  it.each([
    { action: 'markRead', type: 'read', changed: '|INBOX|', unchanged: '|INBOX|read|', queue: 'bulkMarkAsRead' as const },
    { action: 'markUnread', type: 'unread', changed: '|INBOX|read|', unchanged: '|INBOX|', queue: 'bulkMarkAsUnread' as const },
    { action: 'star', type: 'star', changed: '|INBOX|', unchanged: '|INBOX|starred|', queue: 'bulkStar' as const },
    { action: 'unstar', type: 'unstar', changed: '|INBOX|starred|', unchanged: '|INBOX|', queue: 'bulkUnstar' as const },
  ])('logs only changed bulk $action rows and sends only their UIDs', async ({ action, type, changed, unchanged, queue }) => {
    seed([row('changed', { uid: 12, tags: changed }), row('unchanged', { uid: 13, tags: unchanged })]);
    await bulk()(null, ['changed', 'changed', 'unchanged'], action);
    expect(h.logUserAction).toHaveBeenCalledExactlyOnceWith('changed', type, expect.objectContaining({ source: 'user' }), h.storage);
    expect(h.syncEngine[queue]).toHaveBeenCalledExactlyOnceWith('INBOX', [12]);
  });

  it.each(['local update', 'queue rejection', 'failed queue receipt'])('does not learn a read action after a failed %s', async cause => {
    seed([row('e1')]);
    if (cause === 'local update') h.storage.bulkUpdateTags.mockRejectedValue(new Error('write failed'));
    if (cause === 'queue rejection') h.syncEngine.bulkMarkAsRead.mockRejectedValue(new Error('queue failed'));
    if (cause === 'failed queue receipt') h.syncEngine.bulkMarkAsRead.mockResolvedValue('failed');
    await bulk()(null, ['e1'], 'markRead');
    expect(h.logUserAction).not.toHaveBeenCalled();
  });

  it('captures the correct mailbox for individual read actions while the active account changes', async () => {
    seed([row('e1')]);
    h.namedStorage = h.storage;
    let accept!: (outcome: string) => void;
    h.syncEngine.markAsRead.mockReturnValue(new Promise(resolve => { accept = resolve; }));
    const pending = h.handlers.get('emails:markRead')!(null, 'e1', true, 'other-account');
    await vi.waitFor(() => expect(h.syncEngine.markAsRead).toHaveBeenCalled());
    h.activeStorage = { wrongMailbox: true };
    accept('queued');
    await pending;
    expect(h.logUserAction).toHaveBeenCalledExactlyOnceWith('e1', 'read', expect.objectContaining({ senderAddress: 'offers@example.test' }), h.storage);
  });

  it.each([
    { channel: 'emails:markRead', tags: '|INBOX|read|' },
    { channel: 'emails:markStarred', tags: '|INBOX|starred|' },
  ])('does not learn a no-op from $channel', async ({ channel, tags }) => {
    seed([row('e1', { tags })]);
    await h.handlers.get(channel)!(null, 'e1', true);
    expect(h.logUserAction).not.toHaveBeenCalled();
  });

  it('logs a direct Trash action once without a separate aggregate increment', async () => {
    seed([row('e1')]);
    await h.handlers.get('emails:moveToTrash')!(null, 'e1');
    expect(h.logUserAction).toHaveBeenCalledExactlyOnceWith('e1', 'delete', expect.objectContaining({ actionValue: JSON.stringify({ destination: 'Trash' }) }), h.storage);
    expect(h.storage.upsertSenderStats).not.toHaveBeenCalled();
  });

  it('refuses to teach or remove a directly deleted message when its queue request is rejected', async () => {
    seed([row('e1', { folderId: 'trash', tags: '|Trash|' })]);
    h.syncEngine.operationQueue.delete.mockResolvedValue('failed');
    const result = await h.handlers.get('emails:delete')!(null, 'e1');
    expect(result.success).toBe(false);
    expect(h.logUserAction).not.toHaveBeenCalled();
    expect(h.storage.deleteEmail).not.toHaveBeenCalled();
  });
});

/**
 * emails:fetchBody — repairing a stored body whose `cid:` images never resolved.
 *
 * A body was parsed and stored by code that couldn't resolve some `cid:` image
 * (see packages/core/src/utils/cid-images.ts). The raw source is not kept, so
 * the substitution can only happen on a fresh parse — re-fetching is the only
 * repair there is. The two ways to get this wrong are both bad: never repair
 * (the image stays broken forever), or repair unconditionally (a reference that
 * names no part in the message can NEVER resolve, so the mail re-downloads its
 * entire source from IMAP every single time it is opened).
 */
describe('emails:fetchBody — cid: repair', () => {
  const stored = (over: Record<string, unknown> = {}) => ({
    id: 'e1', rawBody: '<p>hello</p>', folderId: 'f', uid: 7, hasAttachments: false, ...over,
  });

  // Breaks: every mail with a cached body re-downloads its source on open.
  it('returns a cached body untouched when it holds no cid reference', async () => {
    h.storage.getEmail.mockResolvedValue(stored({ id: 'clean-1' }));

    const res = await fetchBody()(null, 'clean-1');

    expect(res).toEqual({ success: true, data: expect.objectContaining({ id: 'clean-1' }) });
    expect(h.syncEngine.fetchBody).not.toHaveBeenCalled();
  });

  // Breaks: the reported broken image is permanent for every mail already in the
  // database — the fix would only ever help mail that arrives after it.
  it('re-fetches a stored body that still carries a cid reference, and returns the repaired row', async () => {
    h.storage.getEmail
      .mockResolvedValueOnce(stored({ id: 'broken-1', rawBody: '<img src="cid:avatar@x">' }))
      .mockResolvedValueOnce(stored({ id: 'broken-1', rawBody: '<img src="data:image/png;base64,AAA">' }));
    h.syncEngine.fetchBody.mockResolvedValue({ rawBody: 'r', cleanBody: 'c', contentType: 'text/html' });

    const res = await fetchBody()(null, 'broken-1');

    expect(h.syncEngine.fetchBody).toHaveBeenCalledWith('broken-1', 'INBOX', 7);
    expect(res.data.rawBody).toContain('data:image/png');
  });

  // Breaks: a sender's unresolvable reference (a part that simply isn't in the
  // message) turns every open of that mail into a full source download, forever.
  it('tries exactly once per email per session', async () => {
    const unfixable = stored({ id: 'broken-2', rawBody: '<img src="cid:gone@x">' });
    h.storage.getEmail.mockResolvedValue(unfixable);
    h.syncEngine.fetchBody.mockResolvedValue({ rawBody: 'r', cleanBody: 'c', contentType: 'text/html' });

    await fetchBody()(null, 'broken-2');
    await fetchBody()(null, 'broken-2');
    await fetchBody()(null, 'broken-2');

    expect(h.syncEngine.fetchBody).toHaveBeenCalledTimes(1);
  });

  // Breaks: opening an old mail OFFLINE shows an error where the body used to
  // be. The repair is cosmetic — it must never cost the user a body they have.
  it('falls back to the stored body when the repair cannot run', async () => {
    h.storage.getEmail.mockResolvedValue(stored({ id: 'broken-3', rawBody: '<img src="cid:x@y">' }));
    h.syncEngine.isConnected.mockReturnValue(false);

    const res = await fetchBody()(null, 'broken-3');

    expect(res).toEqual({ success: true, data: expect.objectContaining({ id: 'broken-3' }) });
    expect(h.syncEngine.fetchBody).not.toHaveBeenCalled();
  });

  // Breaks: same, for the two other ways the re-fetch can come up empty — a row
  // with no UID, and a fetch that returns nothing.
  it('falls back to the stored body when the fetch yields nothing', async () => {
    h.storage.getEmail.mockResolvedValue(stored({ id: 'broken-4', rawBody: '<img src="cid:x@y">' }));
    h.syncEngine.fetchBody.mockResolvedValue(null);

    const res = await fetchBody()(null, 'broken-4');

    expect(res.success).toBe(true);
    expect(res.data.rawBody).toBe('<img src="cid:x@y">');
  });

  // Breaks: an email with no body at all stops reporting real failures, because
  // the cid fallback swallows them. Only a repair may degrade to success.
  it('still reports a real failure when there is no body to fall back on', async () => {
    h.storage.getEmail.mockResolvedValue(stored({ id: 'empty-1', rawBody: null }));
    h.syncEngine.isConnected.mockReturnValue(false);

    await expect(fetchBody()(null, 'empty-1')).resolves.toEqual({
      success: false, error: 'Not connected to IMAP',
    });
  });
});

/**
 * emails:fetchBody — a row with no UID.
 *
 * A local-first move (the spam filter or a rule at ingest, or a user move)
 * repoints the row and clears its UID until the destination folder's next sync
 * stamps the new one. The realtime path fetches the body of every arrival
 * straight away, so a mail the spam filter just filed hits this window every
 * time. Answering with a plain failure parked it in the renderer's failedBodies:
 * opening it later showed "Unable to load email content" until restart.
 */
describe('emails:fetchBody — row awaiting its UID after a move', () => {
  const moved = (over: Record<string, unknown> = {}) => ({
    id: 'moved-1', rawBody: null, folderId: 'junk', uid: null, hasAttachments: false, ...over,
  });

  // Breaks: a just-filed spam mail can never be opened this session.
  it('answers with a retryable deferred error the renderer will not memoise', async () => {
    h.storage.getEmail.mockResolvedValue(moved());

    const res = await fetchBody()(null, 'moved-1');

    expect(res.success).toBe(false);
    expect(isRetryableBodyFetchError(res.error)).toBe(true);
    expect(h.syncEngine.fetchBody).not.toHaveBeenCalled();
  });

  // Breaks: the renderer reads the error as "gone from server" and asks the
  // guarded deletion reconcile to look at live mail.
  it('never words the deferral like a server-side deletion', async () => {
    h.storage.getEmail.mockResolvedValue(moved());

    const res = await fetchBody()(null, 'moved-1');

    expect(looksGoneFromServer(res.error)).toBe(false);
  });

  // Breaks: a folder row that genuinely vanished gets retried forever instead
  // of reported — only the missing UID is transient.
  it('still fails outright when the folder itself is unknown', async () => {
    h.storage.getEmail.mockResolvedValue(moved({ uid: 5 }));
    h.storage.getFolder.mockResolvedValue(null);

    const res = await fetchBody()(null, 'moved-1');

    expect(res).toEqual({ success: false, error: 'Cannot determine folder/UID' });
    expect(isRetryableBodyFetchError(res.error)).toBe(false);
  });

  // Breaks: once the destination sync stamps the UID the body still never loads.
  it('fetches normally from the destination once the UID is stamped', async () => {
    h.storage.getEmail.mockResolvedValue(moved({ uid: 41 }));
    h.storage.getFolder.mockResolvedValue({ path: 'Junk' });
    h.syncEngine.fetchBody.mockResolvedValue({ rawBody: 'r', cleanBody: 'c', contentType: 'text/html' });

    const res = await fetchBody()(null, 'moved-1');

    expect(h.syncEngine.fetchBody).toHaveBeenCalledWith('moved-1', 'Junk', 41);
    expect(res.success).toBe(true);
  });

  // Breaks: an image-repair re-fetch on a moved row takes away the body the
  // user already has.
  it('keeps the stored body when a cid repair meets a missing UID', async () => {
    h.storage.getEmail.mockResolvedValue(moved({ id: 'moved-2', rawBody: '<img src="cid:a@b">' }));

    const res = await fetchBody()(null, 'moved-2');

    expect(res).toEqual({ success: true, data: expect.objectContaining({ id: 'moved-2' }) });
  });
});

describe('emails:fetchBody — legacy sent attachment metadata', () => {
  it.each([0, 212])('reparses a cached local Sent mirror with previously missing attachments at UID %i', async (uid) => {
    const legacy = {
      id: 'sent@example.test', messageId: '<sent@example.test>', folderId: 'sent-folder', uid,
      tags: '|Sent|read|', rawBody: '<p>Forwarded message.</p>',
      hasAttachments: false, attachmentNames: '', attachmentSizes: null,
    };
    const repaired = {
      ...legacy, uid: 42, hasAttachments: true,
      attachmentNames: '["report.docx"]', attachmentSizes: '[14336]',
    };
    h.storage.getEmail.mockResolvedValueOnce(legacy).mockResolvedValue(repaired);
    h.storage.getFolder.mockResolvedValue({ path: 'Sent' });
    h.syncEngine.fetchBody.mockResolvedValue({ rawBody: repaired.rawBody });

    const result = await fetchBody()(null, legacy.id);

    expect(h.syncEngine.fetchBody).toHaveBeenCalledWith(legacy.id, 'Sent', uid);
    expect(result).toEqual({ success: true, data: repaired });
  });

  it('reparses a paperclip whose attachment names and truthy size array are empty', async () => {
    const incomplete = {
      id: 'server-row', messageId: '<server@example.test>', folderId: 'sent-folder', uid: 42,
      tags: '|Sent|read|', rawBody: '<p>Forwarded message.</p>',
      hasAttachments: true, attachmentNames: '', attachmentSizes: '[]',
    };
    h.storage.getEmail.mockResolvedValue(incomplete);
    h.storage.getFolder.mockResolvedValue({ path: 'Sent' });
    h.syncEngine.fetchBody.mockResolvedValue({ rawBody: incomplete.rawBody });

    await fetchBody()(null, incomplete.id);

    expect(h.syncEngine.fetchBody).toHaveBeenCalledWith(incomplete.id, 'Sent', 42);
  });
});

describe('claimCidRepairAttempt', () => {
  // Breaks: the once-only rule either never fires (repeat downloads) or fires
  // for bodies that need nothing (a download per open of every mail).
  it('claims a body with a reference once and never again', () => {
    const attempted = new Set<string>();
    expect(claimCidRepairAttempt('<img src="cid:a@b">', 'e1', attempted)).toBe(true);
    expect(claimCidRepairAttempt('<img src="cid:a@b">', 'e1', attempted)).toBe(false);
    // A different email is judged on its own.
    expect(claimCidRepairAttempt('<img src="cid:a@b">', 'e2', attempted)).toBe(true);
  });

  // Breaks: a body with nothing to repair is claimed, so the set fills with ids
  // that never needed an attempt and every mail re-downloads once.
  it('claims nothing for a body with no reference', () => {
    const attempted = new Set<string>();
    expect(claimCidRepairAttempt('<p>plain</p>', 'e1', attempted)).toBe(false);
    expect(claimCidRepairAttempt(null, 'e2', attempted)).toBe(false);
    expect(claimCidRepairAttempt(undefined, 'e3', attempted)).toBe(false);
    expect(attempted.size).toBe(0);
  });

  // Breaks: a long-running session grows this set without bound — a slow leak in
  // the main process, which is the one that must never be restarted under the user.
  it('forgets everything once it reaches the cap', () => {
    const attempted = new Set<string>();
    for (let i = 0; i < CID_REPAIR_MEMORY; i++) claimCidRepairAttempt('<img src="cid:a@b">', `e${i}`, attempted);
    expect(attempted.size).toBe(CID_REPAIR_MEMORY);

    claimCidRepairAttempt('<img src="cid:a@b">', 'one-more', attempted);

    expect(attempted.size).toBe(1);
    expect(attempted.has('one-more')).toBe(true);
  });
});


// `emails:search` is the FALLBACK route — the renderer uses it when the AI-parsed
// search path throws. It has its own operator parser, so a tag: query that works
// in the main path and not here degrades into "the search that came back empty
// the one time everything else had already failed".
describe('emails:search — tag: operator', () => {
  const search = () => h.handlers.get('emails:search')!;
  const lastQuery = () => h.storage.searchEmails.mock.calls.at(-1)![0];

  it('passes a tag: term through to storage and strips it from the free text', async () => {
    await search()(null, 'tag:receipt netflix');
    expect(lastQuery()).toMatchObject({ tags: ['receipt'], query: 'netflix' });
  });

  // Two tags AND in the SQL layer; keeping only the first would widen the search
  // back to everything carrying the other one.
  it('collects EVERY tag:, not just the first', async () => {
    await search()(null, 'tag:receipt tag:subscription');
    expect(lastQuery().tags).toEqual(['receipt', 'subscription']);
  });

  it('accepts a quoted tag name with spaces', async () => {
    await search()(null, 'tag:"needs review"');
    expect(lastQuery().tags).toEqual(['needs review']);
    expect(lastQuery().query).toBe('');
  });

  // Tag matching is a literal comparison against the stored string.
  it('preserves the case the reader typed', async () => {
    await search()(null, 'tag:Work/Clients');
    expect(lastQuery().tags).toEqual(['Work/Clients']);
  });

  it('leaves tags unset when no tag: is present, so the filter cannot narrow by accident', async () => {
    await search()(null, 'is:unread invoice');
    expect(lastQuery().tags).toBeUndefined();
    expect(lastQuery()).toMatchObject({ isUnread: true, query: 'invoice' });
  });
});
