import { readFileSync } from 'node:fs';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({
  available: vi.fn(), encrypt: vi.fn(), decrypt: vi.fn(), ready: vi.fn(),
  relaunch: vi.fn(), quit: vi.fn(), show: vi.fn(), showError: vi.fn(), focus: vi.fn(), authorize: vi.fn(),
}));
vi.mock('electron', () => ({
  app: { whenReady: native.ready, relaunch: native.relaunch, quit: native.quit, focus: native.focus },
  dialog: { showMessageBox: native.show, showErrorBox: native.showError },
  safeStorage: { encryptString: native.encrypt, decryptString: native.decrypt },
}));
vi.mock('../../../../electron/services/os-encryption', () => ({ isOsBackedEncryption: native.available }));
vi.mock('../../../../electron/services/macos-keychain-access', () => ({ requestMacKeychainAccess: native.authorize }));

import { ensureSecureStorageForStartup, probeSecureStorage, reportStartupInitializationFailure, startupRecoveryOptions, type SecureStorageStartupDeps } from '../../../../electron/services/secure-storage-startup';

beforeEach(() => {
  vi.resetAllMocks(); native.available.mockReturnValue(true);
  native.encrypt.mockImplementation(value => Buffer.from(`v11:${value}`));
  native.decrypt.mockImplementation(value => value.toString().slice('v11:'.length));
  native.ready.mockResolvedValue(undefined); native.show.mockResolvedValue({ response: 1 });
  native.authorize.mockResolvedValue({ outcome: 'authorized', status: 0 });
});

function harness(extra: SecureStorageStartupDeps = {}) {
  const checkStorage = vi.fn().mockReturnValue(false); const restart = vi.fn(); const quit = vi.fn();
  const showRecovery = vi.fn().mockResolvedValue({ response: 1 }); const showErrorBox = vi.fn(); const log = vi.fn();
  const foregroundMac = vi.fn().mockResolvedValue(undefined); const authorizeMac = vi.fn().mockResolvedValue({ outcome: 'authorized', status: 0 });
  const deps: SecureStorageStartupDeps = { platform: 'darwin', whenReady: async () => undefined, checkStorage, foregroundMac, authorizeMac, restart, quit, showRecovery, showErrorBox, log, ...extra };
  return { deps, checkStorage, foregroundMac, authorizeMac, restart, quit, showRecovery, showErrorBox, log };
}

describe('secure storage startup probe', () => {
  it('requires OS-backed availability before any encryption request', () => {
    native.available.mockReturnValue(false);
    expect(probeSecureStorage()).toBe(false); expect(native.encrypt).not.toHaveBeenCalled(); expect(native.decrypt).not.toHaveBeenCalled();
  });

  it('proves a round trip using only fixed nonsecret text and persists nothing', () => {
    expect(probeSecureStorage()).toBe(true);
    expect(native.encrypt).toHaveBeenCalledExactlyOnceWith('Sarv Inbox secure-storage startup check');
    expect(native.decrypt).toHaveBeenCalledExactlyOnceWith(Buffer.from('v11:Sarv Inbox secure-storage startup check'));
  });

  it('rejects a wrong or empty encryption result', () => {
    native.encrypt.mockReturnValueOnce(Buffer.alloc(0)); expect(probeSecureStorage()).toBe(false); expect(native.decrypt).not.toHaveBeenCalled();
    native.decrypt.mockReturnValueOnce('wrong'); expect(probeSecureStorage()).toBe(false);
  });

  it.each(['available', 'encrypt', 'decrypt'] as const)('fails closed when %s throws', method => {
    native[method].mockImplementation(() => { throw new Error('Synthetic sensitive detail'); });
    expect(probeSecureStorage()).toBe(false);
  });

  it('accepts a Linux keyring v11 ciphertext only after a matching round trip', () => {
    expect(probeSecureStorage('linux')).toBe(true);
    expect(native.decrypt).toHaveBeenCalledOnce();
  });

  it.each(['v10', 'v12', 'unknown', ''])('rejects Linux ciphertext prefix %j before decryption', prefix => {
    native.encrypt.mockReturnValue(Buffer.from(`${prefix}:Sarv Inbox secure-storage startup check`));
    expect(probeSecureStorage('linux')).toBe(false); expect(native.decrypt).not.toHaveBeenCalled();
  });

  it.each(['darwin', 'win32'] as const)('continues to verify the native %s round trip without imposing Linux versions', platform => {
    native.encrypt.mockImplementation(value => Buffer.from(`v10:${value}`));
    expect(probeSecureStorage(platform)).toBe(true); expect(native.decrypt).toHaveBeenCalledOnce();
  });
});

