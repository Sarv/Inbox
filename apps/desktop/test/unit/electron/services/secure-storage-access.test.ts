import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { asPlatformAsync } from '../../../helpers/as-platform';

const h = vi.hoisted(() => ({ authorize: vi.fn(), probe: vi.fn(), restart: vi.fn(), quit: vi.fn(), focus: vi.fn() }));
vi.mock('electron', () => ({ app: { focus: h.focus, quit: h.quit } }));
vi.mock('../../../../electron/services/macos-keychain-access', () => ({ requestMacKeychainAccess: h.authorize }));
vi.mock('../../../../electron/services/secure-storage-startup', () => ({ probeSecureStorage: h.probe }));
vi.mock('../../../../electron/services/secure-storage-relaunch', () => ({ relaunchForSecureStorage: h.restart }));

let requestSecureStorageAccess: typeof import('../../../../electron/services/secure-storage-access')['requestSecureStorageAccess'];
beforeEach(async () => {
  vi.resetModules();
  ({ requestSecureStorageAccess } = await import('../../../../electron/services/secure-storage-access'));
  vi.useFakeTimers(); h.authorize.mockReset(); h.probe.mockReset(); h.restart.mockReset(); h.quit.mockReset(); h.focus.mockReset();
});
afterEach(() => vi.useRealTimers());

describe('native secure-storage access requests', () => {
  it('shares one pending OS prompt across callers and keeps already-working storage in process', async () => {
    await asPlatformAsync('darwin', async () => {
      let resolve!: (value: { status: number; outcome: string }) => void;
      h.authorize.mockReturnValueOnce(new Promise(done => { resolve = done; }));
      h.probe.mockReturnValue(true);
      const first = requestSecureStorageAccess(); const second = requestSecureStorageAccess();
      expect(first).toBe(second); expect(h.authorize).toHaveBeenCalledOnce();
      resolve({ status: 0, outcome: 'authorized' });
      expect(await first).toEqual({ status: 0, outcome: 'authorized', restarting: false });
      expect(h.restart).not.toHaveBeenCalled();
    });
  });

  it.each(['cancelled', 'unavailable'] as const)('does not relaunch or probe after %s authorization', async outcome => {
    await asPlatformAsync('darwin', async () => {
      h.authorize.mockResolvedValueOnce({ status: -128, outcome });
      expect((await requestSecureStorageAccess()).outcome).toBe(outcome);
      expect(h.probe).not.toHaveBeenCalled(); expect(h.restart).not.toHaveBeenCalled();
    });
  });

  it('schedules one clean relaunch when successful OS authorization leaves a failed native cache', async () => {
    await asPlatformAsync('darwin', async () => {
      h.authorize.mockResolvedValueOnce({ status: 0, outcome: 'authorized' }); h.probe.mockReturnValue(false);
      expect(await requestSecureStorageAccess()).toEqual({ status: 0, outcome: 'authorized', restarting: true });
      expect(h.restart).toHaveBeenCalledOnce(); expect(h.quit).not.toHaveBeenCalled();
      await requestSecureStorageAccess();
      expect(h.authorize).toHaveBeenCalledOnce(); expect(h.restart).toHaveBeenCalledOnce();
      await vi.runAllTimersAsync(); expect(h.quit).toHaveBeenCalledOnce();
    });
  });

  it('does not pretend authorization fixed storage when the restart fails', async () => {
    await asPlatformAsync('darwin', async () => {
      h.authorize.mockResolvedValueOnce({ status: 0, outcome: 'authorized' }); h.probe.mockReturnValue(false);
      h.restart.mockImplementationOnce(() => { throw new Error('restart failed'); });
      await expect(requestSecureStorageAccess()).rejects.toThrow('restart failed');
      expect(h.quit).not.toHaveBeenCalled();
    });
  });

  it('does not request Mac authorization on other platforms', async () => {
    await asPlatformAsync('linux', async () => {
      expect((await requestSecureStorageAccess()).outcome).toBe('unavailable');
      expect(h.authorize).not.toHaveBeenCalled(); expect(h.restart).not.toHaveBeenCalled();
    });
  });
});
