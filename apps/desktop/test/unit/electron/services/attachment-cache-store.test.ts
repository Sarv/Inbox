import { createHash } from 'crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  truncateSync,
  utimesSync,
  writeFileSync,
  promises,
} from 'fs';
import { tmpdir } from 'os';
import { basename, dirname, join, relative, sep } from 'path';

import { SEALED_BYTES_OVERHEAD } from '@sarvinbox/core';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The sealed, per-account attachment store (CASA M-7) as a STORE: where entries
 * live, what the folder names give away, and what happens to an account's
 * entries when the account is removed, renamed, or forgotten.
 *
 * The regressions guarded here are the quiet ones: a removed account whose
 * attachments outlive it on disk, a rename that strands an unsynced draft's only
 * copy under the old id, a sweep that reads "could not tell" as "nobody owns
 * this" and deletes a live mailbox's files, and a directory listing that tells a
 * reader whose mail it is and what was attached.
 *
 * Real filesystem under a temp userData; only Electron's `app`, the DB key and
 * the account resolver (never reached here) are faked.
 */

const h = vi.hoisted(() => ({
  userData: '',
  dbKey: 'k'.repeat(64),
  /** A locked key store (keychain refused, Linux without a Secret Service). */
  keyThrows: false,
}));

vi.mock('electron', () => ({ app: { getPath: () => h.userData } }));
vi.mock('../../../../electron/services/db-key-store', () => ({
  getDbEncryptionKey: () => {
    if (h.keyThrows) throw new Error('key store locked');
    return h.dbKey;
  },
}));
// resolveAttachmentFile is not under test here; keep the account runtime (and
// with it storage-node) out of this suite.
vi.mock('../../../../electron/services/account-target', () => ({ resolveAccountTarget: vi.fn() }));
vi.mock('@sarvinbox/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@sarvinbox/core')>()),
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

import {
  accountAttachmentDir,
  AttachmentError,
  cachedAttachmentSize,
  cleanupOrphanedAttachmentStores,
  deleteAccountAttachments,
  getOrCacheAttachment,
  legacyAttachmentCacheRoot,
  legacyAttachmentDir,
  MAX_ATTACHMENT_BYTES,
  readCachedAttachment,
  rekeyAccountAttachments,
  removeAllCachedAttachments,
  resetAttachmentStoreKeys,
  seedAttachmentCache,
  storeCachedAttachment,
} from '../../../../electron/services/attachment-cache';

const TMP = mkdtempSync(join(tmpdir(), 'attachment-store-'));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

const HOUR = 60 * 60 * 1000;

/** Root of the sealed store — the parent of every account folder. */
const storeRoot = () => dirname(accountAttachmentDir('any'));

/** Cache an attachment the way a saved draft does (no server copy). */
const seed = (accountId: string | null, emailId: string, filename: string, text: string) =>
  seedAttachmentCache(accountId, emailId, [{ filename, content: Buffer.from(text) }]);

/** The sealed file for an entry, via the store's own lookup (uid 0: cache hit or nothing). */
const entryPath = (accountId: string | null, emailId: string, filename: string) =>
  getOrCacheAttachment(accountId, emailId, 'INBOX', 0, filename, null);

/** The plaintext of an entry, the way every consumer reads it. */
const readEntry = async (accountId: string | null, emailId: string, filename: string) =>
  (await readCachedAttachment(await entryPath(accountId, emailId, filename))).toString('utf8');

/** Every path under the store, relative to its root. */
function listTree(dir: string, base = dir): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    const rel = relative(base, full);
    return statSync(full).isDirectory() ? [rel, ...listTree(full, base)] : [rel];
  });
}

/** Push a directory's mtime into the past so the stale guard counts it as abandoned. */
const age = (dir: string, ms: number) => {
  const when = (Date.now() - ms) / 1000;
  utimesSync(dir, when, when);
};

/**
 * A folder written a moment ago. File mtimes carry sub-millisecond precision
 * while `Date.now()` does not, so a folder created in the current millisecond
 * can read as "in the future" and survive even `staleAfterMs: 0`. One second
 * back takes that clock-granularity race out of the tests without making the
 * folder anywhere near stale under the default one-hour guard.
 */
const settle = (dir: string) => age(dir, 1000);

beforeEach(() => {
  h.userData = mkdtempSync(join(TMP, 'ud-'));
  h.dbKey = 'k'.repeat(64);
  h.keyThrows = false;
  resetAttachmentStoreKeys();
});

