import { readFileSync } from 'fs';
import { join } from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

// The app's name decides its data folder and keychain item, and Electron fixes
// the data folder the first time anything reads it. A regression here is a dev
// run that reads and writes the INSTALLED app's mailbox data and key (seen
// 2026-11-19, when a module opened the core database while loading, before
// main.ts named the app).

const electron = vi.hoisted(() => ({ app: { name: 'Sarv Inbox' } }));
const devMode = vi.hoisted(() => ({ isDevBuild: vi.fn(() => true) }));
vi.mock('electron', () => electron);
vi.mock('../../../electron/utils/dev-mode', () => devMode);

afterEach(() => { vi.resetModules(); electron.app.name = 'Sarv Inbox'; });

describe('the app identity', () => {
  // Breaks: dev and the installed app share a data folder and keychain item.
  it.each([[true, 'Sarv Inbox Dev'], [false, 'Sarv Inbox']])('names a dev run (%s) %s as soon as it loads', async (dev, name) => {
    devMode.isDevBuild.mockReturnValue(dev);
    const identity = await import('../../../electron/app-identity');
    expect(electron.app.name).toBe(name);
    expect(identity).toMatchObject({ isDev: dev, APP_NAME: name });
  });

  // Breaks: another import's top level runs before the app is named, so
  // whatever it reads (data folder, core database, keychain) is the release
  // app's. A bare import is also one import/order and eslint --fix never move.
  it('is the first thing main.ts imports, as a bare import', () => {
    const source = readFileSync(join(__dirname, '../../../electron/main.ts'), 'utf8');
    const first = source.split('\n').find(line => /^import\s/.test(line));
    expect(first).toBe("import './app-identity';");
  });
});
