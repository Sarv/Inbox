import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Crash-report consent is main's, not the settings blob's (CASA L-8).
 *
 * What breaks if this file goes red: the settings bootstrap pushes a
 * crash-report choice into main again. It used to, on every launch and every
 * settings write, with `crashReports !== false` — so a profile that had never
 * been asked told main "yes" each boot, "not yet asked" could never exist,
 * and an answer given in the consent dialog was overwritten by the blob's
 * stale copy.
 */

const SETTINGS_KEY = 'sarvinbox-settings';

async function boot(blob: string | null, db: Record<string, string> = {}) {
  const storage = new Map<string, string>();
  if (blob !== null) storage.set(SETTINGS_KEY, blob);
  const setCrashReports = vi.fn(async () => ({ success: true }));
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, String(value)); },
    removeItem: (key: string) => { storage.delete(key); },
  });
  vi.stubGlobal('window', {
    electronAPI: {
      diagnostics: { setCrashReports, getCrashReports: vi.fn() },
      identity: { setPolicy: vi.fn(async () => ({ success: true })) },
      appSettings: { getAllSync: () => db, set: vi.fn(async () => undefined), delete: vi.fn(async () => undefined) },
    },
    dispatchEvent: vi.fn(),
  });
  vi.resetModules();
  await import('../../../../src/bootstrap/app-settings-sync');
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { setCrashReports, storage };
}

beforeEach(() => { vi.resetModules(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('crash-report consent is never pushed from the settings blob', () => {
  // Breaks if boot tells main "yes" for a profile that was never asked
  // (the old default), or replays a legacy blob value over main's answer.
  it.each([
    ['a fresh profile (seeded defaults)', null],
    ['a blob with no crash-report value', JSON.stringify({ signatures: [] })],
    ['a legacy blob saying true', JSON.stringify({ crashReports: true })],
    ['a legacy blob saying false', JSON.stringify({ crashReports: false })],
  ])('sends nothing at boot for %s', async (_label, blob) => {
    const { setCrashReports, storage } = await boot(blob);
    expect(setCrashReports).not.toHaveBeenCalled();
    // And the seeded defaults carry no crash-report choice to replay later.
    if (blob === null) expect('crashReports' in JSON.parse(storage.get(SETTINGS_KEY) ?? '{}')).toBe(false);
  });

  // Breaks if every Settings Save (any write of the blob) overwrites the
  // answer the user gave in the consent dialog.
  it('sends nothing when the settings blob is written', async () => {
    const { setCrashReports } = await boot(JSON.stringify({}), { [SETTINGS_KEY]: JSON.stringify({}) });
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ crashReports: true, maxEmailsPerFolder: 10 }));
    expect(setCrashReports).not.toHaveBeenCalled();
  });
});
