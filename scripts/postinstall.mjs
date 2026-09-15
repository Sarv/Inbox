#!/usr/bin/env node

// Post-install native-deps fixup for desktop dev on Node 22/24 + Electron 32.
//
// Two problems this repo hits after a plain `pnpm install`, both surfaced by
// running a recent Node against electron@32:
//
//   1. better-sqlite3 installs a prebuilt binary for the *host* Node ABI
//      (e.g. ABI 137 on Node 24), but the desktop app runs inside Electron,
//      which needs Electron's ABI (128 for Electron 32). Loading the DB then
//      fails with ERR_DLOPEN_FAILED / NODE_MODULE_VERSION mismatch.
//
//   2. electron@32's bundled zip-extractor fails to unpack the Electron binary
//      under Node 24 — `dist/` ends up with only the license file and the app
//      throws "Electron failed to install correctly". The downloaded zip in the
//      cache is intact, so we just re-extract it ourselves.
//
// Best-effort by design: failures log actionable guidance and exit 0 so they
// never block installs on CI or platforms where the desktop app isn't built.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { rebuildBetterSqlite3 } from './lib/native-abi.mjs';

const ROOT = join(import.meta.dirname, '..');
const NODE_MODULES = join(ROOT, 'node_modules');
const log = (msg) => console.log(`[postinstall] ${msg}`);
const warn = (msg) => console.warn(`[postinstall] ${msg}`);

const readElectronVersion = () => {
  const pkg = join(NODE_MODULES, 'electron', 'package.json');
  if (!existsSync(pkg)) return null;
  return JSON.parse(readFileSync(pkg, 'utf8')).version ?? null;
};

// Resolve @electron/get's cache directory for the current platform.
const electronCacheDir = () => {
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Caches', 'electron');
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
    return join(local, 'electron', 'Cache');
  }
  const xdg = process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache');
  return join(xdg, 'electron');
};

// Find the cached Electron zip for this version/platform/arch, wherever
// @electron/get parked it (cache is bucketed under opaque hash subdirs).
const findCachedZip = (version) => {
  const cacheDir = electronCacheDir();
  if (!existsSync(cacheDir)) return null;
  const zipName = `electron-v${version}-${process.platform}-${process.arch}.zip`;
  for (const entry of readdirSync(cacheDir)) {
    const candidate = join(cacheDir, entry, zipName);
    if (existsSync(candidate)) return candidate;
  }
  return null;
};

// (2) Re-extract Electron from its cached zip if the binary is missing.
const ensureElectronExtracted = (version) => {
  if (process.platform !== 'darwin') return; // mac is the primary dev target
  const electronDir = join(NODE_MODULES, 'electron');
  const distAppDir = join(electronDir, 'dist', 'Electron.app');
  const pathTxt = join(electronDir, 'path.txt');
  // Presence check must tolerate our dev rename: brandDevAppName() renames the
  // launcher binary (MacOS/Electron → "Sarv Inbox Dev") and repoints path.txt.
  // Checking the stock "MacOS/Electron" path would then read as "missing" on
  // every later install and needlessly re-extract. Validate the binary that
  // path.txt actually points at instead.
  const binaryPresent = () => {
    if (!existsSync(pathTxt)) return false;
    try {
      // path.txt is relative to dist/ — the electron package resolves it as
      // join(__dirname, 'dist', <path.txt>). Mirror that here.
      const rel = readFileSync(pathTxt, 'utf8').trim();
      return !!rel && existsSync(join(electronDir, 'dist', rel));
    } catch {
      return false;
    }
  };
  if (existsSync(distAppDir) && binaryPresent()) {
    log('Electron binary present — skipping extraction');
    return;
  }
  const zip = findCachedZip(version);
  if (!zip) {
    warn(`Electron binary missing and no cached zip found. Run: pnpm --filter @sarvinbox/desktop exec node node_modules/electron/install.js`);
    return;
  }
  log(`Electron binary missing — re-extracting from cache (${zip})`);
  const dist = join(electronDir, 'dist');
  rmSync(dist, { recursive: true, force: true });
  execFileSync('unzip', ['-q', zip, '-d', dist], { stdio: 'inherit' });
  writeFileSync(pathTxt, 'Electron.app/Contents/MacOS/Electron');
  log('Electron extracted');
};

