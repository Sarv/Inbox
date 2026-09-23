import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The auto-update service: the I/O edge around electron-updater.
 *
 * The decisions themselves are covered by update-policy.test.ts. What is tested
 * here is the wiring that has to hold for those decisions to reach anything:
 * that a press is written to disk and survives a restart, that "Skip" actually
 * disarms the silent install-on-quit, and that an unsupported build never
 * arms a timer or touches electron-updater at all.
 */

const h = vi.hoisted(() => ({
  userData: '',
  isPackaged: true,
  platform: 'darwin' as NodeJS.Platform,
  /** Stand-in for electron-updater's singleton. */
  updater: {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    logger: undefined as unknown,
    handlers: new Map<string, (...args: unknown[]) => void>(),
    on(event: string, handler: (...args: unknown[]) => void) {
      this.handlers.set(event, handler);
      return this;
    },
    emit(event: string, ...args: unknown[]) {
      this.handlers.get(event)?.(...args);
    },
    checkForUpdates: vi.fn(async () => ({})),
    quitAndInstall: vi.fn(),
  },
  sent: [] as Array<{ channel: string; payload: unknown }>,
}));

vi.mock('electron', () => ({
  // Getters, not values: the factory runs once per module registry, so a plain
  // property would freeze whatever the first test happened to set.
  app: {
    getPath: () => h.userData,
    get isPackaged() {
      return h.isPackaged;
    },
  },
}));

vi.mock('electron-updater', () => ({ autoUpdater: h.updater }));

vi.mock('@sarvinbox/core', () => ({
  createLogger: () => ({
    info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {},
  }),
}));

vi.mock('../../../../electron/shared', () => ({
  getMainWindow: () => ({
    isDestroyed: () => false,
    webContents: { send: (channel: string, payload: unknown) => h.sent.push({ channel, payload }) },
  }),
}));

type Service = typeof import('../../../../electron/services/update-service');

/** Fresh module per test — the service caches prefs and state at module scope. */
const load = async (): Promise<Service> => {
  vi.resetModules();
  return import('../../../../electron/services/update-service');
};

const PREFS = 'update-prefs.json';
const readPrefs = () => JSON.parse(readFileSync(join(h.userData, PREFS), 'utf8'));

let originalPlatform: PropertyDescriptor | undefined;

beforeEach(() => {
  h.userData = mkdtempSync(join(tmpdir(), 'sarvinbox-update-'));
  h.isPackaged = true;
  h.sent = [];
  h.updater.handlers.clear();
  h.updater.autoDownload = false;
  h.updater.autoInstallOnAppQuit = false;
  h.updater.checkForUpdates = vi.fn(async () => ({}));
  h.updater.quitAndInstall = vi.fn();
  originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  delete process.env['APPIMAGE'];
});

afterEach(() => {
  if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
  rmSync(h.userData, { recursive: true, force: true });
  vi.useRealTimers();
});

describe('startUpdateService', () => {
  // If the silent path were not armed, updates would only ever apply when the
  // user happened to press a button - which is not "automatic" at all.
  it('arms background download and install-on-quit for a supported build', async () => {
    const service = await load();
    service.startUpdateService();

    expect(h.updater.autoDownload).toBe(true);
    expect(h.updater.autoInstallOnAppQuit).toBe(true);
    service.stopUpdateService();
  });

  // If this armed a timer, every `pnpm dev` session would throw on the missing
  // app-update.yml 30 seconds in.
  it('does nothing at all for an unpackaged build', async () => {
    h.isPackaged = false;
    const service = await load();
    service.startUpdateService();

    expect(h.updater.autoDownload).toBe(false);
    expect(h.updater.handlers.size).toBe(0);
    expect(service.getUpdateState()).toMatchObject({ phase: 'unsupported', prompt: false });
  });

  // A .deb/.rpm install is owned by root and the package manager; attempting an
  // in-place swap there is the one case that can damage a user's system.
  it('does nothing for a Linux distro package, but runs for an AppImage', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });

    const packaged = await load();
    packaged.startUpdateService();
    expect(packaged.getUpdateState().phase).toBe('unsupported');
    expect(h.updater.autoDownload).toBe(false);

    process.env['APPIMAGE'] = '/tmp/Sarv Inbox.AppImage';
    const appImage = await load();
    appImage.startUpdateService();
    expect(h.updater.autoDownload).toBe(true);
    appImage.stopUpdateService();
  });
});

describe('state broadcasting', () => {
  // The renderer owns no update state of its own, so a push that never happens
  // is a dialog that never appears.
  it('pushes a downloaded update to the renderer with prompt set', async () => {
    const service = await load();
    service.startUpdateService();
    await service.checkForUpdates('scheduled');

    h.updater.emit('update-downloaded', { version: '1.2.0' });

    const last = h.sent.at(-1);
    expect(last?.channel).toBe('updater:state');
    expect(last?.payload).toMatchObject({ phase: 'downloaded', version: '1.2.0', prompt: true });
    service.stopUpdateService();
  });

  // If a background failure set prompt, an offline laptop would raise a popup
  // every hour, forever.
  it('never prompts on a background check failure', async () => {
    const service = await load();
    service.startUpdateService();
    await service.checkForUpdates('scheduled');

    h.updater.emit('error', new Error('getaddrinfo ENOTFOUND github.com'));

    expect(service.getUpdateState()).toMatchObject({ phase: 'error', prompt: false });
    service.stopUpdateService();
  });

  // A manual check must report every outcome, or the menu item looks broken.
  it('prompts on a manual check even when already up to date', async () => {
    const service = await load();
    service.startUpdateService();
    await service.checkForUpdates('manual');

    h.updater.emit('update-not-available', { version: '1.1.1' });

    expect(service.getUpdateState()).toMatchObject({ phase: 'up-to-date', prompt: true });
    service.stopUpdateService();
  });
});

