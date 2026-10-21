import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  directory: '', available: true, backend: 'gnome_libsecret', unreadable: false, queryFailure: false,
  blobs: {} as Record<string, string>, versions: {} as Record<string, string>, pgp: [] as Array<{ envelope: string; version?: string; passphrase: number }>, pgpTable: false,
  scanners: [] as Array<{ envelope: string; version: string }>,
  opened: vi.fn(), prepared: [] as string[],
}));

vi.mock('electron', () => ({
  app: { getPath: () => h.directory },
  safeStorage: {
    isEncryptionAvailable: () => h.available,
    getSelectedStorageBackend: () => h.backend,
    decryptString: vi.fn(() => { throw new Error('The status check must never decrypt secrets'); }),
  },
}));
vi.mock('../../../../electron/services/core-db', () => ({
  CORE_DB_FILE: 'sarvinbox-core.db',
  getCoreDb: () => {
    h.opened();
    if (h.unreadable) throw new Error('Database unavailable');
    return {
      prepare: (sql: string) => {
        h.prepared.push(sql);
        return {
          get: (key?: string) => {
            if (sql.includes('count(*)')) return { count: 4 };
            if (sql.includes("name = 'pgp_own_keys'")) return h.pgpTable ? { exists: 1 } : undefined;
            if (sql.includes('core_blobs')) {
              if (h.queryFailure) throw new Error('Cannot read stored metadata');
              return key && key in h.blobs ? { envelope: h.blobs[key], version: h.versions[key] ?? '' } : undefined;
            }
            throw new Error('Unexpected metadata query');
          },
          all: () => sql.includes('antivirus-config:') ? h.scanners : h.pgp,
        };
      },
    };
  },
}));

import { getSecureStorageStatus } from '../../../../electron/services/secure-storage-status';
import { asPlatform } from '../../../helpers/as-platform';

beforeAll(() => { h.directory = mkdtempSync(join(tmpdir(), 'sarvinbox-storage-status-')); });
beforeEach(() => {
  rmSync(h.directory, { recursive: true, force: true });
  mkdirSync(h.directory);
  h.available = true;
  h.backend = 'gnome_libsecret';
  h.unreadable = false;
  h.queryFailure = false;
  h.blobs = {};
  h.versions = {};
  h.pgp = [];
  h.scanners = [];
  h.pgpTable = false;
  h.opened.mockReset();
  h.prepared = [];
});
afterAll(() => { rmSync(h.directory, { recursive: true, force: true }); });

const profile = (key: string = 'ENC1:secret-ciphertext') => {
  writeFileSync(join(h.directory, 'db-key.bin'), key);
  writeFileSync(join(h.directory, 'sarvinbox-core.db'), 'encrypted-database');
};
const macStatus = () => asPlatform('darwin', getSecureStorageStatus);

describe('saved protection is independent of current Keychain availability', () => {
  it('reports plaintext envelopes inside a Keychain-protected database as encrypted at rest', () => {
    profile();
    h.blobs = { 'secure-credentials': 'plaintext', 'oauth-accounts': 'plaintext', 'ai-secrets': 'encrypted' };
    const status = macStatus();
    expect(status).toMatchObject({ platform: 'darwin', keyStore: 'available', databaseKey: 'encrypted', databaseReadable: true });
    expect(status.stores.find(store => store.id === 'credentials')).toMatchObject({
      envelope: 'plaintext', protection: 'encrypted', protectedByDatabase: true,
    });
    expect(status.stores.find(store => store.id === 'oauth-tokens')?.protection).toBe('encrypted');
    expect(JSON.stringify(status)).not.toContain('secret-ciphertext');
    expect(h.prepared.every(sql => !/SELECT\s+(?:data|secret)\b/i.test(sql))).toBe(true);
  });

  it('does not call encrypted records missing or exposed when Keychain is unavailable', () => {
    profile();
    h.available = false;
    h.unreadable = true;
    const status = macStatus();
    expect(status).toMatchObject({ keyStore: 'unavailable', databaseKey: 'encrypted', databaseReadable: false });
    expect(status.stores).toHaveLength(7);
    expect(status.databaseKeyProtection).toBe('encrypted');
    expect(status.stores.every(store => store.envelope === 'unknown' && store.protection === 'unknown' && !store.protectedByDatabase)).toBe(true);
  });

  it('distinguishes exposed plaintext from independently encrypted saved credentials', () => {
    profile('PLAIN1:unprotected-key');
    h.available = false;
    h.blobs = { 'secure-credentials': 'encrypted', 'oauth-accounts': 'plaintext' };
    const status = macStatus();
    expect(status.databaseKey).toBe('plaintext');
    expect(status.stores.find(store => store.id === 'credentials')).toMatchObject({ protection: 'encrypted', protectedByDatabase: false });
    expect(status.stores.find(store => store.id === 'oauth-tokens')).toMatchObject({ protection: 'unprotected', protectedByDatabase: false });
    expect(status.stores.find(store => store.id === 'ai-keys')?.protection).toBe('missing');
  });

  it('keeps failed queries unknown instead of silently treating them as an empty vault', () => {
    profile('PLAIN1:unprotected-key');
    h.queryFailure = true;
    const status = macStatus();
    expect(status.stores.find(store => store.id === 'credentials')).toMatchObject({ envelope: 'unknown', protection: 'unknown' });
  });

  it('does not open or initialize a missing database or manufacture a new key during inspection', () => {
    const status = macStatus();
    expect(status.databaseKey).toBe('missing');
    expect(status.databaseReadable).toBeNull();
    expect(status.stores.every(store => store.protection === 'missing')).toBe(true);
    expect(h.opened).not.toHaveBeenCalled();
  });

  it('does not replace or open an existing database whose key file is absent or unknown', () => {
    profile('BROKEN');
    const status = macStatus();
    expect(status.databaseKey).toBe('unknown');
    expect(status.databaseReadable).toBeNull();
    expect(status.stores.every(store => store.envelope === 'unknown' && store.protection === 'unknown')).toBe(true);
    expect(h.opened).not.toHaveBeenCalled();
  });
});