describe('secure storage startup recovery', () => {
  it('allows a working store without opening a recovery dialog or changing the process', async () => {
    const h = harness({ checkStorage: () => true });
    expect(await ensureSecureStorageForStartup(h.deps)).toBe(true);
    expect(h.showRecovery).not.toHaveBeenCalled(); expect(h.quit).not.toHaveBeenCalled(); expect(h.restart).not.toHaveBeenCalled();
  });

  it('waits for app ready before the first native probe', async () => {
    let ready!: () => void;
    const h = harness({ whenReady: () => new Promise<void>(resolve => { ready = resolve; }) });
    const pending = ensureSecureStorageForStartup(h.deps);
    expect(h.checkStorage).not.toHaveBeenCalled(); expect(h.showRecovery).not.toHaveBeenCalled();
    ready(); expect(await pending).toBe(false); expect(h.checkStorage).toHaveBeenCalledOnce();
  });

  it('shows recovery and quits on unavailable storage without automatically restarting', async () => {
    const h = harness(); expect(await ensureSecureStorageForStartup(h.deps)).toBe(false);
    expect(h.showRecovery).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ buttons: ['Try again', 'Quit'], defaultId: 1, cancelId: 1 }));
    expect(h.quit).toHaveBeenCalledOnce(); expect(h.restart).not.toHaveBeenCalled();
    expect(h.log).toHaveBeenCalledWith(expect.stringContaining('Existing profile data preserved'));
  });

  it('relaunches only after an explicit restart choice, then stops this startup', async () => {
    const h = harness(); h.showRecovery.mockResolvedValue({ response: 0 });
    expect(await ensureSecureStorageForStartup(h.deps)).toBe(false);
    expect(h.restart).toHaveBeenCalledOnce(); expect(h.quit).toHaveBeenCalledOnce();
    expect(h.restart.mock.invocationCallOrder[0]).toBeLessThan(h.quit.mock.invocationCallOrder[0]!);
    expect(h.checkStorage).toHaveBeenCalledOnce();
    expect(h.authorizeMac).toHaveBeenCalledTimes(2);
  });

  it('never loops or retries a process-cached availability failure automatically', async () => {
    const h = harness(); h.showRecovery.mockResolvedValue({ response: 0 });
    await ensureSecureStorageForStartup(h.deps);
    expect(h.checkStorage).toHaveBeenCalledOnce(); expect(h.showRecovery).toHaveBeenCalledOnce(); expect(h.restart).toHaveBeenCalledOnce();
    expect(h.authorizeMac).toHaveBeenCalledTimes(2);
  });

  it('fails closed with a dialog when the probe or readiness callback throws', async () => {
    for (const option of ['checkStorage', 'whenReady'] as const) {
      const h = harness({ [option]: () => { throw new Error('secret=do-not-display'); } });
      expect(await ensureSecureStorageForStartup(h.deps)).toBe(false);
      expect(h.showRecovery).toHaveBeenCalledOnce(); expect(h.quit).toHaveBeenCalledOnce();
      expect(JSON.stringify(h.showRecovery.mock.calls)).not.toContain('do-not-display');
      expect(JSON.stringify(h.log.mock.calls)).not.toContain('do-not-display');
    }
  });

  it('falls back to a safe native error and quits if the recovery dialog fails', async () => {
    const h = harness(); h.showRecovery.mockRejectedValue(new Error('No display'));
    expect(await ensureSecureStorageForStartup(h.deps)).toBe(false);
    expect(h.showErrorBox).toHaveBeenCalledWith('Sarv Inbox needs secure storage', expect.stringContaining('ask macOS to unlock its keychain'));
    expect(h.quit).toHaveBeenCalledOnce(); expect(h.restart).not.toHaveBeenCalled();
  });

  it('still quits if both native dialog paths are unavailable', async () => {
    const h = harness(); h.showRecovery.mockRejectedValue(new Error('No display')); h.showErrorBox.mockImplementation(() => { throw new Error('No display'); });
    expect(await ensureSecureStorageForStartup(h.deps)).toBe(false); expect(h.quit).toHaveBeenCalledOnce();
  });

  it('gives manual reopening guidance if scheduling a restart fails', async () => {
    const h = harness(); h.showRecovery.mockResolvedValue({ response: 0 }); h.restart.mockImplementation(() => { throw new Error('Failure'); });
    expect(await ensureSecureStorageForStartup(h.deps)).toBe(false);
    expect(h.showErrorBox).toHaveBeenCalledWith('Reopen Sarv Inbox', expect.stringContaining('Your existing data is preserved'));
    expect(h.quit).toHaveBeenCalledOnce();
  });

  it('uses the default native dependencies only through the guarded launch path', async () => {
    native.available.mockReturnValue(false);
    expect(await ensureSecureStorageForStartup({ platform: 'darwin', log: vi.fn() })).toBe(false);
    expect(native.ready).toHaveBeenCalledOnce(); expect(native.show).toHaveBeenCalledOnce(); expect(native.quit).toHaveBeenCalledOnce(); expect(native.relaunch).not.toHaveBeenCalled();
    expect(native.focus).toHaveBeenCalledExactlyOnceWith({ steal: true }); expect(native.authorize).toHaveBeenCalledOnce();
  });
});

