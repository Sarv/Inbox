import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Persisted pipeline AI provider config — the fix for "AI is off after a
 * restart". Invariants: only SERIALIZABLE fields are stored (never the
 * `resolveBearer` / `fetchImpl` closures), an unreadable copy loads as `null`
 * (the pipeline then waits for the renderer push instead of crashing), and a
 * persist failure never breaks the live config update.
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
  clearPipelineAIConfig,
  loadPipelineAIConfigSync,
  savePipelineAIConfig,
} from '../../../../electron/services/pipeline-ai-config-store';

const BLOB_KEY = 'pipeline-ai-config';
const LEGACY = 'pipeline-ai-config.json';

const config = (over: Record<string, unknown> = {}) =>
  ({
    type: 'openai',
    apiKey: 'sk-123',
    model: 'gpt-5',
    baseUrl: 'https://api.example.com',
    authMethod: 'apiKey',
    ...over,
  }) as unknown as Parameters<typeof savePipelineAIConfig>[0];

const plainEnvelope = (value: unknown): Buffer => Buffer.from(`PLAIN1:${JSON.stringify(value)}`, 'utf8');

beforeAll(() => { h.userData = mkdtempSync(join(tmpdir(), 'sarvinbox-pipelinecfg-')); });

beforeEach(() => {
  resetFakeCoreDb();
  h.encAvailable = true;
  rmSync(h.userData, { recursive: true, force: true });
  mkdirSync(h.userData, { recursive: true });
});

afterAll(() => { rmSync(h.userData, { recursive: true, force: true }); });

describe('savePipelineAIConfig', () => {
  it('round-trips the serializable fields through the encrypted envelope', async () => {
    await savePipelineAIConfig(config());
    expect(dbState.blobs.get(BLOB_KEY)!.subarray(0, 5).toString()).toBe('ENC1:');
    expect(loadPipelineAIConfigSync()).toEqual({
      type: 'openai',
      apiKey: 'sk-123',
      model: 'gpt-5',
      baseUrl: 'https://api.example.com',
      authMethod: 'apiKey',
      oauthProvider: undefined,
      oauthEmail: undefined,
    });
  });

  it('NEVER persists the non-serializable closures', async () => {
    await savePipelineAIConfig(config({
      resolveBearer: async () => 'token',
      fetchImpl: () => Promise.resolve(new Response()),
    }));
    const stored = dbState.blobs.get(BLOB_KEY)!.toString('utf8');
    expect(stored).not.toContain('resolveBearer');
    expect(stored).not.toContain('fetchImpl');
  });

  it('keeps an OAuth (Sarv) provider identifiable with an empty apiKey', async () => {
    await savePipelineAIConfig(config({
      apiKey: undefined, authMethod: 'oauth', oauthProvider: 'sarv', oauthEmail: 'me@sarv.com',
    }));
    expect(loadPipelineAIConfigSync()).toMatchObject({
      apiKey: '', authMethod: 'oauth', oauthProvider: 'sarv', oauthEmail: 'me@sarv.com',
    });
  });

  it('ignores a config with no provider type', async () => {
    await savePipelineAIConfig(config({ type: undefined }));
    await savePipelineAIConfig(undefined as unknown as Parameters<typeof savePipelineAIConfig>[0]);
    expect(dbState.blobs.has(BLOB_KEY)).toBe(false);
  });

  it('uses the marked plaintext envelope with no keychain', async () => {
    h.encAvailable = false;
    await savePipelineAIConfig(config());
    expect(dbState.blobs.get(BLOB_KEY)!.subarray(0, 7).toString()).toBe('PLAIN1:');
    expect(loadPipelineAIConfigSync()).toMatchObject({ model: 'gpt-5' });
  });

  it('never throws when the DB write fails', async () => {
    dbState.failBlobWrite = true;
    await expect(savePipelineAIConfig(config())).resolves.toBeUndefined();
  });

  it('serialises overlapping pushes — the last one wins', async () => {
    await Promise.all([
      savePipelineAIConfig(config({ model: 'first' })),
      savePipelineAIConfig(config({ model: 'second' })),
    ]);
    expect(loadPipelineAIConfigSync()!.model).toBe('second');
  });
});

