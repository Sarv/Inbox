import { beforeEach, describe, expect, it, vi } from 'vitest';

// What breaks if this file fails: main's draft deletes pick their rows with the
// ONE draft predicate (core isDraftRow's SQL twin, `accountDraftRowSql`), never
// with bare `|draft|` / `|Drafts|` markers of their own. A Sent copy can keep a
// stale `|draft|` tag (`|Sent|draft|`), and the bare markers took it for a
// draft: discarding a draft, or sending a reply, deleted the reader's own SENT
// reply from the local database AND handed its Sent-folder UID to the
// Drafts-folder expunge — where that number names some unrelated draft.
// Nothing throws; the sent reply is just gone.

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
import { deleteDraftsForThread, registerDraftHandlers } from '../../../../electron/ipc/draft-handlers';
import { resolveAccountTarget } from '../../../../electron/services/account-target';
import { sendToWindow } from '../../../../electron/shared';

// A provider whose Drafts folder is NOT one of the standard names, so only the
// account's own folder list makes its copies drafts.
const DRAFTS = 'INBOX.Drafts';
const SENT = 'INBOX.Sent';

type Db = ReturnType<typeof newMigratedDb>;

function mailbox(): Db {
  const db = newMigratedDb();
  const folder = db.prepare('INSERT OR IGNORE INTO folders (id, name, path, special_use) VALUES (?, ?, ?, ?)');
  folder.run('f-inbox', 'INBOX', 'INBOX', null);
  folder.run('f-drafts', 'Drafts', DRAFTS, '\\Drafts');
  folder.run('f-sent', 'Sent', SENT, '\\Sent');
  db.prepare(`INSERT INTO threads (id, subject, first_message_id, last_message_id, last_message_date)
              VALUES ('t-1', 'Plan', '<orig@y>', '<orig@y>', 1700000000)`).run();
  return db;
}

function addRow(db: Db, row: { id: string; tags: string; uid: number; subject?: string; to?: string; inReplyTo?: string }) {
  db.prepare(`
    INSERT INTO emails (id, message_id, thread_id, folder_id, tags, from_address, to_address, subject, date,
                        clean_body, raw_body, content_type, content_hash, uid, in_reply_to)
    VALUES (?, ?, 't-1', 'f-inbox', ?, 'me@x.com', ?, ?, ?, 'body', 'body', 'text', ?, ?, ?)
  `).run(row.id, `<${row.id}@x>`, row.tags, row.to ?? 'them@y.com', row.subject ?? 'Re: Plan',
    1_700_000_000, `hash-${row.id}`, row.uid, row.inReplyTo ?? '<orig@y>');
}

const idsLeft = (db: Db): string[] =>
  (db.prepare('SELECT id FROM emails ORDER BY id').all() as Array<{ id: string }>).map((r) => r.id);

const storageOver = (db: unknown) => ({
  db,
  getFolders: async () => [
    { id: 'f-drafts', name: 'Drafts', path: DRAFTS, specialUse: '\\Drafts', type: 'drafts' },
    { id: 'f-sent', name: 'Sent', path: SENT, specialUse: '\\Sent', type: 'sent' },
  ],
});

const removedIds = () =>
  vi.mocked(sendToWindow).mock.calls
    .filter(([channel]) => channel === 'drafts:removed')
    .flatMap(([, payload]) => (payload as { messageIds: string[] }).messageIds);

/** A thread holding a local draft, a provider-path draft and two stale-tagged Sent copies. */
function threadWithSentCopies(): Db {
  const db = mailbox();
  addRow(db, { id: 'draft', tags: '|draft|', uid: 0 });
  addRow(db, { id: 'pdraft', tags: `|${DRAFTS}|`, uid: 41 });
  addRow(db, { id: 'sent', tags: `|${SENT}|draft|`, uid: 900 });
  addRow(db, { id: 'stdsent', tags: '|Sent|draft|', uid: 901 });
  return db;
}

beforeEach(() => {
  h.handlers.clear();
  vi.clearAllMocks();
  registerDraftHandlers();
});

const call = (name: string, ...args: unknown[]) => h.handlers.get(name)!({}, ...args) as Promise<any>;

