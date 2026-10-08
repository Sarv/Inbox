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

const h = vi.hoisted(() => ({ userData: '', encAvailable: true, backend: 'gnome_libsecret' }));

vi.mock('electron', () => ({
  app: { getPath: () => h.userData, getName: () => 'Sarv Inbox Test', isPackaged: false },
  safeStorage: {
    isEncryptionAvailable: () => h.encAvailable,
    // Linux only in Electron; a real keyring unless a test says otherwise.
    getSelectedStorageBackend: () => h.backend,
    encryptString: (s: string) => Buffer.from(`enc(${s})`, 'utf8'),
    decryptString: (b: Buffer) => {
      const m = /^enc\((.*)\)$/s.exec(b.toString('utf8'));
      if (!m) throw new Error('cannot decrypt');
      return m[1];
    },
  },
}));

vi.mock('../../../../electron/services/core-db', async () => await import('../../../../electron/services/__testing__/fake-core-db'));

vi.mock('@sarvinbox/core', async (orig) => ({
  ...(await orig<typeof import('@sarvinbox/core')>()),
  createLogger: () => ({
    info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {},
  }),
}));

import { resetFakeCoreDb, state as dbState } from '../../../../electron/services/__testing__/fake-core-db';
import {
  deleteAiSecret,
  getAllAiSecrets,
  listAiSecretIds,
  resolveAiKey,
  revertAiSecret,
  isSecureStorageAvailable,
  setAiSecret,
} from '../../../../electron/services/ai-secret-store';
import { asPlatform } from '../../../helpers/as-platform';

const BLOB_KEY = 'ai-secrets';
const LEGACY = 'ai-secrets.json';

const plainEnvelope = (value: unknown): Buffer => Buffer.from(`PLAIN1:${JSON.stringify(value)}`, 'utf8');

beforeAll(() => { h.userData = mkdtempSync(join(tmpdir(), 'sarvinbox-aisecrets-')); });

