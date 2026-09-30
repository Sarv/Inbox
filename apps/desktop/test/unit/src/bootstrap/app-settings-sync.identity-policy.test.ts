import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The sender-identity policy the renderer pushes to main (bootstrap/app-settings-sync).
 *
 * What breaks if this file goes red: main owns the Gravatar, BIMI and favicon
 * lookups and does whatever the renderer last pushed. Push the wrong value and
 * the General tab shows one thing while main does another — Gravatar asked
 * about every contact after the reader turned it off, or never asked on a
 * profile where the tab shows it on. Gravatar stays off until the reader
 * explicitly opts in; this pins the push to that rule.
 */

const SETTINGS_KEY = 'sarvinbox-settings';

interface Harness {
  setPolicy: ReturnType<typeof vi.fn>;
  dbSet: ReturnType<typeof vi.fn>;
  dispatchEvent: ReturnType<typeof vi.fn>;
  storage: Map<string, string>;
}

/**
 * Boot the module the way main.tsx does (it runs on import), against an
 * in-memory localStorage and a stubbed preload bridge. `db` present = the
 * durable settings API exists, which also installs the write mirror.
 * `identity`: how main's policy channel behaves (or that it is missing).
 */
async function boot(
  blob: string | null,
  { db, identity = 'ok' }: { db?: Record<string, string>; identity?: 'ok' | 'reject' | 'missing' } = {},
): Promise<Harness> {
  const storage = new Map<string, string>();
  if (blob !== null) storage.set(SETTINGS_KEY, blob);
  const setPolicy = vi.fn(async () => {
    if (identity === 'reject') throw new Error('main is restarting');
    return { success: true };
  });
  const dbSet = vi.fn(async () => undefined);
  const dispatchEvent = vi.fn();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, String(value)); },
    removeItem: (key: string) => { storage.delete(key); },
  });
  vi.stubGlobal('window', {
    electronAPI: {
      ...(identity === 'missing' ? {} : { identity: { setPolicy } }),
      ...(db ? { appSettings: { getAllSync: () => db, set: dbSet, delete: vi.fn(async () => undefined) } } : {}),
    },
    dispatchEvent,
  });
  vi.resetModules();
  await import('../../../../src/bootstrap/app-settings-sync');
  // Let the push's acknowledgement (or rejection) settle.
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { setPolicy, dbSet, dispatchEvent, storage };
}

const policyChangedEvents = (dispatchEvent: ReturnType<typeof vi.fn>) =>
  dispatchEvent.mock.calls.filter(([event]) => (event as Event).type === 'sarvinbox:identity-policy-changed').length;

beforeEach(() => { vi.resetModules(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('sender-identity policy push', () => {
  // Breaks if a profile with no stored Gravatar choice starts probing contacts.
  it('pushes Gravatar off at boot when the settings carry no value for it', async () => {
    const { setPolicy } = await boot(JSON.stringify({ signatures: [] }));
    expect(setPolicy).toHaveBeenCalledWith({ logos: true, favicons: true, gravatar: false });
  });

  // Breaks if a reader's explicit "off" is overridden during boot.
  it('pushes an explicit Gravatar "off" as off', async () => {
    const { setPolicy } = await boot(JSON.stringify({ contactGravatar: false, senderLogos: false }));
    expect(setPolicy).toHaveBeenCalledWith({ logos: false, favicons: true, gravatar: false });
  });

  // Breaks if an explicit "on" is lost.
  it('pushes an explicit Gravatar "on" as on', async () => {
    const { setPolicy } = await boot(JSON.stringify({ contactGravatar: true }));
    expect(setPolicy).toHaveBeenLastCalledWith({ logos: true, favicons: true, gravatar: true });
  });

  // Breaks if an unreadable blob is pushed as "all defaults" — which would turn
  // Gravatar on for a reader whose saved "off" is merely unreadable right now.
  it('pushes nothing when the settings blob cannot be read', async () => {
    const { setPolicy } = await boot('{not json');
    expect(setPolicy).not.toHaveBeenCalled();
  });

  // Breaks if a brand-new profile probes Gravatar before consent.
  it('seeds a fresh profile with Gravatar off and pushes it', async () => {
    const { setPolicy, storage, dbSet } = await boot(null, { db: {} });
    expect(JSON.parse(storage.get(SETTINGS_KEY) ?? '{}').contactGravatar).toBe(false);
    expect(dbSet).toHaveBeenCalledWith(SETTINGS_KEY, expect.any(String));
    expect(setPolicy).toHaveBeenCalledWith({ logos: true, favicons: true, gravatar: false });
  });

  // Breaks if turning Gravatar off in Settings (any later write of the blob)
  // does not reach main until the next launch.
  it('pushes the new policy whenever the settings blob is written', async () => {
    const { setPolicy } = await boot(JSON.stringify({ contactGravatar: true }), { db: { [SETTINGS_KEY]: JSON.stringify({ contactGravatar: true }) } });
    setPolicy.mockClear();

    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ contactGravatar: false }));

    expect(setPolicy).toHaveBeenCalledTimes(1);
    expect(setPolicy).toHaveBeenCalledWith({ logos: true, favicons: true, gravatar: false });
  });

  // Breaks if a blob that parses to something other than an object (null, a
  // number) is pushed as "all defaults" instead of being ignored.
  it('pushes nothing when the stored settings are not an object', async () => {
    for (const blob of ['null', '42']) {
      const { setPolicy } = await boot(blob);
      expect(setPolicy).not.toHaveBeenCalled();
    }
  });

  // Breaks boot on a preload that has no identity channel (an older main, a
  // test window): the push must be skipped, never thrown out of main.tsx.
  it('boots without a policy channel', async () => {
    await expect(boot(JSON.stringify({ contactGravatar: false }), { identity: 'missing' })).resolves.toBeDefined();
  });

  // Breaks if the renderer drops its identity cache before main has applied
  // the policy (showing pictures main has not been told to stop), or if a
  // failed push escapes as an unhandled rejection.
  it('announces the change only once main has acknowledged it', async () => {
    const ok = await boot(JSON.stringify({ contactGravatar: false }));
    expect(policyChangedEvents(ok.dispatchEvent)).toBe(1);

    const refused = await boot(JSON.stringify({ contactGravatar: false }), { identity: 'reject' });
    expect(refused.setPolicy).toHaveBeenCalledTimes(1);
    expect(policyChangedEvents(refused.dispatchEvent)).toBe(0);
  });
});

describe('settings-written announcement', () => {
  const settingsWritten = (dispatchEvent: ReturnType<typeof vi.fn>) =>
    dispatchEvent.mock.calls.filter(([event]) => (event as Event).type === 'sarvinbox:settings-written').length;

  // Breaks: the remote-image mode is kept parsed in memory and re-read only
  // when the settings blob is written; a write this window made (any Settings
  // screen) would leave every open message deciding under the old mode. Only
  // the settings blob announces — other keys do not.
  it('announces every write of the settings blob, and only that key', async () => {
    const { dispatchEvent } = await boot(JSON.stringify({}), { db: { [SETTINGS_KEY]: JSON.stringify({}) } });
    dispatchEvent.mockClear();

    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ remoteImageMode: 'block' }));
    localStorage.setItem('sarvinbox-view-mode', 'list');

    expect(settingsWritten(dispatchEvent)).toBe(1);
  });
});
