import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { accountIdFor } from '@sarvinbox/core';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The durable accounts registry. Pinned invariants:
 *   - SECRETS never cross into the registry (passwords / OAuth tokens are
 *     stripped from every config before a write),
 *   - a snapshot mirror NEVER deletes rows it omits (the localStorage-wipe bug),
 *   - seeding only fills MISSING accounts and never overwrites an existing one,
 *   - identity resolution prefers the owning account and returns an EMPTY
 *     identity rather than guessing,
 *   - legacy-file cleanup is gated on the data being provably migrated.
 */

// Mutable mock state. `userData` is filled in beforeAll — the electron mock's
// getPath() is only called at runtime, so it does not need a value at hoist time.
const h = vi.hoisted(() => ({
  userData: '',
  oauthAccounts: [] as Array<{ provider: string; email: string; displayName?: string }>,
  oauthThrows: false,
  imapAccount: null as Record<string, unknown> | null,
  imapThrows: false,
  primaryId: null as string | null,
  storageIds: new Map<unknown, string | null>(),
}));

vi.mock('electron', () => ({
  app: { getPath: () => h.userData, getName: () => 'Sarv Inbox Test', isPackaged: false },
}));

vi.mock('../../../../electron/services/core-db', async () => await import('../../../../electron/services/__testing__/fake-core-db'));

vi.mock('../../../../electron/services/oauth-token-store', () => ({
  loadAccounts: async () => {
    if (h.oauthThrows) throw new Error('token store locked');
    return h.oauthAccounts;
  },
}));

vi.mock('../../../../electron/services/imap-account-store', () => ({
  loadImapAccount: async () => {
    if (h.imapThrows) throw new Error('keychain locked');
    return h.imapAccount;
  },
}));

vi.mock('../../../../electron/services/accounts-runtime', () => ({
  loadPrimaryAccountId: () => h.primaryId,
}));

vi.mock('../../../../electron/shared', () => ({
  getAccountIdForStorage: (storage: unknown) => h.storageIds.get(storage) ?? null,
}));

vi.mock('@sarvinbox/core', async () => {
  const actual = await vi.importActual<typeof import('@sarvinbox/core')>('@sarvinbox/core');
  return {
    ...actual,
    createLogger: () => ({
      info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {},
    }),
  };
});


import { resetFakeCoreDb, state as dbState } from '../../../../electron/services/__testing__/fake-core-db';
import {
  accountRegistryExists,
  cleanupMigratedLegacyFiles,
  getRegistryActiveAccountId,
  listRegistryAccounts,
  readRegistryAccounts,
  removeRegistryAccount,
  resolveAccountEmail,
  resolveAccountIdentity,
  seedAccountRegistryFromDurableStores,
  setRegistryActiveAccountId,
  upsertRegistryAccount,
  upsertRegistryAccounts,
  type RegistryAccount,
} from '../../../../electron/services/accounts-registry';

const account = (over: Partial<RegistryAccount> = {}): RegistryAccount => ({
  id: 'acct-a',
  email: 'a@example.com',
  imapConfig: { host: 'imap.example.com', username: 'a@example.com' },
  smtpConfig: null,
  smtpConfigured: false,
  ...over,
});

beforeAll(() => {
  h.userData = mkdtempSync(join(tmpdir(), 'sarvinbox-registry-'));
});

beforeEach(() => {
  resetFakeCoreDb();
  h.oauthAccounts = [];
  h.oauthThrows = false;
  h.imapAccount = null;
  h.imapThrows = false;
  h.primaryId = null;
  h.storageIds.clear();
  rmSync(h.userData, { recursive: true, force: true });
  mkdirSync(h.userData, { recursive: true });
});

afterAll(() => {
  rmSync(h.userData, { recursive: true, force: true });
});