describe('Linux backend and independent recovery copies', () => {
  it('never calls Chromium basic_text OS-backed protection', () => {
    profile('ENC1:v10weak-ciphertext');
    h.backend = 'basic_text';
    h.blobs = { 'secure-credentials': 'encrypted' };
    h.versions = { 'secure-credentials': 'v10' };
    const status = asPlatform('linux', getSecureStorageStatus);
    expect(status.keyStore).toBe('basic-text');
    expect(status.databaseKeyProtection).toBe('unprotected');
    expect(status.stores.find(store => store.id === 'credentials')).toMatchObject({ protection: 'unprotected', protectedByDatabase: false });
  });

  it('recognizes legacy weak Linux v10 data even after a real keyring becomes available', () => {
    profile('ENC1:v10weak-ciphertext');
    h.blobs = { 'secure-credentials': 'encrypted' };
    h.versions = { 'secure-credentials': 'v10' };
    const status = asPlatform('linux', getSecureStorageStatus);
    expect(status.keyStore).toBe('available');
    expect(status.databaseKeyProtection).toBe('unprotected');
    expect(status.stores.find(store => store.id === 'credentials')?.protection).toBe('unprotected');
  });

  it('uses the stored Linux v11 version to verify protection, without guessing unknown versions', () => {
    profile('ENC1:v11secure-ciphertext');
    h.blobs = { 'secure-credentials': 'plaintext' };
    const status = asPlatform('linux', getSecureStorageStatus);
    expect(status.databaseKeyProtection).toBe('encrypted');
    expect(status.stores.find(store => store.id === 'credentials')?.protection).toBe('encrypted');
    profile('ENC1:v99future-ciphertext');
    expect(asPlatform('linux', getSecureStorageStatus).databaseKeyProtection).toBe('unknown');
  });

  it('does not presume Linux ciphertext is basic_text merely because its keyring is unavailable', () => {
    profile();
    h.available = false;
    h.unreadable = true;
    const status = asPlatform('linux', getSecureStorageStatus);
    expect(status.stores.find(store => store.id === 'credentials')?.protection).toBe('unknown');
  });

  it('reports plaintext legacy backups outside an encrypted database as exposed', () => {
    profile();
    writeFileSync(join(h.directory, 'oauth-accounts.json.bak'), 'PLAIN1:private-token-do-not-return');
    const status = macStatus();
    expect(status.stores.find(store => store.id === 'oauth-tokens-legacy-2')).toMatchObject({
      envelope: 'plaintext', protection: 'unprotected', protectedByDatabase: false,
    });
    expect(JSON.stringify(status)).not.toContain('private-token-do-not-return');
  });
});

describe('OpenPGP private-key envelopes', () => {
  it('recognizes passphrase protection independently of Keychain or the mail key', () => {
    profile('PLAIN1:unprotected-key');
    h.available = false;
    h.pgpTable = true;
    h.pgp = [{ envelope: 'encrypted', passphrase: 1 }];
    expect(macStatus().stores.find(store => store.id === 'pgp-keys')).toMatchObject({
      envelope: 'encrypted', protection: 'encrypted', protectedByDatabase: false,
    });
  });

  it('keeps an unknown private-key format unknown when no database protection covers it', () => {
    profile('PLAIN1:unprotected-key');
    h.pgpTable = true;
    h.pgp = [{ envelope: 'encrypted', passphrase: 1 }, { envelope: 'unknown', passphrase: 0 }];
    expect(macStatus().stores.find(store => store.id === 'pgp-keys')?.protection).toBe('unknown');
  });
});

describe('scanner credentials', () => {
  it('includes existing scanner configurations without returning extension IDs or credentials', () => {
    profile('PLAIN1:unprotected-key');
    h.scanners = [{ envelope: 'encrypted', version: 'v11' }];
    expect(asPlatform('linux', getSecureStorageStatus).stores.find(store => store.id === 'scanner-credentials')).toMatchObject({
      envelope: 'encrypted', protection: 'encrypted', protectedByDatabase: false,
    });
  });
});
