import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The per-account credential vault. The dangerous failure mode here is a
 * read-modify-write that reads an unreadable vault as EMPTY and then persists
 * that — wiping every other account's password. So:
 *   - a present-but-undecodable vault THROWS (never reads as `{}`),
 *   - writes are serialised so two concurrent set() calls can't clobber,
 *   - writing one kind (imap/smtp) never wipes the other,
 *   - blank fields are dropped rather than persisted as empty strings.
 */

const h = vi.hoisted(() => ({ userData: '', encAvailable: true }));

vi.mock('electron', () => ({
  app: { getPath: () => h.userData, getName: () => 'Sarv Inbox Test', isPackaged: false },
  safeStorage: {
    isEncryptionAvailable: () => h.encAvailable,
    encryptString: (s: string) => Buffer.from(`enc(${s})`, 'utf8'),
    decryptString: (b: Buffer) => {
      const m = /^enc\((.*)\)$/s.exec(b.toString('utf8'));
      if (!m) throw new Error('cannot decrypt');
      return m[1];
    },
  },
}));

vi.mock('../../../../electron/services/core-db', async () => await import('../../../../electron/services/__testing__/fake-core-db'));

vi.mock('@sarvinbox/core', () => ({
  createLogger: () => ({
    info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {},
  }),
}));

import { resetFakeCoreDb, state as dbState } from '../../../../electron/services/__testing__/fake-core-db';
import {
  deleteAccountSecrets,
  getAccountSecrets,
  hasAccountSecrets,
  isSecureStorageAvailable,
  legacySecureCredFilesExist,
  migrateSecureCredsFromFile,
  rekeyAccountSecrets,
  setAccountSecrets,
} from '../../../../electron/services/secure-credential-store';

const BLOB_KEY = 'secure-credentials';
const LEGACY = 'secure-credentials.json';

const plainEnvelope = (value: unknown): Buffer => Buffer.from(`PLAIN1:${JSON.stringify(value)}`, 'utf8');

beforeAll(() => { h.userData = mkdtempSync(join(tmpdir(), 'sarvinbox-vault-')); });

beforeEach(() => {
  resetFakeCoreDb();
  h.encAvailable = true;
  rmSync(h.userData, { recursive: true, force: true });
  mkdirSync(h.userData, { recursive: true });
});

afterAll(() => { rmSync(h.userData, { recursive: true, force: true }); });

describe('isSecureStorageAvailable', () => {
  it('mirrors safeStorage so callers can refuse to store plaintext', () => {
    expect(isSecureStorageAvailable()).toBe(true);
    h.encAvailable = false;
    expect(isSecureStorageAvailable()).toBe(false);
  });
});