describe('upsertRegistryAccount', () => {
  it('strips every secret field from BOTH configs before writing', () => {
    upsertRegistryAccount(
      account({
        imapConfig: {
          host: 'imap.example.com', username: 'a@example.com',
          password: 'imap-secret', accessToken: 'at', refreshToken: 'rt',
        },
        smtpConfig: { host: 'smtp.example.com', password: 'smtp-secret', accessToken: 'at2' },
        smtpConfigured: true,
      }),
    );
    const [stored] = listRegistryAccounts();
    expect(stored.imapConfig).toEqual({ host: 'imap.example.com', username: 'a@example.com' });
    expect(stored.smtpConfig).toEqual({ host: 'smtp.example.com' });
    // ...and nothing secret survived anywhere in the serialized row.
    const raw = JSON.stringify([...dbState.rows.values()]);
    expect(raw).not.toContain('imap-secret');
    expect(raw).not.toContain('smtp-secret');
    expect(raw).not.toContain('refreshToken');
  });

  it('denormalizes authMethod / oauthProvider out of the imap config', () => {
    upsertRegistryAccount(
      account({ imapConfig: { host: 'imap.gmail.com', authMethod: 'oauth2', oauthProvider: 'gmail' } }),
    );
    const row = dbState.rows.get('acct-a')!;
    expect(row.auth_method).toBe('oauth2');
    expect(row.oauth_provider).toBe('gmail');
  });

  it('ignores an account with no id or no email', () => {
    upsertRegistryAccount(account({ id: '' }));
    upsertRegistryAccount(account({ email: '' }));
    upsertRegistryAccount(undefined as unknown as RegistryAccount);
    expect(listRegistryAccounts()).toHaveLength(0);
  });

  it('defaults the tri-state flags to ON and only stores 0 for an explicit false', () => {
    upsertRegistryAccount(account({ id: 'defaults' }));
    upsertRegistryAccount(
      account({ id: 'explicit', includeInUnified: false, backgroundSync: false, notify: false }),
    );
    expect(dbState.rows.get('defaults')).toMatchObject({
      include_in_unified: 1, background_sync: 1, notify: 1,
    });
    expect(dbState.rows.get('explicit')).toMatchObject({
      include_in_unified: 0, background_sync: 0, notify: 0,
    });
  });

  it('updating an existing id overwrites its fields in place (no duplicate row)', () => {
    upsertRegistryAccount(account({ name: 'First' }));
    upsertRegistryAccount(account({ name: 'Second', color: '#fff' }));
    const rows = listRegistryAccounts();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: 'Second', color: '#fff' });
  });
});

describe('listRegistryAccounts', () => {
  it('maps rows back to the renderer shape (JSON configs, tri-state flags, ordering)', () => {
    upsertRegistryAccount(account({ id: 'first', email: 'first@x.com', name: 'First' }));
    upsertRegistryAccount(account({ id: 'second', email: 'second@x.com', notify: false }));
    const [first, second] = listRegistryAccounts();
    expect(first).toEqual({
      id: 'first',
      email: 'first@x.com',
      name: 'First',
      imapConfig: { host: 'imap.example.com', username: 'a@example.com' },
      smtpConfig: null,
      smtpConfigured: false,
      color: undefined,
      includeInUnified: true,
      backgroundSync: true,
      notify: true,
    });
    expect(second.notify).toBe(false);
  });

  it('surfaces undefined (not null) for absent optional columns', () => {
    dbState.rows.set('sparse', {
      id: 'sparse', email: 's@x.com', name: null, imap_config: null, smtp_config: null,
      smtp_configured: 0, auth_method: null, oauth_provider: null, color: null,
      include_in_unified: null, background_sync: null, notify: null,
      created_at: 1, updated_at: 1,
    });
    expect(listRegistryAccounts()[0]).toMatchObject({
      name: undefined, color: undefined,
      includeInUnified: undefined, backgroundSync: undefined, notify: undefined,
    });
  });

  it('tolerates a corrupt JSON config (null instead of a throw)', () => {
    dbState.rows.set('bad', {
      id: 'bad', email: 'b@x.com', name: null, imap_config: '{not json', smtp_config: null,
      smtp_configured: 1, auth_method: null, oauth_provider: null, color: null,
      include_in_unified: 1, background_sync: 1, notify: 1, created_at: 1, updated_at: 1,
    });
    const [row] = listRegistryAccounts();
    expect(row.imapConfig).toBeNull();
    expect(row.smtpConfigured).toBe(true);
  });

  it('returns [] when the query itself fails', () => {
    dbState.fail.add('select');
    expect(listRegistryAccounts()).toEqual([]);
  });

  // The distinction that cost two live mailbox DBs: a failed read and an empty
  // registry are the same VALUE but opposite FACTS. Anything that deletes files
  // must call the throwing read, so "I could not find out" can never be acted on
  // as "there are no accounts". If this ever stops throwing, the startup sweep
  // silently regains permission to delete every mailbox on the machine.
  it('readRegistryAccounts THROWS on a failed read instead of answering "empty"', () => {
    upsertRegistryAccount(account({ id: 'live', email: 'live@x.com' }));
    dbState.fail.add('select');
    expect(() => readRegistryAccounts()).toThrow();
    dbState.fail.delete('select');
    expect(readRegistryAccounts().map((a) => a.id)).toEqual(['live']);
  });
});

