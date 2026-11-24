import { getLogLevel, setLogLevel, setLogSink } from '@sarvinbox/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// What breaks if this file fails: a draft's subject or recipient (as the user
// typed them), the account database's full path (the OS user's home folder),
// an email-derived account id, or whatever the renderer sends over
// `drafts:debug` is written to app.log. The draft diagnostic lines were
// `logger.info` with whole option objects, and the release app.log keeps info.
// They are debug now (dropped at the release level) and carry explicit
// scalars, and the one error line on the subject-search path carries the
// error's class, not the ImapFlow error (whose `executedCommand` quotes the
// SEARCH SUBJECT it ran). The deletes themselves must behave exactly as before.

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  active: 'acct-jane-sentinel-example-com--imap',
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
  getCurrentAccountId: vi.fn(() => h.active),
  getAllAccountIds: vi.fn(() => [h.active, 'acct-bob-sentinel-example-org--imap']),
  sendToWindow: vi.fn(),
}));
vi.mock('../../../../electron/services/oauth-service', () => ({ getValidAccessToken: vi.fn() }));
vi.mock('../../../../electron/services/unified-pipeline-service', () => ({ getPipelineUserName: vi.fn(() => 'Me') }));
vi.mock('../../../../electron/services/outbox-service', () => ({
  getOutboxQueue: vi.fn(),
  drainOutbox: vi.fn(),
  getOutboxQueueForAccount: vi.fn(),
  drainOutboxForAccount: vi.fn(),
  notifyOutboxChanged: vi.fn(),
}));
vi.mock('../../../../electron/services/accounts-runtime', () => ({ ensureAccountRuntime: vi.fn() }));
vi.mock('../../../../electron/services/account-target', () => ({ resolveAccountTarget: vi.fn() }));

import { captureLogs, type CapturedLogs } from '../../../../../../packages/core/src/test-support/log-capture';
import { deleteDraftsForThread, registerDraftHandlers, rendererDraftDebugFields } from '../../../../electron/ipc/draft-handlers';
import { resolveAccountTarget } from '../../../../electron/services/account-target';

/** Text the user typed, an OS user name and an account id: none may reach a log line. */
const SUBJECT = 'SENTINEL-subject Payslip for Jane';
const TO = 'Jane SENTINEL-to <jane@example.com>';
const HOME_USER = 'SENTINEL-osuser';
const ACCOUNT = h.active;
const OTHER_ACCOUNT = 'acct-bob-sentinel-example-org--imap';
const SECRETS = [SUBJECT, 'SENTINEL-to', HOME_USER, ACCOUNT, OTHER_ACCOUNT, 'SENTINEL'];

function expectNoSecrets(logs: CapturedLogs): void {
  for (const secret of SECRETS) expect(logs.containing(secret), secret).toEqual([]);
}

interface FakeDb {
  name: string;
  prepare(sql: string): { all: (...a: unknown[]) => unknown[]; get: (...a: unknown[]) => unknown; run: (...a: unknown[]) => { changes: number } };
}

/** An account database whose draft rows match the subject-only cleanup. */
function makeStorage(dbName: string, rows: Array<{ message_id: string; uid: number }> = []) {
  const db: FakeDb = {
    name: dbName,
    prepare: (sql: string) => ({
      all: () => (/SELECT message_id/.test(sql) ? rows : []),
      get: () => rows[0],
      run: () => ({ changes: 1 }),
    }),
  };
  return { db, getFolders: async () => [{ id: 'f1', name: 'Drafts', path: 'Drafts', type: 'drafts' }] };
}

const dbPath = (file: string) => `/Users/${HOME_USER}/Library/Application Support/Sarv Inbox/${file}`;

/** An ImapFlow-shaped command error: it carries the command it ran, subject and all. */
function imapSearchError(): Error {
  return Object.assign(new Error('Command failed'), {
    code: 'NoConnection',
    responseText: 'Connection not available',
    executedCommand: `A9 UID SEARCH DRAFT SUBJECT "${SUBJECT}"`,
  });
}

