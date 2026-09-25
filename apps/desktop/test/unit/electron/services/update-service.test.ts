import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { UPDATE_CHECK_TIMEOUT_MS } from '../../../../electron/services/update-policy';

/**
 * The auto-update service: the I/O edge around electron-updater.
 *
 * The decisions themselves are covered by update-policy.test.ts. What is tested
 * here is the wiring that has to hold for those decisions to reach anything:
 * that a check can never hang, that a press is written to disk and survives a
 * restart, that "Skip" actually disarms the silent install-on-quit, that
 * turning automatic updates off stops a single byte being fetched, and that an
 * unsupported build never arms a timer or touches electron-updater at all.
 */

const h = vi.hoisted(() => ({
  userData: '',
  /** Stands in for process.resourcesPath - where app-update.yml lives. */
  resources: '',
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
    downloadUpdate: vi.fn(async () => [] as string[]),
    quitAndInstall: vi.fn(),
  },
  sent: [] as Array<{ channel: string; payload: unknown }>,
  /** Overridable so a build whose version lookup throws can be exercised. */
  getVersion: (): string => '1.2.1',
  /** Null models a closed window; a throwing send models a torn-down one. */
  window: true,
  send: (channel: string, payload: unknown) => {
    h.sent.push({ channel, payload });
  },
}));

vi.mock('electron', () => ({
  // Getters, not values: the factory runs once per module registry, so a plain
  // property would freeze whatever the first test happened to set.
  app: {
    getPath: () => h.userData,
    getVersion: () => h.getVersion(),
    // Deliberately NO isPackaged: the service must not consult it. Electron
    // derives it from the executable's file name, which scripts/postinstall.mjs
    // renames in dev, so it is true inside `pnpm dev:desktop`.
  },
}));

vi.mock('electron-updater', () => ({ autoUpdater: h.updater }));

vi.mock('@sarvinbox/core', async () => {
  // The REAL withTimeout, not a stand-in: the timeout is the behaviour under
  // test here, and a fake one would prove nothing about the thing that used to
  // hang. Only the logger is stubbed.
  const timeout = await vi.importActual<
    typeof import('../../../../../../packages/core/src/utils/timeout')
  >('../../../../../../packages/core/src/utils/timeout');
  return {
    createLogger: () => ({
      info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {},
    }),
    withTimeout: timeout.withTimeout,
    isTimeoutError: timeout.isTimeoutError,
  };
});

vi.mock('../../../../electron/shared', () => ({
  getMainWindow: () =>
    h.window
      ? { isDestroyed: () => false, webContents: { send: (c: string, p: unknown) => h.send(c, p) } }
      : null,
}));

type Service = typeof import('../../../../electron/services/update-service');

/** Fresh module per test — the service caches prefs and state at module scope. */
const load = async (): Promise<Service> => {
  vi.resetModules();
  return import('../../../../electron/services/update-service');
};

const PREFS = 'update-prefs.json';
const readPrefs = () => JSON.parse(readFileSync(join(h.userData, PREFS), 'utf8'));
const writePrefs = (prefs: Record<string, unknown>) =>
  writeFileSync(join(h.userData, PREFS), JSON.stringify(prefs));

/** Start with automatic updates OFF — the mode where the dialog does the work. */
const manualMode = () => writePrefs({ skippedVersion: null, remindAfter: null, autoUpdate: false });

let originalPlatform: PropertyDescriptor | undefined;
let originalDefaultApp: PropertyDescriptor | undefined;
let originalResourcesPath: PropertyDescriptor | undefined;

/** Both signals the support gate reads, set to "this is a shipped build". */
const defineProcess = (key: string, value: unknown) =>
  Object.defineProperty(process, key, { value, configurable: true, writable: true });

/** Model a `pnpm dev:desktop` run: Electron was handed a script to execute. */
const devRun = () => defineProcess('defaultApp', true);

/** Model a packaged build published without electron-builder's update config. */
const withoutUpdateConfig = () => rmSync(join(h.resources, 'app-update.yml'), { force: true });

