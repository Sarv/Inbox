import { readFileSync } from 'node:fs';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { devServerUrlFor, isDevBuild, isDevRun, isReleaseBundle } from '../../../../electron/utils/dev-mode';

vi.mock('electron', () => ({ app: { isPackaged: true } }));

/**
 * Dev-run detection.
 *
 * What breaks if this goes red: the dev app is treated as a shipped build — it
 * takes the single-instance lock, publishes a heartbeat, and puts the
 * "Move to Applications?" modal in front of a startup that then waits on it
 * with no window, looking exactly like a dev app that will not start.
 */
describe('isDevRun', () => {
  // THE case: the renamed `Sarv Inbox Dev` binary makes Electron report
  // isPackaged === true; the dev server URL must still win.
  it('is dev under the vite dev server even when Electron claims packaged', () => {
    expect(isDevRun({ devServerUrl: 'http://localhost:5173', isPackaged: true })).toBe(true);
  });

  // A plain `electron .` run has no dev server but is unpackaged.
  it('is dev for an unpackaged run without a dev server', () => {
    expect(isDevRun({ devServerUrl: undefined, isPackaged: false })).toBe(true);
  });

  // A shipped build: no dev server and packaged. An empty URL is not a server.
  it('is not dev for a packaged build with no dev server', () => {
    expect(isDevRun({ devServerUrl: undefined, isPackaged: true })).toBe(false);
    expect(isDevRun({ devServerUrl: '', isPackaged: true })).toBe(false);
    expect(isDevRun({ devServerUrl: null, isPackaged: true })).toBe(false);
  });
});

// CASA L-3: in a shipped app VITE_DEV_SERVER_URL can only come from whoever
// launched it (a shell, or a .env in the launch directory). Breaks: it turns
// a release build into a "dev run" (DevTools, dev profile) and the window
// loads the attacker's server with the full preload bridge.
describe('a release bundle ignores the dev server URL', () => {
  it('is not dev when packaged, whatever the environment says', () => {
    expect(isDevRun({ devServerUrl: 'http://evil.example', isPackaged: true, releaseBundle: true })).toBe(false);
    // An unpackaged run of a release bundle (`electron .`) is still a local run.
    expect(isDevRun({ devServerUrl: 'http://evil.example', isPackaged: false, releaseBundle: true })).toBe(true);
  });

  it('never loads a dev server, not even the localhost default', () => {
    expect(devServerUrlFor({ envUrl: 'http://evil.example', releaseBundle: true, isDev: true })).toBeNull();
    expect(devServerUrlFor({ envUrl: undefined, releaseBundle: true, isDev: true })).toBeNull();
  });

  // Dev runs unchanged. Breaks: `pnpm dev:desktop` loads a blank window.
  it('loads the dev server in a dev bundle, defaulting to localhost for a dev run', () => {
    expect(devServerUrlFor({ envUrl: 'http://localhost:5174', releaseBundle: false, isDev: true })).toBe('http://localhost:5174');
    expect(devServerUrlFor({ envUrl: undefined, releaseBundle: false, isDev: true })).toBe('http://localhost:5173');
    expect(devServerUrlFor({ envUrl: '', releaseBundle: false, isDev: false })).toBeNull();
  });
});

describe('isReleaseBundle', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it('is true only for a bundle built in production mode', () => {
    vi.stubEnv('SARVINBOX_BUILD_MODE', 'production');
    expect(isReleaseBundle()).toBe(true);
    vi.stubEnv('SARVINBOX_BUILD_MODE', 'development');
    expect(isReleaseBundle()).toBe(false);
    vi.stubEnv('SARVINBOX_BUILD_MODE', '');
    expect(isReleaseBundle()).toBe(false);
  });

  // Vite inlines only the exact `process.env.NAME` form. Breaks: a bracket
  // read (or a renamed define) is not replaced at build time, so a release
  // bundle reads its real environment — where the mode is unset — and the dev
  // server URL is honoured again.
  it('reads the mode in the form vite inlines, and the build defines it', () => {
    const devMode = readFileSync(new URL('../../../../electron/utils/dev-mode.ts', import.meta.url), 'utf8');
    expect(devMode).toContain("return process.env.SARVINBOX_BUILD_MODE === 'production';");
    const viteConfig = readFileSync(new URL('../../../../vite.config.ts', import.meta.url), 'utf8');
    expect(viteConfig).toContain("defines['process.env.SARVINBOX_BUILD_MODE'] = JSON.stringify(mode);");
    expect(viteConfig.match(/define: buildDefines\(mode\)/g)!.length).toBeGreaterThanOrEqual(3);
  });
});

// The live check main.ts uses. Breaks: isDevBuild stops passing the release
// flag through, so a packaged release build with VITE_DEV_SERVER_URL in its
// environment runs as dev again.
describe('isDevBuild', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it('ignores the dev server URL in a packaged release bundle, and honours it in a dev bundle', () => {
    vi.stubEnv('VITE_DEV_SERVER_URL', 'http://evil.example');
    vi.stubEnv('SARVINBOX_BUILD_MODE', 'production');
    expect(isDevBuild()).toBe(false);
    vi.stubEnv('SARVINBOX_BUILD_MODE', 'development');
    expect(isDevBuild()).toBe(true);
  });
});
