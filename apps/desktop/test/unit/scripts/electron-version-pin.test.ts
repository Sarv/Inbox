import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * The Electron a release packages must be the Electron dev and the tests run.
 *
 * The regression (CASA I-4): `build.electronVersion` was pinned to 43.2.0 at
 * the initial import, and the Electron 44 upgrade (2026-09-26) changed only
 * the devDependency. electron-builder reads `electronVersion` before anything
 * installed, so every release from then on shipped the Electron 43.2.0
 * runtime, while dev, CI and every security test that says "measured on
 * Electron 44" ran 44. beforeBuild rebuilt better-sqlite3 for 43.2.0 to match,
 * so the smoke launch passed and nothing noticed.
 *
 * The fix leaves electron-builder to derive the version. With the hoisted
 * linker there is no apps/desktop/node_modules/electron, so it falls back to
 * the devDependency SPEC, which it accepts only when exact. Hence the pin.
 */

const require = createRequire(import.meta.url);
const desktopDir = fileURLToPath(new URL('../../../', import.meta.url));

const packageJson = require('../../../package.json') as {
  devDependencies: Record<string, string>;
  build: Record<string, unknown>;
};
/** What `pnpm install` put on disk: what `pnpm dev:desktop` and the tests run. */
const installedElectron = (require('electron/package.json') as { version: string }).version;

// electron-builder's own resolver and its own semver, not a reimplementation:
// the risk is precisely the installed builder deciding differently.
const { getElectronVersion, computeElectronVersion } = require('app-builder-lib/out/electron/electronVersion.js') as {
  getElectronVersion: (projectDir: string) => Promise<string>;
  computeElectronVersion: (projectDir: string) => Promise<string>;
};
const semver = createRequire(require.resolve('app-builder-lib/package.json'))('semver') as {
  valid: (version: string) => string | null;
};

describe('the packaged Electron version', () => {
  // Breaks: a hard-coded electronVersion drifts from the installed Electron
  // again, and releases ship a runtime nobody developed or tested on.
  it('is not pinned separately in the electron-builder config (or matches the install)', () => {
    expect(packageJson.build.electronVersion ?? installedElectron).toBe(installedElectron);
  });

  // Breaks: a range (`^44.5.1`) makes electron-builder refuse to package
  // ("is not fixed in project"); a stale exact pin makes it package a version
  // other than the one installed.
  it('is pinned exactly in devDependencies, to the installed Electron', () => {
    const spec = packageJson.devDependencies.electron;
    expect(semver.valid(spec), `"electron": "${spec}" must be an exact version`).toBe(spec);
    expect(spec).toBe(installedElectron);
  });

  // Breaks: whatever the two checks above miss about how electron-builder
  // actually picks the version (config first, then node_modules, then the
  // spec). This is the same call its ElectronFramework makes before packaging.
  it("is what electron-builder's own resolver picks for apps/desktop", async () => {
    await expect(getElectronVersion(desktopDir)).resolves.toBe(installedElectron);
    await expect(computeElectronVersion(desktopDir)).resolves.toBe(installedElectron);
  });
});
