import { beforeEach, describe, expect, it, vi } from 'vitest';

// What breaks if this file fails: the auto-drafter's claim on its own draft.
// It mints the draft's Message-ID and records it on its decision BEFORE the
// save, because saveDraftToIMAP writes the local draft row before the IMAP
// append — so the save must stamp exactly that id. And only a main-process
// caller may choose it: the `drafts:save` IPC passes the renderer's payload
// straight through as `draft`, and a renderer-chosen Message-ID naming an
// existing row would have the local mirror write overwrite that row.

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
import { newDraftMessageId, registerDraftHandlers, saveDraftToIMAP } from '../../../../electron/ipc/draft-handlers';
import { resolveAccountTarget } from '../../../../electron/services/account-target';

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

const messageIdsIn = (db: ReturnType<typeof draftsDb>): string[] =>
  (db.prepare('SELECT message_id AS m FROM emails ORDER BY message_id').all() as Array<{ m: string }>).map((r) => r.m);

beforeEach(() => {
  h.handlers.clear();
  vi.clearAllMocks();
});

describe('newDraftMessageId', () => {
  // Breaks: two drafts sharing a Message-ID (the local mirror row of one
  // replaces the other), or an id off the account's domain.
  it("mints a fresh id on the account address's domain, with a fallback domain", () => {
    const a = newDraftMessageId('me@example.com');
    const b = newDraftMessageId('me@example.com');
    expect(a).toMatch(/^<draft-\d+-[a-z0-9]+@example\.com>$/);
    expect(a).not.toBe(b);
    expect(newDraftMessageId('')).toMatch(/@sarvinbox\.local>$/);
    expect(newDraftMessageId(null)).toMatch(/@sarvinbox\.local>$/);
  });
});

describe("saveDraftToIMAP — the caller's own Message-ID", () => {
  // Breaks: the id the auto-drafter recorded on its decision is not the id
  // the draft row carries — its own draft then reads as the user's.
  it('stamps the id a main-process caller passes in options, on the row and in the result', async () => {
    const db = draftsDb();
    vi.mocked(resolveAccountTarget).mockResolvedValue({
      storage: storageOver(db),
      syncEngine: { isConnected: () => false },
    } as any);

    const res = await saveDraftToIMAP(
      { to: 'a@x.com', subject: 'Re: s', body: 'hi', accountEmail: 'me@x.com', threadId: 't-1' },
      { messageId: '<agent-chosen@x.com>' },
    );

    expect(res).toMatchObject({ success: true, messageId: '<agent-chosen@x.com>' });
    expect(messageIdsIn(db)).toEqual(['<agent-chosen@x.com>']);
  });

  // Breaks: without a caller id every save still gets a fresh one.
  it('mints one when the caller passes none', async () => {
    const db = draftsDb();
    vi.mocked(resolveAccountTarget).mockResolvedValue({
      storage: storageOver(db),
      syncEngine: { isConnected: () => false },
    } as any);

    const res = await saveDraftToIMAP({ to: 'a@x.com', subject: 's', body: 'hi', accountEmail: 'me@x.com' });

    expect(res.messageId).toMatch(/^<draft-\d+-[a-z0-9]+@x\.com>$/);
    expect(messageIdsIn(db)).toEqual([res.messageId]);
  });

  // Breaks: the renderer choosing a draft's Message-ID through the IPC payload
  // — naming an existing message's id would have the mirror write replace it.
  it('ignores a messageId smuggled into the drafts:save IPC payload', async () => {
    const db = draftsDb();
    vi.mocked(resolveAccountTarget).mockResolvedValue({
      storage: storageOver(db),
      syncEngine: { isConnected: () => false },
    } as any);
    registerDraftHandlers();

    const res = (await h.handlers.get('drafts:save')!({}, {
      to: 'a@x.com', subject: 's', body: 'hi', accountEmail: 'me@x.com', messageId: '<victim@x.com>',
    })) as { success: boolean; messageId?: string };

    expect(res.success).toBe(true);
    expect(res.messageId).not.toBe('<victim@x.com>');
    expect(messageIdsIn(db)).toEqual([res.messageId]);
  });
});
