import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The main-process runtime registry. It is pure state (electron/storage/core are
 * type-only imports), so it needs no mocks — but it IS the thing that decides
 * which account's DB a "no-argument" IPC handler resolves, so the invariants are
 * worth pinning:
 *   - the pre-account `__default__` slot is never reported as a real account,
 *   - the PRIMARY claims that slot (its open DB is reused, not re-opened),
 *   - removing/re-keying the active account never leaves a stale pointer,
 *   - storage -> account reverse lookups are identity-based (how the pipeline
 *     attributes an email to an account with no accountId column),
 *   - sendToWindow refuses a DESTROYED window (which `?.` alone does not catch).
 */

type Shared = typeof import('../../../electron/shared');

/** Fresh module — every runtime map / pointer is module state. */
const load = async (): Promise<Shared> => {
  vi.resetModules();
  return import('../../../electron/shared');
};

const runtime = (tag: string) =>
  ({
    storage: { tag } as unknown,
    syncEngine: { tag: `${tag}-engine` } as unknown,
    smtpClient: null,
  }) as unknown as Parameters<Shared['registerAccountRuntime']>[1];

interface FakeWindow {
  destroyed: boolean;
  contentsDestroyed: boolean;
  sent: Array<{ channel: string; args: unknown[] }>;
  isDestroyed: () => boolean;
  webContents: { isDestroyed: () => boolean; send: (channel: string, ...args: unknown[]) => void };
}

const makeWindow = (): FakeWindow => {
  const win: FakeWindow = {
    destroyed: false,
    contentsDestroyed: false,
    sent: [],
    isDestroyed: () => win.destroyed,
    webContents: {
      isDestroyed: () => win.contentsDestroyed,
      send: (channel, ...args) => win.sent.push({ channel, args }),
    },
  };
  return win;
};

let shared: Shared;

beforeEach(async () => {
  shared = await load();
});

describe('the pre-account default slot', () => {
  it('reports no current account and empty accessors before any account exists', () => {
    expect(shared.getCurrentAccountId()).toBeNull();
    expect(shared.getStorage()).toBeNull();
    expect(shared.getSyncEngine()).toBeNull();
    expect(shared.getSmtpClient()).toBeNull();
    expect(shared.getAllAccountIds()).toEqual([]);
    expect(shared.getAllAccountRuntimes()).toEqual([]);
  });

  it('holds the startup instances without exposing them as an account', () => {
    const storage = { tag: 'startup' } as never;
    shared.setStorage(storage);
    shared.setSyncEngine({ tag: 'engine' } as never);
    shared.setSmtpClient({ tag: 'smtp' } as never);

    expect(shared.getStorage()).toBe(storage);
    expect(shared.getAllAccountIds()).toEqual([]);          // __default__ excluded
    expect(shared.getAccountIdForStorage(storage)).toBeNull(); // ...and unattributed
  });

  it('requireStorage / requireSyncEngine / requireMainWindow throw with clear messages', () => {
    expect(() => shared.requireStorage()).toThrow('Storage not initialized');
    expect(() => shared.requireSyncEngine()).toThrow('Sync engine not initialized');
    expect(() => shared.requireMainWindow()).toThrow('Main window not available');

    const storage = { tag: 's' } as never;
    shared.setStorage(storage);
    expect(shared.requireStorage()).toBe(storage);
    const engine = { tag: 'e' } as never;
    shared.setSyncEngine(engine);
    expect(shared.requireSyncEngine()).toBe(engine);
    const win = makeWindow() as never;
    shared.setMainWindow(win);
    expect(shared.requireMainWindow()).toBe(win);
  });
});

describe('the account registry', () => {
  it('registers, resolves and lists real accounts only', () => {
    const a = runtime('a');
    shared.registerAccountRuntime('acct-a', a);
    shared.setStorage({ tag: 'default-slot' } as never); // the __default__ slot too

    expect(shared.getAccountRuntime('acct-a')).toBe(a);
    expect(shared.hasAccountRuntime('acct-a')).toBe(true);
    expect(shared.hasAccountRuntime('acct-missing')).toBe(false);
    expect(shared.getAllAccountIds()).toEqual(['acct-a']);
    expect(shared.getAllAccountRuntimes()).toEqual([['acct-a', a]]);
  });

  it('does not count a runtime whose storage is still null', () => {
    shared.registerAccountRuntime('acct-a', { storage: null, syncEngine: null, smtpClient: null } as never);
    expect(shared.hasAccountRuntime('acct-a')).toBe(false);
    expect(shared.getAllAccountIds()).toEqual([]);
  });

  it('resolves per-account accessors, and null for an unknown account', () => {
    const a = runtime('a');
    shared.registerAccountRuntime('acct-a', a);
    expect(shared.getStorageFor('acct-a')).toBe(a.storage);
    expect(shared.getSyncEngineFor('acct-a')).toBe(a.syncEngine);
    expect(shared.getStorageFor('nope')).toBeNull();
    expect(shared.getSyncEngineFor('nope')).toBeNull();
    expect(shared.getSmtpClientFor('nope')).toBeNull();
    expect(shared.getAccountRuntime('nope')).toBeUndefined();
  });

  it('sets an account SMTP client in place (and ignores an unknown account)', () => {
    const a = runtime('a');
    shared.registerAccountRuntime('acct-a', a);
    const client = { tag: 'smtp' } as never;
    shared.setSmtpClientFor('acct-a', client);
    expect(shared.getSmtpClientFor('acct-a')).toBe(client);

    expect(() => shared.setSmtpClientFor('nope', client)).not.toThrow();
    shared.setSmtpClientFor('acct-a', null);
    expect(shared.getSmtpClientFor('acct-a')).toBeNull();
  });
});

