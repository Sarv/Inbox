/*
 * Find the compiled addons inside a packaged Electron app, and say which
 * required ones are missing.
 *
 * Why this exists. On the v1.2.0 tag all four release jobs went green and all
 * four artifacts were empty: `apps/desktop/build/beforeBuild.js` returned
 * false, electron-builder 26 read that as "node_modules are handled
 * externally", and PlatformPackager skipped collecting node_modules on EVERY
 * platform. The installers built, uploaded and installed; their app.asar held
 * only dist/, dist-electron/ and package.json.
 *
 * That shipped because only the Windows job looked inside the artifact (see
 * verify-win-arch.mjs). macOS and Linux verified nothing, so "success" meant
 * "electron-builder exited 0" -- which it does perfectly happily with no
 * better_sqlite3.node in the package. And a missing addon is not a crash: every
 * core-DB read is wrapped in a try/catch returning an empty result (CLAUDE.md),
 * so the user gets an app with no accounts and no mail rather than an error.
 *
 * An unreadable store and an empty store are the same value and opposite facts.
 * The only defence is to open the artifact and look.
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * Addons that MUST be present in every packaged app. better-sqlite3 is the
 * whole database: without it there is no mail, no accounts and no error.
 */
export const REQUIRED_ADDONS = ['better_sqlite3.node'];

/**
 * How deep to look for a packed app below the release directory.
 * `mac-arm64/Sarv Inbox.app/Contents/Resources` is 4; `linux-unpacked/resources`
 * is 2. Bounded so this never walks into the unpacked tree looking for more.
 */
const MAX_APP_DEPTH = 5;

/**
 * Collect every `.node` addon under a directory tree: the files on disk, never
 * the entries an archive's header lists (see {@link readTreeOnDisk}).
 *
 * @param {string} root
 * @returns {string[]} Absolute-or-as-given paths, sorted for stable output.
 */
export function findNativeAddons(root) {
  /** @type {string[]} */
  const found = [];
  for (const entry of readTreeOnDisk(root)) {
    if (entry.isFile() && entry.name.endsWith('.node')) {
      found.push(path.join(entry.parentPath ?? entry.path, entry.name));
    }
  }
  return found.sort();
}

/**
 * Every entry under `root` as it is on disk -- never the inside of an archive.
 *
 * Inside Electron (the desktop suite runs there while the dev app holds the
 * Electron ABI) `node:fs` reads every `.asar` file as a directory, and the
 * recursive readdir goes wrong both ways. A real app.asar is descended into and
 * the addons its header LISTS are reported whether or not they are on disk, so
 * an app whose app.asar.unpacked never landed passes. An app.asar that cannot
 * be opened cuts the listing of its directory short, so the app.asar.unpacked
 * beside it -- where the addon really is -- may never be looked at.
 *
 * `process.noAsar` is Electron's switch for exactly this, and means nothing to
 * plain Node. `original-fs` is not enough: Node's recursive readdir asks the
 * native binding whether each entry is a directory, Electron patches that
 * binding for everyone, and so it still steps into a real app.asar and throws
 * ENOTDIR there.
 *
 * @param {string} root
 * @returns {fs.Dirent[]}
 */
function readTreeOnDisk(root) {
  const asarWas = process.noAsar;
  process.noAsar = true;
  try {
    return fs.readdirSync(root, { withFileTypes: true, recursive: true });
  } finally {
    // Process-wide: if it stayed set, an Electron process could no longer read its own app.asar.
    process.noAsar = asarWas;
  }
}

/**
 * Find the `resources` directory of every app packed below `releaseDir` -- the
 * directory holding `app.asar`, on any platform. Returns one entry per packed
 * app, so a two-arch build that only produced one of them is still caught.
 *
 * @param {string} releaseDir electron-builder's output directory.
 * @returns {string[]} Sorted resource directories.
 */
export function findPackagedApps(releaseDir) {
  /** @type {string[]} */
  const found = [];

  /** @param {string} directory @param {number} depth */
  const walk = (directory, depth) => {
    if (depth > MAX_APP_DEPTH) return;
    /** @type {fs.Dirent[]} */
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return; // A dangling symlink or an unreadable dir is not a packed app.
    }
    if (entries.some((entry) => entry.name === 'app.asar')) {
      found.push(directory);
      return; // Do not descend into the app's own payload.
    }
    for (const entry of entries) {
      if (entry.isDirectory()) walk(path.join(directory, entry.name), depth + 1);
    }
  };

  walk(releaseDir, 0);
  return found.sort();
}

/**
 * Which of the required addons are absent from a set of found addon paths.
 *
 * Pure: takes paths, returns names. Matching is on the basename so it does not
 * care whether the addon sits in app.asar.unpacked, a flat resources dir, or
 * wherever a future electron-builder decides to put it.
 *
 * @param {string[]} addonPaths Output of {@link findNativeAddons}.
 * @param {string[]} [required] Defaults to {@link REQUIRED_ADDONS}.
 * @returns {string[]} The missing names, in the order they were required.
 */
export function missingRequiredAddons(addonPaths, required = REQUIRED_ADDONS) {
  const present = new Set(addonPaths.map((addon) => path.basename(addon)));
  return required.filter((name) => !present.has(name));
}

/**
 * Read only the start of a file, rather than pulling a multi-megabyte addon
 * into memory to look at a few dozen bytes of its header.
 *
 * @param {string} file
 * @param {number} [bytes] How much to read. The default covers a PE DOS stub
 *   and a Mach-O fat header with room to spare.
 * @returns {Buffer} What was actually read, which may be shorter than `bytes`.
 */
export function readFileHeader(file, bytes = 1024) {
  const handle = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    const read = fs.readSync(handle, buffer, 0, bytes, 0);
    return buffer.subarray(0, read);
  } finally {
    fs.closeSync(handle);
  }
}
