import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

/**
 * How main.ts wires the main window's security boundary — a source guard,
 * because main.ts cannot be imported by a test (it starts the app). The
 * modules it wires are tested on their own (main-window-preferences,
 * navigation-guards, navigation-policy); this pins that main.ts really uses
 * them, with the one app URL (CASA M-6).
 */

const source = readFileSync(new URL('../../../electron/main.ts', import.meta.url), 'utf8');

/** The file with `//` and `/* *\/` comments removed, so prose can't match. */
const code = source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1'))
  .join('\n');

describe('main.ts main-window wiring', () => {
  // Breaks: the app URL drifts between the window, its guards and the two
  // protocol handlers — or production falls back to "any file:" again.
  it('builds the app URL once, from the bundled entry, and loads exactly that file', () => {
    expect(code).toContain("const APP_ENTRY_FILE = join(__dirname, '../dist/index.html');");
    expect(code).toContain('const APP_URL = VITE_DEV_SERVER_URL ?? pathToFileURL(APP_ENTRY_FILE).href;');
    expect(code).toContain('mainWindow.loadFile(APP_ENTRY_FILE);');
    expect(code).toContain('registerAttachmentProtocol(APP_URL);');
    expect(code).toContain('registerPanelProtocol(APP_URL, resolvePanelExtensionDir);');
  });

  // Breaks (CASA L-3): a shipped app takes VITE_DEV_SERVER_URL — from a shell
  // or a planted .env in the launch directory — loads that server with the full
  // preload bridge, and counts it as the app; or it reads a planted .env at all.
  it('takes the dev server URL and .env only in a dev bundle', () => {
    expect(code).toContain("const VITE_DEV_SERVER_URL = devServerUrlFor({ envUrl: process.env['VITE_DEV_SERVER_URL'], releaseBundle: isReleaseBundle(), isDev });");
    expect(code.match(/VITE_DEV_SERVER_URL'\]/g)).toHaveLength(1);
    expect(code).toContain('if (!isReleaseBundle()) loadDotEnv(defaultDotEnvPaths());');
    expect(code.match(/loadDotEnv\(/g)).toHaveLength(1);
  });

  // Breaks (CASA L-1): a listener registered before the guard — Sentry's,
  // log:forward, or any handler — answers senders other than the app window;
  // or the guard never learns the app URL and refuses the app itself.
  it('guards ipcMain before anything registers, against the main window and the app URL', () => {
    const guard = code.indexOf('installIpcSenderGuard(ipcMain, {');
    expect(guard).toBeGreaterThan(-1);
    expect(code.match(/installIpcSenderGuard\(/g)).toHaveLength(1);
    expect(code.indexOf('initSentryMain();')).toBeGreaterThan(guard);
    expect(code.indexOf("ipcMain.on('log:forward'")).toBeGreaterThan(guard);
    expect(code.indexOf('registerAllHandlers();')).toBeGreaterThan(guard);
    expect(code.slice(0, guard)).not.toMatch(/ipcMain\.(handle|on|once|addListener)\(/);
    expect(code).toContain('mainWindow: getMainWindow,');
    expect(code).toContain('appUrl: () => ipcAppUrl,');
    const appUrl = code.indexOf('const APP_URL = ');
    expect(code.indexOf('ipcAppUrl = APP_URL;')).toBeGreaterThan(appUrl);
  });

  // Breaks (CASA L-2): the session keeps Electron's grant-everything default
  // (microphone, clipboard read, notifications for any frame), or the policy
  // is installed only after the window has loaded.
  it('installs the permission policy on the session with the app URL, before the window', () => {
    const policy = code.indexOf('installPermissionPolicy(session.defaultSession, APP_URL, {');
    expect(policy).toBeGreaterThan(-1);
    expect(code.match(/installPermissionPolicy\(/g)).toHaveLength(1);
    const startupWindow = code.indexOf('createWindow();', code.indexOf('registerAllHandlers();'));
    expect(startupWindow).toBeGreaterThan(policy);
    expect(code).not.toMatch(/setPermission(Request|Check)Handler\(/);
  });

  // Breaks: the window is built with hand-written preferences that drop the
  // sandbox / isolation / no-drag-drop-navigation settings.
  it('takes its webPreferences from mainWindowWebPreferences', () => {
    expect(code).toContain('webPreferences: mainWindowWebPreferences({');
    expect(code.match(/webPreferences:/g)).toHaveLength(1);
  });

  // Breaks: the navigation guards are not installed, or not with the app URL,
  // and a local HTML page can replace the app or the email frame.
  it('installs the navigation guards on the window with the app URL', () => {
    expect(code).toContain('installNavigationGuards(mainWindow.webContents, APP_URL, {');
    expect(code).not.toContain("'will-navigate'");
    expect(code).not.toContain("'will-frame-navigate'");
  });
});
