import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Agent (AI Assist) config mirror. The bug it fixes is "AI Assist is off after a
 * restart", so what matters is: the persisted `enabled` survives, a corrupt blob
 * degrades to OFF instead of throwing at boot, saves MERGE rather than replace,
 * and a persistence failure never breaks the live update.
 */

const h = vi.hoisted(() => ({ userData: '' }));

vi.mock('electron', () => ({
  app: { getPath: () => h.userData, getName: () => 'Sarv Inbox Test', isPackaged: false },
}));

vi.mock('../../../../electron/services/core-db', async () => await import('../../../../electron/services/__testing__/fake-core-db'));

vi.mock('@sarvinbox/core', () => ({
  createLogger: () => ({
    info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {},
  }),
}));

type Store = typeof import('../../../../electron/services/agent-config-store');
type FakeDb = typeof import('../../../../electron/services/__testing__/fake-core-db');

const BLOB_KEY = 'agent-config';
const LEGACY = 'agent-config.json';

/** Fresh module (the config is cached at module scope) + its fake core DB. */
const setup = async (): Promise<{ store: Store; db: FakeDb['state'] }> => {
  vi.resetModules();
  const fake = await import('../../../../electron/services/__testing__/fake-core-db');
  fake.resetFakeCoreDb();
  const store = await import('../../../../electron/services/agent-config-store');
  return { store, db: fake.state };
};

const blobOf = (db: FakeDb['state']): Record<string, unknown> =>
  JSON.parse(db.blobs.get(BLOB_KEY)!.toString('utf8'));

beforeAll(() => { h.userData = mkdtempSync(join(tmpdir(), 'sarvinbox-agentcfg-')); });

beforeEach(() => {
  rmSync(h.userData, { recursive: true, force: true });
  mkdirSync(h.userData, { recursive: true });
});

afterAll(() => { rmSync(h.userData, { recursive: true, force: true }); });

describe('loadAgentConfig', () => {
  it('defaults to an empty config (AI Assist OFF) on a fresh install', async () => {
    const { store } = await setup();
    expect(store.loadAgentConfig()).toEqual({});
  });

  it('reads the persisted config back', async () => {
    const { store, db } = await setup();
    db.blobs.set(BLOB_KEY, Buffer.from(JSON.stringify({ enabled: true, autoRead: false }), 'utf8'));
    expect(store.loadAgentConfig()).toEqual({ enabled: true, autoRead: false });
  });

  it('caches for the process lifetime', async () => {
    const { store, db } = await setup();
    db.blobs.set(BLOB_KEY, Buffer.from(JSON.stringify({ enabled: true }), 'utf8'));
    expect(store.loadAgentConfig().enabled).toBe(true);
    db.blobs.set(BLOB_KEY, Buffer.from(JSON.stringify({ enabled: false }), 'utf8'));
    expect(store.loadAgentConfig().enabled).toBe(true); // cached
  });

  it('degrades a CORRUPT blob to OFF instead of throwing at boot', async () => {
    const { store, db } = await setup();
    db.blobs.set(BLOB_KEY, Buffer.from('{not json', 'utf8'));
    expect(store.loadAgentConfig()).toEqual({});
  });
});

describe('legacy agent-config.json migration', () => {
  it('seeds the blob FIRST and then renames the file aside', async () => {
    writeFileSync(join(h.userData, LEGACY), JSON.stringify({ enabled: true }));
    const { store, db } = await setup();
    expect(store.loadAgentConfig()).toEqual({ enabled: true });
    expect(blobOf(db)).toEqual({ enabled: true });
    expect(existsSync(join(h.userData, LEGACY))).toBe(false);
    expect(existsSync(join(h.userData, `${LEGACY}.premigrated`))).toBe(true);
  });

  it('defaults to OFF for a malformed legacy file', async () => {
    writeFileSync(join(h.userData, LEGACY), 'not json');
    const { store, db } = await setup();
    expect(store.loadAgentConfig()).toEqual({});
    expect(db.blobs.has(BLOB_KEY)).toBe(false);
  });

  it.skipIf(process.platform === 'win32')(
    'still migrates when the rename fails (blob already written)',
    async () => {
      writeFileSync(join(h.userData, LEGACY), JSON.stringify({ enabled: true }));
      chmodSync(h.userData, 0o500);
      try {
        const { store, db } = await setup();
        expect(store.loadAgentConfig()).toEqual({ enabled: true });
        expect(db.blobs.has(BLOB_KEY)).toBe(true);
      } finally {
        chmodSync(h.userData, 0o700);
      }
    },
  );
});

describe('saveAgentConfig', () => {
  it('MERGES the patch into the stored config', async () => {
    const { store, db } = await setup();
    store.saveAgentConfig({ enabled: true, maxAutoActionsPerHour: 10 });
    store.saveAgentConfig({ enabled: false });
    expect(blobOf(db)).toEqual({ enabled: false, maxAutoActionsPerHour: 10 });
    expect(store.loadAgentConfig()).toEqual({ enabled: false, maxAutoActionsPerHour: 10 });
  });

  it('merges on top of a config loaded from disk', async () => {
    const { store, db } = await setup();
    db.blobs.set(BLOB_KEY, Buffer.from(JSON.stringify({ enabled: true, autoRead: true }), 'utf8'));
    store.saveAgentConfig({ autoRead: false });
    expect(blobOf(db)).toEqual({ enabled: true, autoRead: false });
  });

  it('never throws when persistence fails — the live update still applies', async () => {
    const { store, db } = await setup();
    db.failBlobWrite = true;
    expect(() => store.saveAgentConfig({ enabled: true })).not.toThrow();
    // The in-memory cache still carries the user's change.
    expect(store.loadAgentConfig().enabled).toBe(true);
    expect(db.blobs.has(BLOB_KEY)).toBe(false);
  });
});
