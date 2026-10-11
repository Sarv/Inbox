import { existsSync, mkdirSync, mkdtempSync, promises, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { safeFilename } from '@sarvinbox/core';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Retiring the PLAINTEXT attachment cache older builds kept at
 * `userData/attachment-cache/<emailId>/<name>` (CASA M-7).
 *
 * That cache names no account, and for an unsynced draft it holds the ONLY copy
 * of the draft's attachments. So the migration has two ways to fail quietly:
 * leave plaintext mail on disk forever (the finding itself), or delete a draft's
 * attachments because it could not tell whose they were (data loss). Every test
 * here pins one side of that line: plaintext goes only once it is either sealed
 * into the right account's store or provably nobody's.
 *
 * Real filesystem and the real sealed store under a temp userData; the account
 * list and the per-account databases are injected fakes.
 */

const h = vi.hoisted(() => ({
  userData: '',
  keyThrows: false,
  /** Registry as the default (non-injected) account list reads it. */
  registry: [] as Array<{ id: string }>,
  registryThrows: false,
  ensureRuntime: null as null | ((accountId: string) => Promise<unknown>),
  /** Make storeCachedAttachment fail for matching calls (disk full, I/O error). */
  storeFails: null as null | ((accountId: string, emailId: string, filename: string) => boolean),
}));

vi.mock('electron', () => ({ app: { getPath: () => h.userData } }));
vi.mock('../../../../electron/services/db-key-store', () => ({
  getDbEncryptionKey: () => {
    if (h.keyThrows) throw new Error('key store locked');
    return 'k'.repeat(64);
  },
}));
vi.mock('../../../../electron/services/account-target', () => ({ resolveAccountTarget: vi.fn() }));
vi.mock('../../../../electron/services/accounts-registry', () => ({
  readRegistryAccounts: () => {
    if (h.registryThrows) throw new Error('addon failed to load');
    return [...h.registry];
  },
}));
vi.mock('../../../../electron/services/accounts-runtime', () => ({
  ensureAccountRuntime: (accountId: string) => h.ensureRuntime!(accountId),
}));
// The real store, with a seam to make one seal fail.
vi.mock('../../../../electron/services/attachment-cache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../electron/services/attachment-cache')>();
  return {
    ...actual,
    storeCachedAttachment: (accountId: string, emailId: string, filename: string, content: Buffer) =>
      h.storeFails?.(accountId, emailId, filename)
        ? Promise.reject(new Error('disk full'))
        : actual.storeCachedAttachment(accountId, emailId, filename, content),
  };
});
vi.mock('@sarvinbox/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@sarvinbox/core')>()),
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

import {
  accountAttachmentDir,
  getOrCacheAttachment,
  legacyAttachmentCacheRoot,
  legacyAttachmentDir,
  readCachedAttachment,
  resetAttachmentStoreKeys,
} from '../../../../electron/services/attachment-cache';
import { migrateLegacyAttachmentCache } from '../../../../electron/services/attachment-cache-legacy';

const TMP = mkdtempSync(join(tmpdir(), 'attachment-legacy-'));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

interface Row { id: string; uid?: number | null; attachmentNames?: string | null }

/** One account's database, as the migration sees it. */
const account = (rows: Row[]) => ({
  storage: { getEmail: vi.fn(async (id: string) => rows.find((row) => row.id === id) ?? null) },
});

/** An older build's plaintext cache entry. */
const writeLegacy = (emailId: string, name: string, text: string) => {
  mkdirSync(legacyAttachmentDir(emailId), { recursive: true });
  writeFileSync(join(legacyAttachmentDir(emailId), safeFilename(name)), text);
};
const legacyExists = (emailId: string) => existsSync(legacyAttachmentDir(emailId));

/** An entry read back the way the draft reads it (uid 0: cache hit, or legacy adoption, or 404). */
const readEntry = async (accountId: string, emailId: string, filename: string) =>
  (await readCachedAttachment(await getOrCacheAttachment(accountId, emailId, 'INBOX', 0, filename, null))).toString('utf8');

/** How many sealed files an account's store holds — checks without triggering adoption. */
function storeFileCount(accountId: string): number {
  const walk = (dir: string): number =>
    !existsSync(dir)
      ? 0
      : readdirSync(dir).reduce((n, name) => {
        const full = join(dir, name);
        return n + (statSync(full).isDirectory() ? walk(full) : 1);
      }, 0);
  return walk(accountAttachmentDir(accountId));
}

