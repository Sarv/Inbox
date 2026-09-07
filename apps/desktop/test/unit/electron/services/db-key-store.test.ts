import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The SQLCipher key store. Losing/regenerating this key makes every encrypted DB
 * unreadable, so the invariants are: mint ONCE, cache for the process lifetime,
 * write atomically (tmp + rename), and never silently "recover" an unreadable
 * key file by minting a new one — it throws instead.
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

vi.mock('@sarvinbox/core', () => ({
  createLogger: () => ({
    info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {},
  }),
}));

type Store = typeof import('../../../../electron/services/db-key-store');

const FILE = 'db-key.bin';

/** Fresh module — the key is cached at module scope for the process lifetime. */
const load = async (): Promise<Store> => {
  vi.resetModules();
  return import('../../../../electron/services/db-key-store');
};

beforeAll(() => { h.userData = mkdtempSync(join(tmpdir(), 'sarvinbox-dbkey-')); });

beforeEach(() => {
  h.encAvailable = true;
  rmSync(h.userData, { recursive: true, force: true });
  mkdirSync(h.userData, { recursive: true });
});

afterAll(() => { rmSync(h.userData, { recursive: true, force: true }); });

describe('getDbEncryptionKey', () => {
  it('mints a 256-bit hex key on first run and persists it encrypted', async () => {
    const store = await load();
    const key = store.getDbEncryptionKey();
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    const bytes = readFileSync(join(h.userData, FILE));
    expect(bytes.subarray(0, 5).toString()).toBe('ENC1:');
    expect(bytes.toString()).toBe(`ENC1:enc(${key})`);
    // The atomic-write temp file is gone (renamed into place).
    expect(existsSync(join(h.userData, `${FILE}.tmp`))).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('writes the key file 0600 (owner-only)', async () => {
    const store = await load();
    store.getDbEncryptionKey();
    expect(statSync(join(h.userData, FILE)).mode & 0o777).toBe(0o600);
  });

  it('returns the SAME key on every later call, without re-reading the file', async () => {
    const store = await load();
    const first = store.getDbEncryptionKey();
    rmSync(join(h.userData, FILE));
    expect(store.getDbEncryptionKey()).toBe(first);
  });

  it('reads an existing key back on the next app start', async () => {
    const first = (await load()).getDbEncryptionKey();
    const second = (await load()).getDbEncryptionKey();
    expect(second).toBe(first);
  });

  it('falls back to a MARKED plaintext key file when there is no keychain (Linux)', async () => {
    h.encAvailable = false;
    const store = await load();
    const key = store.getDbEncryptionKey();
    expect(readFileSync(join(h.userData, FILE)).toString()).toBe(`PLAIN1:${key}`);
    // ...and it round-trips on the next start.
    expect((await load()).getDbEncryptionKey()).toBe(key);
  });

  it('THROWS on an encrypted key file with no keychain to open it (never re-mints)', async () => {
    (await load()).getDbEncryptionKey();
    h.encAvailable = false;
    const store = await load();
    expect(() => store.getDbEncryptionKey()).toThrow(
      'DB key is encrypted but safeStorage is unavailable',
    );
  });

  it('THROWS on an unknown key-file format', async () => {
    writeFileSync(join(h.userData, FILE), Buffer.from('WAT:abc', 'utf8'));
    const store = await load();
    expect(() => store.getDbEncryptionKey()).toThrow('Unknown db-key file format');
  });
});

describe('isDbKeyEncryptionAvailable', () => {
  it('reports whether the OS keychain protects the key', async () => {
    const store = await load();
    expect(store.isDbKeyEncryptionAvailable()).toBe(true);
    h.encAvailable = false;
    expect(store.isDbKeyEncryptionAvailable()).toBe(false);
  });
});
