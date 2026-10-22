import fs, { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  assertNoProfileReset, cleanProfileCaches, eraseProfile, eraseProfiles, getResetProfiles, planProfileCleanup,
  type ProfileResetOptions, type ResetProfileId,
} from '../../../../../scripts/lib/profile-reset.mjs';
import { asPlatform } from '../../helpers/as-platform';

let work: string; let baseDir: string;
const names = { production: 'Sarv Inbox', development: 'Sarv Inbox Dev' };
const options = (): ProfileResetOptions => ({ baseDir, readProcesses: () => [], isPidAlive: () => false });
const directory = (profile: ResetProfileId) => join(baseDir, names[profile]);
const lock = (profile: ResetProfileId) => join(baseDir, `.sarvinbox-profile-reset-${profile}.lock`);
function seed(profile: ResetProfileId, file: string, value = 'scratch fixture'): string {
  const target = join(directory(profile), file); mkdirSync(join(target, '..'), { recursive: true }); writeFileSync(target, value); return target;
}
beforeEach(() => {
  work = realpathSync(mkdtempSync(join(tmpdir(), 'inbox-profile-reset-')));
  baseDir = join(work, 'app-data'); mkdirSync(baseDir);
});
afterEach(() => { rmSync(work, { recursive: true, force: true }); });

describe('exact profile erasure', () => {
  it('removes the entire selected profile, including unknown nested data, without touching another profile or legacy data', () => {
    const dev = seed('development', 'sarvinbox-core.db');
    const other = join(baseDir, 'Sarv Inbox AI'); mkdirSync(other); writeFileSync(join(other, 'keep'), 'legacy');
    for (const file of ['sarvinbox-core.db', 'db-key.bin', 'sarvinbox-orphan.db-wal', 'sarvinbox-orphan.db.bak',
      'secure-credentials.json.premigrated', 'ai-secrets.json', 'Local State', 'Network/Cookies', 'Partitions/oauth/Cookies',
      'attachment-store/account/file', 'attachment-previews/file', 'extensions-data/secret', 'unknown/future/file']) seed('production', file);
    expect(eraseProfile({ ...options(), profile: 'production' })).toEqual({ profile: 'production', dir: directory('production'), removed: true });
    expect(existsSync(directory('production'))).toBe(false); expect(existsSync(dev)).toBe(true);
    expect(readFileSync(join(other, 'keep'), 'utf8')).toBe('legacy'); expect(existsSync(lock('production'))).toBe(false);
  });

  it('reports an absent profile honestly and is idempotent', () => {
    expect(eraseProfile({ ...options(), profile: 'production' }).removed).toBe(false);
    expect(eraseProfile({ ...options(), profile: 'production' }).removed).toBe(false);
  });

  it.each(['throw', 'remain'])('never reports success when erasure fails (%s)', failure => {
    const file = seed('production', 'keep'); const original = fs.rmSync;
    const remove = vi.spyOn(fs, 'rmSync').mockImplementation((target, args) => {
      if (String(target) === directory('production')) {
        if (failure === 'throw') throw new Error('private low-level failure');
        return;
      }
      return original(target, args);
    });
    try {
      expect(() => eraseProfile({ ...options(), profile: 'production' })).toThrow(/incomplete/);
      expect(existsSync(file)).toBe(true); expect(existsSync(lock('production'))).toBe(false);
    } finally { remove.mockRestore(); }
  });

  it.each(['all', '../Sarv Inbox', '/tmp', 'constructor', '__proto__', ''])('rejects arbitrary or unknown profile %j before changing files', profile => {
    const file = seed('production', 'keep');
    expect(() => eraseProfile({ ...options(), profile: profile as ResetProfileId })).toThrow('Choose production or development');
    expect(existsSync(file)).toBe(true); expect(readdirSync(baseDir)).toEqual(['Sarv Inbox']);
  });

  it('rejects a relative trusted base directory and an arbitrary ignored process', () => {
    expect(() => eraseProfile({ ...options(), baseDir: '../relative', profile: 'production' })).toThrow('absolute trusted path');
    expect(() => eraseProfile({ ...options(), ignorePid: process.pid + 10, profile: 'production' })).toThrow('Only the current reset process');
  });

  it('acquires the operation lock before the live-process snapshot and releases it afterward', () => {
    seed('production', 'keep');
    const readProcesses = vi.fn(() => {
      expect(existsSync(lock('production'))).toBe(true);
      expect(JSON.parse(readFileSync(lock('production'), 'utf8')).pid).toBe(process.pid);
      if (process.platform !== 'win32') expect(lstatSync(lock('production')).mode & 0o777).toBe(0o600);
      return [];
    });
    eraseProfile({ ...options(), profile: 'production', readProcesses });
    expect(readProcesses).toHaveBeenCalledOnce(); expect(existsSync(lock('production'))).toBe(false);
  });

  it('holds both explicit all-profile locks and preflights both before deleting either profile', () => {
    const prod = seed('production', 'keep'); const dev = seed('development', 'keep');
    expect(() => eraseProfiles({ ...options(), profiles: ['production', 'development'], readProcesses: () => {
      expect(existsSync(lock('production'))).toBe(true); expect(existsSync(lock('development'))).toBe(true);
      return [{ pid: 314, command: 'sarvinbox-main' }];
    } })).toThrow('Quit Sarv Inbox');
    expect(existsSync(prod)).toBe(true); expect(existsSync(dev)).toBe(true);
    expect(existsSync(lock('production'))).toBe(false); expect(existsSync(lock('development'))).toBe(false);
  });

  it('removes both current profiles only when both were explicitly selected', () => {
    seed('production', 'keep'); seed('development', 'keep');
    expect(eraseProfiles({ ...options(), profiles: ['production', 'development'] })).toHaveLength(2);
    expect(existsSync(directory('production'))).toBe(false); expect(existsSync(directory('development'))).toBe(false);
  });
});