const call = (channel: string, ...args: unknown[]) => h.handlers.get(channel)!({}, ...args) as Promise<any>;

let logs: CapturedLogs;
beforeEach(() => {
  h.handlers.clear();
  vi.clearAllMocks();
  registerDraftHandlers();
  logs = captureLogs({ setLogSink, setLogLevel, getLogLevel });
});
afterEach(() => { logs.stop(); });

describe('drafts:delete — what reaches the log', () => {
  // Breaks: 'delete:start' logs `options` whole — the subject and To of the
  // subject-only cleanup — and 'delete:resolved' the DB's full path.
  it('logs the subject-only cleanup as booleans and counts, and still deletes', async () => {
    const search = vi.fn(async () => [5]);
    const deleteAndExpunge = vi.fn(async () => {});
    vi.mocked(resolveAccountTarget).mockResolvedValue({
      storage: makeStorage(dbPath('sarvinbox-1a2b.db')),
      syncEngine: { isConnected: () => true, deleteEmail: vi.fn(), getClient: () => ({ selectFolder: async () => {}, search, deleteAndExpunge }) },
      accountId: ACCOUNT,
    } as any);

    const res = await call('drafts:delete', { subject: SUBJECT, to: TO });

    expect(res).toMatchObject({ success: true, imap: true, deleted: 1 });
    expect(search).toHaveBeenCalledWith({ draft: true, subject: SUBJECT });
    expect(deleteAndExpunge).toHaveBeenCalledWith([5]);
    expectNoSecrets(logs);
    const start = logs.containing('delete:start');
    expect(start).toHaveLength(1);
    expect(start[0]).toContain('bySubject: true');
    expect(start[0]).toContain('hasMessageId: false');
    expect(logs.containing("dbFile: 'sarvinbox-1a2b.db'")).toHaveLength(1);
    expect(logs.containing("by: 'subject', changes: 1")).toHaveLength(1);
  });

  // Breaks (IMAP error): the subject search fails and the error line logs the
  // ImapFlow error whole, whose executedCommand names the subject.
  it('logs a failed subject search by error class and code, and queues nothing it cannot', async () => {
    vi.mocked(resolveAccountTarget).mockResolvedValue({
      storage: makeStorage(dbPath('sarvinbox-1a2b.db')),
      syncEngine: {
        isConnected: () => true,
        deleteEmail: vi.fn(),
        getClient: () => ({ selectFolder: async () => {}, search: async () => { throw imapSearchError(); } }),
      },
      accountId: ACCOUNT,
    } as any);

    const res = await call('drafts:delete', { subject: SUBJECT, to: TO });

    expect(res).toMatchObject({ success: true, imap: false, queued: 0, error: 'Command failed' });
    expectNoSecrets(logs);
    expect(logs.containing('Failed to delete draft from IMAP')).toEqual([
      "[ERROR] [draft-handlers] [Drafts] Failed to delete draft from IMAP: { name: 'Error', code: 'NoConnection' }",
    ]);
  });

  // Breaks (transient, offline): the queued server delete logs the folder,
  // the UIDs or the options while it hands the removal to the durable queue.
  it('logs an offline delete as counts while it queues the server removal', async () => {
    const deleteEmail = vi.fn(async () => ({ success: true }));
    vi.mocked(resolveAccountTarget).mockResolvedValue({
      storage: makeStorage(dbPath('sarvinbox-1a2b.db'), [{ message_id: '<d1@example.com>', uid: 41 }]),
      syncEngine: { isConnected: () => false, deleteEmail },
      accountId: ACCOUNT,
    } as any);

    const res = await call('drafts:delete', { threadId: 't-1', subject: SUBJECT, to: TO, accountId: ACCOUNT });

    expect(res).toMatchObject({ success: true, imap: false, queued: 1 });
    expect(deleteEmail).toHaveBeenCalledWith('Drafts', 41);
    expectNoSecrets(logs);
    expect(logs.containing("delete:queued { reason: 'offline or no engine', uids: 1, queued: 1 }")).toHaveLength(1);
  });

  // Breaks (multi-account): a delete for a draft of ANOTHER account writes
  // either account's id; what it may say is whether it named the active one.
  it('says whether the named account is the active one, without naming either', async () => {
    vi.mocked(resolveAccountTarget).mockResolvedValue({
      storage: makeStorage(dbPath('sarvinbox-9f9f.db'), [{ message_id: '<d2@example.org>', uid: 0 }]),
      syncEngine: { isConnected: () => false, deleteEmail: vi.fn() },
      accountId: OTHER_ACCOUNT,
    } as any);

    await call('drafts:delete', { messageId: '<d2@example.org>', accountId: OTHER_ACCOUNT });

    expectNoSecrets(logs);
    expect(logs.containing('namedAccountIsActive: false')).toHaveLength(1);
    expect(logs.containing("dbFile: 'sarvinbox-9f9f.db'")).toHaveLength(1);
  });

  // Breaks (idempotent re-run): the second discard of the same draft (nothing
  // left to delete) logs something the first did not — e.g. the options.
  it('logs nothing new and nothing secret when the same delete runs twice', async () => {
    vi.mocked(resolveAccountTarget).mockResolvedValue({
      storage: makeStorage(dbPath('sarvinbox-1a2b.db')),
      syncEngine: { isConnected: () => false, deleteEmail: vi.fn() },
      accountId: ACCOUNT,
    } as any);

    await call('drafts:delete', { subject: SUBJECT, to: TO });
    const first = logs.lines.length;
    await call('drafts:delete', { subject: SUBJECT, to: TO });

    expect(logs.lines.length).toBe(first * 2);
    expect(logs.lines.slice(first)).toEqual(logs.lines.slice(0, first));
    expectNoSecrets(logs);
  });

  // Breaks: the draft diagnostics go back to info, and every user's release
  // app.log gets the "immortal draft" investigation trail again.
  it('writes no draft diagnostic line at the release log level', async () => {
    logs.stop();
    logs = captureLogs({ setLogSink, setLogLevel, getLogLevel }, { level: 'info' });
    vi.mocked(resolveAccountTarget).mockResolvedValue({
      storage: makeStorage(dbPath('sarvinbox-1a2b.db'), [{ message_id: '<d1@example.com>', uid: 41 }]),
      syncEngine: { isConnected: () => false, deleteEmail: vi.fn(async () => ({ success: true })) },
      accountId: ACCOUNT,
    } as any);

    await call('drafts:delete', { threadId: 't-1', subject: SUBJECT, to: TO });

    expect(logs.containing('[DraftDebug]')).toEqual([]);
  });
});