describe('setAccountSecrets / getAccountSecrets', () => {
  it('round-trips both kinds through the encrypted envelope', async () => {
    await setAccountSecrets('acct-a', {
      imap: { password: 'imap-pw' },
      smtp: { password: 'smtp-pw', refreshToken: 'rt' },
    });
    expect(dbState.blobs.get(BLOB_KEY)!.subarray(0, 5).toString()).toBe('ENC1:');
    await expect(getAccountSecrets('acct-a')).resolves.toEqual({
      imap: { password: 'imap-pw' },
      smtp: { password: 'smtp-pw', refreshToken: 'rt' },
    });
  });

  it('writing SMTP never wipes the stored IMAP password (and vice versa)', async () => {
    await setAccountSecrets('acct-a', { imap: { password: 'imap-pw' } });
    await setAccountSecrets('acct-a', { smtp: { password: 'smtp-pw' } });
    await expect(getAccountSecrets('acct-a')).resolves.toEqual({
      imap: { password: 'imap-pw' },
      smtp: { password: 'smtp-pw' },
    });
    // Re-writing one kind replaces only that kind.
    await setAccountSecrets('acct-a', { imap: { accessToken: 'at' } });
    await expect(getAccountSecrets('acct-a')).resolves.toEqual({
      imap: { accessToken: 'at' },
      smtp: { password: 'smtp-pw' },
    });
  });

  it('drops blank/undefined fields instead of persisting empty strings', async () => {
    await setAccountSecrets('acct-a', {
      imap: { password: 'kept', accessToken: '', refreshToken: undefined },
    });
    await expect(getAccountSecrets('acct-a')).resolves.toEqual({ imap: { password: 'kept' } });
  });

  it('no-ops when there is nothing to store, or no account id', async () => {
    await setAccountSecrets('', { imap: { password: 'x' } });
    await setAccountSecrets('acct-a', {});
    await setAccountSecrets('acct-a', { imap: {}, smtp: { password: '' } });
    expect(dbState.blobs.has(BLOB_KEY)).toBe(false);
    await expect(getAccountSecrets('')).resolves.toBeNull();
    await expect(getAccountSecrets('acct-a')).resolves.toBeNull();
  });

  it('keeps accounts isolated and concurrent writes non-destructive', async () => {
    await Promise.all([
      setAccountSecrets('acct-a', { imap: { password: 'a' } }),
      setAccountSecrets('acct-b', { imap: { password: 'b' } }),
      setAccountSecrets('acct-c', { imap: { password: 'c' } }),
    ]);
    await expect(getAccountSecrets('acct-a')).resolves.toEqual({ imap: { password: 'a' } });
    await expect(getAccountSecrets('acct-b')).resolves.toEqual({ imap: { password: 'b' } });
    await expect(getAccountSecrets('acct-c')).resolves.toEqual({ imap: { password: 'c' } });
  });

  it('uses the marked plaintext envelope when there is no keychain', async () => {
    h.encAvailable = false;
    await setAccountSecrets('acct-a', { imap: { password: 'pw' } });
    expect(dbState.blobs.get(BLOB_KEY)!.subarray(0, 7).toString()).toBe('PLAIN1:');
    await expect(getAccountSecrets('acct-a')).resolves.toEqual({ imap: { password: 'pw' } });
  });
});

describe('an undecodable vault', () => {
  it('THROWS on read rather than reading as empty', async () => {
    dbState.blobs.set(BLOB_KEY, Buffer.from('WAT:{}', 'utf8'));
    await expect(getAccountSecrets('acct-a')).rejects.toThrow('Unknown secure-credentials blob format');
  });

  it('THROWS when encrypted but the keychain is unavailable', async () => {
    dbState.blobs.set(BLOB_KEY, Buffer.from(`ENC1:enc(${JSON.stringify({ a: {} })})`, 'utf8'));
    h.encAvailable = false;
    await expect(getAccountSecrets('acct-a')).rejects.toThrow(
      'Credentials are encrypted but safeStorage is unavailable',
    );
  });

  it('fails the WRITE too, so a locked keychain cannot clobber other accounts', async () => {
    const original = plainEnvelope({ 'acct-other': { imap: { password: 'precious' } } });
    dbState.blobs.set(BLOB_KEY, Buffer.concat([Buffer.from('ENC1:'), original]));
    await expect(setAccountSecrets('acct-a', { imap: { password: 'new' } })).rejects.toThrow();
    // The stored bytes are untouched.
    expect(dbState.blobs.get(BLOB_KEY)!.toString()).toContain('precious');
  });
});

describe('rekeyAccountSecrets', () => {
  it('moves the entry to the canonical id', async () => {
    await setAccountSecrets('acct-old', { imap: { password: 'pw' } });
    await rekeyAccountSecrets('acct-old', 'acct-new');
    await expect(getAccountSecrets('acct-old')).resolves.toBeNull();
    await expect(getAccountSecrets('acct-new')).resolves.toEqual({ imap: { password: 'pw' } });
  });

  it('keeps the canonical entry when BOTH ids have secrets, dropping the old one', async () => {
    await setAccountSecrets('acct-old', { imap: { password: 'old' } });
    await setAccountSecrets('acct-new', { imap: { password: 'new' } });
    await rekeyAccountSecrets('acct-old', 'acct-new');
    await expect(getAccountSecrets('acct-new')).resolves.toEqual({ imap: { password: 'new' } });
    await expect(getAccountSecrets('acct-old')).resolves.toBeNull();
  });

  it('is idempotent and no-ops on missing / equal ids', async () => {
    await rekeyAccountSecrets('', 'acct-new');
    await rekeyAccountSecrets('acct-old', '');
    await rekeyAccountSecrets('same', 'same');
    await rekeyAccountSecrets('never-existed', 'acct-new');
    await expect(getAccountSecrets('acct-new')).resolves.toBeNull();
  });
});