describe('loadPipelineAIConfigSync', () => {
  it('is null on a fresh install', () => {
    expect(loadPipelineAIConfigSync()).toBeNull();
  });

  it('is null (not a throw) for an undecodable blob', () => {
    dbState.blobs.set(BLOB_KEY, Buffer.from('WAT:{}', 'utf8'));
    expect(loadPipelineAIConfigSync()).toBeNull();
  });

  it('is null when encrypted but the keychain is unavailable', () => {
    dbState.blobs.set(BLOB_KEY, Buffer.from(`ENC1:enc(${JSON.stringify({ type: 'openai' })})`, 'utf8'));
    h.encAvailable = false;
    expect(loadPipelineAIConfigSync()).toBeNull();
  });
});

describe('legacy pipeline-ai-config.json migration', () => {
  it('seeds the blob with the same bytes, then renames the file aside', () => {
    const bytes = plainEnvelope({ type: 'gemini', apiKey: 'k', model: 'flash' });
    writeFileSync(join(h.userData, LEGACY), bytes);
    expect(loadPipelineAIConfigSync()).toMatchObject({ type: 'gemini', model: 'flash' });
    expect(dbState.blobs.get(BLOB_KEY)).toEqual(bytes);
    expect(existsSync(join(h.userData, LEGACY))).toBe(false);
    expect(existsSync(join(h.userData, `${LEGACY}.premigrated`))).toBe(true);
  });

  it('is null for undecodable legacy bytes, and leaves the file in place', () => {
    writeFileSync(join(h.userData, LEGACY), Buffer.from('WAT:{}', 'utf8'));
    expect(loadPipelineAIConfigSync()).toBeNull();
    expect(dbState.blobs.has(BLOB_KEY)).toBe(false);
    expect(existsSync(join(h.userData, LEGACY))).toBe(true);
  });

  it('is null on a real read error (not just ENOENT)', () => {
    mkdirSync(join(h.userData, LEGACY)); // EISDIR
    expect(loadPipelineAIConfigSync()).toBeNull();
  });

  it.skipIf(process.platform === 'win32')('still migrates when the rename fails', () => {
    writeFileSync(join(h.userData, LEGACY), plainEnvelope({ type: 'gemini', apiKey: '', model: 'm' }));
    chmodSync(h.userData, 0o500);
    try {
      expect(loadPipelineAIConfigSync()).toMatchObject({ type: 'gemini' });
      expect(existsSync(join(h.userData, LEGACY))).toBe(true);
    } finally {
      chmodSync(h.userData, 0o700);
    }
  });
});

describe('clearPipelineAIConfig', () => {
  it('drops the blob and the legacy file', async () => {
    await savePipelineAIConfig(config());
    writeFileSync(join(h.userData, LEGACY), plainEnvelope({ type: 'openai' }));
    await clearPipelineAIConfig();
    expect(dbState.blobs.has(BLOB_KEY)).toBe(false);
    expect(existsSync(join(h.userData, LEGACY))).toBe(false);
    expect(loadPipelineAIConfigSync()).toBeNull();
  });

  it('is quiet when there is no legacy file to unlink', async () => {
    await expect(clearPipelineAIConfig()).resolves.toBeUndefined();
  });

  it('logs but does not throw on a non-ENOENT unlink failure', async () => {
    mkdirSync(join(h.userData, LEGACY)); // unlink on a directory -> EPERM/EISDIR
    await expect(clearPipelineAIConfig()).resolves.toBeUndefined();
    expect(existsSync(join(h.userData, LEGACY))).toBe(true);
  });
});
