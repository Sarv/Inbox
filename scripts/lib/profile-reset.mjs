/* Exact, OS-independent reset. Only trusted main/CLI code supplies baseDir;
 * renderer requests supply a profile id, never a filesystem path. */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { appDataBase } from './userdata-dirs.mjs';

const PROFILES = Object.freeze({ production: 'Sarv Inbox', development: 'Sarv Inbox Dev' });
const RECORDS = ['instance-heartbeat.json', 'dev-instance.json'];
const CACHE_DIRS = ['Cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'Shared Dictionary'];
const LOG_NAME = /^app\.log(?:\.\d+)?$/;
const MAX_RECORD_BYTES = 4096;

export class ProfileResetError extends Error {
  constructor(code, message) { super(message); this.name = 'ProfileResetError'; this.code = code; }
}
const blocked = (code, message) => { throw new ProfileResetError(code, message); };

function profileName(profile) {
  if (typeof profile !== 'string' || !Object.hasOwn(PROFILES, profile)) blocked('INVALID_PROFILE', 'Choose production or development explicitly.');
  return PROFILES[profile];
}
function locations(profile, baseDir = appDataBase()) {
  const label = profileName(profile);
  if (typeof baseDir !== 'string' || !path.isAbsolute(baseDir)) blocked('UNSAFE_PATH', 'The app-data directory must be an absolute trusted path.');
  const base = path.resolve(baseDir);
  return { profile, label, base, dir: path.join(base, label), lock: path.join(base, `.sarvinbox-profile-reset-${profile}.lock`) };
}
function lstat(file) {
  try { return fs.lstatSync(file); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw new ProfileResetError('UNSAFE_PATH', 'A profile path could not be checked safely.'); }
}
/** Reject every symlink, including ancestors, rather than resolving then deleting. */
function assertSafePath(target, directory = false) {
  const absolute = path.resolve(target); let current = path.parse(absolute).root;
  const parts = absolute.slice(current.length).split(path.sep).filter(Boolean);
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]); const entry = lstat(current);
    if (!entry) continue;
    if (entry.isSymbolicLink()) blocked('UNSAFE_PATH', 'Reset refused: the profile, lock or an ancestor is a symbolic link.');
    if ((index < parts.length - 1 || directory) && !entry.isDirectory()) blocked('UNSAFE_PATH', 'Reset refused: an expected profile directory is not a directory.');
  }
  return lstat(absolute);
}
function validatePaths(item) {
  assertSafePath(item.base, true); assertSafePath(item.dir, true);
  const entry = assertSafePath(item.lock);
  if (entry && !entry.isFile()) blocked('UNSAFE_PATH', 'Reset refused: the operation lock is not a regular file.');
}
function readRecord(file) {
  const entry = lstat(file); if (!entry) return null;
  if (!entry.isFile() || entry.isSymbolicLink() || entry.size > MAX_RECORD_BYTES) blocked('INVALID_RECORD', 'An app process record could not be checked safely.');
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Number.isSafeInteger(value?.pid) || value.pid < 1 || value.pid > 2_147_483_647) throw new Error('Invalid pid');
    return { pid: value.pid, stat: entry };
  } catch { blocked('INVALID_RECORD', 'An app process record is unreadable or invalid; reset was not started.'); }
}
/** Signal zero tests existence only; no termination signal is ever sent. */
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === 'ESRCH' ? false : null; }
}
function probePid(options, pid) {
  try { return (options.isPidAlive || pidAlive)(pid); } catch { return null; }
}
/** Bounded read-only metadata; command lines never leave this module. */
function readProcesses() {
  try {
    if (process.platform === 'win32') {
      const text = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        'Get-CimInstance Win32_Process | Select-Object ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress'],
      { encoding: 'utf8', timeout: 5000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
      const parsed = JSON.parse(text || '[]');
      return (Array.isArray(parsed) ? parsed : [parsed]).filter(row => row.ProcessId > 0)
        .map(row => ({ pid: row.ProcessId, command: `${row.ExecutablePath || ''} ${row.CommandLine || ''}`.trim() }));
    }
    if (process.platform !== 'darwin' && process.platform !== 'linux') return null;
    const text = execFileSync('/bin/ps', ['-axo', 'pid=,command='], { encoding: 'utf8', timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
    const rows = text.split('\n').filter(line => line.trim()).map(line => {
      const match = /^\s*(\d+)\s+(.+)$/.exec(line);
      if (!match) throw new Error('Invalid process metadata');
      return { pid: Number(match[1]), command: match[2] };
    });
    return rows.length ? rows : null;
  } catch { return null; }
}
function looksLikeApp(command, profile) {
  const value = command.replaceAll('\\', '/');
  // Renderers, GPU/utility children and the updater/relauncher cannot open a
  // profile's stores. Exclude them even when their path shares the dev bundle.
  if (/(?:^|\s)--type(?:=|\s)/.test(value) || /\.framework\//i.test(value)
    || /\/(?:chrome_)?crashpad_handler(?:["\s]|$)/i.test(value)
    || /\/relauncher(?:["\s]|$)/i.test(value)
    || /\/(?:Electron|SarvInboxDev|Sarv Inbox(?: Dev)?) Helper(?: \([^)]*\))?(?:\.app\/|["\s]|$)/i.test(value)) return false;
  if (profile === 'production') {
    return /^(?:sarvinbox-main|(?:"?[^"\n]*\/)?sarv-inbox)(?:\s|$)/i.test(value)
      || /^"?[^"\n]*\/Contents\/MacOS\/Sarv Inbox(?:"|\s|$)/.test(value)
      || /^"?[^"\n]*\/Sarv Inbox\.exe(?:"|\s|$)/i.test(value);
  }
  return /^sarvinbox-dev-main(?:\s|$)/i.test(value)
    || /^"?[^"\n]*\/(?:SarvInboxDev|Sarv Inbox Dev)(?:\.exe)?(?:"|\s|$)/i.test(value)
    || /^"?[^"\n]*\/node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?electron\//i.test(value)
    // An early Windows dev main is still named electron.exe and may not have
    // recorded its pid yet. Conservatively require Electron to quit there.
    || (process.platform === 'win32' && /^"?[^"\n]*\/electron\.exe(?:"|\s|$)/i.test(value));
}
function snapshot(options) {
  let rows;
  try { rows = (options.readProcesses || readProcesses)(); } catch { rows = null; }
  if (!Array.isArray(rows) || rows.some(row => !Number.isSafeInteger(row?.pid) || row.pid < 1 || typeof row.command !== 'string')) {
    blocked('PROCESS_CHECK_FAILED', 'Running app processes could not be checked. No profile data was changed.');
  }
  return rows;
}
function assertClosed(item, options, rows) {
  for (const name of RECORDS) {
    const record = readRecord(path.join(item.dir, name));
    if (record && record.pid !== options.ignorePid && probePid(options, record.pid) !== false) {
      blocked('PROFILE_RUNNING', `Quit ${item.label} before cleaning or resetting its profile.`);
    }
  }
  if (rows.some(row => row.pid !== options.ignorePid && looksLikeApp(row.command, item.profile))) {
    blocked('PROFILE_RUNNING', `Quit ${item.label} before cleaning or resetting its profile.`);
  }
}
function removeDeadLock(item, options) {
  const record = readRecord(item.lock); if (!record) return;
  if (probePid(options, record.pid) !== false) blocked('RESET_IN_PROGRESS', `A reset of ${item.label} is already in progress. Wait for it to finish.`);
  const current = assertSafePath(item.lock);
  if (!current || current.dev !== record.stat.dev || current.ino !== record.stat.ino) blocked('RESET_IN_PROGRESS', 'The profile reset lock changed. Retry after the other reset finishes.');
  fs.unlinkSync(item.lock);
}
/** Called by normal Electron startup BEFORE Sentry/logging or opening any store. */
export function assertNoProfileReset(options) {
  const item = locations(options.profile, options.baseDir);
  // Ordinary startup may read a user-relocated/symlinked profile. Strict reset
  // path checks apply only when an actual external operation lock is present.
  if (!lstat(item.lock)) return;
  validatePaths(item); removeDeadLock(item, options);
}
function acquire(item, options) {
  validatePaths(item); fs.mkdirSync(item.base, { recursive: true, mode: 0o700 }); validatePaths(item); removeDeadLock(item, options);
  let fd;
  try {
    fd = fs.openSync(item.lock, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: Date.now() })); fs.fsyncSync(fd);
    const own = fs.fstatSync(fd);
    return () => {
      try {
        const current = assertSafePath(item.lock);
        if (!current || current.dev !== own.dev || current.ino !== own.ino) blocked('RESET_IN_PROGRESS', 'The profile reset lock changed; it was not removed.');
        fs.unlinkSync(item.lock);
      } finally { fs.closeSync(fd); }
    };
  } catch (error) {
    if (fd !== undefined) { fs.closeSync(fd); try { fs.unlinkSync(item.lock); } catch { /* Preserve an uncertain lock. */ } }
    if (error instanceof ProfileResetError) throw error;
    blocked('RESET_IN_PROGRESS', `A reset of ${item.label} could not acquire its operation lock. No profile data was changed.`);
  }
}
function selectedItems(profiles, options) {
  if (options.ignorePid !== undefined && options.ignorePid !== process.pid) blocked('INVALID_PROFILE', 'Only the current reset process may be ignored.');
  if (!Array.isArray(profiles) || profiles.length === 0 || profiles.length > 2 || new Set(profiles).size !== profiles.length) blocked('INVALID_PROFILE', 'Choose each reset profile once.');
  return profiles.map(profile => locations(profile, options.baseDir)).sort((a, b) => a.profile.localeCompare(b.profile));
}
function withLocks(profiles, options, action) {
  const items = selectedItems(profiles, options); const releases = []; let result; let failure;
  try {
    for (const item of items) releases.push(acquire(item, options));
    const rows = snapshot(options);
    for (const item of items) { validatePaths(item); assertClosed(item, options, rows); }
    result = action(items);
  } catch (error) { failure = error; }
  for (const release of releases.reverse()) {
    try { release(); } catch (error) { failure ||= error; }
  }
  if (failure) throw failure;
  return result;
}
/** Metadata only; never decrypts data or removes even a stale lock. */
export function getResetProfiles(options = {}) {
  if (options.ignorePid !== undefined && options.ignorePid !== process.pid) blocked('INVALID_PROFILE', 'Only the current reset process may be ignored.');
  let rows; let snapshotError;
  try { rows = snapshot(options); } catch (error) { snapshotError = error; }
  return Object.keys(PROFILES).map(profile => {
    const item = locations(profile, options.baseDir); let reason; let present = false;
    try {
      validatePaths(item); present = !!lstat(item.dir);
      const record = readRecord(item.lock);
      if (record && probePid(options, record.pid) !== false) blocked('RESET_IN_PROGRESS', 'A profile reset is already in progress.');
      if (snapshotError) throw snapshotError;
      assertClosed(item, options, rows);
    } catch (error) { reason = error instanceof ProfileResetError ? error.message : 'The profile could not be checked safely.'; }
    return { id: profile, label: item.label, dir: item.dir, exists: present, running: !!reason, ...(reason ? { blockedReason: reason } : {}) };
  });
}
export function eraseProfiles(options) {
  return withLocks(options.profiles, options, items => items.map(item => {
    validatePaths(item); const present = !!lstat(item.dir);
    try { fs.rmSync(item.dir, { recursive: true, force: true }); }
    catch { blocked('DELETE_FAILED', `The ${item.label} profile could not be fully removed. Close the app and retry; reset is incomplete.`); }
    if (lstat(item.dir)) blocked('DELETE_FAILED', `The ${item.label} profile still exists. Reset is incomplete.`);
    return { profile: item.profile, dir: item.dir, removed: present };
  }));
}
export function eraseProfile(options) { return eraseProfiles({ ...options, profiles: [options.profile] })[0]; }
function cachePaths(item) {
  if (!lstat(item.dir)) return [];
  let names;
  try { names = fs.readdirSync(item.dir); }
  catch { blocked('UNSAFE_PATH', 'Profile caches could not be listed safely.'); }
  return [...CACHE_DIRS, ...names.filter(name => LOG_NAME.test(name))].map(name => path.join(item.dir, name)).filter(file => !!lstat(file));
}
export function planProfileCleanup(options) {
  const item = locations(options.profile, options.baseDir); validatePaths(item);
  return options.full ? [item.dir] : cachePaths(item);
}
export function cleanProfileCaches(options) {
  return withLocks(options.profiles || [options.profile], options, items => items.map(item => {
    const files = cachePaths(item);
    for (const file of files) assertSafePath(file);
    for (const file of files) {
      validatePaths(item); assertSafePath(file);
      try { fs.rmSync(file, { recursive: true, force: true }); }
      catch { blocked('DELETE_FAILED', 'Some caches or logs could not be removed. Close the app and retry.'); }
      if (lstat(file)) blocked('DELETE_FAILED', 'Some caches or logs remain. Cleanup is incomplete.');
    }
    return { profile: item.profile, dir: item.dir, removed: files };
  }));
}