describe('drafts:save — what reaches the log', () => {
  // Breaks (transient: a busy database right after the APPEND): recording the
  // server UID on the local row fails and the draft diagnostic logs the error's
  // message, or the save around it logs the subject or recipient; the draft
  // must still count as saved to the server.
  it('logs a failed UID update by error class and code, and the save still succeeds', async () => {
    const appendMessage = vi.fn(async () => 77);
    const storage = makeStorage(dbPath('sarvinbox-1a2b.db'));
    const prepare = storage.db.prepare;
    storage.db.prepare = (sql: string) => {
      if (sql.startsWith('UPDATE emails SET uid')) throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
      return prepare(sql);
    };
    vi.mocked(resolveAccountTarget).mockResolvedValue({
      storage,
      syncEngine: { isConnected: () => true, getClient: () => ({ appendMessage }) },
      accountId: ACCOUNT,
    } as any);

    const res = await call('drafts:save', { subject: SUBJECT, to: TO, body: `${SUBJECT} body`, accountEmail: 'jane@example.com' });

    expect(res).toMatchObject({ success: true, folderPath: 'Drafts' });
    expect(res.error).toBeUndefined();
    expect(appendMessage).toHaveBeenCalledWith('Drafts', expect.any(Buffer), ['\\Draft', '\\Seen']);
    expectNoSecrets(logs);
    expect(logs.containing("save:uid-update:error { error: { name: 'Error', code: 'SQLITE_BUSY' } }")).toHaveLength(1);
  });
});

