import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The account lifecycle reaching the attachment store (CASA M-7).
 *
 * Removing an account must remove its cached attachments, and an account id
 * change must carry them along — an unsynced draft's files live ONLY there.
 * The store itself is covered by attachment-cache-store.test.ts; this pins that
 * `deleteAccountData` and `rekeyAccount` actually call it, and that a failing
 * cache step never stops the rest of the removal or the rekey.
 */

const h = vi.hoisted(() => ({
  userData: '',
  calls: [] as string[],
  attachmentsDeleteThrows: false,
  attachmentsRekeyThrows: false,
  secretsDeleteThrows: false,
  runtimes: new Map<string, unknown>(),
}));

vi.mock('electron', () => ({
  app: { getPath: () => h.userData, getName: () => 'Sarv Inbox Test', isPackaged: false },
}));
vi.mock('@sarvinbox/core', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {} }),
  SyncEngine: class {},
}));
vi.mock('@sarvinbox/storage-node', () => ({
  SHARED_CONTACTS_FILE: 'sarvinbox-shared-contacts.db',
  SQLiteStorage: class {},
}));
vi.mock('../../../../electron/services/accounts-registry', () => ({ listRegistryAccounts: () => [] }));
vi.mock('../../../../electron/services/core-db', async () => await import('../../../../electron/services/__testing__/fake-core-db'));
vi.mock('../../../../electron/services/db-key-store', () => ({ getDbEncryptionKey: () => 'deadbeef' }));
vi.mock('../../../../electron/services/folder-count-broadcast', () => ({ wireFolderCountBroadcast: () => {} }));
vi.mock('../../../../electron/services/pgp-service', () => ({ attachAutocrypt: () => {} }));
vi.mock('../../../../electron/services/reputation-service', () => ({ attachReputation: () => {} }));
vi.mock('../../../../electron/services/secure-credential-store', () => ({
  deleteAccountSecrets: async (id: string) => {
    h.calls.push(`secrets-delete:${id}`);
    if (h.secretsDeleteThrows) throw new Error('vault locked');
  },
  rekeyAccountSecrets: async (oldId: string, newId: string) => { h.calls.push(`secrets-rekey:${oldId}->${newId}`); },
}));
vi.mock('../../../../electron/services/attachment-cache', () => ({
  deleteAccountAttachments: async (id: string) => {
    h.calls.push(`attachments-delete:${id}`);
    if (h.attachmentsDeleteThrows) throw new Error('EBUSY');
  },
  rekeyAccountAttachments: async (oldId: string, newId: string) => {
    h.calls.push(`attachments-rekey:${oldId}->${newId}`);
    if (h.attachmentsRekeyThrows) throw new Error('EACCES');
  },
}));
vi.mock('../../../../electron/shared', () => ({
  claimDefaultRuntime: () => false,
  getAccountRuntime: (id: string) => h.runtimes.get(id),
  hasAccountRuntime: (id: string) => h.runtimes.has(id),
  registerAccountRuntime: (id: string, rt: unknown) => { h.runtimes.set(id, rt); },
  rekeyRuntime: (oldId: string, newId: string) => { h.calls.push(`runtime-rekey:${oldId}->${newId}`); },
  getAccountIdForStorage: () => null,
  sendToWindow: () => {},
  unregisterRuntime: (id: string) => { h.calls.push(`unregister:${id}`); h.runtimes.delete(id); },
}));

import { resetFakeCoreDb } from '../../../../electron/services/__testing__/fake-core-db';
import {
  dbFileForAccount,
  deleteAccountData,
  isAccountUnderMaintenance,
  loadPrimaryAccountId,
  rekeyAccount,
  savePrimaryAccountId,
} from '../../../../electron/services/accounts-runtime';

const TMP = mkdtempSync(join(tmpdir(), 'runtime-attachments-'));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