describe('upsertRegistryAccounts (snapshot mirror)', () => {
  it('NEVER deletes rows the snapshot omits', () => {
    upsertRegistryAccount(account({ id: 'kept', email: 'kept@x.com' }));
    upsertRegistryAccounts([account({ id: 'new', email: 'new@x.com' })]);
    expect(listRegistryAccounts().map((a) => a.id)).toEqual(['kept', 'new']);
  });

  it('ignores an empty / non-array snapshot (a transiently-empty renderer)', () => {
    upsertRegistryAccount(account({ id: 'kept' }));
    upsertRegistryAccounts([]);
    upsertRegistryAccounts(null as unknown as RegistryAccount[]);
    expect(listRegistryAccounts()).toHaveLength(1);
  });

  it('swallows a failed transaction instead of throwing at the IPC boundary', () => {
    dbState.fail.add('transaction');
    expect(() => upsertRegistryAccounts([account()])).not.toThrow();
    expect(listRegistryAccounts()).toHaveLength(0);
  });
});

describe('removeRegistryAccount', () => {
  it('removes the row and clears the active pointer when it pointed at it', () => {
    upsertRegistryAccount(account());
    setRegistryActiveAccountId('acct-a');
    removeRegistryAccount('acct-a');
    expect(listRegistryAccounts()).toHaveLength(0);
    expect(getRegistryActiveAccountId()).toBeNull();
  });

  it('leaves an active pointer to a DIFFERENT account alone', () => {
    upsertRegistryAccount(account({ id: 'a' }));
    upsertRegistryAccount(account({ id: 'b', email: 'b@x.com' }));
    setRegistryActiveAccountId('b');
    removeRegistryAccount('a');
    expect(getRegistryActiveAccountId()).toBe('b');
  });

  it('is idempotent and no-ops on an empty id', () => {
    removeRegistryAccount('');
    expect(() => removeRegistryAccount('never-existed')).not.toThrow();
  });

  it('swallows a delete failure', () => {
    upsertRegistryAccount(account());
    dbState.fail.add('delete');
    expect(() => removeRegistryAccount('acct-a')).not.toThrow();
    expect(listRegistryAccounts()).toHaveLength(1);
  });
});

describe('the active-account pointer', () => {
  it('round-trips and can be cleared with null', () => {
    expect(getRegistryActiveAccountId()).toBeNull();
    setRegistryActiveAccountId('acct-a');
    expect(getRegistryActiveAccountId()).toBe('acct-a');
    setRegistryActiveAccountId(null);
    expect(getRegistryActiveAccountId()).toBeNull();
  });
});

