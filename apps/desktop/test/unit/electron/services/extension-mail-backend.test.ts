import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

/**
 * What `context.mail` actually does to the mailbox. Pinned behaviour:
 *   - label and flag changes go through the SAME planner a workflow result
 *     goes through, so an extension acting on a click and the same extension
 *     acting on arrival cannot diverge,
 *   - a permission the user did not grant is refused even though the call
 *     already passed the context wrapper,
 *   - a flag change that matches the stored state does not reach the server,
 *   - trash means "move to the trash folder", never an expunge,
 *   - an unknown id and an id in a closed account fail identically, so an
 *     extension cannot probe which mailboxes exist,
 *   - every mutation is logged with the extension's id.
 */

const h = vi.hoisted(() => ({
  logs: [] as string[],
  manager: null as any,
  storageByEmail: new Map<string, any>(),
  storageByAccount: new Map<string, any>(),
  primaryStorage: null as any,
  syncEngine: null as any,
  moveCalls: [] as { emailId: string; folderId: string; operation: string }[],
  moveResult: { ok: true } as { ok: boolean; error?: string },
}));

// The real planner, imported from core SRC: it is pure, and it is the whole
// permission boundary — stubbing it would leave enforcement untested.
vi.mock('@sarvinbox/core', async () => {
  const effects = await import(
    '../../../../../../packages/core/src/extensions/workflow-effects'
  );
  return {
    planWorkflowEffects: effects.planWorkflowEffects,
    createLogger: () => ({
      info: (...args: unknown[]) => h.logs.push(args.join(' ')),
      warn: (...args: unknown[]) => h.logs.push(args.join(' ')),
      error: (...args: unknown[]) => h.logs.push(args.join(' ')),
      debug: () => {},
    }),
  };
});

vi.mock('../../../../electron/shared', () => ({
  getExtensionManager: () => h.manager,
  findStorageForEmail: (emailId: string) => h.storageByEmail.get(emailId) ?? null,
  getStorage: () => h.primaryStorage,
  getStorageFor: (accountId: string) => h.storageByAccount.get(accountId) ?? null,
  getSyncEngineForStorage: () => h.syncEngine,
}));

vi.mock('../../../../electron/ipc/email-handlers', () => ({
  moveOrCopyOne: async (
    _storage: unknown,
    _sync: unknown,
    emailId: string,
    folderId: string,
    operation: string
  ) => {
    h.moveCalls.push({ emailId, folderId, operation });
    return h.moveResult;
  },
}));

import { createExtensionMailBackend } from '../../../../electron/services/extension-mail-backend';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function makeEmail(id: string, overrides: Record<string, unknown> = {}) {
  return { id, accountId: 'account-1', folderId: 'inbox', uid: 42, tags: '|INBOX|', ...overrides };
}

interface FakeStorage {
  getEmail: Mock;
  updateEmail: Mock;
  getFolder: Mock;
  getFolders: Mock;
  recalculateFolderCounts: Mock;
}

function makeStorage(
  emails: Record<string, any>,
  folders: any[] = [{ id: 'inbox', name: 'Inbox', path: 'INBOX', type: 'inbox' }]
): FakeStorage {
  return {
    getEmail: vi.fn(async (id: string) => emails[id] ?? null),
    updateEmail: vi.fn(async () => {}),
    getFolder: vi.fn(async () => ({ id: 'inbox', path: 'INBOX' })),
    getFolders: vi.fn(async () => folders),
    recalculateFolderCounts: vi.fn(async () => {}),
  };
}

/** Register one storage as the owner of these emails, and as the primary. */
function install(storage: FakeStorage, emails: string[], permissions: string[]): void {
  for (const id of emails) h.storageByEmail.set(id, storage);
  h.primaryStorage = storage;
  h.storageByAccount.set('account-1', storage);
  h.manager = {
    getExtensionInfo: () => ({ manifest: { permissions } }),
  };
}