describe('per-account entries', () => {
  it('re-fetches old server-backed bytes once without losing unsynced draft attachments', async () => {
    await seed('acct-a', 'remote-1', 'report.pdf', 'old duplicated MIME chunks');
    await seed('acct-a', 'draft-1', 'notes.txt', 'only local copy');
    const oldPath = await entryPath('acct-a', 'remote-1', 'report.pdf');
    const correct = Buffer.from('%PDF-1.4\ncomplete server copy\n%%EOF\n');
    const remote = { isConnected: () => true, fetchAttachmentPart: vi.fn(async () => ({ filename: 'report.pdf', content: correct })), fetchAttachment: vi.fn() };

    const refreshed = await getOrCacheAttachment('acct-a', 'remote-1', 'INBOX', 42, 'report.pdf', remote);
    expect(refreshed).not.toBe(oldPath);
    expect(await readCachedAttachment(refreshed)).toEqual(correct);
    expect(await readEntry('acct-a', 'draft-1', 'notes.txt')).toBe('only local copy');
    expect(existsSync(oldPath)).toBe(true);

    const cached = await getOrCacheAttachment('acct-a', 'remote-1', 'INBOX', 42, 'report.pdf', null);
    expect(cached).toBe(refreshed);
    expect(remote.fetchAttachmentPart).toHaveBeenCalledTimes(1);
    expect(remote.fetchAttachment).not.toHaveBeenCalled();
    for (const segment of relative(storeRoot(), refreshed).split(sep)) expect(segment).toMatch(/^[0-9a-f]{32}$/);
  });

  it('does not serve an old corrupt server copy offline or remove local draft data', async () => {
    await seed('acct-a', 'remote-1', 'report.pdf', 'old duplicated MIME chunks');
    await seed('acct-a', 'draft-1', 'notes.txt', 'only local copy');
    const oldPath = await entryPath('acct-a', 'remote-1', 'report.pdf');
    await expect(getOrCacheAttachment('acct-a', 'remote-1', 'INBOX', 42, 'report.pdf', null))
      .rejects.toMatchObject({ status: 503 });
    expect(existsSync(oldPath)).toBe(true);
    expect(await readEntry('acct-a', 'draft-1', 'notes.txt')).toBe('only local copy');
  });

  it('keeps the repaired server copy cached when a message moves to a new folder and UID', async () => {
    const correct = Buffer.from('complete attachment bytes');
    const remote = {
      isConnected: () => true,
      fetchAttachmentPart: vi.fn(async () => ({ filename: 'report.pdf', content: correct })),
      fetchAttachment: vi.fn(),
    };
    const initial = await getOrCacheAttachment('acct-a', 'mail-1', 'INBOX', 42, 'report.pdf', remote);

    // UIDs identify a server location, but the cached bytes belong to the
    // stable account/email/file slot and remain available while offline.
    const moved = await getOrCacheAttachment('acct-a', 'mail-1', 'Archive', 901, 'report.pdf', null);

    expect(moved).toBe(initial);
    expect(await readCachedAttachment(moved)).toEqual(correct);
    expect(remote.fetchAttachmentPart).toHaveBeenCalledTimes(1);
  });

  it('moves repaired server slots and local draft slots together when an account is rekeyed', async () => {
    await seed('acct-old', 'draft-1', 'only-local.txt', 'draft bytes');
    const correct = Buffer.from('complete server bytes');
    await getOrCacheAttachment('acct-old', 'mail-1', 'INBOX', 42, 'report.pdf', {
      isConnected: () => true,
      fetchAttachmentPart: async () => ({ filename: 'report.pdf', content: correct }),
      fetchAttachment: vi.fn(),
    });
    // Exercise the file-by-file merge, including two namespaces under one
    // email folder, rather than only the whole-account directory rename.
    await seed('acct-old', 'mail-1', 'report.pdf', 'old local slot');
    await seed('acct-new', 'mail-1', 'other.txt', 'already under new account');

    await rekeyAccountAttachments('acct-old', 'acct-new');

    const repaired = await getOrCacheAttachment('acct-new', 'mail-1', 'INBOX', 42, 'report.pdf', null);
    expect(await readCachedAttachment(repaired)).toEqual(correct);
    expect(await readEntry('acct-new', 'mail-1', 'report.pdf')).toBe('old local slot');
    expect(await readEntry('acct-new', 'draft-1', 'only-local.txt')).toBe('draft bytes');
    expect(await readEntry('acct-new', 'mail-1', 'other.txt')).toBe('already under new account');
    expect(existsSync(accountAttachmentDir('acct-old'))).toBe(false);
  });

  // Breaks: two mailboxes holding the same message (a shared list, a Cc to both)
  // overwrite each other's cached copy — one account opens the other's bytes.
  it('keeps the same email id + filename apart per account', async () => {
    await seed('acct-a', 'email-1', 'report.pdf', 'from A');
    await seed('acct-b', 'email-1', 'report.pdf', 'from B');

    expect(await readEntry('acct-a', 'email-1', 'report.pdf')).toBe('from A');
    expect(await readEntry('acct-b', 'email-1', 'report.pdf')).toBe('from B');
    expect(dirname(dirname(await entryPath('acct-a', 'email-1', 'report.pdf')))).toBe(accountAttachmentDir('acct-a'));
  });

  // Breaks: account B is served account A's cached file for a draft it does not
  // have — a cross-account read through the cache.
  it('does not answer one account\'s miss with another account\'s entry', async () => {
    await seed('acct-a', 'email-1', 'report.pdf', 'from A');

    await expect(entryPath('acct-b', 'email-1', 'report.pdf')).rejects.toMatchObject({ status: 404 });
  });

  // Breaks: the legacy-cache migration seals a draft's files somewhere the draft
  // never looks, and the draft opens with its attachments missing.
  it('storeCachedAttachment writes the entry the draft reads back', async () => {
    await storeCachedAttachment('acct-a', 'draft-1', 'notes.txt', Buffer.from('hello'));

    expect(await readEntry('acct-a', 'draft-1', 'notes.txt')).toBe('hello');
  });
});