describe('resolveAccountIdentity', () => {
  it('prefers the account that OWNS this storage', () => {
    upsertRegistryAccount(account({ id: 'acct-a', email: 'a@Example.com', name: 'A' }));
    upsertRegistryAccount(account({ id: 'acct-b', email: 'b@Example.com', name: 'B' }));
    const storage = { tag: 'b-db' };
    h.storageIds.set(storage, 'acct-b');
    expect(resolveAccountIdentity(storage)).toEqual({
      email: 'b@Example.com',
      name: 'B',
      aliases: ['a@example.com', 'b@example.com'],
    });
  });

  it('falls back to the ACTIVE account when the storage maps to nothing', () => {
    upsertRegistryAccount(account({ id: 'acct-a', email: 'a@x.com' }));
    upsertRegistryAccount(account({ id: 'acct-b', email: 'b@x.com', name: 'B' }));
    setRegistryActiveAccountId('acct-b');
    expect(resolveAccountIdentity({}).email).toBe('b@x.com');
  });

  it('falls back to the SOLE account on a single-account install', () => {
    upsertRegistryAccount(account({ email: 'only@x.com' }));
    expect(resolveAccountIdentity().email).toBe('only@x.com');
    expect(resolveAccountEmail()).toBe('only@x.com');
  });

  it('falls back to the SOLE account when the active pointer is stale', () => {
    upsertRegistryAccount(account({ id: 'acct-a', email: 'only@x.com' }));
    setRegistryActiveAccountId('acct-gone');
    expect(resolveAccountIdentity().email).toBe('only@x.com');
  });

  it('defaults aliases to the account address when it is the only row', () => {
    dbState.rows.set('noemail', {
      id: 'noemail', email: '', name: null, imap_config: null, smtp_config: null,
      smtp_configured: 0, auth_method: null, oauth_provider: null, color: null,
      include_in_unified: 1, background_sync: 1, notify: 1, created_at: 1, updated_at: 1,
    });
    dbState.rows.set('acct-a', {
      id: 'acct-a', email: 'Solo@X.com', name: null, imap_config: null, smtp_config: null,
      smtp_configured: 0, auth_method: null, oauth_provider: null, color: null,
      include_in_unified: 1, background_sync: 1, notify: 1, created_at: 2, updated_at: 2,
    });
    setRegistryActiveAccountId('acct-a');
    // The blank-email row is filtered out of the alias list, leaving only the
    // resolved account's own (lowercased) address.
    expect(resolveAccountIdentity()).toEqual({
      email: 'Solo@X.com', name: '', aliases: ['solo@x.com'],
    });
  });

  it('falls back to the legacy per-DB accounts table when the registry is empty', () => {
    const storage = {
      db: {
        prepare: () => ({
          all: () => [
            { email: 'Legacy@X.com', name: 'Legacy' },
            { email: 'Alias@X.com' },
          ],
        }),
      },
    };
    expect(resolveAccountIdentity(storage)).toEqual({
      email: 'Legacy@X.com',
      name: 'Legacy',
      aliases: ['legacy@x.com', 'alias@x.com'],
    });
  });

  it('returns an EMPTY identity rather than guessing (no registry, no legacy rows)', () => {
    expect(resolveAccountIdentity()).toEqual({ email: '', name: '', aliases: [] });
    expect(resolveAccountIdentity({ db: { prepare: () => ({ all: () => [] }) } })).toEqual({
      email: '', name: '', aliases: [],
    });
    expect(resolveAccountIdentity({ db: { prepare: () => { throw new Error('no such table'); } } }))
      .toEqual({ email: '', name: '', aliases: [] });
  });

  it('a legacy row with a blank email still yields an empty-string email', () => {
    const storage = { db: { prepare: () => ({ all: () => [{ name: 'No Address' }] }) } };
    expect(resolveAccountIdentity(storage)).toEqual({
      email: '', name: 'No Address', aliases: [],
    });
  });
});

