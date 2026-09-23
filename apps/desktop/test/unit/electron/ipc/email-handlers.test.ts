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
    searchEmails: vi.fn(),
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

import {
  CID_REPAIR_MEMORY,
  claimCidRepairAttempt,
  registerEmailHandlers,
} from '../../../../electron/ipc/email-handlers';

const fetchBodiesBatch = () => h.handlers.get('emails:fetchBodiesBatch')!;
const fetchBody = () => h.handlers.get('emails:fetchBody')!;
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
  h.storage.searchEmails.mockReset().mockResolvedValue([]);
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