describe('what the store reveals at rest', () => {
  const ACCOUNT = 'acct-alice-example-com--imap.example.com';
  const EMAIL = 'secret-draft-42@example.com';
  const FILE = 'Payroll Q3 2026.pdf';
  const BODY = 'CONFIDENTIAL salary table';

  // Breaks (privacy, CASA M-7): a directory listing of userData tells whoever
  // reads it which address the mail is for, which message, and what was attached.
  it('names no account, email or file anywhere in the tree', async () => {
    await seed(ACCOUNT, EMAIL, FILE, BODY);

    const tree = listTree(storeRoot());
    expect(tree.length).toBeGreaterThan(0);
    for (const entry of tree) {
      for (const segment of entry.split(sep)) {
        if (segment === '.cache-generation') continue;
        expect(segment).toMatch(/^[0-9a-f]{32}$/);
      }
    }
    const listing = tree.join('\n').toLowerCase();
    for (const leak of ['alice', 'example', 'secret', 'draft', 'payroll', '.pdf', 'acct']) {
      expect(listing).not.toContain(leak);
    }
  });

  // Breaks: the bytes are stored in the clear, so the sealing protects nothing.
  it('stores no plaintext bytes', async () => {
    await seed(ACCOUNT, EMAIL, FILE, BODY);

    const sealed = readFileSync(await entryPath(ACCOUNT, EMAIL, FILE));
    expect(sealed.includes(Buffer.from(BODY))).toBe(false);
    expect(sealed.includes(Buffer.from('CONFIDENTIAL'))).toBe(false);
  });

  // Breaks: the email/file names become a plain hash, which anyone can confirm
  // by hashing a guessed message id or filename — no key required.
  it('hides email and file names behind a KEYED hash; the account folder needs no key', async () => {
    await seed(ACCOUNT, EMAIL, FILE, BODY);
    const underFirstKey = relative(storeRoot(), await entryPath(ACCOUNT, EMAIL, FILE)).split(sep);

    h.dbKey = 'z'.repeat(64);
    resetAttachmentStoreKeys();
    await seed(ACCOUNT, EMAIL, FILE, BODY);
    const underSecondKey = relative(storeRoot(), await entryPath(ACCOUNT, EMAIL, FILE)).split(sep);

    // Account folder: same under any key, so removal and the orphan sweep work
    // without the key store.
    expect(underSecondKey[0]).toBe(underFirstKey[0]);
    // Email and file: depend on the key.
    expect(underSecondKey[1]).not.toBe(underFirstKey[1]);
    expect(underSecondKey[2]).not.toBe(underFirstKey[2]);
    // ...and are not the unkeyed digest of the name.
    const plainDigest = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 32);
    expect(underFirstKey[1]).not.toBe(plainDigest(EMAIL));
    expect(underFirstKey[2]).not.toBe(plainDigest(FILE));
  });
});

