import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The Inbox Agent "Tools" switch is read by the main process from the core
// database. What breaks if this goes red: the switch is no longer mirrored
// there, so turning it on in the header changes nothing.

const KEY = 'sarvinbox-inbox-agent';

async function boot(local: Record<string, string>, db: Record<string, string> = {}) {
  const storage = new Map(Object.entries(local));
  const set = vi.fn(async () => undefined);
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, String(value)); },
    removeItem: (key: string) => { storage.delete(key); },
  });
  vi.stubGlobal('window', {
    electronAPI: {
      diagnostics: { setCrashReports: vi.fn(), getCrashReports: vi.fn() },
      identity: { setPolicy: vi.fn(async () => ({ success: true })) },
      appSettings: { getAllSync: () => db, set, delete: vi.fn(async () => undefined) },
    },
    dispatchEvent: vi.fn(),
  });
  vi.resetModules();
  await import('../../../../src/bootstrap/app-settings-sync');
  return { set, storage };
}

beforeEach(() => { vi.resetModules(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('the Inbox Agent setting is mirrored to the core database', () => {
  it('pushes an existing value at boot, restores a lost one, and mirrors every later write', async () => {
    const pushed = await boot({ [KEY]: '{"toolAgent":true}' });
    expect(pushed.set).toHaveBeenCalledWith(KEY, '{"toolAgent":true}');
    const restored = await boot({}, { [KEY]: '{"toolAgent":true}' });
    expect(restored.storage.get(KEY)).toBe('{"toolAgent":true}');
    localStorage.setItem(KEY, '{"toolAgent":false}');
    expect(restored.set).toHaveBeenCalledWith(KEY, '{"toolAgent":false}');
  });
});
