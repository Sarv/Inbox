/*
 * Shared helpers for the maintenance scripts (clean-db, clean-logs, …).
 *
 * Cross-platform (macOS / Windows / Linux): resolves every userData path the app
 * has ever used and offers small fs helpers. Keep OS-specific path logic HERE so
 * the individual scripts stay platform-agnostic and never duplicate it.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Electron's `app.getPath('appData')` — the parent of `userData`. Each app's
 * data lives under `<appData>/<app.name>`, and `app.name` drives the folder name
 * on every platform, so the same app-name list works cross-platform.
 *   macOS   → ~/Library/Application Support
 *   Windows → %APPDATA% (…/AppData/Roaming)
 *   Linux   → $XDG_CONFIG_HOME or ~/.config
 */
export function appDataBase(homeDir = os.homedir()) {
  // `homeDir` is a parameter, not just os.homedir(), so a test can point this at
  // a scratch directory. Overriding $HOME does NOT work from inside a worker
  // thread — `process.env` there is a JS-level copy and `os.homedir()` reads the
  // real process environment through libuv, so the override is invisible to it.
  // vitest runs in worker threads, which is exactly where that bit.
  if (process.platform === 'darwin') {
    return path.join(homeDir, 'Library', 'Application Support');
  }
  if (process.platform === 'win32') {
    return process.env.APPDATA || path.join(homeDir, 'AppData', 'Roaming');
  }
  return process.env.XDG_CONFIG_HOME || path.join(homeDir, '.config');
}

// All app.name values the app has shipped under (current + legacy). Every rename
// leaves orphaned data behind until a cleanup script removes it. The
// "@sarvinbox/desktop" entry is a nested path segment on disk — path.join handles
// the separator.
export const APP_NAMES = [
  'Sarv Inbox',
  'Sarv Inbox Dev',
  'Sarv Inbox AI',
  path.join('@sarvinbox', 'desktop'),
];

/** Resolve each known app.name to its absolute userData dir for this platform. */
export function getAppDataDirs() {
  const base = appDataBase();
  return APP_NAMES.map((name) => ({ label: name, dir: path.join(base, name) }));
}

export function exists(p) {
  return fs.existsSync(p);
}

// The file logger rotates in place: at its size cap it renames app.log →
// app.log.1 and reopens (see apps/desktop/electron/utils/file-logger.ts). So the
// log is up to TWO files, and "delete app.log" leaves the older — and larger —
// half on disk. These are mail logs: they carry addresses, subjects and folder
// names, so a half-clean before sharing a bug report is a privacy problem, not
// just wasted space. Match the whole family, never the bare name.
const LOG_FILE = /^app\.log(\.\d+)?$/;

/** Every log file in a userData dir — app.log plus its rotated siblings. */
export function listLogFiles(dir) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter((name) => LOG_FILE.test(name))
    .sort()
    .map((name) => path.join(dir, name));
}

export function fileSize(p) {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

export function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(1)} ${units[i]}`;
}

// A running app holds its database, log and cache files open. Windows refuses to
// unlink an open file (EBUSY/EPERM) — so an uncaught throw here would abort the
// cleanup half-done, leaving a userData dir with some files gone and some not,
// which is worse than either extreme. macOS and Linux unlink happily and let the
// app keep writing to the orphaned inode, which is its own kind of confusing.
// Both cases want the same thing: skip the file, keep going, and tell the caller
// at the end that the app needs quitting.
const LOCKED = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY']);

/** Files that could not be removed because something else holds them open. */
export const lockedPaths = [];

function remove(p, options) {
  if (!exists(p)) return false;
  try {
    fs.rmSync(p, { force: true, ...options });
    return true;
  } catch (err) {
    if (LOCKED.has(err?.code)) {
      lockedPaths.push(p);
      return false;
    }
    throw err;
  }
}

/** Delete a single file. Returns true if it existed and was removed. */
export function rmFile(p) {
  return remove(p);
}

/** Delete a directory tree. Returns true if it existed and was removed. */
export function rmDir(p) {
  return remove(p, { recursive: true });
}