describe('deleteAccountSecrets / hasAccountSecrets', () => {
  it('forgets one account and leaves the others intact', async () => {
    await setAccountSecrets('acct-a', { imap: { password: 'a' } });
    await setAccountSecrets('acct-b', { imap: { password: 'b' } });
    await expect(hasAccountSecrets('acct-a')).resolves.toBe(true);

    await deleteAccountSecrets('acct-a');
    await expect(hasAccountSecrets('acct-a')).resolves.toBe(false);
    await expect(hasAccountSecrets('acct-b')).resolves.toBe(true);
  });

  it('no-ops on an empty id and on an unknown account', async () => {
    await deleteAccountSecrets('');
    await expect(deleteAccountSecrets('nobody')).resolves.toBeUndefined();
    await expect(hasAccountSecrets('')).resolves.toBe(false);
  });
});

describe('legacy secure-credentials.json migration', () => {
  it('migrates on first read and renames the file .premigrated', async () => {
    const vault = { 'acct-a': { imap: { password: 'legacy-pw' } } };
    writeFileSync(join(h.userData, LEGACY), plainEnvelope(vault));

    await expect(getAccountSecrets('acct-a')).resolves.toEqual({ imap: { password: 'legacy-pw' } });
    expect(dbState.blobs.has(BLOB_KEY)).toBe(true);
    expect(existsSync(join(h.userData, LEGACY))).toBe(false);
    expect(existsSync(join(h.userData, `${LEGACY}.premigrated`))).toBe(true);
  });

  it('migrateSecureCredsFromFile forces the migration ahead of the file cleanup', async () => {
    writeFileSync(join(h.userData, LEGACY), plainEnvelope({ 'acct-a': { imap: { password: 'x' } } }));
    await migrateSecureCredsFromFile();
    expect(dbState.blobs.has(BLOB_KEY)).toBe(true);
  });

  it('is a no-op with no legacy file (an empty vault, not an error)', async () => {
    await expect(migrateSecureCredsFromFile()).resolves.toBeUndefined();
    expect(dbState.blobs.has(BLOB_KEY)).toBe(false);
  });

  it('propagates a real read error instead of caching an empty vault', async () => {
    mkdirSync(join(h.userData, LEGACY)); // EISDIR
    await expect(getAccountSecrets('acct-a')).rejects.toThrow();
  });

  it('propagates undecodable legacy bytes (never clobbers them)', async () => {
    writeFileSync(join(h.userData, LEGACY), Buffer.from('WAT:{}', 'utf8'));
    await expect(getAccountSecrets('acct-a')).rejects.toThrow('Unknown secure-credentials blob format');
    expect(existsSync(join(h.userData, LEGACY))).toBe(true);
  });

  it.skipIf(process.platform === 'win32')(
    'keeps the original file when the .premigrated rename fails',
    async () => {
      writeFileSync(join(h.userData, LEGACY), plainEnvelope({ 'acct-a': { imap: { password: 'pw' } } }));
      chmodSync(h.userData, 0o500);
      try {
        await expect(getAccountSecrets('acct-a')).resolves.toEqual({ imap: { password: 'pw' } });
        expect(existsSync(join(h.userData, LEGACY))).toBe(true);
      } finally {
        chmodSync(h.userData, 0o700);
      }
    },
  );
});

describe('legacySecureCredFilesExist', () => {
  it('is true for the file, its .premigrated rename, or a .bak sibling', () => {
    expect(legacySecureCredFilesExist()).toBe(false);
    for (const suffix of ['', '.premigrated', '.bak']) {
      writeFileSync(join(h.userData, LEGACY + suffix), 'x');
      expect(legacySecureCredFilesExist()).toBe(true);
      rmSync(join(h.userData, LEGACY + suffix));
    }
  });
});