describe('entries that will not open', () => {
  // Breaks: after the DB key changes (a reset key store), every old entry is
  // served as garbage — or worse, a read throws forever instead of re-fetching.
  it('discards entries sealed under a previous DB key on read', async () => {
    await seed('acct-a', 'email-1', 'report.pdf', 'old key bytes');
    const sealedPath = await entryPath('acct-a', 'email-1', 'report.pdf');

    h.dbKey = 'z'.repeat(64);
    resetAttachmentStoreKeys();

    const failure = await readCachedAttachment(sealedPath).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AttachmentError);
    expect(failure).toMatchObject({ status: 500, message: 'The attachment could not be read. Try again.' });
    // Removed, so the next open fetches afresh instead of failing forever.
    expect(existsSync(sealedPath)).toBe(false);
    // And the new key's lookup does not find the old entry under another name.
    await expect(entryPath('acct-a', 'email-1', 'report.pdf')).rejects.toMatchObject({ status: 404 });
  });

  // Breaks: a sealed file copied into another email's slot is served as that
  // email's attachment — the bytes must be bound to where they were written.
  it('refuses a sealed file moved into another slot', async () => {
    await seed('acct-a', 'email-1', 'report.pdf', 'email one');
    await seed('acct-a', 'email-2', 'report.pdf', 'email two');
    const one = await entryPath('acct-a', 'email-1', 'report.pdf');
    const two = await entryPath('acct-a', 'email-2', 'report.pdf');

    copyFileSync(one, two);

    await expect(readCachedAttachment(two)).rejects.toMatchObject({ status: 500 });
    expect(existsSync(two)).toBe(false);
    expect(await readCachedAttachment(one).then(String)).toBe('email one');
  });

  // Breaks: a plaintext or damaged file at a cache path (an older build, a disk
  // error) is served verbatim as if it had been vouched for.
  it('refuses plaintext and altered bytes', async () => {
    await seed('acct-a', 'email-1', 'a.txt', 'sealed');
    await seed('acct-a', 'email-1', 'b.txt', 'sealed');
    const plain = await entryPath('acct-a', 'email-1', 'a.txt');
    const altered = await entryPath('acct-a', 'email-1', 'b.txt');
    writeFileSync(plain, 'not sealed at all');
    const bytes = readFileSync(altered);
    bytes[bytes.length - 1] ^= 0xff;
    writeFileSync(altered, bytes);

    await expect(readCachedAttachment(plain)).rejects.toMatchObject({ status: 500 });
    await expect(readCachedAttachment(altered)).rejects.toMatchObject({ status: 500 });
    expect(existsSync(plain)).toBe(false);
    expect(existsSync(altered)).toBe(false);
  });

  // Changed deliberately (CASA M-7): only a BOUNDED read (the unscanned
  // snapshot) refuses an entry over the limit; other reads are unbounded, as
  // when the file was read directly. Breaks: a bounded read opens it anyway, or
  // the refusal deletes it as if it were damaged (it is only refused).
  it('refuses a bounded read of an entry over the limit with 413 and keeps it', async () => {
    await seed('acct-a', 'email-1', 'huge.bin', 'small');
    const sealedPath = await entryPath('acct-a', 'email-1', 'huge.bin');
    truncateSync(sealedPath, MAX_ATTACHMENT_BYTES + SEALED_BYTES_OVERHEAD + 1);

    await expect(readCachedAttachment(sealedPath, MAX_ATTACHMENT_BYTES)).rejects.toMatchObject({ status: 413 });
    expect(existsSync(sealedPath)).toBe(true);
  });

  // Breaks: a key store that cannot open right now is taken for a damaged
  // file, and the entry — an unsynced draft's only copy — is deleted.
  it('keeps the entry when the key cannot be had, rather than calling it damaged', async () => {
    await seed('acct-a', 'email-1', 'draft.pdf', 'only copy');
    const sealedPath = await entryPath('acct-a', 'email-1', 'draft.pdf');
    resetAttachmentStoreKeys();
    h.keyThrows = true;

    await expect(readCachedAttachment(sealedPath)).rejects.toThrow();
    expect(existsSync(sealedPath)).toBe(true);
  });
});

describe('cachedAttachmentSize', () => {
  // Breaks: the size reconciled onto the email (and shown in the list and the
  // viewer header) is the SEALED file's size — every attachment reads 32 bytes
  // larger than what "Save a copy" writes.
  it('reports the plaintext size of a sealed entry', async () => {
    const body = 'twenty-one bytes long';
    await seed('acct-a', 'email-1', 'a.txt', body);

    await expect(cachedAttachmentSize(await entryPath('acct-a', 'email-1', 'a.txt'))).resolves.toBe(body.length);
  });

  // Changed deliberately (CASA M-7): a file that is not sealed data has no
  // attachment size at all (null), rather than a clamped guess. Breaks: a
  // damaged or planted file's size is written into the email's attachment
  // sizes before anything checked it.
  it('reports no size for a file that is not sealed data', async () => {
    await seed('acct-a', 'email-1', 'a.txt', 'x');
    const sealedPath = await entryPath('acct-a', 'email-1', 'a.txt');
    writeFileSync(sealedPath, 'short');
    await expect(cachedAttachmentSize(sealedPath)).resolves.toBeNull();
    writeFileSync(sealedPath, 'a plaintext file longer than the seal overhead, from an older build');
    await expect(cachedAttachmentSize(sealedPath)).resolves.toBeNull();
  });
});