describe('draft error paths — what reaches the log', () => {
  /** A database whose every statement fails (busy: a transient condition). */
  const failingStorage = () => ({
    db: {
      name: dbPath('sarvinbox-dead.db'),
      prepare: () => { throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' }); },
    },
    getFolders: async () => [{ id: 'f1', name: 'Drafts', path: 'Drafts', type: 'drafts' }],
  });

  // Breaks (transient: a busy database, a dropped queue write): the draft
  // diagnostics log an error's message (exact lines: class and code only), or
  // the request's subject and recipient on the way.
  it('logs every failed step by error class and code, and still answers', async () => {
    vi.mocked(resolveAccountTarget).mockResolvedValue({
      storage: failingStorage(),
      syncEngine: { isConnected: () => false, deleteEmail: vi.fn() },
      accountId: ACCOUNT,
    } as any);
    const failedCollect = await call('drafts:delete', { threadId: 't-1', subject: SUBJECT, to: TO });

    vi.mocked(resolveAccountTarget).mockResolvedValue({
      storage: makeStorage(dbPath('sarvinbox-1a2b.db'), [{ message_id: '<d1@example.com>', uid: 41 }]),
      syncEngine: { isConnected: () => false, deleteEmail: vi.fn(async () => { throw new Error('pending_operations write failed'); }) },
      accountId: ACCOUNT,
    } as any);
    const failedQueue = await call('drafts:delete', { threadId: 't-1' });

    expect(failedCollect).toMatchObject({ success: true, imap: false, queued: 0 });
    expect(failedQueue).toMatchObject({ success: true, imap: false, queued: 0 });
    expectNoSecrets(logs);
    expect(logs.containing("delete:collect:error { error: { name: 'Error', code: 'SQLITE_BUSY' } }")).toHaveLength(1);
    expect(logs.containing("delete:queue:error { uid: 41, error: { name: 'Error' } }")).toHaveLength(1);
  });

  // Breaks: the send-time cleanup of a thread's drafts logs the thread id, or
  // its failure logs the error's message.
  it('logs the send-time cleanup as a count, and its failure by class', async () => {
    vi.mocked(resolveAccountTarget).mockResolvedValueOnce({
      storage: makeStorage(dbPath('sarvinbox-1a2b.db'), [{ message_id: '<d1@example.com>', uid: 41 }]),
      syncEngine: null,
      accountId: ACCOUNT,
    } as any);
    await deleteDraftsForThread(ACCOUNT, 'SENTINEL-thread');
    vi.mocked(resolveAccountTarget).mockResolvedValueOnce({ storage: failingStorage(), syncEngine: null, accountId: ACCOUNT } as any);
    await deleteDraftsForThread(ACCOUNT, 'SENTINEL-thread');

    expectNoSecrets(logs);
    expect(logs.containing('sendCleanup:start { count: 1 }')).toHaveLength(1);
    expect(logs.containing("sendCleanup:collect:error { error: { name: 'Error', code: 'SQLITE_BUSY' } }")).toHaveLength(1);
  });
});

describe('drafts:cleanup — what reaches the log', () => {
  // Breaks (multi-account): the per-account sweep line names each account id
  // and its database's full path; the result handed back keeps the id.
  it('logs each account by its database file name only', async () => {
    vi.mocked(resolveAccountTarget).mockImplementation(async (accountId?: string) => ({
      storage: makeStorage(dbPath(accountId === ACCOUNT ? 'sarvinbox-aaaa.db' : 'sarvinbox-bbbb.db'), [{ message_id: '<x@y>', uid: 0 }]),
      syncEngine: null,
      accountId,
    }) as any);

    const res = await call('drafts:cleanup', { sinceMs: 1 });

    expect(res.results.map((r: { accountId: string }) => r.accountId)).toEqual([ACCOUNT, OTHER_ACCOUNT]);
    expectNoSecrets(logs);
    expect(logs.containing("cleanup { dbFile: 'sarvinbox-aaaa.db', localDeleted: 1, imapDeleted: 0 }")).toHaveLength(1);
    expect(logs.containing("cleanup { dbFile: 'sarvinbox-bbbb.db', localDeleted: 1, imapDeleted: 0 }")).toHaveLength(1);
  });

  // Breaks (transient: the server's date SEARCH times out): the sweep's
  // failure line logs the error's message, or the failure stops the sweep from
  // answering for the account.
  it('logs a failed server date search by error class and code, and still answers', async () => {
    const search = vi.fn(async () => { throw Object.assign(new Error(`Command timed out for ${ACCOUNT}`), { code: 'ETIMEDOUT' }); });
    const deleteAndExpunge = vi.fn(async () => {});
    const conn = { selectFolder: vi.fn(async () => {}), search, deleteAndExpunge };
    vi.mocked(resolveAccountTarget).mockResolvedValue({
      storage: makeStorage(dbPath('sarvinbox-1a2b.db')),
      syncEngine: { isConnected: () => true, connectionPool: { withConnection: (fn: (c: unknown) => unknown) => fn(conn) } },
      accountId: ACCOUNT,
    } as any);

    const res = await call('drafts:cleanup', { accountId: ACCOUNT, sinceMs: 1_000, beforeMs: 2_000 });

    expect(search).toHaveBeenCalledWith({ since: new Date(1_000), before: new Date(2_000) });
    expect(deleteAndExpunge).not.toHaveBeenCalled();
    expect(res.results).toEqual([{ accountId: ACCOUNT, dbFile: 'sarvinbox-1a2b.db', localDeleted: 0, imapDeleted: 0 }]);
    expectNoSecrets(logs);
    expect(logs.containing("cleanup:datesearch:error { error: { name: 'Error', code: 'ETIMEDOUT' } }")).toHaveLength(1);
  });

  // Breaks: a database handle with no file name (an in-memory one) or one
  // that throws when asked fails the sweep's log line, or falls back to
  // something that is not a fixed word.
  it('names a database it cannot name by a fixed word', async () => {
    const unnamed = makeStorage('');
    const throwing = makeStorage(dbPath('sarvinbox-1a2b.db'));
    Object.defineProperty(throwing.db, 'name', { get: () => { throw new Error(`closed: ${dbPath('sarvinbox-1a2b.db')}`); } });
    vi.mocked(resolveAccountTarget).mockImplementation(async (accountId?: string) => ({
      storage: accountId === ACCOUNT ? unnamed : throwing,
      syncEngine: null,
      accountId,
    }) as any);

    const res = await call('drafts:cleanup', { sinceMs: 1 });

    expect(res.results.map((r: { dbFile: string }) => r.dbFile)).toEqual(['unknown', 'error']);
    expectNoSecrets(logs);
    expect(logs.containing("cleanup { dbFile: 'unknown', localDeleted: 0, imapDeleted: 0 }")).toHaveLength(1);
    expect(logs.containing("cleanup { dbFile: 'error', localDeleted: 0, imapDeleted: 0 }")).toHaveLength(1);
  });

  // Breaks: a failed sweep logs the error's message (or the account id).
  it('logs a failed sweep by error class', async () => {
    vi.mocked(resolveAccountTarget).mockRejectedValue(Object.assign(new Error(`no storage for ${ACCOUNT}`), { code: 'ENOENT' }));

    const res = await call('drafts:cleanup', { accountId: ACCOUNT });

    expect(res.results).toEqual([{ accountId: ACCOUNT, error: `no storage for ${ACCOUNT}` }]);
    expectNoSecrets(logs);
    expect(logs.containing("cleanup:error { error: { name: 'Error', code: 'ENOENT' } }")).toHaveLength(1);
  });
});

describe('drafts:debug — the renderer passthrough', () => {
  // Breaks: whatever the renderer sends is logged verbatim (today ids and
  // account ids; tomorrow anything a caller adds, a subject included).
  it('logs only the allowlisted scalars of a listed event', async () => {
    const res = await call('drafts:debug', 'store.discardDraft', {
      messageId: '<SENTINEL-mid@example.com>', threadId: 'SENTINEL-thread', passedAccountId: ACCOUNT, resolvedAcct: ACCOUNT,
      snapshotFound: true, removedCount: 2, subject: SUBJECT,
    });

    expect(res).toEqual({ success: true });
    expectNoSecrets(logs);
    const [line] = logs.containing('renderer:store.discardDraft');
    expect(line).toContain('snapshotFound: true');
    expect(line).toContain('removedCount: 2');
    expect(line).toContain('has_messageId: true');
    expect(line).toContain('passedAccountId_is_resolvedAcct: true');
  });

  // Breaks: an event name the renderer made up (it can carry any text) is
  // written, with its payload.
  it('logs an unlisted event by a fixed name and nothing else', async () => {
    await call('drafts:debug', `SENTINEL ${SUBJECT}`, { subject: SUBJECT });

    expectNoSecrets(logs);
    expect(logs.containing('renderer:unlisted {}')).toHaveLength(1);
  });
});

describe('rendererDraftDebugFields', () => {
  // Breaks: the InlineReply dismiss event loses the facts the investigation
  // used (unified view, which account replied vs. which is active).
  it('keeps the InlineReply dismiss facts as booleans', () => {
    expect(rendererDraftDebugFields('InlineReply.handleDismiss', {
      messageId: 'm', draftMessageId: '', replyAccountId: 'a', threadId: undefined,
      isUnifiedView: true, viewAccountId: 'b', activeAccountId: 'a',
    })).toEqual({
      event: 'InlineReply.handleDismiss',
      fields: {
        isUnifiedView: true,
        has_messageId: true, has_draftMessageId: false, has_threadId: false,
        has_replyAccountId: true, has_viewAccountId: true, has_activeAccountId: true,
        replyAccountId_is_activeAccountId: true, viewAccountId_is_activeAccountId: false,
      },
    });
  });

  // Breaks: a wrongly typed field (a string where a flag or count belongs) is
  // written as it came.
  it('drops a flag or count of the wrong type, and a payload that is not an object', () => {
    expect(rendererDraftDebugFields('store.discardDraft', { snapshotFound: 'SENTINEL', removedCount: 'SENTINEL' }).fields)
      .toEqual({ has_messageId: false, has_threadId: false, has_passedAccountId: false, has_resolvedAcct: false });
    expect(rendererDraftDebugFields('store.discardDraft', { removedCount: Number.POSITIVE_INFINITY }).fields).not.toHaveProperty('removedCount');
    expect(rendererDraftDebugFields('store.discardDraft', 'SENTINEL').fields).toEqual({
      has_messageId: false, has_threadId: false, has_passedAccountId: false, has_resolvedAcct: false,
    });
  });

  // Breaks: an inherited property name passes as a listed event.
  it('treats a prototype key or a non-string event as unlisted', () => {
    expect(rendererDraftDebugFields('constructor', {})).toEqual({ event: 'unlisted', fields: {} });
    expect(rendererDraftDebugFields(42, {})).toEqual({ event: 'unlisted', fields: {} });
  });
});