describe('symlink and path refusal', () => {
  it('rejects a symlinked profile without following or removing its target', () => {
    const outside = join(work, 'outside'); mkdirSync(outside); writeFileSync(join(outside, 'keep'), 'x');
    symlinkSync(outside, directory('production'), 'junction');
    expect(() => eraseProfile({ ...options(), profile: 'production' })).toThrow('symbolic link');
    expect(readFileSync(join(outside, 'keep'), 'utf8')).toBe('x'); expect(lstatSync(directory('production')).isSymbolicLink()).toBe(true);
  });

  it('rejects a symlinked ancestor and a symlinked lock', () => {
    const alias = join(work, 'alias'); symlinkSync(baseDir, alias, 'junction'); seed('production', 'keep');
    expect(() => eraseProfile({ ...options(), baseDir: alias, profile: 'production' })).toThrow('symbolic link');
    const outside = join(work, 'outside.json'); writeFileSync(outside, '{"pid":2}'); symlinkSync(outside, lock('production'));
    expect(() => eraseProfile({ ...options(), profile: 'production' })).toThrow('symbolic link');
    expect(readFileSync(outside, 'utf8')).toBe('{"pid":2}');
  });

  it('unlinks nested profile symlinks without following them outside the selected profile', () => {
    const outside = join(work, 'outside'); mkdirSync(outside); writeFileSync(join(outside, 'keep'), 'outside');
    seed('production', 'keep'); symlinkSync(outside, join(directory('production'), 'nested-link'), 'junction');
    expect(eraseProfile({ ...options(), profile: 'production' }).removed).toBe(true);
    expect(readFileSync(join(outside, 'keep'), 'utf8')).toBe('outside');
  });

  it('revalidates paths after the process snapshot so a target replaced by a symlink is refused', () => {
    seed('production', 'keep'); const outside = join(work, 'outside'); mkdirSync(outside); writeFileSync(join(outside, 'keep'), 'outside');
    expect(() => eraseProfile({ ...options(), profile: 'production', readProcesses: () => {
      rmSync(directory('production'), { recursive: true }); symlinkSync(outside, directory('production'), 'junction'); return [];
    } })).toThrow('symbolic link');
    expect(readFileSync(join(outside, 'keep'), 'utf8')).toBe('outside');
  });
});