beforeEach(() => {
  resetFakeCoreDb();
  h.encAvailable = true;
  h.backend = 'gnome_libsecret';
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

  // Changed deliberately: delete now returns the id of its write (for undo),
  // so this asserts the vault is untouched rather than an undefined result.
  it('no-ops on an empty id and on an unknown provider', async () => {
    await setAiSecret('openai', 'sk-1');
    await expect(deleteAiSecret('')).resolves.toBeUndefined();
    await deleteAiSecret('nope');
    await expect(getAllAiSecrets()).resolves.toEqual({ openai: 'sk-1' });
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

describe('origin binding', () => {
  // A key is bound to the endpoint it was saved for; main only ever attaches
  // it to requests on that origin. The URL and provider id come from the
  // renderer, which also renders untrusted email HTML.
  it('returns the key only for the origin it was saved for', async () => {
    await setAiSecret('p1', 'sk-1', 'https://api.openai.com/v1');
    await expect(resolveAiKey('p1', 'https://api.openai.com/v1/chat/completions')).resolves.toEqual({ status: 'found', key: 'sk-1' });
    // THE leak. Breaks: the user's OpenAI key is sent to a renderer-chosen server.
    await expect(resolveAiKey('p1', 'https://evil.example/v1/chat/completions')).resolves.toEqual({
      status: 'origin-mismatch', boundOrigin: 'https://api.openai.com',
    });
    // Scheme and port are part of the origin.
    await expect(resolveAiKey('p1', 'http://api.openai.com/v1')).resolves.toMatchObject({ status: 'origin-mismatch' });
    await expect(resolveAiKey('p1', 'https://api.openai.com:8443/v1')).resolves.toMatchObject({ status: 'origin-mismatch' });
  });

  it('is none for an unknown provider, a missing id, or a URL that is not one', async () => {
    await setAiSecret('p1', 'sk-1', 'https://api.openai.com/v1');
    await expect(resolveAiKey('p2', 'https://api.openai.com/v1')).resolves.toEqual({ status: 'none' });
    await expect(resolveAiKey('', 'https://api.openai.com/v1')).resolves.toEqual({ status: 'none' });
    await expect(resolveAiKey('p1', 'file:///etc/passwd')).resolves.toEqual({ status: 'none' });
    await expect(resolveAiKey('p1', undefined)).resolves.toEqual({ status: 'none' });
  });

  // Upgrade path. Breaks: every key saved before binding stops working.
  it('binds a pre-binding (bare string) key to the first origin it is used with', async () => {
    dbState.blobs.set(BLOB_KEY, plainEnvelope({ legacy: 'sk-old' }));
    await expect(resolveAiKey('legacy', 'https://api.openai.com/v1/models')).resolves.toEqual({ status: 'found', key: 'sk-old' });
    await expect(resolveAiKey('legacy', 'https://evil.example/v1')).resolves.toMatchObject({ status: 'origin-mismatch' });
    await expect(getAllAiSecrets()).resolves.toEqual({ legacy: 'sk-old' });
  });

  // A key saved without an endpoint (none given) is bound on first use too.
  it('binds a key saved without a base URL on first use', async () => {
    await setAiSecret('p1', 'sk-1');
    await expect(resolveAiKey('p1', 'https://generativelanguage.googleapis.com/v1beta/models')).resolves.toMatchObject({ status: 'found' });
    await expect(resolveAiKey('p1', 'https://api.openai.com/v1')).resolves.toMatchObject({ status: 'origin-mismatch' });
  });

  // The renderer saves a key and immediately pushes a config naming it.
  // Breaks: the push races the write and the pipeline starts with no key.
  it('sees a key whose write was queued just before the lookup', async () => {
    const write = setAiSecret('p1', 'sk-1', 'https://api.openai.com/v1');
    const lookup = resolveAiKey('p1', 'https://api.openai.com/v1');
    await write;
    await expect(lookup).resolves.toEqual({ status: 'found', key: 'sk-1' });
  });

  it('lists only the ids that have a key — never the keys', async () => {
    await setAiSecret('p1', 'sk-1', 'https://api.openai.com/v1');
    await setAiSecret('p2', 'gm-1', 'https://generativelanguage.googleapis.com/v1beta');
    await expect(listAiSecretIds()).resolves.toEqual(['p1', 'p2']);
  });
});

describe('writes while the keychain is unavailable', () => {
  // A transient keychain outage must not become permanent key loss. Breaks:
  // the empty degraded read is written back over every saved key.
  it('refuses to write over an encrypted vault it cannot read right now', async () => {
    await setAiSecret('p1', 'sk-1', 'https://api.openai.com/v1');
    const before = dbState.blobs.get(BLOB_KEY);
    h.encAvailable = false;
    await expect(setAiSecret('p2', 'sk-2')).rejects.toThrow(/cannot be read right now/);
    await expect(deleteAiSecret('p1')).rejects.toThrow(/cannot be read right now/);
    expect(dbState.blobs.get(BLOB_KEY)).toEqual(before);
    h.encAvailable = true;
    await expect(getAllAiSecrets()).resolves.toEqual({ p1: 'sk-1' });
  });

  // An unknown format is corrupt for good; keys are re-enterable.
  it('may overwrite a blob in an unknown format', async () => {
    dbState.blobs.set(BLOB_KEY, Buffer.from('WAT:{}', 'utf8'));
    await setAiSecret('p1', 'sk-1');
    await expect(getAllAiSecrets()).resolves.toEqual({ p1: 'sk-1' });
  });
});

describe('revertAiSecret (undo one write)', () => {
  // A settings edit that fails or is cancelled after writing its key must put
  // the old key back — main does it, since the renderer never held the old
  // key. Breaks: a cancelled edit leaves the new (or no) key in place.
  it('restores the key a write replaced, and removes a key a write created', async () => {
    await setAiSecret('p1', 'old', 'https://api.openai.com/v1');
    const edit = await setAiSecret('p1', 'new', 'https://api.openai.com/v1');
    await revertAiSecret('p1', edit!);
    await expect(getAllAiSecrets()).resolves.toEqual({ p1: 'old' });
    await expect(resolveAiKey('p1', 'https://api.openai.com/v1')).resolves.toEqual({ status: 'found', key: 'old' });

    const created = await setAiSecret('p2', 'fresh');
    await revertAiSecret('p2', created!);
    await expect(getAllAiSecrets()).resolves.toEqual({ p1: 'old' });
  });

  it('undoes a delete', async () => {
    await setAiSecret('p1', 'keep-me');
    const removal = await deleteAiSecret('p1');
    await revertAiSecret('p1', removal!);
    await expect(getAllAiSecrets()).resolves.toEqual({ p1: 'keep-me' });
  });

  // THE race. Breaks: undoing a stale write overwrites a newer key the user
  // saved meanwhile with an older one.
  it('is a no-op once a newer write has landed, and when repeated', async () => {
    await setAiSecret('p1', 'old');
    const stale = await setAiSecret('p1', 'stale-edit');
    await setAiSecret('p1', 'newer');
    await revertAiSecret('p1', stale!);
    await expect(getAllAiSecrets()).resolves.toEqual({ p1: 'newer' });

    const latest = await setAiSecret('p1', 'latest');
    await revertAiSecret('p1', latest!);
    await revertAiSecret('p1', latest!);
    await expect(getAllAiSecrets()).resolves.toEqual({ p1: 'newer' });
  });

  it('ignores unknown providers and write ids', async () => {
    await setAiSecret('p1', 'k');
    await revertAiSecret('nope', 1);
    await revertAiSecret('p1', 999_999);
    await revertAiSecret('', 1);
    await expect(getAllAiSecrets()).resolves.toEqual({ p1: 'k' });
  });
});

describe('Linux without a system keyring (basic_text)', () => {
  // Chromium's basic_text backend "encrypts" with a key published in its
  // source, and isEncryptionAvailable() still says true. Breaks if reported as
  // encrypted: the user is never warned that saved AI keys are readable by anyone
  // who copies the profile (CASA M-1).
  it('reports storage as NOT secure on basic_text', () => asPlatform('linux', () => {
    h.backend = 'basic_text';
    expect(isSecureStorageAvailable()).toBe(false);
    h.backend = 'kwallet5';
    expect(isSecureStorageAvailable()).toBe(true);
  }));
});
