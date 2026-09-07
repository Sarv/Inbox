import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Last-good IMAP account store. It is the recovery path for a lost renderer
 * localStorage, so the invariants are: the password never lands unencrypted when
 * a keychain IS available, an unreadable blob reads as `null` (never as a
 * half-decoded config), and the legacy JSON file is migrated exactly once and
 * kept as `.premigrated` rather than deleted.
 */

const h = vi.hoisted(() => ({
  userData: '',
  encAvailable: true,
}));

vi.mock('electron', () => ({
  app: { getPath: () => h.userData, getName: () => 'Sarv Inbox Test', isPackaged: false },
  safeStorage: {
    isEncryptionAvailable: () => h.encAvailable,
    encryptString: (s: string) => Buffer.from(`enc(${s})`, 'utf8'),
    decryptString: (b: Buffer) => {
      const raw = b.toString('utf8');
      const m = /^enc\((.*)\)$/s.exec(raw);
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
  clearImapAccount,
  legacyImapFilesExist,
  loadImapAccount,
  saveImapAccount,
} from '../../../../electron/services/imap-account-store';

const BLOB_KEY = 'imap-account';
const LEGACY = 'imap-account.json';

const config = { host: 'imap.example.com', port: 993, username: 'me@example.com', password: 'hunter2' };

const plainEnvelope = (value: unknown): Buffer =>
  Buffer.from(`PLAIN1:${JSON.stringify(value)}`, 'utf8');
const encEnvelope = (value: unknown): Buffer =>
  Buffer.from(`ENC1:enc(${JSON.stringify(value)})`, 'utf8');

beforeAll(() => { h.userData = mkdtempSync(join(tmpdir(), 'sarvinbox-imapstore-')); });

beforeEach(() => {
  resetFakeCoreDb();
  h.encAvailable = true;
  rmSync(h.userData, { recursive: true, force: true });
  mkdirSync(h.userData, { recursive: true });
});

afterAll(() => { rmSync(h.userData, { recursive: true, force: true }); });

describe('saveImapAccount', () => {
  it('round-trips through the ENCRYPTED envelope when a keychain is available', async () => {
    await saveImapAccount(config);
    const blob = dbState.blobs.get(BLOB_KEY)!;
    expect(blob.subarray(0, 5).toString()).toBe('ENC1:');
    // The plaintext password is not stored verbatim by the store itself.
    expect(blob.toString()).toContain('enc(');
    await expect(loadImapAccount()).resolves.toEqual(config);
  });

  it('falls back to a clearly-MARKED plaintext envelope with no keychain (Linux)', async () => {
    h.encAvailable = false;
    await saveImapAccount(config);
    const blob = dbState.blobs.get(BLOB_KEY)!;
    expect(blob.subarray(0, 7).toString()).toBe('PLAIN1:');
    await expect(loadImapAccount()).resolves.toEqual(config);
  });

  it('no-ops on an incomplete config so a partial connect cannot clobber the good one', async () => {
    await saveImapAccount(config);
    const good = dbState.blobs.get(BLOB_KEY);
    await saveImapAccount(null);
    await saveImapAccount(undefined);
    await saveImapAccount({});
    await saveImapAccount({ host: 'imap.example.com' });
    await saveImapAccount({ username: 'me@example.com' });
    expect(dbState.blobs.get(BLOB_KEY)).toEqual(good);
  });

  it('the last of several overlapping saves wins (writes are serialised)', async () => {
    await Promise.all([
      saveImapAccount({ ...config, username: 'first@example.com' }),
      saveImapAccount({ ...config, username: 'second@example.com' }),
    ]);
    const loaded = await loadImapAccount();
    expect(loaded.username).toBe('second@example.com');
  });
});

describe('loadImapAccount', () => {
  it('is null when nothing has ever been stored', async () => {
    await expect(loadImapAccount()).resolves.toBeNull();
  });

  it('is null (never a throw) for an ENCRYPTED blob with no keychain to open it', async () => {
    dbState.blobs.set(BLOB_KEY, encEnvelope(config));
    h.encAvailable = false;
    await expect(loadImapAccount()).resolves.toBeNull();
  });

  it('is null for an unknown envelope / corrupt JSON', async () => {
    dbState.blobs.set(BLOB_KEY, Buffer.from('GARBAGE:{}', 'utf8'));
    await expect(loadImapAccount()).resolves.toBeNull();
    dbState.blobs.set(BLOB_KEY, Buffer.from('PLAIN1:{not json', 'utf8'));
    await expect(loadImapAccount()).resolves.toBeNull();
  });
});

describe('legacy imap-account.json migration', () => {
  it('migrates a plaintext legacy file into the DB and renames it .premigrated', async () => {
    writeFileSync(join(h.userData, LEGACY), plainEnvelope(config));
    await expect(loadImapAccount()).resolves.toEqual(config);
    expect(dbState.blobs.has(BLOB_KEY)).toBe(true);
    expect(existsSync(join(h.userData, LEGACY))).toBe(false);
    expect(existsSync(join(h.userData, `${LEGACY}.premigrated`))).toBe(true);
    // Subsequent loads come from the blob.
    await expect(loadImapAccount()).resolves.toEqual(config);
  });

  it('migrates an ENCRYPTED legacy file byte-for-byte (same envelope, new container)', async () => {
    const bytes = encEnvelope(config);
    writeFileSync(join(h.userData, LEGACY), bytes);
    await expect(loadImapAccount()).resolves.toEqual(config);
    expect(dbState.blobs.get(BLOB_KEY)).toEqual(bytes);
  });

  it('returns null and does not migrate when the legacy file is undecodable', async () => {
    writeFileSync(join(h.userData, LEGACY), Buffer.from('WAT:{}', 'utf8'));
    await expect(loadImapAccount()).resolves.toBeNull();
    expect(dbState.blobs.has(BLOB_KEY)).toBe(false);
    expect(existsSync(join(h.userData, LEGACY))).toBe(true);
  });

  it('returns null on a real read error (not just ENOENT)', async () => {
    mkdirSync(join(h.userData, LEGACY)); // EISDIR on read
    await expect(loadImapAccount()).resolves.toBeNull();
  });

  it.skipIf(process.platform === 'win32')(
    'still migrates when the .premigrated rename fails (file kept, data safe)',
    async () => {
      writeFileSync(join(h.userData, LEGACY), plainEnvelope(config));
      chmodSync(h.userData, 0o500);
      try {
        await expect(loadImapAccount()).resolves.toEqual(config);
        expect(dbState.blobs.has(BLOB_KEY)).toBe(true);
        expect(existsSync(join(h.userData, LEGACY))).toBe(true);
      } finally {
        chmodSync(h.userData, 0o700);
      }
    },
  );
});

describe('clearImapAccount', () => {
  it('drops the blob and the legacy file', async () => {
    await saveImapAccount(config);
    writeFileSync(join(h.userData, LEGACY), plainEnvelope(config));
    await clearImapAccount();
    expect(dbState.blobs.has(BLOB_KEY)).toBe(false);
    expect(existsSync(join(h.userData, LEGACY))).toBe(false);
    await expect(loadImapAccount()).resolves.toBeNull();
  });

  it('is safe when there is nothing to clear', async () => {
    await expect(clearImapAccount()).resolves.toBeUndefined();
  });
});

describe('legacyImapFilesExist', () => {
  it('is true for the file OR its .premigrated rename, false otherwise', () => {
    expect(legacyImapFilesExist()).toBe(false);
    writeFileSync(join(h.userData, LEGACY), 'x');
    expect(legacyImapFilesExist()).toBe(true);
    rmSync(join(h.userData, LEGACY));
    writeFileSync(join(h.userData, `${LEGACY}.premigrated`), 'x');
    expect(legacyImapFilesExist()).toBe(true);
  });
});