describe('seedAccountRegistryFromDurableStores', () => {
  it('seeds from the last-good IMAP config with a DETERMINISTIC id and no secrets', async () => {
    h.imapAccount = {
      host: 'imap.example.com', port: 993, username: 'User@Example.com',
      password: 'top-secret', refreshToken: 'rt',
    };
    await seedAccountRegistryFromDurableStores();
    const [seeded] = listRegistryAccounts();
    expect(seeded.id).toBe(accountIdFor('User@Example.com', 'imap.example.com'));
    expect(seeded.id).toBe('acct-user-example-com--imap-example-com');
    expect(seeded.email).toBe('User@Example.com');
    expect(seeded.imapConfig).toEqual({
      host: 'imap.example.com', port: 993, username: 'User@Example.com',
    });
  });

  it('the seeded id is case-insensitive in the email and host-scoped', () => {
    expect(accountIdFor('user@example.com', 'imap.example.com'))
      .toBe(accountIdFor('USER@Example.COM', 'IMAP.example.com'));
    expect(accountIdFor('user@example.com', 'imap.gmail.com'))
      .not.toBe(accountIdFor('user@example.com', 'imap.example.com'));
    expect(accountIdFor('user@example.com')).toBe('acct-user-example-com');
  });

  it('skips an incomplete IMAP config (no host or no username)', async () => {
    h.imapAccount = { host: 'imap.example.com' };
    await seedAccountRegistryFromDurableStores();
    h.imapAccount = { username: 'a@example.com' };
    await seedAccountRegistryFromDurableStores();
    h.imapAccount = null;
    await seedAccountRegistryFromDurableStores();
    expect(listRegistryAccounts()).toHaveLength(0);
  });

  it('NEVER overwrites an account the renderer already mirrored', async () => {
    const id = accountIdFor('a@example.com', 'imap.example.com');
    upsertRegistryAccount(account({ id, email: 'a@example.com', name: 'Renderer Name', color: '#abc' }));
    h.imapAccount = { host: 'imap.example.com', username: 'a@example.com', password: 'p' };
    await seedAccountRegistryFromDurableStores();
    const rows = listRegistryAccounts();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: 'Renderer Name', color: '#abc' });
  });

  it('seeds OAuth accounts from the provider preset, skipping non-mailbox providers', async () => {
    h.oauthAccounts = [
      { provider: 'gmail', email: 'g@gmail.com', displayName: 'G' },
      { provider: 'sarv', email: 's@sarv.com' },
    ];
    await seedAccountRegistryFromDurableStores();
    const rows = listRegistryAccounts();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      email: 'g@gmail.com',
      name: 'G',
      smtpConfigured: false,
      imapConfig: {
        host: 'imap.gmail.com', username: 'g@gmail.com',
        authMethod: 'oauth2', oauthProvider: 'gmail',
      },
    });
  });

  it('does not re-seed an OAuth account already present (idempotent across runs)', async () => {
    h.oauthAccounts = [{ provider: 'gmail', email: 'g@gmail.com', displayName: 'First' }];
    await seedAccountRegistryFromDurableStores();
    h.oauthAccounts = [{ provider: 'gmail', email: 'g@gmail.com', displayName: 'Changed' }];
    await seedAccountRegistryFromDurableStores();
    const rows = listRegistryAccounts();
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('First');
  });

  it('a failing source is skipped, not fatal — the other source still seeds', async () => {
    h.imapThrows = true;
    h.oauthAccounts = [{ provider: 'gmail', email: 'g@gmail.com' }];
    await seedAccountRegistryFromDurableStores();
    expect(listRegistryAccounts()).toHaveLength(1);

    resetFakeCoreDb();
    h.imapThrows = false;
    h.imapAccount = { host: 'imap.example.com', username: 'a@example.com' };
    h.oauthThrows = true;
    await seedAccountRegistryFromDurableStores();
    expect(listRegistryAccounts()).toHaveLength(1);
  });

  it('adopts the primary pointer as active ONLY when that account was seeded', async () => {
    h.imapAccount = { host: 'imap.example.com', username: 'a@example.com' };
    h.primaryId = accountIdFor('a@example.com', 'imap.example.com');
    await seedAccountRegistryFromDurableStores();
    expect(getRegistryActiveAccountId()).toBe(h.primaryId);

    resetFakeCoreDb();
    h.primaryId = 'acct-not-seeded';
    await seedAccountRegistryFromDurableStores();
    expect(getRegistryActiveAccountId()).toBeNull();
  });

  it('never clobbers an existing active pointer', async () => {
    setRegistryActiveAccountId('acct-chosen');
    h.imapAccount = { host: 'imap.example.com', username: 'a@example.com' };
    h.primaryId = accountIdFor('a@example.com', 'imap.example.com');
    await seedAccountRegistryFromDurableStores();
    expect(getRegistryActiveAccountId()).toBe('acct-chosen');
  });

  it('swallows a total failure (the registry query itself blowing up)', async () => {
    dbState.fail.add('select');
    await expect(seedAccountRegistryFromDurableStores()).resolves.toBeUndefined();
  });
});