beforeEach(() => {
  h.userData = mkdtempSync(join(TMP, 'ud-'));
  h.keyThrows = false;
  h.registry = [];
  h.registryThrows = false;
  h.ensureRuntime = null;
  h.storeFails = null;
  resetAttachmentStoreKeys();
});

describe('nothing to migrate', () => {
  // Breaks: every launch after the migration opens every account's database
  // (it runs at startup until the folder is gone) — or a fresh install errors.
  it('returns "none" and opens nothing when there is no legacy folder', async () => {
    const accountIds = vi.fn(() => ['acct-a']);
    const openAccount = vi.fn(async () => account([]));

    await expect(migrateLegacyAttachmentCache({ accountIds, openAccount })).resolves.toBe('none');

    expect(accountIds).not.toHaveBeenCalled();
    expect(openAccount).not.toHaveBeenCalled();
  });

  // Breaks: the idempotent re-run on the next launch does the work again (or
  // fails) instead of finding nothing left.
  it('returns "none" on the run after a completed migration', async () => {
    writeLegacy('mail-1', 'a.pdf', 'plaintext');
    const deps = { accountIds: () => ['acct-a'], openAccount: async () => account([{ id: 'mail-1', uid: 7 }]) };

    await expect(migrateLegacyAttachmentCache(deps)).resolves.toBe('done');
    await expect(migrateLegacyAttachmentCache(deps)).resolves.toBe('none');
  });
});

describe('mail matched to an account', () => {
  // Breaks (CASA M-7): plaintext attachments of ordinary mail stay readable on
  // disk after the upgrade. Mail with a UID is re-fetchable, so it is not kept.
  it('deletes the plaintext of mail that has a UID without sealing it', async () => {
    writeLegacy('mail-1', 'invoice.pdf', 'plaintext invoice');

    const result = await migrateLegacyAttachmentCache({
      accountIds: () => ['acct-a'],
      openAccount: async () => account([{ id: 'mail-1', uid: 42, attachmentNames: '["invoice.pdf"]' }]),
    });

    expect(result).toBe('done');
    expect(legacyExists('mail-1')).toBe(false);
    expect(storeFileCount('acct-a')).toBe(0);
  });

  // Breaks (data loss): a draft saved offline by an older build loses its
  // attachments — their only copy is the plaintext cache — or keeps them in
  // plaintext. uid 0 and uid null both mean "never reached the server".
  it('seals an unsynced draft\'s declared files into its account\'s store and removes the plaintext', async () => {
    writeLegacy('draft-0', 'plan.pdf', 'plan bytes');
    writeLegacy('draft-0', 'evil.exe', 'not declared');
    writeLegacy('draft-null', 'notes.txt', 'note bytes');

    const result = await migrateLegacyAttachmentCache({
      accountIds: () => ['acct-a'],
      openAccount: async () => account([
        // JSON and the older comma-separated column, plus a declared name that
        // was never cached (skipped, not a failure).
        { id: 'draft-0', uid: 0, attachmentNames: '["plan.pdf","never-cached.pdf"]' },
        { id: 'draft-null', uid: null, attachmentNames: 'notes.txt' },
      ]),
    });

    expect(result).toBe('done');
    expect(legacyExists('draft-0')).toBe(false);
    expect(legacyExists('draft-null')).toBe(false);
    expect(await readEntry('acct-a', 'draft-0', 'plan.pdf')).toBe('plan bytes');
    expect(await readEntry('acct-a', 'draft-null', 'notes.txt')).toBe('note bytes');
    // The undeclared file was not carried over: only declared names are sealed.
    expect(storeFileCount('acct-a')).toBe(2);
    await expect(getOrCacheAttachment('acct-a', 'draft-0', 'INBOX', 0, 'evil.exe', null))
      .rejects.toMatchObject({ status: 404 });
  });

  // Breaks (security): a hostile declared name pulls a file from outside the
  // draft's folder (the DB key next door) into the store.
  it('never reads outside the draft\'s folder for a traversal name', async () => {
    writeFileSync(join(h.userData, 'db-key.bin'), 'SECRET');
    writeLegacy('draft-1', 'real.txt', 'real');

    await migrateLegacyAttachmentCache({
      accountIds: () => ['acct-a'],
      openAccount: async () => account([{ id: 'draft-1', uid: 0, attachmentNames: '["../../db-key.bin"]' }]),
    });

    expect(storeFileCount('acct-a')).toBe(0);
    expect(existsSync(join(h.userData, 'db-key.bin'))).toBe(true);
  });

  // Breaks (multi-account): a draft's files are sealed into ANOTHER account's
  // store — that account cannot see them, and the owner opens a draft without
  // its attachments.
  it('places each folder in the store of the account whose database has the email', async () => {
    writeLegacy('draft-a', 'a.pdf', 'from A');
    writeLegacy('draft-b', 'b.pdf', 'from B');
    writeLegacy('mail-b', 'm.pdf', 'synced');
    const a = account([{ id: 'draft-a', uid: 0, attachmentNames: '["a.pdf"]' }]);
    const b = account([
      { id: 'draft-b', uid: null, attachmentNames: '["b.pdf"]' },
      { id: 'mail-b', uid: 9, attachmentNames: '["m.pdf"]' },
    ]);

    const result = await migrateLegacyAttachmentCache({
      accountIds: () => ['acct-a', 'acct-b'],
      openAccount: async (id) => (id === 'acct-a' ? a : b),
    });

    expect(result).toBe('done');
    expect(await readEntry('acct-a', 'draft-a', 'a.pdf')).toBe('from A');
    expect(await readEntry('acct-b', 'draft-b', 'b.pdf')).toBe('from B');
    expect(storeFileCount('acct-a')).toBe(1);
    expect(storeFileCount('acct-b')).toBe(1);
    await expect(getOrCacheAttachment('acct-a', 'draft-b', 'INBOX', 0, 'b.pdf', null)).rejects.toMatchObject({ status: 404 });
    await expect(getOrCacheAttachment('acct-b', 'draft-a', 'INBOX', 0, 'a.pdf', null)).rejects.toMatchObject({ status: 404 });
    // A folder claimed by one account is not offered to the next.
    expect(b.storage.getEmail).not.toHaveBeenCalledWith('draft-a');
  });
});