// (3) Brand the dev app name. In dev we run the raw Electron binary, so macOS
// reads the *Electron* bundle's Info.plist for the dock name and Cmd+Tab label
// — which ships as "Electron". `app.name`/the custom menu only fix the menu
// bar, not the bundle name. Rewrite CFBundleName/CFBundleDisplayName so dev
// shows "Sarv Inbox" everywhere. The packaged build has its own correct
// plist, so this only affects local dev. Idempotent.
//
// CRUCIALLY we also rewrite CFBundleIdentifier away from the stock
// "com.github.Electron". macOS caches an app's Dock/Cmd+Tab name+icon PER
// bundle identifier — and every Electron dev build ever run on the machine has
// shared "com.github.Electron", so that identifier is durably cached as
// "Electron" in the Dock/WindowServer. Rebranding the name alone leaves the
// Dock and Cmd+Tab switcher showing "Electron" until a logout/reboot. Giving
// the bundle our own identifier (the packaged app's, from build.appId) makes
// macOS treat it as a fresh app with no cached name — fixed without a reboot.
// Dev is deliberately distinct from the packaged release ("Sarv Inbox" /
// build.appId) so an installed DMG and the dev build never collide — separate
// dock name, separate bundle id, and (via app.name in main.ts) separate
// userData dir. Suffix the release appId with ".dev" for the identifier.
const DEV_APP_NAME = 'Sarv Inbox Dev';
const readDevAppId = () => {
  try {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'apps', 'desktop', 'package.json'), 'utf8'));
    const releaseId = pkg.build?.appId || 'com.sarv.sarvinbox';
    return `${releaseId}.dev`;
  } catch {
    return 'com.sarv.sarvinbox.dev';
  }
};
const brandDevAppName = () => {
  if (process.platform !== 'darwin') return; // dock naming is a macOS-only concern
  const appPath = join(NODE_MODULES, 'electron', 'dist', 'Electron.app');
  const plist = join(appPath, 'Contents', 'Info.plist');
  const macosDir = join(appPath, 'Contents', 'MacOS');
  const pathTxt = join(NODE_MODULES, 'electron', 'path.txt');
  if (!existsSync(plist)) {
    warn('Electron Info.plist not found — skipping dev app-name branding');
    return;
  }
  const DEV_APP_ID = readDevAppId();
  const print = (key) =>
    execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist]).toString().trim();
  const set = (key, value) =>
    execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, plist]);
  try {
    const nameOk = print('CFBundleName') === DEV_APP_NAME;
    const idOk = print('CFBundleIdentifier') === DEV_APP_ID;
    const exeOk = print('CFBundleExecutable') === DEV_APP_NAME;
    if (nameOk && idOk && exeOk) {
      log(`Dev app already branded "${DEV_APP_NAME}" (${DEV_APP_ID})`);
    } else {
      set('CFBundleName', DEV_APP_NAME);
      set('CFBundleDisplayName', DEV_APP_NAME);
      set('CFBundleIdentifier', DEV_APP_ID);
      set('CFBundleExecutable', DEV_APP_NAME);
      // Bump the bundle mtime so name/icon caches keyed on it invalidate.
      try { execFileSync('touch', [appPath]); } catch { /* best-effort */ }
      log(`Dev app branded "${DEV_APP_NAME}" (${DEV_APP_ID})`);
    }
  } catch {
    warn('Could not rewrite Electron bundle identity — dev dock may still show "Electron"');
    return;
  }

  // Rename the launcher binary — THE fix for the dock/Cmd+Tab label. `pnpm dev`
  // exec's this binary DIRECTLY (via the `electron` package's path.txt), so the
  // Dock/Cmd+Tab tile takes the EXECUTABLE FILENAME, not CFBundleName /
  // LSDisplayName. A stock install ships it as "Electron", which is why the dev
  // tile kept saying "Electron" no matter what we did to the plist or the
  // LaunchServices cache. Rename it (exactly what electron-builder does for the
  // packaged app) and repoint path.txt so require('electron') finds it.
  try {
    const stockExe = join(macosDir, 'Electron');
    const brandedExe = join(macosDir, DEV_APP_NAME);
    if (existsSync(stockExe) && !existsSync(brandedExe)) {
      renameSync(stockExe, brandedExe);
      log(`Renamed dev launcher binary → "${DEV_APP_NAME}"`);
    }
    if (existsSync(brandedExe)) {
      writeFileSync(pathTxt, `Electron.app/Contents/MacOS/${DEV_APP_NAME}`);
    }
  } catch (e) {
    warn(`Could not rename dev launcher binary — dock may still show "Electron" (${e.message})`);
  }

  // Swap the stock Electron ATOM icon for the Sarv Inbox logo. The Cmd+Tab
  // tile reads the bundle icon (Resources/electron.icns, per CFBundleIconFile),
  // NOT app.dock.setIcon — so without this the switcher keeps showing the atom
  // even though the label is correct. Overwrite electron.icns in place so no
  // plist change is needed; skip if unchanged.
  try {
    const brandIcns = join(ROOT, 'apps', 'desktop', 'build', 'icon.icns');
    const bundleIcns = join(appPath, 'Contents', 'Resources', 'electron.icns');
    if (existsSync(brandIcns)) {
      const next = readFileSync(brandIcns);
      const cur = existsSync(bundleIcns) ? readFileSync(bundleIcns) : null;
      if (!cur || !cur.equals(next)) {
        writeFileSync(bundleIcns, next);
        log('Set dev app icon to the Sarv Inbox logo');
      }
    } else {
      warn('apps/desktop/build/icon.icns not found — dev icon stays the Electron atom');
    }
  } catch (e) {
    warn(`Could not set dev app icon (${e.message})`);
  }
  // Refresh LaunchServices so macOS drops any cached "Electron" label for this
  // bundle path. This runs UNCONDITIONALLY (not gated on the plist changing):
  // a `touch` doesn't invalidate the name cache, and once the plist is already
  // correct we'd otherwise never clear a cache still holding the old name — the
  // exact reason a rebranded bundle kept showing "Electron". lsregister is cheap
  // and non-disruptive; the next dev launch reads the fresh name.
  try {
    const lsregister =
      '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';
    if (existsSync(lsregister)) execFileSync(lsregister, ['-f', appPath]);
  } catch {
    // Non-fatal — worst case the dock shows the stale name until a manual
    // re-register (lsregister -f node_modules/electron/dist/Electron.app).
  }
};

// (1) Rebuild better-sqlite3 for Electron's ABI.
//
// The rebuild itself lives in scripts/lib/native-abi.mjs, shared with
// scripts/native-abi.mjs (`pnpm test:node-abi`), because the addon is valid for
// exactly ONE ABI at a time and the two callers must not drift.
//
// SARVINBOX_SKIP_ELECTRON_REBUILD=1 skips it — set by CI, which runs the test
// suites in plain Node and would otherwise spend a minute compiling a binary it
// then has to replace.
const rebuildBetterSqliteForElectron = (version) => {
  if (process.env.SARVINBOX_SKIP_ELECTRON_REBUILD === '1') {
    log('SARVINBOX_SKIP_ELECTRON_REBUILD=1 — leaving better-sqlite3 on the Node ABI');
    return;
  }
  rebuildBetterSqlite3({ runtime: 'electron', target: version, log, warn });
};

const main = () => {
  const version = readElectronVersion();
  if (!version) {
    log('electron not installed — nothing to do');
    return;
  }
  ensureElectronExtracted(version);
  brandDevAppName();
  rebuildBetterSqliteForElectron(version);
};

main();