describe('accountRegistryExists', () => {
  it('tracks whether the core DB is on disk', () => {
    expect(accountRegistryExists()).toBe(true);
    dbState.exists = false;
    expect(accountRegistryExists()).toBe(false);
  });
});

describe('cleanupMigratedLegacyFiles', () => {
  const touch = (name: string): string => {
    const p = join(h.userData, name);
    writeFileSync(p, 'x');
    return p;
  };

  it('removes a legacy file (and its siblings) only once its data is migrated', () => {
    touch('oauth-accounts.json');
    touch('oauth-accounts.json.premigrated');
    touch('oauth-accounts.json.bak');
    touch('oauth-accounts.json.tmp');
    dbState.exists = false; // isolate from the accounts-registry.db sweep

    // Not migrated yet -> nothing is touched.
    expect(cleanupMigratedLegacyFiles()).toEqual([]);
    expect(existsSync(join(h.userData, 'oauth-accounts.json'))).toBe(true);

    dbState.blobs.set('oauth-accounts', Buffer.from('envelope'));
    expect(cleanupMigratedLegacyFiles().sort()).toEqual([
      'oauth-accounts.json',
      'oauth-accounts.json.bak',
      'oauth-accounts.json.premigrated',
      'oauth-accounts.json.tmp',
    ]);
    expect(existsSync(join(h.userData, 'oauth-accounts.json'))).toBe(false);
  });

  it('gates META-keyed files on the meta value, not a blob', () => {
    touch('primary-account.json');
    dbState.exists = false;
    expect(cleanupMigratedLegacyFiles()).toEqual([]);
    dbState.meta.set('primary_account_id', 'acct-a');
    expect(cleanupMigratedLegacyFiles()).toEqual(['primary-account.json']);
  });

  it('is idempotent and best-effort when a path cannot be unlinked', () => {
    // A DIRECTORY where a file is expected: unlinkSync throws → warned + skipped.
    mkdirSync(join(h.userData, 'ai-secrets.json'));
    dbState.blobs.set('ai-secrets', Buffer.from('x'));
    dbState.exists = false;
    expect(cleanupMigratedLegacyFiles()).toEqual([]);
    expect(existsSync(join(h.userData, 'ai-secrets.json'))).toBe(true);
    // Second run behaves identically (no throw, nothing removed).
    expect(cleanupMigratedLegacyFiles()).toEqual([]);
  });

  it('removes the dead standalone accounts-registry.db + sidecars once the core DB exists', () => {
    for (const suffix of ['', '-shm', '-wal', '-journal']) touch(`accounts-registry.db${suffix}`);
    dbState.exists = false;
    expect(cleanupMigratedLegacyFiles()).toEqual([]);

    dbState.exists = true;
    expect(cleanupMigratedLegacyFiles().sort()).toEqual([
      'accounts-registry.db',
      'accounts-registry.db-journal',
      'accounts-registry.db-shm',
      'accounts-registry.db-wal',
    ]);
  });

  it('tolerates an unremovable accounts-registry.db', () => {
    mkdirSync(join(h.userData, 'accounts-registry.db'));
    dbState.exists = true;
    expect(cleanupMigratedLegacyFiles()).toEqual([]);
    expect(existsSync(join(h.userData, 'accounts-registry.db'))).toBe(true);
  });
});

describe('module surface', () => {
  it('re-exports the core-DB settings/migration helpers so callers have one import site', async () => {
    const mod = await import('../../../../electron/services/accounts-registry');
    for (const name of [
      'getAllAppSettings', 'setAppSetting', 'deleteAppSetting',
      'isMigrationDone', 'markMigrationDone',
    ]) {
      expect(typeof (mod as unknown as Record<string, unknown>)[name]).toBe('function');
    }
  });
});
