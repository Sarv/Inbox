import { beforeEach, describe, expect, it, vi } from 'vitest';

// What breaks if this file fails: the Drafts list stops following draft writes.
// A compose closed into a draft does not appear until some later sync happens to
// reload the view ("sometimes I don't see the draft"), and the draft an autosave
// replaced lingers beside its replacement as a duplicate row. Neither throws —
// the DB is right, only the open view is stale — so only the event can be tested.

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

// eslint-disable-next-line import/order -- see local-mirror-content-hash.test.ts
import { newMigratedDb } from '../../../../../../packages/storage-node/src/test-support/test-db';
import { registerDraftHandlers, saveDraftToIMAP } from '../../../../electron/ipc/draft-handlers';
import { resolveAccountTarget } from '../../../../electron/services/account-target';
import { sendToWindow } from '../../../../electron/shared';

const DRAFTS = 'Drafts';

function draftsDb() {
  const db = newMigratedDb();
  db.prepare('INSERT OR IGNORE INTO folders (id, name, path, special_use) VALUES (?, ?, ?, ?)')
    .run('f-drafts', DRAFTS, DRAFTS, '\\Drafts');
  return db;
}

const storageOver = (db: unknown) => ({
  db,
  getFolders: async () => [{ id: 'f-drafts', name: DRAFTS, path: DRAFTS, specialUse: '\\Drafts', type: 'drafts' }],
});

const eventsNamed = (name: string) =>
  vi.mocked(sendToWindow).mock.calls.filter(([channel]) => channel === name).map(([, payload]) => payload);

beforeEach(() => {
  h.handlers.clear();
  vi.clearAllMocks();
});

describe('saveDraftToIMAP — drafts:saved', () => {
  // Breaks: THE regression — the list only learned of a new draft on the next sync.
  it('announces the draft as soon as the local row is written', async () => {
    const db = draftsDb();
    vi.mocked(resolveAccountTarget).mockResolvedValue({
      storage: storageOver(db),
      syncEngine: { isConnected: () => false },
    } as any);

    const res = await saveDraftToIMAP({ to: 'a@x.com', subject: 's', body: 'hi', accountEmail: 'me@x.com', threadId: 't-1' });

    expect(res.success).toBe(true);
    expect(eventsNamed('drafts:saved')).toEqual([{ messageId: res.messageId, threadId: 't-1' }]);
  });

  // Breaks: an event for a row that was never written makes the list reload
  // into a state that still lacks the draft — or, worse, signals success.
  it('does not announce when the local write fails', async () => {
    vi.mocked(resolveAccountTarget).mockResolvedValue({
      storage: storageOver({ prepare: () => { throw new Error('disk I/O error'); } }),
      syncEngine: { isConnected: () => false },
    } as any);

    await saveDraftToIMAP({ to: 'a@x.com', subject: 's', body: 'hi', accountEmail: 'me@x.com' });

    expect(eventsNamed('drafts:saved')).toEqual([]);
  });
});

describe('drafts:delete — drafts:removed', () => {
  const rows = [{ message_id: '<old@x>', uid: 0 }];
  const storage = {
    db: {
      prepare: (sql: string) => ({
        all: () => (/SELECT message_id/.test(sql) ? rows : []),
        get: () => rows[0],
        run: () => ({ changes: rows.length }),
      }),
    },
    getFolders: async () => [{ id: 'f1', name: DRAFTS, path: DRAFTS, type: 'drafts' }],
  };

  const callDelete = (opts: Record<string, unknown>) => {
    registerDraftHandlers();
    return h.handlers.get('drafts:delete')!({}, opts) as Promise<unknown>;
  };

  // Breaks: the autosave's replace-in-place deletes the superseded draft by
  // message-id; without this event it stays on screen as a duplicate.
  it('tells the renderer which draft rows it removed', async () => {
    vi.mocked(resolveAccountTarget).mockResolvedValue({
      storage,
      syncEngine: { isConnected: () => false, deleteEmail: vi.fn(async () => ({ success: true })) },
    } as any);

    await callDelete({ messageId: '<old@x>', accountId: 'acct-1' });

    expect(eventsNamed('drafts:removed')).toEqual([{ threadId: '', messageIds: ['<old@x>'] }]);
  });

  // Breaks: a delete that matched nothing still fires, making every open view
  // reload for no change.
  it('stays quiet when nothing matched', async () => {
    vi.mocked(resolveAccountTarget).mockResolvedValue({
      storage: { ...storage, db: { prepare: () => ({ all: () => [], get: () => undefined, run: () => ({ changes: 0 }) }) } },
      syncEngine: { isConnected: () => false },
    } as any);

    await callDelete({ threadId: 't-9', accountId: 'acct-1' });

    expect(eventsNamed('drafts:removed')).toEqual([]);
  });
});