describe('deleteAccountAttachments', () => {
  // Breaks (CASA M-7): a removed account's attachments stay on disk — or the
  // removal takes the OTHER accounts' cached files with it.
  it('removes only that account\'s folder', async () => {
    await seed('acct-a', 'email-1', 'a.pdf', 'A');
    await seed('acct-b', 'email-1', 'b.pdf', 'B');

    await deleteAccountAttachments('acct-a');

    expect(existsSync(accountAttachmentDir('acct-a'))).toBe(false);
    expect(await readEntry('acct-b', 'email-1', 'b.pdf')).toBe('B');
  });

  // Breaks: removing an account that never opened an attachment (or removing it
  // twice) fails the removal the user asked for.
  it('is a no-op for an account with nothing cached, and idempotent', async () => {
    await expect(deleteAccountAttachments('acct-never')).resolves.toBeUndefined();
    await seed('acct-a', 'email-1', 'a.pdf', 'A');
    await deleteAccountAttachments('acct-a');
    await expect(deleteAccountAttachments('acct-a')).resolves.toBeUndefined();
  });

  // Breaks: with the key store locked (Linux without a keyring, a refused
  // keychain prompt) a removed account's files cannot be deleted at all.
  it('works without the DB key', async () => {
    await seed('acct-a', 'email-1', 'a.pdf', 'A');
    resetAttachmentStoreKeys();
    h.keyThrows = true;

    await deleteAccountAttachments('acct-a');

    expect(existsSync(accountAttachmentDir('acct-a'))).toBe(false);
  });
});

describe('rekeyAccountAttachments — moves that fail', () => {
  const lockedErr = () => Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });

  // Breaks (data loss, Windows): a file briefly held open (antivirus scanning it)
  // refuses the folder move with EPERM; read as "target exists", the merge never
  // created the target, every move failed silently, and the old folder — an
  // unsynced draft's only copy — was deleted.
  it('rides out a short lock and moves the folder', async () => {
    await seed('acct-old', 'draft-1', 'plan.pdf', 'only copy');
    const real = promises.rename.bind(promises);
    let refusals = 2;
    const rename = vi.spyOn(promises, 'rename').mockImplementation(async (source, target) => {
      if (refusals-- > 0) throw lockedErr();
      return real(source, target);
    });
    try {
      await rekeyAccountAttachments('acct-old', 'acct-new');
    } finally {
      rename.mockRestore();
    }
    expect(existsSync(accountAttachmentDir('acct-old'))).toBe(false);
    expect(await readEntry('acct-new', 'draft-1', 'plan.pdf')).toBe('only copy');
  });

  // Breaks (data loss): a lock that does not clear still ends in the old folder
  // being deleted.
  it('throws and keeps the old folder when the move stays refused', async () => {
    await seed('acct-old', 'draft-1', 'plan.pdf', 'only copy');
    const rename = vi.spyOn(promises, 'rename').mockRejectedValue(lockedErr());
    try {
      await expect(rekeyAccountAttachments('acct-old', 'acct-new')).rejects.toMatchObject({ code: 'EPERM' });
    } finally {
      rename.mockRestore();
    }
    expect(await readEntry('acct-old', 'draft-1', 'plan.pdf')).toBe('only copy');
    expect(existsSync(accountAttachmentDir('acct-new'))).toBe(false);
  });

  // Breaks (data loss): merging into an existing folder, an entry whose move
  // fails is deleted with the old folder; or a file the new id's same email
  // folder lacks is dropped instead of moved in.
  it('merges file by file and keeps whatever did not move', async () => {
    await seed('acct-new', 'draft-1', 'a.pdf', 'new a');
    await seed('acct-old', 'draft-1', 'a.pdf', 'old a');
    await seed('acct-old', 'draft-1', 'b.pdf', 'old b');
    await seed('acct-old', 'draft-2', 'c.pdf', 'old c');
    const real = promises.rename.bind(promises);
    const blocked = await entryPath('acct-old', 'draft-2', 'c.pdf');
    const draft2 = dirname(blocked);
    const rename = vi.spyOn(promises, 'rename').mockImplementation(async (source, target) => {
      if (String(source) === draft2) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      return real(source, target);
    });
    try {
      await rekeyAccountAttachments('acct-old', 'acct-new');
    } finally {
      rename.mockRestore();
    }
    expect(await readEntry('acct-new', 'draft-1', 'a.pdf')).toBe('new a'); // the new id's copy wins
    expect(await readEntry('acct-new', 'draft-1', 'b.pdf')).toBe('old b'); // moved into the same email
    expect(await readEntry('acct-old', 'draft-2', 'c.pdf')).toBe('old c'); // not moved: kept
  });
});

