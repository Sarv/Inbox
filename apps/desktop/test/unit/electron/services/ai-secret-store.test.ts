import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * AI provider API-key vault. Same envelope rules as the mail credential vault
 * (ENC1 with a keychain, clearly-marked PLAIN1 without), read-modify-write
 * serialised through the write queue, and an empty key DELETES the entry rather
 * than persisting a blank string.
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
  deleteAiSecret,
  getAllAiSecrets,
  isSecureStorageAvailable,
  setAiSecret,
} from '../../../../electron/services/ai-secret-store';

const BLOB_KEY = 'ai-secrets';
const LEGACY = 'ai-secrets.json';

const plainEnvelope = (value: unknown): Buffer => Buffer.from(`PLAIN1:${JSON.stringify(value)}`, 'utf8');

beforeAll(() => { h.userData = mkdtempSync(join(tmpdir(), 'sarvinbox-aisecrets-')); });

beforeEach(() => {
  resetFakeCoreDb();
  h.encAvailable = true;
  rmSync(h.userData, { recursive: true, force: true });
  mkdirSync(h.userData, { recursive: true });
});

afterAll(() => { rmSync(h.userData, { recursive: true, force: true }); });

describe('isSecureStorageAvailable', () => {
  it('mirrors safeStorage', () => {
    expect(isSecureStorageAvailable()).toBe(true);
    h.encAvailable = false;
    expect(isSecureStorageAvailable()).toBe(false);
  });
});

describe('setAiSecret', () => {
  it('stores a key inside the encrypted envelope', async () => {
    await setAiSecret('openai', 'sk-123');
    expect(dbState.blobs.get(BLOB_KEY)!.subarray(0, 5).toString()).toBe('ENC1:');
    await expect(getAllAiSecrets()).resolves.toEqual({ openai: 'sk-123' });
  });

  it('replaces one provider key without touching the others', async () => {
    await setAiSecret('openai', 'sk-1');
    await setAiSecret('gemini', 'gm-1');
    await setAiSecret('openai', 'sk-2');
    await expect(getAllAiSecrets()).resolves.toEqual({ openai: 'sk-2', gemini: 'gm-1' });
  });

  it('an EMPTY key deletes the entry (never persists a blank)', async () => {
    await setAiSecret('openai', 'sk-1');
    await setAiSecret('openai', '');
    await expect(getAllAiSecrets()).resolves.toEqual({});
  });

  it('no-ops without a provider id', async () => {
    await setAiSecret('', 'sk-1');
    expect(dbState.blobs.has(BLOB_KEY)).toBe(false);
  });

  it('concurrent writes do not clobber each other', async () => {
    await Promise.all([
      setAiSecret('openai', 'a'),
      setAiSecret('gemini', 'b'),
      setAiSecret('custom', 'c'),
    ]);
    await expect(getAllAiSecrets()).resolves.toEqual({ openai: 'a', gemini: 'b', custom: 'c' });
  });

  it('falls back to the marked plaintext envelope with no keychain', async () => {
    h.encAvailable = false;
    await setAiSecret('openai', 'sk-1');
    expect(dbState.blobs.get(BLOB_KEY)!.subarray(0, 7).toString()).toBe('PLAIN1:');
    await expect(getAllAiSecrets()).resolves.toEqual({ openai: 'sk-1' });
  });
});

describe('deleteAiSecret', () => {
  it('forgets one provider and keeps the rest', async () => {
    await setAiSecret('openai', 'sk-1');
    await setAiSecret('gemini', 'gm-1');
    await deleteAiSecret('openai');
    await expect(getAllAiSecrets()).resolves.toEqual({ gemini: 'gm-1' });
  });

  it('no-ops on an empty id and on an unknown provider', async () => {
    await deleteAiSecret('');
    await expect(deleteAiSecret('nope')).resolves.toBeUndefined();
  });
});

describe('getAllAiSecrets', () => {
  it('is empty on a fresh install', async () => {
    await expect(getAllAiSecrets()).resolves.toEqual({});
  });

  it('degrades an undecodable blob to EMPTY (keys are re-enterable, unlike mail creds)', async () => {
    dbState.blobs.set(BLOB_KEY, Buffer.from('WAT:{}', 'utf8'));
    await expect(getAllAiSecrets()).resolves.toEqual({});
  });

  it('degrades to empty when encrypted but the keychain is unavailable', async () => {
    dbState.blobs.set(BLOB_KEY, Buffer.from(`ENC1:enc(${JSON.stringify({ openai: 'sk' })})`, 'utf8'));
    h.encAvailable = false;
    await expect(getAllAiSecrets()).resolves.toEqual({});
  });
});

describe('legacy ai-secrets.json migration', () => {
  it('seeds the blob with the exact bytes, then renames the file aside', async () => {
    const bytes = plainEnvelope({ openai: 'sk-legacy' });
    writeFileSync(join(h.userData, LEGACY), bytes);
    await expect(getAllAiSecrets()).resolves.toEqual({ openai: 'sk-legacy' });
    expect(dbState.blobs.get(BLOB_KEY)).toEqual(bytes);
    expect(existsSync(join(h.userData, LEGACY))).toBe(false);
    expect(existsSync(join(h.userData, `${LEGACY}.premigrated`))).toBe(true);
  });

  it('degrades to empty for undecodable legacy bytes, leaving the file alone', async () => {
    writeFileSync(join(h.userData, LEGACY), Buffer.from('WAT:{}', 'utf8'));
    await expect(getAllAiSecrets()).resolves.toEqual({});
    expect(dbState.blobs.has(BLOB_KEY)).toBe(false);
    expect(existsSync(join(h.userData, LEGACY))).toBe(true);
  });

  it('degrades to empty on a real read error (not just ENOENT)', async () => {
    mkdirSync(join(h.userData, LEGACY)); // EISDIR
    await expect(getAllAiSecrets()).resolves.toEqual({});
  });

  it.skipIf(process.platform === 'win32')(
    'still migrates when the rename fails',
    async () => {
      writeFileSync(join(h.userData, LEGACY), plainEnvelope({ openai: 'sk-legacy' }));
      chmodSync(h.userData, 0o500);
      try {
        await expect(getAllAiSecrets()).resolves.toEqual({ openai: 'sk-legacy' });
        expect(existsSync(join(h.userData, LEGACY))).toBe(true);
      } finally {
        chmodSync(h.userData, 0o700);
      }
    },
  );
});
