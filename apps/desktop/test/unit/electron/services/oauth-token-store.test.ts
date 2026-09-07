import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * OAuth token store. Same "never read a broken store as empty" rule as the
 * vault (a cached `[]` would make the next save destroy every refresh token),
 * plus a process-lifetime CACHE — so each test re-imports the module together
 * with the fake core-DB it is wired to (`setup()`).
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

type Store = typeof import('../../../../electron/services/oauth-token-store');
type FakeDb = typeof import('../../../../electron/services/__testing__/fake-core-db');

const BLOB_KEY = 'oauth-accounts';
const LEGACY = 'oauth-accounts.json';

/**
 * A fresh store module (the account cache lives at module scope) plus the fake
 * core-DB instance THAT module resolved to — after `resetModules` both live in a
 * new module-registry generation, so they must be imported together.
 */
const setup = async (): Promise<{ store: Store; db: FakeDb['state'] }> => {
  vi.resetModules();
  const fake = await import('../../../../electron/services/__testing__/fake-core-db');
  fake.resetFakeCoreDb();
  const store = await import('../../../../electron/services/oauth-token-store');
  return { store, db: fake.state };
};

const acct = (over: Record<string, unknown> = {}) =>
  ({
    provider: 'gmail',
    email: 'me@gmail.com',
    displayName: 'Me',
    accessToken: 'at',
    refreshToken: 'rt',
    accessExpiresAt: 1_800_000_000,
    updatedAt: 1_700_000_000,
    ...over,
  }) as unknown as Parameters<Store['saveAccount']>[0];

const plainEnvelope = (value: unknown): Buffer => Buffer.from(`PLAIN1:${JSON.stringify(value)}`, 'utf8');

beforeAll(() => { h.userData = mkdtempSync(join(tmpdir(), 'sarvinbox-oauthstore-')); });

beforeEach(() => {
  h.encAvailable = true;
  rmSync(h.userData, { recursive: true, force: true });
  mkdirSync(h.userData, { recursive: true });
});

afterAll(() => { rmSync(h.userData, { recursive: true, force: true }); });

describe('saveAccount / getAccount', () => {
  it('persists through the encrypted envelope and reads back', async () => {
    const { store, db } = await setup();
    await store.saveAccount(acct());
    expect(db.blobs.get(BLOB_KEY)!.subarray(0, 5).toString()).toBe('ENC1:');
    await expect(store.getAccount('gmail' as never, 'me@gmail.com')).resolves.toMatchObject({
      email: 'me@gmail.com', refreshToken: 'rt',
    });
  });

  it('matches on provider + a CASE-INSENSITIVE email', async () => {
    const { store } = await setup();
    await store.saveAccount(acct({ email: 'Me@Gmail.com' }));
    await expect(store.getAccount('gmail' as never, 'me@GMAIL.com')).resolves.toBeTruthy();
    await expect(store.getAccount('microsoft' as never, 'Me@Gmail.com')).resolves.toBeNull();
    await expect(store.getAccount('gmail' as never, 'someone@else.com')).resolves.toBeNull();
  });

  it('REPLACES the entry for the same provider+email rather than duplicating it', async () => {
    const { store } = await setup();
    await store.saveAccount(acct({ accessToken: 'first' }));
    await store.saveAccount(acct({ email: 'ME@gmail.com', accessToken: 'second' }));
    const all = await store.listAccounts();
    expect(all).toHaveLength(1);
    expect(all[0].accessToken).toBe('second');
  });

  it('keeps accounts of different providers with the same address apart', async () => {
    const { store } = await setup();
    await store.saveAccount(acct({ provider: 'gmail' }));
    await store.saveAccount(acct({ provider: 'microsoft' }));
    expect(await store.listAccounts()).toHaveLength(2);
  });

  it('falls back to the marked plaintext envelope without a keychain', async () => {
    h.encAvailable = false;
    const { store, db } = await setup();
    await store.saveAccount(acct());
    expect(db.blobs.get(BLOB_KEY)!.subarray(0, 7).toString()).toBe('PLAIN1:');
    await expect(store.getAccount('gmail' as never, 'me@gmail.com')).resolves.toBeTruthy();
  });
});