describe('rekeyAccountAttachments', () => {
  // Breaks: an account id change (legacy id canonicalised) strands its cache —
  // including an unsynced draft's ONLY copy of its attachments — under the old id.
  it('moves the folder to the new id and the files still decrypt there', async () => {
    await seed('acct-old', 'draft-1', 'only-copy.pdf', 'draft bytes');
    await seed('acct-old', 'email-2', 'b.txt', 'second');

    await rekeyAccountAttachments('acct-old', 'acct-new');

    expect(existsSync(accountAttachmentDir('acct-old'))).toBe(false);
    expect(await readEntry('acct-new', 'draft-1', 'only-copy.pdf')).toBe('draft bytes');
    expect(await readEntry('acct-new', 'email-2', 'b.txt')).toBe('second');
  });

  // Breaks: a rekey into an id that already has a cache (a re-run after an
  // interrupted move, or both ids used by different builds) either loses the old
  // id's entries or overwrites the new id's own copies.
  it('merges into an existing target without overwriting its entries', async () => {
    await seed('acct-new', 'email-1', 'shared.pdf', 'new copy');
    await seed('acct-old', 'email-1', 'shared.pdf', 'old copy');
    await seed('acct-old', 'email-2', 'moved.pdf', 'only under old');

    await rekeyAccountAttachments('acct-old', 'acct-new');

    expect(await readEntry('acct-new', 'email-1', 'shared.pdf')).toBe('new copy');
    expect(await readEntry('acct-new', 'email-2', 'moved.pdf')).toBe('only under old');
    expect(existsSync(accountAttachmentDir('acct-old'))).toBe(false);
  });

  // Breaks: rekeying an account that never cached anything throws, failing the
  // whole id migration, or creates an empty folder for the new id.
  it('is a no-op when nothing is cached under the old id', async () => {
    await expect(rekeyAccountAttachments('acct-ghost', 'acct-new')).resolves.toBeUndefined();
    expect(existsSync(accountAttachmentDir('acct-new'))).toBe(false);

    // ...and leaves an existing target alone.
    await seed('acct-new', 'email-1', 'a.pdf', 'kept');
    await rekeyAccountAttachments('acct-ghost', 'acct-new');
    expect(await readEntry('acct-new', 'email-1', 'a.pdf')).toBe('kept');
  });

  // Breaks: a repeated migration (it runs on every hydrate) or a same-id call
  // deletes the folder it was meant to keep.
  it('is idempotent and ignores a same-id call', async () => {
    await seed('acct-a', 'email-1', 'a.pdf', 'A');

    await rekeyAccountAttachments('acct-a', 'acct-a');
    expect(await readEntry('acct-a', 'email-1', 'a.pdf')).toBe('A');

    await rekeyAccountAttachments('acct-a', 'acct-b');
    await rekeyAccountAttachments('acct-a', 'acct-b');
    expect(await readEntry('acct-b', 'email-1', 'a.pdf')).toBe('A');
  });

  // Breaks: a move that fails for an unexpected reason (permissions) is
  // swallowed and the old folder deleted anyway — losing the draft's only copy.
  // POSIX-only: chmod cannot make a directory read-only on Windows (ACLs).
  it.skipIf(process.platform === 'win32')('throws on an unexpected move failure and leaves the source intact', async () => {
    await seed('acct-old', 'draft-1', 'only-copy.pdf', 'draft bytes');
    chmodSync(storeRoot(), 0o500);
    try {
      await expect(rekeyAccountAttachments('acct-old', 'acct-new')).rejects.toThrow();
    } finally {
      chmodSync(storeRoot(), 0o700);
    }
    expect(await readEntry('acct-old', 'draft-1', 'only-copy.pdf')).toBe('draft bytes');
  });
});