describe('storage -> account reverse lookups', () => {
  it('maps a storage back to its engine and its account id', () => {
    const a = runtime('a');
    const b = runtime('b');
    shared.registerAccountRuntime('acct-a', a);
    shared.registerAccountRuntime('acct-b', b);

    expect(shared.getSyncEngineForStorage(a.storage as never)).toBe(a.syncEngine);
    expect(shared.getAccountIdForStorage(b.storage as never)).toBe('acct-b');
  });

  it('is null for a null / unknown storage', () => {
    expect(shared.getSyncEngineForStorage(null)).toBeNull();
    expect(shared.getAccountIdForStorage(null)).toBeNull();
    expect(shared.getSyncEngineForStorage({ tag: 'foreign' } as never)).toBeNull();
    expect(shared.getAccountIdForStorage({ tag: 'foreign' } as never)).toBeNull();
  });

  it('never attributes the default slot to an account id', () => {
    const storage = { tag: 'startup' } as never;
    shared.setStorage(storage);
    expect(shared.getAccountIdForStorage(storage)).toBeNull();
    // ...but its engine is still resolvable by identity.
    const engine = { tag: 'engine' } as never;
    shared.setSyncEngine(engine);
    expect(shared.getSyncEngineForStorage(storage)).toBe(engine);
  });
});

describe('setCurrentAccount', () => {
  it('switches which account the no-argument accessors resolve', () => {
    const a = runtime('a');
    const b = runtime('b');
    shared.registerAccountRuntime('acct-a', a);
    shared.registerAccountRuntime('acct-b', b);

    shared.setCurrentAccount('acct-a');
    expect(shared.getCurrentAccountId()).toBe('acct-a');
    expect(shared.getStorage()).toBe(a.storage);

    shared.setCurrentAccount('acct-b');
    expect(shared.getStorage()).toBe(b.storage);
    expect(shared.getSyncEngine()).toBe(b.syncEngine);
  });

  it('creates an EMPTY slot for an account with no runtime yet', () => {
    const rt = shared.setCurrentAccount('acct-new');
    expect(rt).toEqual({ storage: null, syncEngine: null, smtpClient: null });
    expect(shared.getStorage()).toBeNull();
    // Writing through the active-account setters fills that slot.
    const storage = { tag: 'later' } as never;
    shared.setStorage(storage);
    expect(shared.getStorageFor('acct-new')).toBe(storage);
  });
});

describe('claimDefaultRuntime', () => {
  /**
   * The legacy primary database is opened before anyone knows whose it is, so
   * the claim is also where its storage LEARNS its account id. Doubles here
   * carry `adoptAccountId` for that reason — without it the shared contact
   * directory files this mailbox's provenance under the file name instead of
   * the account every other mailbox is keyed by.
   */
  const claimable = (tag: string) => ({ tag, adoptAccountId: vi.fn() });

  it('moves the startup runtime under the primary account (DB reused, not re-opened)', () => {
    const storage = claimable('sarvinbox.db');
    shared.setStorage(storage as never);
    shared.setSyncEngine({ tag: 'engine' } as never);

    expect(shared.claimDefaultRuntime('acct-primary')).toBe(true);
    expect(shared.getStorageFor('acct-primary')).toBe(storage);
    expect(shared.getAllAccountIds()).toEqual(['acct-primary']);
    expect(shared.getAccountIdForStorage(storage as never)).toBe('acct-primary');
    // Regression: the claim must TELL the storage its id, not just file it.
    expect(storage.adoptAccountId).toHaveBeenCalledWith('acct-primary');
  });

  it('refuses when the default slot has no open storage (nothing to claim)', () => {
    expect(shared.claimDefaultRuntime('acct-primary')).toBe(false);
    shared.setSyncEngine({ tag: 'engine-only' } as never);
    expect(shared.claimDefaultRuntime('acct-primary')).toBe(false);
    expect(shared.getAllAccountIds()).toEqual([]);
  });

  it('can only be claimed once', () => {
    shared.setStorage(claimable('db') as never);
    expect(shared.claimDefaultRuntime('acct-a')).toBe(true);
    expect(shared.claimDefaultRuntime('acct-b')).toBe(false);
  });
});