beforeEach(() => {
  h.logs.length = 0;
  h.manager = null;
  h.storageByEmail.clear();
  h.storageByAccount.clear();
  h.primaryStorage = null;
  h.syncEngine = { markAsRead: vi.fn(async () => {}), markAsStarred: vi.fn(async () => {}) };
  h.moveCalls.length = 0;
  h.moveResult = { ok: true };
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------

describe('applyLabels', () => {
  // Regression: the whole acceptance case. A reader copies a code, the
  // extension marks the mail read, and that has to reach BOTH the local row
  // and the server — a read flag that never leaves the machine comes back
  // unread on the next device.
  it('persists a granted flag and pushes it to the server', async () => {
    const storage = makeStorage({ 'e1': makeEmail('e1') });
    install(storage, ['e1'], ['email:flag']);

    await createExtensionMailBackend().applyLabels('otp-code', 'e1', { add: ['read'] });

    expect(storage.updateEmail).toHaveBeenCalledWith('e1', { tags: expect.stringContaining('read') });
    expect(h.syncEngine.markAsRead).toHaveBeenCalledWith('INBOX', 42, true);
    expect(h.logs.join('\n')).toContain('otp-code changed e1');
  });

  // Regression: the permission is checked again here, against the installed
  // manifest. If this stops, a bug in the context wrapper becomes a mailbox
  // change the user never approved.
  it('refuses a change the extension was not granted', async () => {
    const storage = makeStorage({ 'e1': makeEmail('e1') });
    install(storage, ['e1'], ['email:read']);

    await expect(
      createExtensionMailBackend().applyLabels('greedy', 'e1', { add: ['read'] })
    ).rejects.toThrow(/may not apply 'read'/);
    expect(storage.updateEmail).not.toHaveBeenCalled();
    expect(h.syncEngine.markAsRead).not.toHaveBeenCalled();
  });

  // Regression: a flag the message already has must not cost a server round
  // trip. A card re-shown on a body-stage re-run would otherwise re-push the
  // same flag for every message on a first sync.
  it('does not touch storage or the server when the state already matches', async () => {
    const storage = makeStorage({ 'e1': makeEmail('e1', { tags: '|INBOX|read|' }) });
    install(storage, ['e1'], ['email:flag']);

    await createExtensionMailBackend().applyLabels('otp-code', 'e1', { add: ['read'] });

    expect(storage.updateEmail).not.toHaveBeenCalled();
    expect(h.syncEngine.markAsRead).not.toHaveBeenCalled();
  });

  // Regression: a label is not a flag. `email:label` must not buy the ability
  // to flip read/starred, which are the two tags that reach the server.
  it('applies a label with email:label and still refuses a flag', async () => {
    const storage = makeStorage({ 'e1': makeEmail('e1') });
    install(storage, ['e1'], ['email:label']);
    const backend = createExtensionMailBackend();

    await backend.applyLabels('tagger', 'e1', { add: ['receipts'] });
    expect(storage.updateEmail).toHaveBeenCalledWith('e1', {
      tags: expect.stringContaining('receipts'),
    });

    await expect(backend.applyLabels('tagger', 'e1', { add: ['starred'] })).rejects.toThrow(
      /may not apply 'starred'/
    );
  });

  // Regression: a server push that fails must not abandon the local change or
  // the remaining flags — the queue retries the server side on reconnect.
  it('keeps the local change when the server push fails', async () => {
    const storage = makeStorage({ 'e1': makeEmail('e1') });
    install(storage, ['e1'], ['email:flag']);
    h.syncEngine.markAsRead = vi.fn(async () => {
      throw new Error('connection reset');
    });

    await expect(
      createExtensionMailBackend().applyLabels('otp-code', 'e1', { add: ['read'] })
    ).resolves.toBeUndefined();
    expect(storage.updateEmail).toHaveBeenCalled();
    expect(h.logs.join('\n')).toContain('Could not push read');
  });

  // Regression: an extension that names a message it cannot see must learn
  // nothing from the difference between "no such id" and "not your account".
  it.each([
    ['an unknown id', 'nope'],
    ['an id in a storage it cannot reach', 'closed-account-email'],
  ])('fails identically for %s', async (_label, emailId) => {
    const storage = makeStorage({ 'e1': makeEmail('e1') });
    install(storage, ['e1'], ['email:flag']);

    await expect(
      createExtensionMailBackend().applyLabels('otp-code', emailId, { add: ['read'] })
    ).rejects.toThrow(`mail: no message '${emailId}'`);
  });

  it('rejects an empty email id', async () => {
    const storage = makeStorage({ 'e1': makeEmail('e1') });
    install(storage, ['e1'], ['email:flag']);

    await expect(
      createExtensionMailBackend().applyLabels('otp-code', '', { add: ['read'] })
    ).rejects.toThrow(/an email id is required/);
  });
});

// ---------------------------------------------------------------------------

describe('move and trash', () => {
  // Regression: an extension's move must be the SAME move an IPC-driven move
  // is — folder tag rewrite, Gmail label semantics, the queued IMAP operation.
  // A second implementation here would drift and leave mail in two folders.
  it('runs the shared move and recounts folders', async () => {
    const storage = makeStorage({ 'e1': makeEmail('e1') }, [
      { id: 'inbox', name: 'Inbox', path: 'INBOX', type: 'inbox' },
      { id: 'archive', name: 'Archive', path: 'Archive' },
    ]);
    install(storage, ['e1'], ['email:move']);

    await createExtensionMailBackend().move('filer', 'e1', 'archive');

    expect(h.moveCalls).toEqual([{ emailId: 'e1', folderId: 'archive', operation: 'move' }]);
    expect(storage.recalculateFolderCounts).toHaveBeenCalled();
    expect(h.logs.join('\n')).toContain('filer moved e1 to folder archive');
  });

  // Regression: a recount hiccup must never fail a move that already happened.
  it('does not fail a move when the recount throws', async () => {
    const storage = makeStorage({ 'e1': makeEmail('e1') });
    storage.recalculateFolderCounts = vi.fn(async () => {
      throw new Error('db busy');
    });
    install(storage, ['e1'], ['email:move']);

    await expect(createExtensionMailBackend().move('filer', 'e1', 'archive')).resolves.toBeUndefined();
  });

  it('surfaces a failed move rather than reporting success', async () => {
    const storage = makeStorage({ 'e1': makeEmail('e1') });
    install(storage, ['e1'], ['email:move']);
    h.moveResult = { ok: false, error: 'destination is gone' };

    await expect(createExtensionMailBackend().move('filer', 'e1', 'archive')).rejects.toThrow(
      /destination is gone/
    );
  });

  // Regression: trash is a MOVE to the trash folder. An extension able to
  // expunge would be one bug away from an unrecoverable mailbox.
  it('moves to the trash folder rather than deleting', async () => {
    const storage = makeStorage({ 'e1': makeEmail('e1') }, [
      { id: 'inbox', name: 'Inbox', path: 'INBOX', type: 'inbox' },
      { id: 'bin', name: 'Trash', path: 'Trash', type: 'trash' },
    ]);
    install(storage, ['e1'], ['email:delete']);

    await createExtensionMailBackend().trash('filer', 'e1');

    expect(h.moveCalls).toEqual([{ emailId: 'e1', folderId: 'bin', operation: 'move' }]);
  });

  // Regression: trashing a message already in the bin must be a no-op, not a
  // self-move that churns the server and the counts.
  it('does nothing when the message is already in the trash', async () => {
    const storage = makeStorage({ 'e1': makeEmail('e1', { folderId: 'bin' }) }, [
      { id: 'bin', name: 'Trash', path: 'Trash', type: 'trash' },
    ]);
    install(storage, ['e1'], ['email:delete']);

    await createExtensionMailBackend().trash('filer', 'e1');
    expect(h.moveCalls).toHaveLength(0);
  });

  it('reports an account with no trash folder instead of guessing one', async () => {
    const storage = makeStorage({ 'e1': makeEmail('e1') }, [
      { id: 'inbox', name: 'Inbox', path: 'INBOX', type: 'inbox' },
    ]);
    install(storage, ['e1'], ['email:delete']);

    await expect(createExtensionMailBackend().trash('filer', 'e1')).rejects.toThrow(
      /no trash folder/
    );
    expect(h.moveCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------

describe('reads', () => {
  it('returns null for a message it cannot reach, rather than throwing', async () => {
    const storage = makeStorage({ 'e1': makeEmail('e1') });
    install(storage, ['e1'], ['email:read']);

    expect(await createExtensionMailBackend().get('reader', 'nope')).toBeNull();
  });

  // Regression: an extension is shown a folder's identity, never the row —
  // a folder record carries sync state an extension has no business seeing.
  it('reduces folders to the published subset', async () => {
    const storage = makeStorage({ 'e1': makeEmail('e1') }, [
      { id: 'inbox', name: 'Inbox', path: 'INBOX', type: 'inbox', uidValidity: 9, unread: 3 },
    ]);
    install(storage, ['e1'], ['email:read']);

    const folders = await createExtensionMailBackend().folders('reader', 'account-1');
    expect(folders).toEqual([
      { id: 'inbox', name: 'Inbox', path: 'INBOX', type: 'inbox', accountId: 'account-1' },
    ]);
  });

  it('returns no folders when the named account is not open', async () => {
    const storage = makeStorage({ 'e1': makeEmail('e1') });
    install(storage, ['e1'], ['email:read']);

    expect(await createExtensionMailBackend().folders('reader', 'account-9')).toEqual([]);
  });
});