describe('automatic macOS authorization before persistent startup', () => {
  it('orders app readiness, foreground/event turn, native authorization, then the strict probe', async () => {
    const order: string[] = [];
    const h = harness({
      whenReady: async () => { order.push('ready'); },
      foregroundMac: async () => { order.push('foreground'); },
      authorizeMac: async () => { order.push('authorize'); return { outcome: 'authorized', status: 0 }; },
      checkStorage: () => { order.push('probe'); return true; },
    });
    expect(await ensureSecureStorageForStartup(h.deps)).toBe(true);
    expect(order).toEqual(['ready', 'foreground', 'authorize', 'probe']);
    expect(h.showRecovery).not.toHaveBeenCalled(); expect(h.quit).not.toHaveBeenCalled(); expect(h.restart).not.toHaveBeenCalled();
  });

  it('awaits foreground and native authorization before even probing secure storage', async () => {
    let foreground!: () => void; let authorization!: (value: { outcome: 'authorized'; status: number }) => void;
    const h = harness({
      foregroundMac: () => new Promise<void>(resolve => { foreground = resolve; }),
      authorizeMac: vi.fn(() => new Promise<{ outcome: 'authorized'; status: number }>(resolve => { authorization = resolve; })),
    });
    const pending = ensureSecureStorageForStartup(h.deps);
    await Promise.resolve();
    expect(h.deps.authorizeMac).not.toHaveBeenCalled(); expect(h.checkStorage).not.toHaveBeenCalled();
    foreground(); await Promise.resolve(); await Promise.resolve();
    expect(h.deps.authorizeMac).toHaveBeenCalledOnce(); expect(h.checkStorage).not.toHaveBeenCalled();
    authorization({ outcome: 'authorized', status: 0 });
    expect(await pending).toBe(false); expect(h.checkStorage).toHaveBeenCalledOnce();
  });

  it.each([
    { outcome: 'cancelled', status: -128 },
    { outcome: 'unavailable', status: -25337 },
    { outcome: 'authorized', status: -2147416032 },
  ] as const)('blocks the probe and all continuing startup after native $outcome / $status', async result => {
    const h = harness(); h.authorizeMac.mockResolvedValue(result);
    const persistentStartup = vi.fn();
    if (await ensureSecureStorageForStartup(h.deps)) persistentStartup();
    expect(h.checkStorage).not.toHaveBeenCalled(); expect(persistentStartup).not.toHaveBeenCalled();
    expect(h.quit).toHaveBeenCalledOnce(); expect(h.restart).not.toHaveBeenCalled();
    expect(h.showRecovery).toHaveBeenCalledWith(expect.objectContaining({ detail: expect.stringContaining(`macOS Keychain status: ${result.status}.`) }));
    expect(h.log).toHaveBeenCalledWith(expect.stringContaining(`OSStatus ${result.status}.`));
  });

  it('does not confuse OSStatus zero with a working encryption key', async () => {
    const h = harness();
    expect(await ensureSecureStorageForStartup(h.deps)).toBe(false);
    expect(h.checkStorage).toHaveBeenCalledOnce(); expect(h.showRecovery).toHaveBeenCalledOnce(); expect(h.quit).toHaveBeenCalledOnce();
  });

  it('labels cancelled authorization honestly and permits an explicit later retry', async () => {
    const h = harness(); h.authorizeMac.mockResolvedValueOnce({ outcome: 'cancelled', status: -128 });
    h.showRecovery.mockResolvedValue({ response: 0 });
    expect(await ensureSecureStorageForStartup(h.deps)).toBe(false);
    expect(h.showRecovery).toHaveBeenCalledWith(expect.objectContaining({ message: 'Keychain authorization was cancelled.' }));
    expect(h.checkStorage).not.toHaveBeenCalled(); expect(h.authorizeMac).toHaveBeenCalledTimes(2);
    expect(h.foregroundMac).toHaveBeenCalledTimes(2); expect(h.restart).toHaveBeenCalledOnce(); expect(h.quit).toHaveBeenCalledOnce();
  });

  it.each(['cancelled', 'unavailable'] as const)('never relaunches or loops when the explicit native retry is %s', async outcome => {
    const h = harness(); h.showRecovery.mockResolvedValue({ response: 0 });
    h.authorizeMac.mockResolvedValueOnce({ outcome: 'authorized', status: 0 }).mockResolvedValueOnce({ outcome, status: -128 });
    expect(await ensureSecureStorageForStartup(h.deps)).toBe(false);
    expect(h.authorizeMac).toHaveBeenCalledTimes(2); expect(h.checkStorage).toHaveBeenCalledOnce();
    expect(h.showRecovery).toHaveBeenCalledOnce(); expect(h.showErrorBox).toHaveBeenCalledOnce(); expect(h.restart).not.toHaveBeenCalled(); expect(h.quit).toHaveBeenCalledOnce();
  });

  it.each(['foregroundMac', 'authorizeMac'] as const)('fails closed without leaking native exception details when %s rejects', async callback => {
    const h = harness({ [callback]: vi.fn().mockRejectedValue(new Error('secret-in-native-exception')) });
    expect(await ensureSecureStorageForStartup(h.deps)).toBe(false);
    expect(h.checkStorage).not.toHaveBeenCalled(); expect(h.quit).toHaveBeenCalledOnce();
    expect(JSON.stringify([h.log.mock.calls, h.showRecovery.mock.calls, h.showErrorBox.mock.calls])).not.toContain('secret-in-native-exception');
  });

  it('rejects an invalid helper result instead of displaying arbitrary native output', async () => {
    const h = harness(); h.authorizeMac.mockResolvedValue({ outcome: 'authorized', status: Number.NaN });
    expect(await ensureSecureStorageForStartup(h.deps)).toBe(false); expect(h.checkStorage).not.toHaveBeenCalled();
    expect(h.log).toHaveBeenCalledWith('[Security] Native Keychain authorization is unavailable.');
    expect(JSON.stringify(h.showRecovery.mock.calls)).not.toContain('NaN');
  });

  it.each(['win32', 'linux', 'freebsd'] as const)('leaves normal %s startup and explicit restart behavior unchanged', async platform => {
    const h = harness({ platform, checkStorage: () => true });
    expect(await ensureSecureStorageForStartup(h.deps)).toBe(true);
    expect(h.foregroundMac).not.toHaveBeenCalled(); expect(h.authorizeMac).not.toHaveBeenCalled(); expect(h.showRecovery).not.toHaveBeenCalled();
    h.deps.checkStorage = () => false; h.showRecovery.mockResolvedValue({ response: 0 });
    expect(await ensureSecureStorageForStartup(h.deps)).toBe(false);
    expect(h.showRecovery).toHaveBeenCalledWith(expect.objectContaining({ buttons: ['Restart Sarv Inbox', 'Quit'] }));
    expect(h.authorizeMac).not.toHaveBeenCalled(); expect(h.restart).toHaveBeenCalledOnce(); expect(h.quit).toHaveBeenCalledOnce();
  });

  it('re-authorizes saved-data recovery before relaunch without opening the saved stores again', async () => {
    const h = harness(); h.showRecovery.mockResolvedValue({ response: 0 });
    expect(await reportStartupInitializationFailure(new Error('Cannot decrypt database key'), h.deps)).toBe(false);
    expect(h.authorizeMac).toHaveBeenCalledOnce(); expect(h.checkStorage).not.toHaveBeenCalled(); expect(h.restart).toHaveBeenCalledOnce(); expect(h.quit).toHaveBeenCalledOnce();
  });

  it('does not request Keychain authorization for unrelated initialization failures', async () => {
    const h = harness(); h.showRecovery.mockResolvedValue({ response: 0 });
    expect(await reportStartupInitializationFailure(new Error('Missing module'), h.deps)).toBe(false);
    expect(h.authorizeMac).not.toHaveBeenCalled(); expect(h.restart).toHaveBeenCalledOnce(); expect(h.quit).toHaveBeenCalledOnce();
  });
});