describe('loadAccounts', () => {
  it('is [] on a fresh install', async () => {
    const { store } = await setup();
    await expect(store.loadAccounts()).resolves.toEqual([]);
  });

  it('caches for the process lifetime (a later blob change is not re-read)', async () => {
    const { store, db } = await setup();
    db.blobs.set(BLOB_KEY, plainEnvelope([acct()]));
    expect(await store.loadAccounts()).toHaveLength(1);
    db.blobs.set(BLOB_KEY, plainEnvelope([acct(), acct({ provider: 'yahoo' })]));
    expect(await store.loadAccounts()).toHaveLength(1); // served from cache
  });

  it('listAccounts hands out a COPY (callers cannot mutate the store)', async () => {
    const { store } = await setup();
    await store.saveAccount(acct());
    const list = await store.listAccounts();
    list.pop();
    expect(await store.listAccounts()).toHaveLength(1);
  });

  it('THROWS on an undecodable blob rather than caching "no accounts"', async () => {
    const { store, db } = await setup();
    db.blobs.set(BLOB_KEY, Buffer.from('WAT:[]', 'utf8'));
    await expect(store.loadAccounts()).rejects.toThrow('Unknown oauth-accounts blob format');
  });

  it('THROWS when the blob is encrypted but the keychain is unavailable', async () => {
    const { store, db } = await setup();
    db.blobs.set(BLOB_KEY, Buffer.from(`ENC1:enc(${JSON.stringify([acct()])})`, 'utf8'));
    h.encAvailable = false;
    await expect(store.loadAccounts()).rejects.toThrow(
      'Stored tokens are encrypted but safeStorage is unavailable',
    );
  });
});

describe('removeAccount', () => {
  it('removes a matching account (case-insensitively) and reports it', async () => {
    const { store } = await setup();
    await store.saveAccount(acct({ email: 'Me@Gmail.com' }));
    await store.saveAccount(acct({ provider: 'microsoft', email: 'work@outlook.com' }));
    await expect(store.removeAccount('gmail' as never, 'me@gmail.com')).resolves.toBe(true);
    const left = await store.listAccounts();
    expect(left.map((a) => a.provider)).toEqual(['microsoft']);
  });

  it('returns false and persists nothing when there was no match', async () => {
    const { store, db } = await setup();
    await store.saveAccount(acct());
    const before = db.blobs.get(BLOB_KEY);
    await expect(store.removeAccount('yahoo' as never, 'nobody@yahoo.com')).resolves.toBe(false);
    expect(db.blobs.get(BLOB_KEY)).toEqual(before);
  });
});

describe('legacy oauth-accounts.json migration', () => {
  it('migrates the exact envelope bytes into the DB and renames the file', async () => {
    const bytes = plainEnvelope([acct()]);
    writeFileSync(join(h.userData, LEGACY), bytes);
    const { store, db } = await setup();
    expect(await store.listAccounts()).toHaveLength(1);
    expect(db.blobs.get(BLOB_KEY)).toEqual(bytes);
    expect(existsSync(join(h.userData, LEGACY))).toBe(false);
    expect(existsSync(join(h.userData, `${LEGACY}.premigrated`))).toBe(true);
  });

  it('propagates a real read error instead of caching []', async () => {
    mkdirSync(join(h.userData, LEGACY)); // EISDIR
    const { store } = await setup();
    await expect(store.loadAccounts()).rejects.toThrow();
  });

  it('propagates undecodable legacy bytes and leaves the file alone', async () => {
    writeFileSync(join(h.userData, LEGACY), Buffer.from('WAT:[]', 'utf8'));
    const { store } = await setup();
    await expect(store.loadAccounts()).rejects.toThrow('Unknown oauth-accounts blob format');
    expect(existsSync(join(h.userData, LEGACY))).toBe(true);
  });
});

describe('legacyOAuthFilesExist', () => {
  it('is true for the file, its .premigrated rename, or a .bak sibling', async () => {
    const { store } = await setup();
    expect(store.legacyOAuthFilesExist()).toBe(false);
    for (const suffix of ['', '.premigrated', '.bak']) {
      writeFileSync(join(h.userData, LEGACY + suffix), 'x');
      expect(store.legacyOAuthFilesExist()).toBe(true);
      rmSync(join(h.userData, LEGACY + suffix));
    }
  });
});
