import { beforeEach, describe, expect, it, vi } from 'vitest';

// What breaks if this file fails: which account's database an operation lands
// in. The first-email split cache is keyed by thread id, and the same thread id
// exists in every account's database (it is derived from the headers), so the
// strict resolver must never quietly hand back the ACTIVE account's storage for
// another account — that is a silent read of the wrong cache, or a write of
// account B's split into account A's database — nor CREATE a database for an id
// that is not a configured account. The lenient resolver keeps its documented
// fallback for row actions.

const h = vi.hoisted(() => ({
  current: 'acct-a' as string | null,
  storages: new Map<string, unknown>(),
  engines: new Map<string, unknown>(),
  runtimes: [] as Array<[string, { storage: unknown }]>,
  registry: ['acct-a', 'acct-b', 'acct-c'] as string[],
  registryError: null as Error | null,
  active: { name: 'active-storage' } as unknown,
  activeEngine: { name: 'active-engine' } as unknown,
  created: [] as string[],
}));

vi.mock('../../../../electron/shared', () => ({
  getCurrentAccountId: () => h.current,
  requireStorage: () => {
    if (!h.active) throw new Error('Storage not initialized');
    return h.active;
  },
  getSyncEngine: () => h.activeEngine,
  getStorageFor: (id: string) => h.storages.get(id) ?? null,
  getSyncEngineFor: (id: string) => h.engines.get(id) ?? null,
  getAllAccountRuntimes: () => h.runtimes,
}));
// As in production: ensureAccountRuntime OPENS (creates, migrates, registers)
// a database for ANY id it is handed — it has no notion of "unknown account".
vi.mock('../../../../electron/services/accounts-runtime', () => ({
  ensureAccountRuntime: vi.fn(async (id: string) => {
    h.created.push(id);
    const rt = { storage: { name: `storage-${id}` }, syncEngine: { name: `engine-${id}` } };
    h.storages.set(id, rt.storage);
    h.engines.set(id, rt.syncEngine);
    return rt;
  }),
}));
vi.mock('../../../../electron/services/accounts-registry', () => ({
  readRegistryAccounts: vi.fn(() => {
    if (h.registryError) throw h.registryError;
    return h.registry.map((id) => ({ id, email: `${id}@x.test` }));
  }),
}));

import {
  openAccountStorages,
  requireAccountStorage,
  requireNamedOrActiveStorage,
  requireTargetAccountId,
  resolveAccountTarget,
  resolveNamedOrActiveAccountTarget,
} from '../../../../electron/services/account-target';
import { readRegistryAccounts } from '../../../../electron/services/accounts-registry';
import { ensureAccountRuntime } from '../../../../electron/services/accounts-runtime';

const B = { name: 'storage-b' };

beforeEach(() => {
  h.current = 'acct-a';
  h.storages = new Map<string, unknown>([['acct-b', B]]);
  h.engines = new Map<string, unknown>([['acct-b', { name: 'engine-b' }]]);
  h.runtimes = [];
  h.registry = ['acct-a', 'acct-b', 'acct-c'];
  h.registryError = null;
  h.active = { name: 'active-storage' };
  h.created = [];
  vi.mocked(ensureAccountRuntime).mockClear();
  vi.mocked(readRegistryAccounts).mockClear();
});

describe('attachment download account identity', () => {
  // Breaks: All Inboxes scans a non-active mailbox's attachment under the active account's consent.
  it('preserves the named owner and resolves the active owner only when omitted', () => {
    expect(requireTargetAccountId('acct-b')).toBe('acct-b');
    expect(requireTargetAccountId()).toBe('acct-a');
    expect(ensureAccountRuntime).not.toHaveBeenCalled();
  });
  // Breaks: a removed, blank or unreadable mailbox silently falls back and shares another account's bytes.
  it('rejects unavailable identities and propagates unreadable registry failures', () => {
    expect(() => requireTargetAccountId('')).toThrow(/unavailable/);
    expect(() => requireTargetAccountId('acct-gone')).toThrow(/unavailable/);
    h.current = null;
    expect(() => requireTargetAccountId()).toThrow(/unavailable/);
    h.registryError = new Error('Encrypted registry is unavailable');
    expect(() => requireTargetAccountId('acct-b')).toThrow(/Encrypted registry/);
    expect(ensureAccountRuntime).not.toHaveBeenCalled();
  });
});