describe('cleanupOrphanedAttachmentStores', () => {
  // Breaks: the removal sweep (staleAfterMs 0) keeps a folder written within
  // the current millisecond — its mtime can read a fraction in the future.
  it('with staleAfterMs 0 removes even a folder written this very moment', async () => {
    await seed('acct-gone', 'email-1', 'a.pdf', 'A');
    // The race, made certain: an mtime a moment ahead of Date.now().
    const ahead = (Date.now() + 500) / 1000;
    utimesSync(accountAttachmentDir('acct-gone'), ahead, ahead);
    await expect(cleanupOrphanedAttachmentStores(['acct-kept'], { staleAfterMs: 0 })).resolves.toBe(1);
    expect(existsSync(accountAttachmentDir('acct-gone'))).toBe(false);
  });

  // Breaks (CASA M-7): attachments of accounts removed while the app was closed
  // (or rekeyed by a crashed move) stay on disk forever.
  it('removes stale folders of accounts that are not in the keep-set', async () => {
    await seed('acct-a', 'email-1', 'a.pdf', 'A');
    await seed('acct-gone', 'email-1', 'g.pdf', 'G');
    age(accountAttachmentDir('acct-gone'), 2 * HOUR);

    await expect(cleanupOrphanedAttachmentStores(['acct-a'])).resolves.toBe(1);

    expect(existsSync(accountAttachmentDir('acct-gone'))).toBe(false);
    expect(await readEntry('acct-a', 'email-1', 'a.pdf')).toBe('A');
  });

  // Breaks: a registered account's cache is swept just because it is old — the
  // keep-set must protect it regardless of age (multi-account: every one of them).
  it('keeps every registered account\'s folder, however old', async () => {
    await seed('acct-a', 'email-1', 'a.pdf', 'A');
    await seed('acct-b', 'email-1', 'b.pdf', 'B');
    age(accountAttachmentDir('acct-a'), 48 * HOUR);
    age(accountAttachmentDir('acct-b'), 48 * HOUR);

    await expect(cleanupOrphanedAttachmentStores(['acct-a', 'acct-b'], { staleAfterMs: 0 })).resolves.toBe(0);

    expect(await readEntry('acct-a', 'email-1', 'a.pdf')).toBe('A');
    expect(await readEntry('acct-b', 'email-1', 'b.pdf')).toBe('B');
  });

  // Breaks: the startup sweep races an account added moments ago in another
  // window (its registry row not yet visible) and deletes its fresh cache.
  it('keeps a folder touched within the stale window', async () => {
    await seed('acct-a', 'email-1', 'a.pdf', 'A');
    await seed('acct-fresh', 'email-1', 'f.pdf', 'F');
    settle(accountAttachmentDir('acct-fresh'));

    await expect(cleanupOrphanedAttachmentStores(['acct-a'])).resolves.toBe(0);
    expect(existsSync(accountAttachmentDir('acct-fresh'))).toBe(true);

    // The removal path disables the guard deliberately (its keep-set is fresh).
    await expect(cleanupOrphanedAttachmentStores(['acct-a'], { staleAfterMs: 0 })).resolves.toBe(1);
    expect(existsSync(accountAttachmentDir('acct-fresh'))).toBe(false);
  });

  // Breaks: the sweep deletes things it does not own — the generation marker
  // (which would then discard the whole cache on the next open) or anything a
  // user or another build put under the store root.
  it('ignores the generation marker and names that are not account folders', async () => {
    await seed('acct-a', 'email-1', 'a.pdf', 'A');
    const foreign = ['not-an-account', 'A'.repeat(32), 'a'.repeat(31), `${'b'.repeat(32)}.bak`];
    for (const name of foreign) {
      mkdirSync(join(storeRoot(), name));
      age(join(storeRoot(), name), 48 * HOUR);
    }
    const marker = join(storeRoot(), '.cache-generation');
    expect(existsSync(marker)).toBe(true);
    age(marker, 48 * HOUR);

    await expect(cleanupOrphanedAttachmentStores(['acct-a'], { staleAfterMs: 0 })).resolves.toBe(0);

    for (const name of foreign) expect(existsSync(join(storeRoot(), name))).toBe(true);
    expect(existsSync(marker)).toBe(true);
  });

  // Breaks: an unreadable account registry is reported as "no accounts", and the
  // sweep deletes every mailbox's cache. CLAUDE.md: an unreadable store and an
  // empty store are the same value and opposite facts — the same mistake once
  // made the orphan-DB sweep delete both live mailbox databases. An EMPTY
  // keep-set is never authoritative: it removes NOTHING.
  it('removes nothing for an empty keep-set, even with the stale guard off', async () => {
    await seed('acct-a', 'email-1', 'a.pdf', 'A');
    await seed('acct-b', 'email-1', 'b.pdf', 'B');
    age(accountAttachmentDir('acct-a'), 48 * HOUR);
    age(accountAttachmentDir('acct-b'), 48 * HOUR);

    await expect(cleanupOrphanedAttachmentStores([], { staleAfterMs: 0 })).resolves.toBe(0);

    expect(await readEntry('acct-a', 'email-1', 'a.pdf')).toBe('A');
    expect(await readEntry('acct-b', 'email-1', 'b.pdf')).toBe('B');
  });

  // Breaks: the pre-account default slot (no account id yet) is never cleaned,
  // so files cached before the first account was claimed stay forever.
  it('sweeps the pre-account default slot as an orphan', async () => {
    await seed(null, 'email-1', 'early.pdf', 'early');
    await seed('acct-a', 'email-1', 'a.pdf', 'A');
    for (const name of readdirSync(storeRoot())) settle(join(storeRoot(), name));

    await expect(cleanupOrphanedAttachmentStores(['acct-a'], { staleAfterMs: 0 })).resolves.toBe(1);

    expect(readdirSync(storeRoot()).filter((name) => name !== '.cache-generation'))
      .toEqual([basename(accountAttachmentDir('acct-a'))]);
  });

  // Breaks: the startup sweep throws on a fresh install (no store yet), or
  // cannot run while the key store is locked.
  it('returns 0 with no store, and needs no DB key', async () => {
    await expect(cleanupOrphanedAttachmentStores(['acct-a'], { staleAfterMs: 0 })).resolves.toBe(0);

    await seed('acct-gone', 'email-1', 'g.pdf', 'G');
    settle(accountAttachmentDir('acct-gone'));
    resetAttachmentStoreKeys();
    h.keyThrows = true;
    await expect(cleanupOrphanedAttachmentStores(['acct-a'], { staleAfterMs: 0 })).resolves.toBe(1);
    expect(existsSync(accountAttachmentDir('acct-gone'))).toBe(false);
  });
});