describe('what may only go once every account was checked', () => {
  // Breaks (data loss): an account that could not be opened (locked key store,
  // primary not claimed yet) may own a draft in here; deleting "unclaimed"
  // folders then deletes that draft's only copy of its attachments.
  it.each([
    ['cannot be opened (null)', async () => null],
    ['throws while opening', async () => { throw new Error('database is locked'); }],
  ])('keeps unclaimed folders and reports "partial" when an account %s', async (_label, failingOpen) => {
    writeLegacy('mail-a', 'a.pdf', 'synced plaintext');
    writeLegacy('draft-of-b', 'b.pdf', 'only copy');

    const result = await migrateLegacyAttachmentCache({
      accountIds: () => ['acct-a', 'acct-b'],
      openAccount: (id) => (id === 'acct-a' ? Promise.resolve(account([{ id: 'mail-a', uid: 3 }])) : failingOpen()),
    });

    expect(result).toBe('partial');
    // What the opened account claimed is retired now...
    expect(legacyExists('mail-a')).toBe(false);
    // ...what nobody claimed yet waits for the next launch.
    expect(legacyExists('draft-of-b')).toBe(true);
    expect(existsSync(legacyAttachmentCacheRoot())).toBe(true);
  });

  // Breaks (data loss / interrupted run): once the account that could not be
  // opened opens on a later launch, its draft must still be recoverable, and the
  // run must then complete instead of staying partial forever.
  it('finishes on the next run once the missing account opens', async () => {
    writeLegacy('draft-of-b', 'b.pdf', 'only copy');
    const b = account([{ id: 'draft-of-b', uid: 0, attachmentNames: '["b.pdf"]' }]);
    let bOpens = false;
    const deps = {
      accountIds: () => ['acct-a', 'acct-b'],
      openAccount: async (id: string) => (id === 'acct-a' ? account([]) : bOpens ? b : null),
    };

    await expect(migrateLegacyAttachmentCache(deps)).resolves.toBe('partial');
    bOpens = true;
    await expect(migrateLegacyAttachmentCache(deps)).resolves.toBe('done');

    expect(await readEntry('acct-b', 'draft-of-b', 'b.pdf')).toBe('only copy');
    expect(existsSync(legacyAttachmentCacheRoot())).toBe(false);
  });

  // Breaks (data loss): an unreadable account registry is read as "no accounts",
  // so nothing claims any folder and the whole cache — drafts included — goes.
  // CLAUDE.md: an unreadable store and an empty store are the same value and
  // opposite facts. Neither may license a delete.
  it('reports "partial" and deletes nothing when the account list throws', async () => {
    writeLegacy('draft-1', 'a.pdf', 'only copy');
    const openAccount = vi.fn(async () => account([]));

    const result = await migrateLegacyAttachmentCache({
      accountIds: () => { throw new Error('addon failed to load'); },
      openAccount,
    });

    expect(result).toBe('partial');
    expect(legacyExists('draft-1')).toBe(true);
    expect(openAccount).not.toHaveBeenCalled();
  });

  // Breaks (data loss): same lesson — an EMPTY account list is not
  // authoritative (it is what a broken read looks like), so it removes nothing.
  it('reports "partial" and deletes nothing for an empty account list', async () => {
    writeLegacy('draft-1', 'a.pdf', 'only copy');
    const openAccount = vi.fn(async () => account([]));

    await expect(migrateLegacyAttachmentCache({ accountIds: () => [], openAccount })).resolves.toBe('partial');

    expect(legacyExists('draft-1')).toBe(true);
    expect(openAccount).not.toHaveBeenCalled();
  });

  // Breaks (CASA M-7): folders of removed accounts or deleted mail — which no
  // account will ever claim — keep their plaintext forever.
  it('removes the whole legacy root, unclaimed folders included, once every account was opened', async () => {
    writeLegacy('mail-a', 'a.pdf', 'synced');
    writeLegacy('removed-account-mail', 'x.pdf', 'nobody\'s');
    writeFileSync(join(legacyAttachmentCacheRoot(), '.DS_Store'), 'finder');
    const a = account([{ id: 'mail-a', uid: 1 }]);
    const b = account([]);

    const result = await migrateLegacyAttachmentCache({
      accountIds: () => ['acct-a', 'acct-b'],
      openAccount: async (id) => (id === 'acct-a' ? a : b),
    });

    expect(result).toBe('done');
    expect(existsSync(legacyAttachmentCacheRoot())).toBe(false);
    // Dot-files are not email folders: never looked up as one.
    expect(b.storage.getEmail).not.toHaveBeenCalledWith('.DS_Store');
  });
});