describe('running processes and startup reset locks', () => {
  it('allows ordinary startup with a relocated/symlinked profile or ancestor when no reset lock exists', () => {
    const outside = join(work, 'outside'); mkdirSync(outside); symlinkSync(outside, directory('production'), 'junction');
    expect(() => assertNoProfileReset({ ...options(), profile: 'production' })).not.toThrow();
    const alias = join(work, 'alias'); symlinkSync(baseDir, alias, 'junction');
    expect(() => assertNoProfileReset({ ...options(), baseDir: alias, profile: 'production' })).not.toThrow();
    writeFileSync(lock('production'), '{"pid":314}');
    expect(() => assertNoProfileReset({ ...options(), profile: 'production', isPidAlive: () => true })).toThrow('symbolic link');
  });

  it.each(['instance-heartbeat.json', 'dev-instance.json'])('blocks a live %s even if its timestamp is stale', record => {
    const file = seed('production', record, JSON.stringify({ pid: 314, ts: 1 }));
    expect(() => eraseProfile({ ...options(), profile: 'production', isPidAlive: () => true })).toThrow('Quit Sarv Inbox');
    expect(existsSync(file)).toBe(true); expect(existsSync(lock('production'))).toBe(false);
  });

  it.each([null, true])('fails closed when a recorded pid liveness is %s', alive => {
    seed('production', 'instance-heartbeat.json', '{"pid":314}');
    expect(() => eraseProfile({ ...options(), profile: 'production', isPidAlive: () => alive })).toThrow('Quit Sarv Inbox');
  });

  it('ignores a proved-dead stale record but rejects invalid records', () => {
    seed('production', 'instance-heartbeat.json', '{"pid":314}');
    expect(eraseProfile({ ...options(), profile: 'production' }).removed).toBe(true);
    seed('production', 'instance-heartbeat.json', 'bad-record');
    expect(() => eraseProfile({ ...options(), profile: 'production' })).toThrow('unreadable or invalid');
  });

  it.each([
    ['production', '/Applications/Sarv Inbox.app/Contents/MacOS/Sarv Inbox'],
    ['production', '/Applications/Renamed Inbox.app/Contents/MacOS/Sarv Inbox'],
    ['production', '/usr/bin/sarv-inbox'], ['production', 'sarvinbox-main'],
    ['production', 'C:\\Program Files\\Sarv Inbox\\Sarv Inbox.exe'],
    ['development', '/project/node_modules/electron/dist/Electron.app/Contents/MacOS/SarvInboxDev'],
    ['development', 'sarvinbox-dev-main'],
  ] as const)('blocks a real %s main with no pid record: %s', (profile, command) => {
    seed(profile, 'keep');
    expect(() => eraseProfile({ ...options(), profile, readProcesses: () => [{ pid: 314, command }] })).toThrow('Quit Sarv Inbox');
  });

  it('ignores only this fresh bootstrap pid, excludes renderer/GPU/utility/relauncher children, and still blocks another main', () => {
    seed('development', 'dev-instance.json', JSON.stringify({ pid: process.pid }));
    const executable = '/project/node_modules/electron/dist/Electron.app/Contents/MacOS/SarvInboxDev';
    const rows = [{ pid: process.pid, command: executable },
      ...['renderer', 'gpu-process', 'utility'].map((type, index) => ({ pid: 800 + index, command: `${executable} --type=${type}` })),
      { pid: 810, command: '/project/node_modules/electron/dist/Electron.app/Contents/Frameworks/Electron Framework.framework/Helpers/chrome_crashpad_handler' },
      { pid: 811, command: '/project/node_modules/electron/dist/Electron.app/Contents/Frameworks/Squirrel.framework/Resources/relauncher' },
      { pid: 812, command: '/project/node_modules/electron/dist/Electron.app/Contents/Frameworks/Electron Helper.app/Contents/MacOS/Electron Helper' }];
    const deps = { ...options(), ignorePid: process.pid, isPidAlive: () => true, readProcesses: () => rows };
    expect(getResetProfiles(deps).find(profile => profile.id === 'development')?.running).toBe(false);
    rows.push({ pid: 900, command: executable });
    expect(() => eraseProfile({ ...deps, profile: 'development' })).toThrow('Quit Sarv Inbox Dev');
    rows.pop(); expect(eraseProfile({ ...deps, profile: 'development' }).removed).toBe(true);
  });

  it('checks generic Windows Electron conservatively while excluding its typed child processes', () => {
    asPlatform('win32', () => {
      expect(() => eraseProfile({ ...options(), profile: 'development', readProcesses: () => [{ pid: 314, command: 'C:\\dev\\electron.exe . --type=renderer' }] })).not.toThrow();
      expect(() => eraseProfile({ ...options(), profile: 'development', readProcesses: () => [{ pid: 314, command: 'C:\\dev\\electron.exe .' }] })).toThrow('Quit Sarv Inbox Dev');
    });
  });

  it.each([null, [{ pid: 0, command: 'bad' }], [{ pid: 1, command: 12 }]].map(rows => ({ rows })))('refuses unverified process snapshots', ({ rows }) => {
    seed('production', 'keep');
    expect(() => eraseProfile({ ...options(), profile: 'production', readProcesses: () => rows as never })).toThrow('could not be checked');
    expect(existsSync(directory('production'))).toBe(true);
  });

  it('blocks normal startup and a concurrent erasure while the operation lock is held', () => {
    seed('production', 'keep');
    eraseProfile({ ...options(), profile: 'production', readProcesses: () => {
      const deps = { ...options(), profile: 'production' as const, isPidAlive: () => true };
      expect(() => assertNoProfileReset(deps)).toThrow('already in progress');
      expect(() => eraseProfile(deps)).toThrow('already in progress'); return [];
    } });
    expect(() => assertNoProfileReset({ ...options(), profile: 'production' })).not.toThrow();
  });

  it('removes a stale operation lock only when its owner is proved dead', () => {
    writeFileSync(lock('production'), '{"pid":314}');
    expect(() => assertNoProfileReset({ ...options(), profile: 'production', isPidAlive: () => null })).toThrow('already in progress');
    expect(existsSync(lock('production'))).toBe(true);
    assertNoProfileReset({ ...options(), profile: 'production' }); expect(existsSync(lock('production'))).toBe(false);
    writeFileSync(lock('production'), 'invalid');
    expect(() => assertNoProfileReset({ ...options(), profile: 'production' })).toThrow('unreadable or invalid');
  });
});