describe('draft deletes keep the reader\'s Sent copies', () => {
  // Breaks: THE regression — discarding the thread's draft deleted the sent
  // replies with it and queued their Sent-folder UIDs (900, 901) for the
  // Drafts-folder expunge.
  it('drafts:delete by thread removes only drafts, locally and on the server', async () => {
    const db = threadWithSentCopies();
    const deleteEmail = vi.fn(async () => ({ success: true }));
    vi.mocked(resolveAccountTarget).mockResolvedValue({
      storage: storageOver(db), syncEngine: { isConnected: () => false, deleteEmail },
    } as any);

    const res = await call('drafts:delete', { threadId: 't-1', accountId: 'acct-1' });

    expect(idsLeft(db)).toEqual(['sent', 'stdsent']);
    expect(removedIds().sort()).toEqual(['<draft@x>', '<pdraft@x>']);
    expect(deleteEmail.mock.calls).toEqual([[DRAFTS, 41]]);
    expect(res).toMatchObject({ success: true, queued: 1 });
  });

  // Breaks: sending a reply ran the post-send cleanup over the same bare
  // markers, deleting the very Sent copy the send had just stored.
  it('the post-send cleanup removes only drafts', async () => {
    const db = threadWithSentCopies();
    vi.mocked(resolveAccountTarget).mockResolvedValue({
      storage: storageOver(db), syncEngine: { isConnected: () => false },
    } as any);

    await deleteDraftsForThread('acct-1', 't-1');

    expect(idsLeft(db)).toEqual(['sent', 'stdsent']);
    expect(removedIds().sort()).toEqual(['<draft@x>', '<pdraft@x>']);
  });

  // Breaks: the autosave's subject/recipient delete matched a Sent copy of the
  // same reply (same subject, same To) that kept a stale `|draft|` tag.
  it('drafts:delete by subject and recipient spares a Sent copy of the same reply', async () => {
    const db = mailbox();
    addRow(db, { id: 'draft', tags: '|draft|', uid: 0 });
    addRow(db, { id: 'sent', tags: `|${SENT}|draft|`, uid: 900 });
    vi.mocked(resolveAccountTarget).mockResolvedValue({
      storage: storageOver(db), syncEngine: { isConnected: () => false },
    } as any);

    await call('drafts:delete', { subject: 'Re: Plan', to: 'them@y.com', accountId: 'acct-1' });

    expect(idsLeft(db)).toEqual(['sent']);
  });

  // Breaks: the junk-draft sweep took stale-tagged Sent copies in its window.
  it('drafts:cleanup sweeps only drafts', async () => {
    const db = threadWithSentCopies();
    vi.mocked(resolveAccountTarget).mockResolvedValue({
      storage: storageOver(db), syncEngine: { isConnected: () => false },
    } as any);

    const res = await call('drafts:cleanup', { sinceMs: 1_600_000_000_000, accountId: 'acct-1' });

    expect(idsLeft(db)).toEqual(['sent', 'stdsent']);
    expect(res).toMatchObject({ success: true });
  });

  // Breaks: reopening the thread's draft loaded the SENT reply (newest row
  // with a `|draft|` tag) into the composer as if it were unsent.
  it('drafts:find-for-thread returns the draft, never a stale-tagged Sent copy', async () => {
    const db = mailbox();
    addRow(db, { id: 'draft', tags: '|draft|', uid: 0 });
    addRow(db, { id: 'sent', tags: `|${SENT}|draft|`, uid: 900 });
    db.prepare('UPDATE emails SET date = date + 60 WHERE id = ?').run('sent');
    vi.mocked(resolveAccountTarget).mockResolvedValue({ storage: storageOver(db), syncEngine: {} } as any);

    const res = await call('drafts:find-for-thread', ['<orig@y>'], 'acct-1');

    expect(res).toMatchObject({ success: true, data: { id: 'draft' } });
  });

  // Breaks: with the account's folders unreadable, the delete fell back to
  // guessing from bare markers. A delete must source its rows from a read
  // that fails loudly, and then delete NOTHING.
  it('deletes nothing when the folders table cannot be read', async () => {
    const run = vi.fn(() => ({ changes: 1 }));
    const db = {
      prepare: (sql: string) => {
        if (/FROM folders/.test(sql)) throw new Error('database disk image is malformed');
        return { all: () => [{ message_id: '<sent@x>', uid: 900 }], get: () => undefined, run };
      },
    };
    const deleteEmail = vi.fn(async () => ({ success: true }));
    vi.mocked(resolveAccountTarget).mockResolvedValue({
      storage: storageOver(db), syncEngine: { isConnected: () => false, deleteEmail },
    } as any);

    await call('drafts:delete', { threadId: 't-1', accountId: 'acct-1' });
    await deleteDraftsForThread('acct-1', 't-1');

    expect(run).not.toHaveBeenCalled();
    expect(deleteEmail).not.toHaveBeenCalled();
    expect(removedIds()).toEqual([]);
  });
});