describe('requireAccountStorage — strict, per account', () => {
  // Breaks: the active account's own calls fail, or pay a registry read.
  it("returns the active account's storage for the active account id", async () => {
    await expect(requireAccountStorage('acct-a')).resolves.toBe(h.active);
    expect(ensureAccountRuntime).not.toHaveBeenCalled();
    expect(readRegistryAccounts).not.toHaveBeenCalled();
  });

  // Breaks: a background account's thread reads the active account's cache.
  it("returns a non-active account's OWN storage when its runtime is open", async () => {
    await expect(requireAccountStorage('acct-b')).resolves.toBe(B);
    expect(ensureAccountRuntime).not.toHaveBeenCalled();
  });

  // Breaks: an account whose runtime is not open yet (never viewed this
  // session) cannot be served at all.
  it('opens the runtime of a CONFIGURED account that is not open yet', async () => {
    await expect(requireAccountStorage('acct-c')).resolves.toEqual({ name: 'storage-acct-c' });
    expect(ensureAccountRuntime).toHaveBeenCalledWith('acct-c');
  });

  // Breaks: THE resurrection bug — a stale or removed account id (a background
  // request queued before the account was deleted) made ensureAccountRuntime
  // create a new, empty `sarvinbox-<hash>.db` plus a sync engine and a
  // registered runtime for the dead account, which then joined every
  // all-accounts loop. The id is checked against the registry FIRST.
  it('throws for an id the registry does not list, and never opens (creates) a database for it', async () => {
    await expect(requireAccountStorage('acct-gone')).rejects.toThrow(/acct-gone is not available/);
    expect(ensureAccountRuntime).not.toHaveBeenCalled();
    expect(h.created).toEqual([]);
    expect(h.storages.has('acct-gone')).toBe(false);
  });

  // Breaks: an unreadable registry read as "not registered" (or, worse, as
  // "registered") — it must be an error the caller sees, and open nothing.
  it('rethrows when the registry cannot be read, opening nothing', async () => {
    h.registryError = new Error('core DB unreadable');
    await expect(requireAccountStorage('acct-c')).rejects.toThrow(/core DB unreadable/);
    expect(ensureAccountRuntime).not.toHaveBeenCalled();
    // An already-open account needs no registry read, so it still resolves.
    await expect(requireAccountStorage('acct-b')).resolves.toBe(B);
  });

  // Breaks: THE audit finding — an unresolvable account silently reads and
  // writes the ACTIVE account's database.
  it('throws instead of falling back to the active account', async () => {
    vi.mocked(ensureAccountRuntime).mockResolvedValueOnce(null); // configured, but held for maintenance
    await expect(requireAccountStorage('acct-c')).rejects.toThrow(/acct-c is not available/);
    await expect(requireAccountStorage('')).rejects.toThrow(/account id is required/);
    await expect(requireAccountStorage(undefined as unknown as string)).rejects.toThrow(/account id is required/);
  });

  // Breaks: while still on the pre-account default slot (no active id), an
  // explicit id must still be resolved strictly, not matched to "active".
  it('resolves strictly while no account is active yet', async () => {
    h.current = null;
    await expect(requireAccountStorage('acct-b')).resolves.toBe(B);
    await expect(requireAccountStorage('acct-gone')).rejects.toThrow(/not available/);
    expect(h.created).toEqual([]);
  });
});

describe('requireNamedOrActiveStorage — strict when named, active when not', () => {
  // Breaks: the single-account path (a renderer call that names no account)
  // stops reaching the active account's database.
  it("returns the active account's storage when no id is given", async () => {
    await expect(requireNamedOrActiveStorage()).resolves.toBe(h.active);
    await expect(requireNamedOrActiveStorage(null)).resolves.toBe(h.active);
    await expect(requireNamedOrActiveStorage('')).resolves.toBe(h.active);
  });

  // Breaks: a per-account write keyed by something every mailbox shares (a
  // sender address in the image allowlist) lands in the ACTIVE account when
  // the named one cannot be resolved — the lenient resolver's fallback.
  it('resolves a named account strictly and throws rather than falling back', async () => {
    await expect(requireNamedOrActiveStorage('acct-b')).resolves.toBe(B);
    await expect(requireNamedOrActiveStorage('acct-gone')).rejects.toThrow(/acct-gone is not available/);
    expect(h.created).toEqual([]);
  });
});