describe('skipCurrentVersion', () => {
  // Two regressions in one: a skip that is not persisted returns after a
  // restart, and a skip that does not disarm install-on-quit installs the very
  // version the user just declined.
  it('persists the skip and disarms the silent install', async () => {
    const service = await load();
    service.startUpdateService();
    await service.checkForUpdates('scheduled');
    h.updater.emit('update-downloaded', { version: '1.2.0' });
    expect(h.updater.autoInstallOnAppQuit).toBe(true);

    service.skipCurrentVersion();

    expect(h.updater.autoInstallOnAppQuit).toBe(false);
    expect(readPrefs()).toEqual({ skippedVersion: '1.2.0', remindAfter: null });
    expect(service.getUpdateState().prompt).toBe(false);
    service.stopUpdateService();
  });

  // The skip has to survive a restart, or the prompt returns on the next launch.
  it('is honoured by a fresh process', async () => {
    writeFileSync(
      join(h.userData, PREFS),
      JSON.stringify({ skippedVersion: '1.2.0', remindAfter: null }),
    );

    const service = await load();
    service.startUpdateService();
    await service.checkForUpdates('scheduled');
    h.updater.emit('update-downloaded', { version: '1.2.0' });

    expect(service.getUpdateState()).toMatchObject({ phase: 'downloaded', prompt: false });
    expect(h.updater.autoInstallOnAppQuit).toBe(false);
    service.stopUpdateService();
  });

  // The whole point of scoping a skip to one version: the NEXT release must
  // still arrive, including automatically.
  it('does not suppress the next version', async () => {
    writeFileSync(
      join(h.userData, PREFS),
      JSON.stringify({ skippedVersion: '1.2.0', remindAfter: null }),
    );

    const service = await load();
    service.startUpdateService();
    await service.checkForUpdates('scheduled');
    h.updater.emit('update-downloaded', { version: '1.2.1' });

    expect(service.getUpdateState()).toMatchObject({ phase: 'downloaded', prompt: true });
    expect(h.updater.autoInstallOnAppQuit).toBe(true);
    service.stopUpdateService();
  });
});

describe('remindAboutUpdateLater', () => {
  // "Later" must silence the prompt without cancelling the update itself -
  // ignoring the dialog should still leave you updated on the next quit.
  it('snoozes the prompt but leaves the silent install armed', async () => {
    const service = await load();
    service.startUpdateService();
    await service.checkForUpdates('scheduled');
    h.updater.emit('update-downloaded', { version: '1.2.0' });

    service.remindAboutUpdateLater();

    expect(h.updater.autoInstallOnAppQuit).toBe(true);
    expect(service.getUpdateState().prompt).toBe(false);
    expect(readPrefs().remindAfter).toBeGreaterThan(Date.now());
    service.stopUpdateService();
  });
});

describe('installUpdateAndRestart', () => {
  // Calling quitAndInstall with nothing staged kills the app without replacing
  // anything - the user loses their session and gains no update.
  it('refuses when no update is staged', async () => {
    const service = await load();
    service.startUpdateService();

    expect(service.installUpdateAndRestart()).toBe(false);
    expect(h.updater.quitAndInstall).not.toHaveBeenCalled();
    service.stopUpdateService();
  });

  // isForceRunAfter must be true or the app installs and never comes back,
  // which reads to the user as the update having crashed it.
  it('quits, installs and relaunches once an update is staged', async () => {
    vi.useFakeTimers();
    const service = await load();
    service.startUpdateService();
    await service.checkForUpdates('scheduled');
    h.updater.emit('update-downloaded', { version: '1.2.0' });

    expect(service.installUpdateAndRestart()).toBe(true);
    vi.runOnlyPendingTimers();

    expect(h.updater.quitAndInstall).toHaveBeenCalledWith(false, true);
    service.stopUpdateService();
  });
});

describe('preference file handling', () => {
  // A corrupt prefs file must never be able to stop the app updating - or,
  // worse, stop it starting.
  it('treats an unreadable prefs file as no preferences', async () => {
    writeFileSync(join(h.userData, PREFS), '{ this is not json');

    const service = await load();
    expect(() => service.startUpdateService()).not.toThrow();
    await service.checkForUpdates('scheduled');
    h.updater.emit('update-downloaded', { version: '1.2.0' });

    expect(service.getUpdateState().prompt).toBe(true);
    service.stopUpdateService();
  });

  // Written via tmp+rename: a crash mid-write must leave the old file intact
  // rather than a truncated one that parses as "no preferences".
  it('leaves no temp file behind after a write', async () => {
    const service = await load();
    service.startUpdateService();
    await service.checkForUpdates('scheduled');
    h.updater.emit('update-downloaded', { version: '1.2.0' });

    service.skipCurrentVersion();

    expect(existsSync(join(h.userData, `${PREFS}.tmp`))).toBe(false);
    expect(existsSync(join(h.userData, PREFS))).toBe(true);
    service.stopUpdateService();
  });
});
