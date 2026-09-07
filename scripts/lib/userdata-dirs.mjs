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
export function appDataBase() {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support');
  }
  if (process.platform === 'win32') {
    return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  }
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
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

/** Delete a single file. Returns true if it existed and was removed. */
export function rmFile(p) {
  if (!exists(p)) return false;
  fs.rmSync(p, { force: true });
  return true;
}

/** Delete a directory tree. Returns true if it existed and was removed. */
export function rmDir(p) {
  if (!exists(p)) return false;
  fs.rmSync(p, { recursive: true, force: true });
  return true;
}
