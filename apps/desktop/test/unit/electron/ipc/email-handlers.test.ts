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
  storage: {
    getEmail: vi.fn(),
    getFolder: vi.fn(),
    getFolders: vi.fn(),
    getEmailsByIds: vi.fn(),
    bulkUpdateTags: vi.fn(),
    recalculateFolderCounts: vi.fn(),
  },
  syncEngine: {
    isConnected: vi.fn(() => true),
    fetchBody: vi.fn(),
    bulkMarkAsRead: vi.fn(),
    bulkMarkAsUnread: vi.fn(),
    bulkStar: vi.fn(),
    bulkUnstar: vi.fn(),
  },
  /** false ⇒ getSyncEngine() returns null (account still initialising). */
  engineAvailable: true,
  mainWindow: { webContents: { send: vi.fn() } } as any,
}));

vi.mock('electron', () => ({
  ipcMain: { handle: (name: string, fn: (...a: any[]) => any) => h.handlers.set(name, fn) },
  dialog: {}, shell: {}, app: { getPath: () => '/tmp' },
}));
vi.mock('../../../../electron/shared', () => ({
  requireStorage: () => h.storage,
  requireSyncEngine: () => h.syncEngine,
  getMainWindow: () => h.mainWindow,
  getSyncEngine: () => (h.engineAvailable ? h.syncEngine : null),
  getStorageFor: vi.fn(),
  getSyncEngineFor: vi.fn(),
  getCurrentAccountId: vi.fn(),
}));
vi.mock('../../../../electron/services/body-prefetch-scheduler', () => ({ deferBodyPrefetch: vi.fn() }));
vi.mock('../../../../electron/services/accounts-runtime', () => ({ ensureAccountRuntime: vi.fn() }));
vi.mock('../../../../electron/ipc/agent-handlers', () => ({ logUserAction: vi.fn() }));

import { registerEmailHandlers } from '../../../../electron/ipc/email-handlers';

const fetchBodiesBatch = () => h.handlers.get('emails:fetchBodiesBatch')!;
const spyConsoleWarn = () => vi.spyOn(console, 'warn').mockImplementation(() => {});
let warnSpy: ReturnType<typeof spyConsoleWarn>;
const batchWarns = () =>
  warnSpy.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('fetchBodiesBatch'));

beforeEach(() => {
  h.handlers.clear();
  h.storage.getEmail.mockReset();
  h.storage.getFolder.mockReset().mockResolvedValue({ path: 'INBOX' });
  h.storage.getFolders.mockReset().mockResolvedValue([]);
  h.storage.getEmailsByIds.mockReset().mockResolvedValue([]);
  h.storage.bulkUpdateTags.mockReset().mockResolvedValue(undefined);
  h.storage.recalculateFolderCounts.mockReset().mockResolvedValue(undefined);
  h.syncEngine.isConnected.mockReset().mockReturnValue(true);
  h.syncEngine.fetchBody.mockReset();
  for (const method of ['bulkMarkAsRead', 'bulkMarkAsUnread', 'bulkStar', 'bulkUnstar'] as const) {
    h.syncEngine[method].mockReset().mockResolvedValue(undefined);
  }
  h.engineAvailable = true;
  h.mainWindow.webContents.send.mockReset();
  warnSpy = spyConsoleWarn();
  registerEmailHandlers();
});

afterEach(() => {
  vi.restoreAllMocks();
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