describe('startup recovery wording and outer startup errors', () => {
  it.each([
    ['darwin', 'macOS prompt'], ['win32', 'normal Windows user session'], ['linux', 'GNOME Keyring / Secret Service'], ['freebsd', 'operating system’s secure credential store'],
  ] as const)('gives relevant %s recovery instructions and preserves existing data', (platform, advice) => {
    const options = startupRecoveryOptions('unavailable', platform);
    expect(options.detail).toContain(advice); expect(options.detail).toContain('not been deleted or replaced');
    expect(options.detail).not.toMatch(/stored (?:in |as )?plain|not encrypted/i);
  });

  it('explains native authorization and a clean process without promising to repair macOS errors', () => {
    const detail = startupRecoveryOptions('unavailable', 'darwin').detail;
    expect(detail).toContain('restart after authorization');
    expect(detail).toContain('An unlocked keychain alone does not guarantee');
    expect(detail).toContain('sign out of your Mac');
    expect(detail).toContain('cannot repair every macOS secure-storage error');
    expect(detail).not.toMatch(/Electron|version|Keychain Access/i);
  });

  it.each(['DB key is encrypted but safeStorage is unavailable', 'Invalid database encryption key', 'Cannot decrypt saved credentials', 'Unknown db-key file format'])('shows recovery for a saved-data unlock failure: %s', async message => {
    const h = harness(); expect(await reportStartupInitializationFailure(new Error(message), h.deps)).toBe(false);
    expect(h.showRecovery).toHaveBeenCalledWith(expect.objectContaining({ message: 'Sarv Inbox could not unlock its saved data.' }));
    expect(h.quit).toHaveBeenCalledOnce();
  });

  it.each([new Error('Synthetic startup error password=secret'), null, undefined, 'secret value'])('reports other startup errors safely without echoing raw details', async error => {
    const h = harness(); expect(await reportStartupInitializationFailure(error, h.deps)).toBe(false);
    expect(h.showRecovery).toHaveBeenCalledWith(expect.objectContaining({ message: 'An initialization error prevented Sarv Inbox from opening.' }));
    expect(JSON.stringify(h.showRecovery.mock.calls)).not.toContain('secret');
    expect(h.quit).toHaveBeenCalledOnce();
  });

  it('keeps CI smoke and install-location handling ahead of the guard, and persistent startup after it', () => {
    const source = readFileSync(new URL('../../../../electron/main.ts', import.meta.url), 'utf8');
    const startup = source.slice(source.indexOf('app.whenReady().then'));
    const guard = startup.indexOf('if (!await ensureSecureStorageForStartup(');
    expect(guard).toBeGreaterThan(startup.indexOf('if (smokeTest.enabled)'));
    expect(guard).toBeGreaterThan(startup.indexOf('await offerMoveToApplications()'));
    for (const operation of ['await initializeStorage()', 'await initializeSyncEngine()', 'await initializeAccountRegistry()', 'registerAllHandlers()']) {
      expect(guard).toBeLessThan(startup.indexOf(operation));
    }
    expect(startup).toMatch(/await reportStartupInitializationFailure\(error(?:, [\s\S]*?)?\);\n {4}return;/);
  });
});