describe('a draft that cannot be sealed', () => {
  // Breaks (data loss): a failed seal (disk full) still deletes the plaintext —
  // the draft's attachments are gone from both places.
  it('keeps the draft folder, reports "partial", and still retires the rest', async () => {
    writeLegacy('draft-1', 'first.pdf', 'first');
    writeLegacy('draft-1', 'second.pdf', 'second');
    writeLegacy('mail-1', 'm.pdf', 'synced');
    h.storeFails = (_account, _email, filename) => filename === 'second.pdf';
    const deps = {
      accountIds: () => ['acct-a'],
      openAccount: async () => account([
        { id: 'draft-1', uid: 0, attachmentNames: '["first.pdf","second.pdf"]' },
        { id: 'mail-1', uid: 4 },
      ]),
    };

    await expect(migrateLegacyAttachmentCache(deps)).resolves.toBe('partial');
    expect(legacyExists('draft-1')).toBe(true);
    expect(existsSync(join(legacyAttachmentDir('draft-1'), 'second.pdf'))).toBe(true);
    expect(legacyExists('mail-1')).toBe(false);

    // Idempotent re-run once the disk recovers: both files land, plaintext goes.
    h.storeFails = null;
    await expect(migrateLegacyAttachmentCache(deps)).resolves.toBe('done');
    expect(await readEntry('acct-a', 'draft-1', 'first.pdf')).toBe('first');
    expect(await readEntry('acct-a', 'draft-1', 'second.pdf')).toBe('second');
    expect(existsSync(legacyAttachmentCacheRoot())).toBe(false);
  });

  // Breaks (data loss): with the key store locked (Linux without a keyring) the
  // seal cannot run at all; the plaintext must wait rather than be deleted.
  it('keeps the draft folder while the DB key is unavailable', async () => {
    writeLegacy('draft-1', 'only.pdf', 'only copy');
    h.keyThrows = true;
    const deps = {
      accountIds: () => ['acct-a'],
      openAccount: async () => account([{ id: 'draft-1', uid: 0, attachmentNames: '["only.pdf"]' }]),
    };

    await expect(migrateLegacyAttachmentCache(deps)).resolves.toBe('partial');
    expect(existsSync(join(legacyAttachmentDir('draft-1'), 'only.pdf'))).toBe(true);

    h.keyThrows = false;
    await expect(migrateLegacyAttachmentCache(deps)).resolves.toBe('done');
    expect(await readEntry('acct-a', 'draft-1', 'only.pdf')).toBe('only copy');
  });
});

