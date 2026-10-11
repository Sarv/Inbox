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