describe('resolveAccountTarget — lenient, unchanged', () => {
  // Breaks: a row action on another account's message (unified view) hits the
  // active account's database — the mark-read "Email not found" loop.
  it("returns the named account's storage and engine, opening its runtime when needed", async () => {
    await expect(resolveAccountTarget('acct-b')).resolves.toEqual({ storage: B, syncEngine: { name: 'engine-b' } });
    await expect(resolveAccountTarget('acct-c')).resolves.toEqual({
      storage: { name: 'storage-acct-c' }, syncEngine: { name: 'engine-acct-c' },
    });
    expect(readRegistryAccounts).not.toHaveBeenCalled();
  });

  // Pinned as the documented contract of the LENIENT resolver (row actions),
  // which is why the cache handlers must not use it.
  it('falls back to the active account for no id, the active id, or an unresolvable one', async () => {
    const active = { storage: h.active, syncEngine: h.activeEngine };
    vi.mocked(ensureAccountRuntime).mockResolvedValueOnce(null);
    await expect(resolveAccountTarget()).resolves.toEqual(active);
    await expect(resolveAccountTarget('acct-a')).resolves.toEqual(active);
    await expect(resolveAccountTarget('acct-gone')).resolves.toEqual(active);
  });
});

describe('resolveNamedOrActiveAccountTarget — mutations use the named account', () => {
  it('uses active storage and engine for no id or the active id', async () => {
    const active = { storage: h.active, syncEngine: h.activeEngine };
    await expect(resolveNamedOrActiveAccountTarget()).resolves.toEqual(active);
    await expect(resolveNamedOrActiveAccountTarget('acct-a')).resolves.toEqual(active);
    expect(ensureAccountRuntime).not.toHaveBeenCalled();
    expect(readRegistryAccounts).not.toHaveBeenCalled();
  });

  it('returns the other account storage and engine together', async () => {
    await expect(resolveNamedOrActiveAccountTarget('acct-b')).resolves.toEqual({
      storage: B, syncEngine: { name: 'engine-b' },
    });
    expect(ensureAccountRuntime).not.toHaveBeenCalled();
  });

  it('opens only a configured account whose runtime is not open', async () => {
    await expect(resolveNamedOrActiveAccountTarget('acct-c')).resolves.toEqual({
      storage: { name: 'storage-acct-c' }, syncEngine: { name: 'engine-acct-c' },
    });
    expect(ensureAccountRuntime).toHaveBeenCalledWith('acct-c');
  });

  it('rejects a removed account without creating it or using the active account', async () => {
    await expect(resolveNamedOrActiveAccountTarget('acct-gone')).rejects.toThrow(/acct-gone is not available/);
    expect(ensureAccountRuntime).not.toHaveBeenCalled();
    expect(h.created).toEqual([]);
  });

  it('rejects an unavailable configured account instead of falling back', async () => {
    vi.mocked(ensureAccountRuntime).mockResolvedValueOnce(null);
    await expect(resolveNamedOrActiveAccountTarget('acct-c')).rejects.toThrow(/acct-c is not available/);
  });

  it('surfaces registry failures and resolves named accounts before an active account exists', async () => {
    h.current = null;
    await expect(resolveNamedOrActiveAccountTarget('acct-b')).resolves.toEqual({
      storage: B, syncEngine: { name: 'engine-b' },
    });
    h.registryError = new Error('core DB unreadable');
    await expect(resolveNamedOrActiveAccountTarget('acct-c')).rejects.toThrow(/core DB unreadable/);
    expect(ensureAccountRuntime).not.toHaveBeenCalled();
  });
});

describe('openAccountStorages — the one "every open account" enumerator', () => {
  // Breaks: category lookups and the AI-assist backfill re-queue skipping the
  // active account, or visiting one database twice (the default slot and the
  // primary's runtime share a storage).
  it('lists the active storage first, then each other open runtime once', () => {
    const C = { name: 'storage-c' };
    h.runtimes = [['acct-a', { storage: h.active }], ['acct-b', { storage: B }], ['acct-c', { storage: C }]];
    expect(openAccountStorages()).toEqual([
      { accountId: 'acct-a', storage: h.active },
      { accountId: 'acct-b', storage: B },
      { accountId: 'acct-c', storage: C },
    ]);
  });

  // Breaks: the pre-account default slot mislabelled as some account's id (a
  // backfill recorded as done for an account it never ran on).
  it('labels the default slot null, and works with no active storage at all', () => {
    h.current = null;
    h.runtimes = [['acct-b', { storage: B }]];
    expect(openAccountStorages()).toEqual([{ accountId: null, storage: h.active }, { accountId: 'acct-b', storage: B }]);

    h.active = null;
    expect(openAccountStorages()).toEqual([{ accountId: 'acct-b', storage: B }]);
  });
});