beforeEach(() => {
  h.userData = mkdtempSync(join(tmpdir(), 'sarvinbox-update-'));
  h.resources = mkdtempSync(join(tmpdir(), 'sarvinbox-resources-'));
  // The file electron-updater opens on every check. Present by default, so the
  // default harness build is one that can genuinely update itself.
  writeFileSync(join(h.resources, 'app-update.yml'), 'provider: github\n');
  h.sent = [];
  h.updater.handlers.clear();
  h.updater.autoDownload = false;
  h.updater.autoInstallOnAppQuit = false;
  h.updater.checkForUpdates = vi.fn(async () => ({}));
  h.updater.downloadUpdate = vi.fn(async () => [] as string[]);
  h.updater.quitAndInstall = vi.fn();
  h.getVersion = () => '1.2.1';
  h.window = true;
  h.send = (channel, payload) => {
    h.sent.push({ channel, payload });
  };
  originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  originalDefaultApp = Object.getOwnPropertyDescriptor(process, 'defaultApp');
  originalResourcesPath = Object.getOwnPropertyDescriptor(process, 'resourcesPath');
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  defineProcess('defaultApp', false);
  defineProcess('resourcesPath', h.resources);
  delete process.env['APPIMAGE'];
});

afterEach(() => {
  if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
  if (originalDefaultApp) Object.defineProperty(process, 'defaultApp', originalDefaultApp);
  else delete (process as unknown as Record<string, unknown>)['defaultApp'];
  if (originalResourcesPath) Object.defineProperty(process, 'resourcesPath', originalResourcesPath);
  else delete (process as unknown as Record<string, unknown>)['resourcesPath'];
  rmSync(h.userData, { recursive: true, force: true });
  rmSync(h.resources, { recursive: true, force: true });
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

  // The whole of what the toggle buys. If autoDownload stayed on, turning
  // automatic updates off would still pull a hundred megabytes over someone's
  // tether - the one thing they turned it off to prevent.
  it('does not arm background download when automatic updates are off', async () => {
    manualMode();
    const service = await load();
    service.startUpdateService();

    expect(h.updater.autoDownload).toBe(false);
    // Still armed: bytes already on disk cost nothing to apply on a quit the
    // user was performing anyway. "Ask before downloading" is not "make me sit
    // through an installer".
    expect(h.updater.autoInstallOnAppQuit).toBe(true);
    expect(service.getUpdateState().autoUpdate).toBe(false);
    service.stopUpdateService();
  });

  // If this armed a timer, every `pnpm dev` session would throw on the missing
  // app-update.yml 30 seconds in.
  it('does nothing at all for a development run', async () => {
    devRun();
    withoutUpdateConfig();
    const service = await load();
    service.startUpdateService();

    expect(h.updater.autoDownload).toBe(false);
    expect(h.updater.handlers.size).toBe(0);
    expect(service.getUpdateState()).toMatchObject({ phase: 'unsupported', prompt: false });
  });

  /**
   * THE bug this gate was rewritten for. scripts/postinstall.mjs renames the dev
   * Electron binary to brand the Dock tile, and Electron derives app.isPackaged
   * from that file NAME - so it was true under `pnpm dev:desktop`, the gate
   * passed, the hourly timer armed, and every dev session logged
   * "ENOENT: ... Electron.app/Contents/Resources/app-update.yml" twice.
   * A dev run must arm nothing no matter how packaged the binary looks.
   */
  it('arms nothing in dev even when the binary has been renamed to look packaged', async () => {
    devRun();
    withoutUpdateConfig();
    const service = await load();
    service.startUpdateService();

    expect(h.updater.handlers.size).toBe(0);
    expect(h.updater.checkForUpdates).not.toHaveBeenCalled();
    expect(service.getUpdateState().phase).toBe('unsupported');
  });

  // process.resourcesPath is undefined outside a packaged Electron app, which
  // makes the path join throw. Startup must survive that and refuse to update,
  // not take the main process down before the window opens.
  it('refuses, rather than throwing, when there is no resources directory', async () => {
    defineProcess('resourcesPath', undefined);
    const service = await load();

    expect(() => service.startUpdateService()).not.toThrow();
    expect(h.updater.handlers.size).toBe(0);
    expect(service.getUpdateState().phase).toBe('unsupported');
  });

  // A packaged build whose publish config never made it into the bundle would
  // otherwise throw the same ENOENT at a real user every hour.
  it('does nothing for a packaged build with no app-update.yml', async () => {
    withoutUpdateConfig();
    const service = await load();
    service.startUpdateService();

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

describe('checkForUpdates timeout', () => {
  /**
   * THE regression this whole area exists for.
   *
   * `await autoUpdater.checkForUpdates()` was unbounded, and nothing below it
   * is in a hurry: builder-util-runtime defaults to a 60s socket timeout and
   * retries server errors three times. A slow route to
   * release-assets.githubusercontent.com (measured: ~15s in TCP connect alone)
   * left the dialog reading "Checking for updates..." with no end state and no
   * log line. If this test goes red, that spinner is back.
   */
  it('fails the check at the deadline instead of hanging forever', async () => {
    vi.useFakeTimers();
    h.updater.checkForUpdates = vi.fn(() => new Promise(() => {}));
    const service = await load();
    service.startUpdateService();

    const pending = service.checkForUpdates('manual');
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_TIMEOUT_MS);
    const state = await pending;

    expect(state.phase).toBe('error');
    expect(state.error).toMatch(/did not respond within 20 seconds/);
    // A manual check must still SHOW that answer - silence is what made this
    // look broken in the first place.
    expect(state.prompt).toBe(true);
    service.stopUpdateService();
  });

  /**
   * The second half of the same bug, and the worse one. `checkInFlight` was
   * cleared only by a terminal electron-updater event, so a check that never
   * produced one latched it true for the life of the process: every later
   * "Check for Updates" then fell into the coalescing branch and re-showed
   * "Checking..." WITHOUT EVER SENDING A REQUEST. The app could never check
   * again until it was restarted.
   */
  it('releases the in-flight latch after a timeout so the next check really runs', async () => {
    vi.useFakeTimers();
    h.updater.checkForUpdates = vi.fn(() => new Promise(() => {}));
    const service = await load();
    service.startUpdateService();

    const first = service.checkForUpdates('manual');
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_TIMEOUT_MS);
    await first;

    h.updater.checkForUpdates = vi.fn(async () => ({}));
    await service.checkForUpdates('manual');

    expect(h.updater.checkForUpdates).toHaveBeenCalledTimes(1);
    service.stopUpdateService();
  });

  // A rejection already fires the 'error' event, which sets the state. If this
  // path ALSO set it, the user would see the generic timeout copy instead of
  // the real reason (offline, rate limited, no asset for this platform).
  it('leaves a rejected check reporting its own error', async () => {
    h.updater.checkForUpdates = vi.fn(async () => {
      h.updater.emit('error', new Error('getaddrinfo ENOTFOUND github.com'));
      throw new Error('getaddrinfo ENOTFOUND github.com');
    });
    const service = await load();
    service.startUpdateService();

    const state = await service.checkForUpdates('manual');

    expect(state).toMatchObject({ phase: 'error' });
    expect(state.error).toMatch(/ENOTFOUND/);
    service.stopUpdateService();
  });

  // Two concurrent checks would race two downloads of the same file. The
  // coalescing branch must re-show the running check, not start a second.
  it('coalesces a press that lands while a check is already running', async () => {
    vi.useFakeTimers();
    h.updater.checkForUpdates = vi.fn(() => new Promise(() => {}));
    const service = await load();
    service.startUpdateService();

    const first = service.checkForUpdates('scheduled');
    await service.checkForUpdates('manual');
    expect(h.updater.checkForUpdates).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_TIMEOUT_MS);
    await first;
    service.stopUpdateService();
  });

  // Re-checking mid-download makes electron-updater fetch the same package
  // again - bandwidth the user already spent, and on a metered link the exact
  // harm the toggle exists to prevent.
  it('does not start a new check while a download is running', async () => {
    const service = await load();
    service.startUpdateService();
    await service.checkForUpdates('scheduled');
    h.updater.emit('update-available', { version: '1.3.0' });
    expect(service.getUpdateState().phase).toBe('downloading');

    await service.checkForUpdates('manual');

    expect(h.updater.checkForUpdates).toHaveBeenCalledTimes(1);
    service.stopUpdateService();
  });
});

describe('automatic updates ON', () => {
  // The default mode, and the promise it makes: the user is never interrupted.
  // A dialog appearing here - mid-reply, asking to restart a mail client - is
  // the exact behaviour the toggle's ON position says will not happen.
  it('downloads and stages a background update without ever prompting', async () => {
    const service = await load();
    service.startUpdateService();
    await service.checkForUpdates('scheduled');

    h.updater.emit('update-available', { version: '1.3.0' });
    expect(service.getUpdateState()).toMatchObject({ phase: 'downloading', prompt: false });

    h.updater.emit('download-progress', { percent: 42.4 });
    expect(service.getUpdateState()).toMatchObject({ percent: 42, prompt: false });

    h.updater.emit('update-downloaded', { version: '1.3.0' });
    expect(service.getUpdateState()).toMatchObject({ phase: 'downloaded', prompt: false });
    // Silent, but not skipped: it lands on the next ordinary quit.
    expect(h.updater.autoInstallOnAppQuit).toBe(true);
    service.stopUpdateService();
  });

  // A manual check is the one place the same cycle must report back, or the
  // menu item looks dead.
  it('still reports the same update when the user asked', async () => {
    const service = await load();
    service.startUpdateService();
    await service.checkForUpdates('manual');

    h.updater.emit('update-available', { version: '1.3.0' });

    expect(service.getUpdateState()).toMatchObject({ phase: 'downloading', prompt: true });
    service.stopUpdateService();
  });
});

describe('automatic updates OFF', () => {
  // If the phase ran past 'available', the user would never be asked - and with
  // autoDownload off nothing would be downloading either, so the update would
  // simply never happen.
  it('stops at available and asks, downloading nothing', async () => {
    manualMode();
    const service = await load();
    service.startUpdateService();
    await service.checkForUpdates('scheduled');

    h.updater.emit('update-available', { version: '1.3.0' });

    expect(service.getUpdateState()).toMatchObject({
      phase: 'available',
      version: '1.3.0',
      prompt: true,
    });
    expect(h.updater.downloadUpdate).not.toHaveBeenCalled();
    service.stopUpdateService();
  });

  // The button the user presses to spend the bandwidth. If it did not call
  // downloadUpdate, the dialog would show a progress bar that never moves.
  it('downloads on request and reports when it is staged', async () => {
    manualMode();
    const service = await load();
    service.startUpdateService();
    await service.checkForUpdates('scheduled');
    h.updater.emit('update-available', { version: '1.3.0' });

    expect(service.downloadUpdate()).toBe(true);

    expect(h.updater.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(service.getUpdateState()).toMatchObject({ phase: 'downloading', percent: 0 });

    h.updater.emit('update-downloaded', { version: '1.3.0' });
    expect(service.getUpdateState()).toMatchObject({ phase: 'downloaded', prompt: true });
    service.stopUpdateService();
  });

  // The user pressed "Download and install" and then hid the progress bar to
  // carry on working. When it finishes they are owed the restart prompt - that
  // is the whole point of asking instead of restarting for them. Without the
  // dismissal reset this finished in total silence.
  it('re-opens the dialog when a download the user hid finishes', async () => {
    manualMode();
    const service = await load();
    service.startUpdateService();
    await service.checkForUpdates('scheduled');
    h.updater.emit('update-available', { version: '1.3.0' });
    service.downloadUpdate();

    expect(service.dismissUpdateDialog().prompt).toBe(false);
    h.updater.emit('download-progress', { percent: 80 });
    expect(service.getUpdateState().prompt).toBe(false);

    h.updater.emit('update-downloaded', { version: '1.3.0' });

    expect(service.getUpdateState()).toMatchObject({ phase: 'downloaded', prompt: true });
    service.stopUpdateService();
  });

  // Pressing download with nothing available would start electron-updater on an
  // update it never found - it throws, and the dialog would sit on a progress
  // bar forever. Refusing lets the renderer say so instead.
  it('refuses a download when nothing is available', async () => {
    manualMode();
    const service = await load();
    service.startUpdateService();
    await service.checkForUpdates('scheduled');
    h.updater.emit('update-not-available', { version: '1.2.1' });

    expect(service.downloadUpdate()).toBe(false);
    expect(h.updater.downloadUpdate).not.toHaveBeenCalled();
    service.stopUpdateService();
  });
});

describe('setAutoUpdateEnabled', () => {
  // A toggle that does not persist is a toggle that silently resets on the next
  // launch - and the user's metered connection pays for the difference.
  it('persists the preference and flips background downloading', async () => {
    const service = await load();
    service.startUpdateService();

    service.setAutoUpdateEnabled(false);
    expect(h.updater.autoDownload).toBe(false);
    expect(readPrefs().autoUpdate).toBe(false);
    expect(service.getUpdateState().autoUpdate).toBe(false);

    service.setAutoUpdateEnabled(true);
    expect(h.updater.autoDownload).toBe(true);
    expect(readPrefs().autoUpdate).toBe(true);
    service.stopUpdateService();
  });

  // Turning it on with an update already on screen has to fetch THAT update, or
  // the toggle appears to do nothing and the user presses the other button
  // anyway, wondering what the switch was for.
  it('starts the waiting download immediately when switched on', async () => {
    manualMode();
    const service = await load();
    service.startUpdateService();
    await service.checkForUpdates('scheduled');
    h.updater.emit('update-available', { version: '1.3.0' });

    service.setAutoUpdateEnabled(true);

    expect(h.updater.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(service.getUpdateState().phase).toBe('downloading');
    service.stopUpdateService();
  });

  // The preference must survive an install. Resetting the prefs file wholesale
  // after quitAndInstall would turn automatic downloads back ON for a user who
  // had deliberately turned them off, and they would find out from their data
  // bill rather than from the app.
  it('survives an install that clears the skip and snooze answers', async () => {
    manualMode();
    const service = await load();
    service.startUpdateService();
    await service.checkForUpdates('scheduled');
    h.updater.emit('update-available', { version: '1.3.0' });
    service.downloadUpdate();
    h.updater.emit('update-downloaded', { version: '1.3.0' });

    expect(service.installUpdateAndRestart()).toBe(true);

    expect(readPrefs()).toEqual({ skippedVersion: null, remindAfter: null, autoUpdate: false });
    service.stopUpdateService();
  });
});

describe('state broadcasting', () => {
  // The renderer owns no update state of its own, so a push that never happens
  // is a dialog that never appears.
  it('pushes a downloaded update to the renderer with prompt set', async () => {
    manualMode();
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
  // The running version rides along so the answer can name it ("1.2.1 is the
  // newest version") rather than a vague reassurance.
  it('prompts on a manual check even when already up to date', async () => {
    const service = await load();
    service.startUpdateService();
    await service.checkForUpdates('manual');

    h.updater.emit('update-not-available', { version: '1.1.1' });

    expect(service.getUpdateState()).toMatchObject({
      phase: 'up-to-date',
      prompt: true,
      currentVersion: '1.2.1',
    });
    service.stopUpdateService();
  });
});

describe('skipCurrentVersion', () => {
  // Two regressions in one: a skip that is not persisted returns after a
  // restart, and a skip that does not disarm install-on-quit installs the very
  // version the user just declined.
  it('persists the skip and disarms the silent install', async () => {
    manualMode();
    const service = await load();
    service.startUpdateService();
    await service.checkForUpdates('scheduled');
    h.updater.emit('update-downloaded', { version: '1.2.0' });
    expect(h.updater.autoInstallOnAppQuit).toBe(true);

    service.skipCurrentVersion();

    expect(h.updater.autoInstallOnAppQuit).toBe(false);
    expect(readPrefs()).toEqual({
      skippedVersion: '1.2.0',
      remindAfter: null,
      autoUpdate: false,
    });
    expect(service.getUpdateState().prompt).toBe(false);
    service.stopUpdateService();
  });

  // The skip has to survive a restart, or the prompt returns on the next launch.
  it('is honoured by a fresh process', async () => {
    writePrefs({ skippedVersion: '1.2.0', remindAfter: null, autoUpdate: false });

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
    writePrefs({ skippedVersion: '1.2.0', remindAfter: null, autoUpdate: false });

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
    manualMode();
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

describe('dismissUpdateDialog', () => {
  // THE regression: `prompt` is recomputed on every state change, so a dialog
  // closed during a MANUAL check ("you're up to date" — always promptable)
  // reopened itself the instant anything else touched the state. Close did
  // nothing, however many times it was pressed.
  it('closes the dialog on a manual check and keeps it closed', async () => {
    const service = await load();
    service.startUpdateService();
    await service.checkForUpdates('manual');
    h.updater.emit('update-not-available', { version: '1.2.1' });
    expect(service.getUpdateState().prompt).toBe(true);

    expect(service.dismissUpdateDialog().prompt).toBe(false);

    // Any later state change in the same cycle must not resurrect it.
    h.updater.emit('download-progress', { percent: 12 });
    expect(service.getUpdateState().prompt).toBe(false);
    expect(h.sent.at(-1)?.payload).toMatchObject({ prompt: false });
    service.stopUpdateService();
  });

  // A dismissal answers the check it was shown for, not every future one:
  // pressing "Check for Updates" again must show an answer.
  it('does not silence the next check', async () => {
    const service = await load();
    service.startUpdateService();
    await service.checkForUpdates('manual');
    h.updater.emit('update-not-available', { version: '1.2.1' });
    service.dismissUpdateDialog();

    await service.checkForUpdates('manual');
    h.updater.emit('update-not-available', { version: '1.2.1' });

    expect(service.getUpdateState()).toMatchObject({ phase: 'up-to-date', prompt: true });
    service.stopUpdateService();
  });

  // Same recomputation bug, reached through the other two buttons: on a manual
  // check both were as unclosable as Close.
  it('keeps the dialog closed after Remind me later and Skip on a manual check', async () => {
    const later = await load();
    later.startUpdateService();
    await later.checkForUpdates('manual');
    h.updater.emit('update-downloaded', { version: '1.2.0' });

    expect(later.remindAboutUpdateLater().prompt).toBe(false);
    h.updater.emit('download-progress', { percent: 100 });
    expect(later.getUpdateState().prompt).toBe(false);
    later.stopUpdateService();

    const skipped = await load();
    skipped.startUpdateService();
    await skipped.checkForUpdates('manual');
    h.updater.emit('update-downloaded', { version: '1.2.0' });

    expect(skipped.skipCurrentVersion().prompt).toBe(false);
    expect(skipped.getUpdateState().prompt).toBe(false);
    skipped.stopUpdateService();
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
  // worse, stop it starting. It degrades to the DEFAULTS, which means automatic
  // updates stay on rather than a garbled byte silently stranding the install.
  it('treats an unreadable prefs file as no preferences', async () => {
    writeFileSync(join(h.userData, PREFS), '{ this is not json');

    const service = await load();
    expect(() => service.startUpdateService()).not.toThrow();
    expect(h.updater.autoDownload).toBe(true);
    await service.checkForUpdates('manual');
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

describe('resilience', () => {
  // The spinner the user actually sees. It comes from electron-updater's own
  // event, not from the call site - if this stopped setting 'checking', a
  // manual press would look like it did nothing until the check finished.
  it('shows the check as running as soon as electron-updater starts one', async () => {
    let phaseDuringCheck: string | undefined;
    h.updater.checkForUpdates = vi.fn(async () => {
      h.updater.emit('checking-for-update');
      phaseDuringCheck = service.getUpdateState().phase;
      return {};
    });
    const service = await load();
    service.startUpdateService();

    await service.checkForUpdates('manual');

    expect(phaseDuringCheck).toBe('checking');
    service.stopUpdateService();
  });

  // A menu press on a .deb/.rpm or a dev build must report that it cannot
  // update rather than calling into electron-updater, which throws on the
  // missing app-update.yml.
  it('answers a manual check on an unsupported build without checking', async () => {
    devRun();
    withoutUpdateConfig();
    const service = await load();

    const state = await service.checkForUpdates('manual');

    expect(state).toMatchObject({ phase: 'unsupported', version: null });
    expect(state.error).toBeTruthy();
    expect(h.updater.checkForUpdates).not.toHaveBeenCalled();
  });

  /**
   * A read-only or full userData directory must not break the BUTTON. Losing
   * the preference means the prompt comes back later; throwing here means
   * "Skip this version" appears to do nothing at all, which is worse.
   */
  it('still answers when the preference cannot be written', async () => {
    const service = await load();
    service.startUpdateService();
    await service.checkForUpdates('scheduled');
    h.updater.emit('update-downloaded', { version: '1.3.0' });

    // Nothing can be written inside a path whose parent is a FILE.
    rmSync(h.userData, { recursive: true, force: true });
    writeFileSync(h.userData, 'not a directory');

    expect(() => service.skipCurrentVersion()).not.toThrow();
    // And the in-memory answer still took effect, so this session behaves.
    expect(h.updater.autoInstallOnAppQuit).toBe(false);
    expect(service.getUpdateState().prompt).toBe(false);
    service.stopUpdateService();
  });

  // A window that closed or is mid-teardown between the check and the push is
  // ordinary, not an error. Throwing here would take down the update cycle -
  // and with it every later check - because the window blinked.
  it('survives a renderer that is gone when the state is pushed', async () => {
    const service = await load();
    service.startUpdateService();

    h.window = false;
    await expect(service.checkForUpdates('scheduled')).resolves.toBeTruthy();

    h.window = true;
    h.send = () => {
      throw new Error('Object has been destroyed');
    };
    expect(() => h.updater.emit('update-downloaded', { version: '1.3.0' })).not.toThrow();
    expect(service.getUpdateState().phase).toBe('downloaded');
    service.stopUpdateService();
  });

  // currentVersion only feeds copy ("1.2.1 is the newest version"). If a failed
  // lookup propagated, it would take the whole update cycle down for a string.
  it('degrades to no version rather than failing when the lookup throws', async () => {
    h.getVersion = () => {
      throw new Error('app not ready');
    };
    const service = await load();
    service.startUpdateService();

    await service.checkForUpdates('manual');
    h.updater.emit('update-not-available', { version: '1.2.1' });

    expect(service.getUpdateState()).toMatchObject({ phase: 'up-to-date', currentVersion: null });
    service.stopUpdateService();
  });

  // A rejected download is reported through the 'error' event; this catch only
  // exists so the rejection cannot reach the process as an unhandled one, which
  // in the main process is a crash.
  it('swallows a rejected download rather than crashing the main process', async () => {
    manualMode();
    h.updater.downloadUpdate = vi.fn(async () => {
      throw new Error('ENOSPC: no space left on device');
    });
    const service = await load();
    service.startUpdateService();
    await service.checkForUpdates('scheduled');
    h.updater.emit('update-available', { version: '1.3.0' });

    expect(() => service.downloadUpdate()).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    service.stopUpdateService();
  });

  /**
   * The timers are the only reason an unattended app ever updates. A first
   * check shortly after launch (not AT launch - the first sync already
   * saturates the main thread), then hourly.
   */
  it('checks shortly after launch and then hourly', async () => {
    vi.useFakeTimers();
    const service = await load();
    service.startUpdateService();
    expect(h.updater.checkForUpdates).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(30 * 1000);
    expect(h.updater.checkForUpdates).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(h.updater.checkForUpdates).toHaveBeenCalledTimes(2);

    // And stopping must actually stop them, or a quitting app keeps checking.
    service.stopUpdateService();
    await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000);
    expect(h.updater.checkForUpdates).toHaveBeenCalledTimes(2);
  });
});