describe('cache-only clean and read-only plans', () => {
  it('keeps all mail, drafts/outbox, attachments, credentials, browser sessions and extensions', () => {
    const keep = ['sarvinbox-core.db', 'sarvinbox-account.db', 'sarvinbox-account.db-wal', 'db-key.bin',
      'attachment-store/draft/file', 'attachment-cache/draft/file', 'Cookies', 'Local Storage/value', 'IndexedDB/value',
      'extensions-data/value', 'Preferences', 'unknown-future-data'];
    for (const file of keep) seed('development', file);
    for (const file of ['Cache/value', 'Code Cache/value', 'GPUCache/value', 'app.log', 'app.log.1']) seed('development', file);
    const result = cleanProfileCaches({ ...options(), profile: 'development' });
    expect(result[0]?.removed).toHaveLength(5);
    for (const file of keep) expect(existsSync(join(directory('development'), file)), file).toBe(true);
    expect(existsSync(join(directory('development'), 'Cache'))).toBe(false);
    expect(existsSync(lock('development'))).toBe(false);
  });

  it('dry-run plans touch neither cache nor profile nor stale operation lock', () => {
    const file = seed('production', 'Cache/value'); writeFileSync(lock('production'), '{"pid":314}');
    expect(planProfileCleanup({ profile: 'production', baseDir, full: true })).toEqual([directory('production')]);
    expect(planProfileCleanup({ profile: 'production', baseDir })).toEqual([join(directory('production'), 'Cache')]);
    expect(getResetProfiles(options()).find(profile => profile.id === 'production')).toMatchObject({ exists: true, running: false });
    expect(existsSync(file)).toBe(true); expect(existsSync(lock('production'))).toBe(true);
  });

  it('read-only plans never create a missing app-data directory', () => {
    const missing = join(work, 'missing');
    expect(planProfileCleanup({ profile: 'production', baseDir: missing, full: true })).toEqual([join(missing, 'Sarv Inbox')]);
    expect(getResetProfiles({ ...options(), baseDir: missing }).every(profile => !profile.exists)).toBe(true);
    expect(existsSync(missing)).toBe(false);
  });

  it('refuses cache/log symlinks before deleting any other cache item', () => {
    const cache = seed('development', 'Cache/value'); const outside = join(work, 'outside.log'); writeFileSync(outside, 'outside');
    symlinkSync(outside, join(directory('development'), 'app.log'));
    expect(() => cleanProfileCaches({ ...options(), profile: 'development' })).toThrow('symbolic link');
    expect(existsSync(cache)).toBe(true); expect(readFileSync(outside, 'utf8')).toBe('outside');
  });
});