beforeEach(() => {
  h.userData = mkdtempSync(join(TMP, 'ud-'));
  h.calls.length = 0;
  h.attachmentsDeleteThrows = false;
  h.attachmentsRekeyThrows = false;
  h.secretsDeleteThrows = false;
  h.runtimes.clear();
  resetFakeCoreDb();
});

describe('deleteAccountData', () => {
  // Breaks (CASA M-7): a removed account's cached attachments outlive it on disk.
  it('removes the account\'s cached attachments along with its database', async () => {
    const dbFile = join(h.userData, dbFileForAccount('acct-a'));
    writeFileSync(dbFile, 'db');

    await deleteAccountData('acct-a');

    expect(h.calls).toContain('attachments-delete:acct-a');
    expect(existsSync(dbFile)).toBe(false);
  });

  // Breaks: a locked vault aborts the wipe before the attachments go, leaving
  // them behind for an account that no longer exists.
  it('still removes the attachments when the vault delete fails', async () => {
    h.secretsDeleteThrows = true;

    await deleteAccountData('acct-a');

    expect(h.calls).toEqual(expect.arrayContaining(['secrets-delete:acct-a', 'attachments-delete:acct-a']));
  });

  // Breaks: a cache folder that cannot be removed (file in use on Windows)
  // fails the account removal, or strands the id under its maintenance hold so
  // the same address can never be re-added.
  it('completes, and releases the hold, when the attachment delete fails', async () => {
    h.attachmentsDeleteThrows = true;
    const dbFile = join(h.userData, dbFileForAccount('acct-a'));
    writeFileSync(dbFile, 'db');

    await expect(deleteAccountData('acct-a')).resolves.toBeUndefined();

    expect(existsSync(dbFile)).toBe(false);
    expect(isAccountUnderMaintenance('acct-a')).toBe(false);
  });

  // Breaks: an empty id (a renderer bug) still hashes to a folder name, and the
  // removal deletes whatever lives there instead of being refused.
  it('touches no attachments for an empty id', async () => {
    await deleteAccountData('');

    expect(h.calls.some((call) => call.startsWith('attachments-'))).toBe(false);
  });
});

describe('rekeyAccount', () => {
  // Breaks (data loss): an id change strands the cache under the old id — an
  // unsynced draft then opens without its attachments, and the next orphan
  // sweep deletes them.
  it('moves the cached attachments to the new id', async () => {
    savePrimaryAccountId('old');

    await rekeyAccount('old', 'new');

    expect(h.calls).toContain('attachments-rekey:old->new');
    expect(h.calls).toContain('secrets-rekey:old->new');
    expect(loadPrimaryAccountId()).toBe('new');
  });

  // Breaks: the cache follows only when the DB file is renamed; an account that
  // is OPEN during the rekey (its DB keeps its name) loses its attachments.
  it('moves them even while the account is open', async () => {
    h.runtimes.set('old', { storage: {}, syncEngine: {} });

    await rekeyAccount('old', 'new');

    expect(h.calls).toContain('attachments-rekey:old->new');
  });

  // Breaks: a failing cache move (permissions, a locked file) aborts the rekey
  // half-way — the vault, primary pointer and runtime stay under the old id
  // while the registry moves on, and the account stops resolving.
  it('finishes the rekey when moving the attachments fails', async () => {
    h.attachmentsRekeyThrows = true;
    savePrimaryAccountId('old');

    await expect(rekeyAccount('old', 'new')).resolves.toBeUndefined();

    expect(h.calls).toEqual(expect.arrayContaining(['secrets-rekey:old->new', 'runtime-rekey:old->new']));
    expect(loadPrimaryAccountId()).toBe('new');
  });

  // Breaks: a no-op rekey (same id, or a missing id) moves or merges a folder.
  it('touches no attachments on empty or identical ids', async () => {
    await rekeyAccount('', 'new');
    await rekeyAccount('old', '');
    await rekeyAccount('same', 'same');

    expect(h.calls.some((call) => call.startsWith('attachments-'))).toBe(false);
  });
});