describe('a legacy file that cannot be read right now', () => {
  // Breaks (data loss): any read error was taken for "never cached", and the
  // folder — an unsynced draft's only copy — was deleted unsealed.
  it('keeps the folder and reports "partial", then finishes once it reads', async () => {
    writeLegacy('draft-1', 'only.pdf', 'only copy');
    const real = promises.readFile.bind(promises);
    let refuse = true;
    const read = vi.spyOn(promises, 'readFile').mockImplementation(async (target, options) => {
      if (refuse && String(target).endsWith('only.pdf')) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      return real(target as never, options as never);
    });
    const deps = {
      accountIds: () => ['acct-a'],
      openAccount: async () => account([{ id: 'draft-1', uid: 0, attachmentNames: '["only.pdf"]' }]),
    };
    try {
      await expect(migrateLegacyAttachmentCache(deps)).resolves.toBe('partial');
      expect(existsSync(join(legacyAttachmentDir('draft-1'), 'only.pdf'))).toBe(true);
      refuse = false;
      await expect(migrateLegacyAttachmentCache(deps)).resolves.toBe('done');
    } finally {
      read.mockRestore();
    }
    expect(await readEntry('acct-a', 'draft-1', 'only.pdf')).toBe('only copy');
  });
});

describe('a database that fails while matching', () => {
  // Breaks (data loss): a busy or failing database answers "not this account's
  // mail", the folder counts as unclaimed, and the root — with an unsynced
  // draft's only copy — is deleted as if every account had been checked.
  it('keeps the folder and reports "partial", then finishes once the lookup works', async () => {
    writeLegacy('draft-1', 'only.pdf', 'only copy');
    let busy = true;
    const rows = [{ id: 'draft-1', uid: 0, attachmentNames: '["only.pdf"]' }];
    const deps = {
      accountIds: () => ['acct-a'],
      openAccount: async () => ({
        storage: {
          getEmail: async (id: string) => {
            if (busy) throw new Error('SQLITE_BUSY: database is locked');
            return rows.find((row) => row.id === id) ?? null;
          },
        },
      }),
    };

    await expect(migrateLegacyAttachmentCache(deps)).resolves.toBe('partial');
    expect(existsSync(join(legacyAttachmentDir('draft-1'), 'only.pdf'))).toBe(true);

    busy = false;
    await expect(migrateLegacyAttachmentCache(deps)).resolves.toBe('done');
    expect(await readEntry('acct-a', 'draft-1', 'only.pdf')).toBe('only copy');
  });
});

describe('default dependencies', () => {
  // Breaks: the startup call (no injected deps) reads the swallowing registry
  // reader or never opens the accounts, so the migration never completes — or
  // treats an unreadable registry as empty.
  it('reads the throwing registry and opens accounts through the runtime', async () => {
    writeLegacy('draft-1', 'a.pdf', 'only copy');
    h.registry = [{ id: 'acct-a' }];
    const opened: string[] = [];
    h.ensureRuntime = async (id) => {
      opened.push(id);
      return account([{ id: 'draft-1', uid: 0, attachmentNames: '["a.pdf"]' }]);
    };

    await expect(migrateLegacyAttachmentCache()).resolves.toBe('done');

    expect(opened).toEqual(['acct-a']);
    expect(await readEntry('acct-a', 'draft-1', 'a.pdf')).toBe('only copy');
  });

  // Breaks (data loss): an unreadable registry at startup deletes the cache.
  it('keeps everything when the registry cannot be read', async () => {
    writeLegacy('draft-1', 'a.pdf', 'only copy');
    h.registryThrows = true;

    await expect(migrateLegacyAttachmentCache()).resolves.toBe('partial');
    expect(legacyExists('draft-1')).toBe(true);
  });
});