describe('unregisterRuntime', () => {
  it('drops the runtime and resets the pointer when the ACTIVE account is removed', () => {
    shared.registerAccountRuntime('acct-a', runtime('a'));
    shared.setCurrentAccount('acct-a');

    shared.unregisterRuntime('acct-a');
    expect(shared.getAccountRuntime('acct-a')).toBeUndefined();
    expect(shared.getCurrentAccountId()).toBeNull(); // back to the default slot
    expect(shared.getStorage()).toBeNull();          // never a closed storage
  });

  it('leaves the pointer alone when a DIFFERENT account is removed', () => {
    shared.registerAccountRuntime('acct-a', runtime('a'));
    shared.registerAccountRuntime('acct-b', runtime('b'));
    shared.setCurrentAccount('acct-a');

    shared.unregisterRuntime('acct-b');
    expect(shared.getCurrentAccountId()).toBe('acct-a');
    expect(shared.getAllAccountIds()).toEqual(['acct-a']);
  });

  it('is idempotent for an unknown account', () => {
    expect(() => shared.unregisterRuntime('nope')).not.toThrow();
  });
});

describe('rekeyRuntime', () => {
  it('moves the runtime and the active pointer to the canonical id', () => {
    const a = runtime('a');
    shared.registerAccountRuntime('acct-old', a);
    shared.setCurrentAccount('acct-old');

    shared.rekeyRuntime('acct-old', 'acct-new');
    expect(shared.getAccountRuntime('acct-old')).toBeUndefined();
    expect(shared.getStorageFor('acct-new')).toBe(a.storage);
    expect(shared.getCurrentAccountId()).toBe('acct-new');
  });

  it('never clobbers an already-open runtime under the new id', () => {
    const open = runtime('already-open');
    shared.registerAccountRuntime('acct-old', runtime('old'));
    shared.registerAccountRuntime('acct-new', open);

    shared.rekeyRuntime('acct-old', 'acct-new');
    expect(shared.getStorageFor('acct-new')).toBe(open.storage);
    expect(shared.getAccountRuntime('acct-old')).toBeUndefined();
  });

  it('adopts an EMPTY slot sitting under the new id', () => {
    const a = runtime('a');
    shared.registerAccountRuntime('acct-old', a);
    shared.registerAccountRuntime('acct-new', { storage: null, syncEngine: null, smtpClient: null } as never);
    shared.rekeyRuntime('acct-old', 'acct-new');
    expect(shared.getStorageFor('acct-new')).toBe(a.storage);
  });

  it('still moves the active pointer when there is no runtime to move', () => {
    shared.setCurrentAccount('acct-old');
    shared.rekeyRuntime('acct-old', 'acct-new');
    expect(shared.getCurrentAccountId()).toBe('acct-new');
  });

  it('no-ops on empty or identical ids', () => {
    const a = runtime('a');
    shared.registerAccountRuntime('acct-old', a);
    shared.rekeyRuntime('', 'acct-new');
    shared.rekeyRuntime('acct-old', '');
    shared.rekeyRuntime('acct-old', 'acct-old');
    expect(shared.getStorageFor('acct-old')).toBe(a.storage);
  });
});

describe('process-global singletons', () => {
  it('round-trip the extension manager, AI service, quitting and suspend flags', () => {
    expect(shared.getExtensionManager()).toBeNull();
    expect(shared.getAICategorizationService()).toBeNull();
    expect(shared.getIsQuitting()).toBe(false);
    expect(shared.getSystemSuspended()).toBe(false);
    expect(shared.getMainWindow()).toBeNull();

    const manager = { tag: 'ext' } as never;
    const ai = { tag: 'ai' } as never;
    const win = makeWindow() as never;
    shared.setExtensionManager(manager);
    shared.setAICategorizationService(ai);
    shared.setIsQuitting(true);
    shared.setSystemSuspended(true);
    shared.setMainWindow(win);

    expect(shared.getExtensionManager()).toBe(manager);
    expect(shared.getAICategorizationService()).toBe(ai);
    expect(shared.getIsQuitting()).toBe(true);
    expect(shared.getSystemSuspended()).toBe(true);
    expect(shared.getMainWindow()).toBe(win);

    shared.setMainWindow(null);
    expect(shared.getMainWindow()).toBeNull();
  });
});

describe('sendToWindow', () => {
  it('dispatches to the live window and reports success', () => {
    const win = makeWindow();
    shared.setMainWindow(win as never);
    expect(shared.sendToWindow('some:channel', { a: 1 }, 'b')).toBe(true);
    expect(win.sent).toEqual([{ channel: 'some:channel', args: [{ a: 1 }, 'b'] }]);
  });

  it('refuses when there is no window', () => {
    expect(shared.sendToWindow('x')).toBe(false);
  });

  it('refuses a DESTROYED window (what `?.` alone does not catch)', () => {
    const win = makeWindow();
    shared.setMainWindow(win as never);
    win.destroyed = true;
    expect(shared.sendToWindow('x')).toBe(false);
    expect(win.sent).toEqual([]);
  });

  it('refuses a window whose webContents was destroyed', () => {
    const win = makeWindow();
    shared.setMainWindow(win as never);
    win.contentsDestroyed = true;
    expect(shared.sendToWindow('x')).toBe(false);
    expect(win.sent).toEqual([]);
  });
});