describe('removeAllCachedAttachments', () => {
  // Breaks: removing the last account leaves cached attachments on disk — the
  // sealed store or, worse, the older builds' PLAINTEXT cache that names no account.
  it('removes both the sealed store and the legacy plaintext cache', async () => {
    await seed('acct-a', 'email-1', 'a.pdf', 'A');
    mkdirSync(legacyAttachmentDir('email-legacy'), { recursive: true });
    writeFileSync(join(legacyAttachmentDir('email-legacy'), 'old.pdf'), 'plaintext');

    await removeAllCachedAttachments();

    expect(existsSync(storeRoot())).toBe(false);
    expect(existsSync(legacyAttachmentCacheRoot())).toBe(false);
  });

  // Breaks: the last-account removal fails when nothing was ever cached.
  it('is a no-op when neither cache exists', async () => {
    await expect(removeAllCachedAttachments()).resolves.toBeUndefined();
  });

  // Breaks (data loss): the wipe takes the generation marker while this process
  // still believes it checked it, so a draft saved after the wipe is in a
  // markerless store — which the next launch discards as an old generation.
  it('keeps a draft saved after the wipe across the next launch', async () => {
    await seed('acct-a', 'email-1', 'a.pdf', 'A');
    await removeAllCachedAttachments();
    await seed('acct-b', 'draft-1', 'plan.pdf', 'draft only copy');

    vi.resetModules(); // the next launch: a fresh module, no memory of checks
    const next = await import('../../../../electron/services/attachment-cache');
    const filePath = await next.getOrCacheAttachment('acct-b', 'draft-1', 'Drafts', 0, 'plan.pdf', null);
    expect((await next.readCachedAttachment(filePath)).toString('utf8')).toBe('draft only copy');
  });
});

describe('two writes of one entry at once', () => {
  // Breaks: both write the same temp file; sealed with a fresh IV each, their
  // interleaved bytes never open again (a draft opened while the startup
  // migration seals it).
  it('use separate temp files and leave an entry that opens', async () => {
    const writes = vi.spyOn(promises, 'writeFile');
    await Promise.all([
      seed('acct-a', 'draft-1', 'a.pdf', 'first'),
      seed('acct-a', 'draft-1', 'a.pdf', 'second'),
    ]);
    const temps = writes.mock.calls.map(([target]) => String(target)).filter((target) => target.endsWith('.partial'));
    expect(temps).toHaveLength(2);
    expect(new Set(temps).size).toBe(2);
    expect(['first', 'second']).toContain(await readEntry('acct-a', 'draft-1', 'a.pdf'));
    writes.mockRestore();
  });
});

describe('an unsynced draft saved by an older build', () => {
  const legacyFile = (emailId: string, name: string) => join(legacyAttachmentDir(emailId), name);
  const writeLegacy = (emailId: string, name: string, text: string) => {
    mkdirSync(legacyAttachmentDir(emailId), { recursive: true });
    writeFileSync(legacyFile(emailId, name), text);
  };

  // Breaks: a draft saved offline before this build opens with its attachments
  // missing (their only copy is the old plaintext cache) — or the plaintext stays.
  it('is sealed into the store on first open and the plaintext removed', async () => {
    writeLegacy('draft-1', 'plan.pdf', 'draft plaintext');

    expect(await readEntry('acct-a', 'draft-1', 'plan.pdf')).toBe('draft plaintext');
    expect(existsSync(legacyFile('draft-1', 'plan.pdf'))).toBe(false);
    // Idempotent: the next open is a plain cache hit.
    expect(await readEntry('acct-a', 'draft-1', 'plan.pdf')).toBe('draft plaintext');
  });

  // Breaks: a missing legacy file turns into a crash instead of the usual
  // "cannot fetch" answer for a row with no UID.
  it('still answers 404 when there is no legacy file either', async () => {
    writeLegacy('draft-1', 'other.pdf', 'not this one');

    await expect(entryPath('acct-a', 'draft-1', 'plan.pdf')).rejects.toMatchObject({ status: 404 });
    expect(existsSync(legacyFile('draft-1', 'other.pdf'))).toBe(true);
  });
});
