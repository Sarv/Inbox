import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ base: '', confirm: vi.fn(), relaunch: vi.fn(), quit: vi.fn() }));
vi.mock('electron', () => ({
  app: { getName: () => 'Sarv Inbox', getPath: (name: string) => name === 'appData' ? h.base : join(h.base, 'Sarv Inbox'), relaunch: h.relaunch, quit: h.quit },
  dialog: { showMessageBox: h.confirm },
  get safeStorage() { throw new Error('An isolated local reset must not access Keychain'); },
}));
vi.mock('../../../../../../scripts/lib/profile-reset.mjs', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../../../../scripts/lib/profile-reset.mjs')>();
  // Only the OS process probe is substituted. Erasure, locking and path checks
  // are the production implementation, operating exclusively in this scratch root.
  const processes = () => [{ pid: process.pid, command: 'node isolated reset test' }];
  return {
    ...actual,
    getResetProfiles: (options: object) => actual.getResetProfiles({ ...options, readProcesses: processes }),
    eraseProfile: (options: Parameters<typeof actual.eraseProfile>[0]) => actual.eraseProfile({ ...options, readProcesses: processes }),
  };
});

const seed = (profile: string, file: string) => {
  const target = join(h.base, profile, file); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, 'disposable fixture');
};
beforeEach(() => {
  vi.resetModules(); vi.resetAllMocks(); vi.useFakeTimers();
  vi.stubEnv('SARVINBOX_LOCAL_DATA_RESET', undefined); vi.stubEnv('SARVINBOX_KEYCHAIN_RELAUNCH', undefined);
  h.base = realpathSync(mkdtempSync(join(tmpdir(), 'inbox-reset-flow-')));
  for (const file of ['sarvinbox-core.db', 'db-key.bin', 'sarvinbox-orphan.db-wal', 'ai-secrets.json.premigrated', 'attachment-store/a/file.bin', 'attachment-previews/file', 'Network/Cookies', 'unknown-new-store/data']) seed('Sarv Inbox', file);
  seed('Sarv Inbox Dev', 'keep.txt');
  h.confirm.mockResolvedValue({ response: 1 });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); rmSync(h.base, { recursive: true, force: true }); });

describe('scratch-only confirmed reset through fresh startup', () => {
  it('removes the whole selected profile only after confirmed handoff, preserving the other profile', async () => {
    let service = await import('../../../../electron/services/local-data-reset');
    const parent = { isDestroyed: () => false } as unknown as Parameters<typeof service.eraseLocalData>[1];
    expect(await service.eraseLocalData({ profile: 'production', confirmation: 'ERASE production' }, parent)).toEqual({ restarting: true });
    expect(existsSync(join(h.base, 'Sarv Inbox', 'sarvinbox-core.db'))).toBe(true);
    expect(process.env.SARVINBOX_LOCAL_DATA_RESET).toMatch(/^[a-f0-9]{32}:/);
    await vi.runAllTimersAsync(); expect(h.quit).toHaveBeenCalledOnce();
    // Simulate the fresh main process. The one-use ticket and actual eraser are
    // real; no app process is launched and no production directory is reachable.
    vi.resetModules(); service = await import('../../../../electron/services/local-data-reset');
    expect(service.initializeLocalDataReset()).toEqual({ erased: true });
    expect(existsSync(join(h.base, 'Sarv Inbox'))).toBe(false);
    expect(readFileSync(join(h.base, 'Sarv Inbox Dev', 'keep.txt'), 'utf8')).toBe('disposable fixture');
    expect(process.env.SARVINBOX_LOCAL_DATA_RESET).toBeUndefined();
    expect(existsSync(join(h.base, '.sarvinbox-profile-reset-production.lock'))).toBe(false);
  });
  it('normal reinstall/startup leaves every fixture and saved sign-in intact', async () => {
    const service = await import('../../../../electron/services/local-data-reset');
    expect(service.initializeLocalDataReset()).toEqual({ erased: false });
    for (const file of ['sarvinbox-core.db', 'db-key.bin', 'Network/Cookies', 'unknown-new-store/data']) {
      expect(readFileSync(join(h.base, 'Sarv Inbox', file), 'utf8')).toBe('disposable fixture');
    }
    expect(h.confirm).not.toHaveBeenCalled(); expect(h.relaunch).not.toHaveBeenCalled();
  });
});
