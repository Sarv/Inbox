/*
 * End-to-end guard for scripts/clean-db.mjs, driven through its real CLI with
 * HOME pointed at a scratch directory so it operates on a fake userData tree.
 *
 * Two shipped bugs are pinned:
 *
 *  - `-y` used to mean FULL RESET. Every other tool treats -y as "skip the
 *    prompt and take the default", and the default here is the SAFE clean — so
 *    `pnpm clean:db -y`, the obvious way to run it unattended, silently deleted
 *    db-key.bin, the OAuth tokens and the accounts registry. --full is now the
 *    only path to that.
 *
 *  - the rotated log survived. Only "app.log" was deleted, leaving app.log.1.
 *
 * These go through the CLI rather than the helpers because both bugs lived in
 * argument handling and wiring, which unit tests of the helpers cannot see.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { appDataBase } from '../../../../../scripts/lib/userdata-dirs.mjs';

const SCRIPT = resolve(__dirname, '../../../../../scripts/clean-db.mjs');

let home: string;
let userData: string;

/**
 * Seed a fake userData tree at whatever layout THIS platform uses.
 *
 * Never hardcode the macOS path. `appDataBase()` is
 * ~/Library/Application Support on darwin but $XDG_CONFIG_HOME || ~/.config on
 * Linux, so a hardcoded macOS path seeds a directory the script never looks at:
 * every assertion then fails on the Linux CI runner while passing on the
 * author's Mac. CLAUDE.md's cross-platform rule covers tests too, and this is
 * exactly how it bites — green locally, red for everyone else.
 *
 * `appDataBase()` is called AFTER the HOME override below is in place, so it
 * resolves inside the scratch directory rather than the real home.
 */
const seedUserData = () => {
  userData = join(appDataBase(home), 'Sarv Inbox Dev');
  mkdirSync(userData, { recursive: true });
  for (const name of [
    'sarvinbox-abc123.db', // mailbox — re-syncable, always deleted
    'sarvinbox-abc123.db-wal',
    'sarvinbox-abc123.db.bak',
    'app.log',
    'app.log.1', // rotated — the file that used to survive
    'sarvinbox-core.db', // credentials — full reset only
    'db-key.bin',
    'oauth-accounts.json',
  ]) {
    writeFileSync(join(userData, name), 'x');
  }
  mkdirSync(join(userData, 'attachment-cache'), { recursive: true });
};

const run = (args: string[]) =>
  execFileSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    // process.env already carries the scratch HOME and no XDG_CONFIG_HOME
    // (see beforeEach), so the child resolves the same directory this test seeded.
    env: { ...process.env, HOME: home },
  });

const present = (name: string) => existsSync(join(userData, name));

/** Env this test overrides, restored after each case. */
let realHome: string | undefined;
let realXdg: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'clean-db-cli-'));
  realHome = process.env.HOME;
  realXdg = process.env.XDG_CONFIG_HOME;
  // The CHILD is a real process, so HOME on its env redirects it properly.
  // This test's own `appDataBase(home)` call takes the path explicitly instead —
  // see that helper for why $HOME cannot be overridden from a worker thread.
  process.env.HOME = home;
  // On Linux a real XDG_CONFIG_HOME would win over $HOME and point the script
  // at the developer's actual config directory — which this test then seeds and
  // DELETES. Clearing it keeps the whole run inside the scratch tree.
  delete process.env.XDG_CONFIG_HOME;
  seedUserData();
});

afterEach(() => {
  // Restore the real environment before the next file runs — leaking a scratch
  // HOME into an unrelated suite would point IT at a deleted directory.
  if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
  if (realXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = realXdg;
  rmSync(home, { recursive: true, force: true });
});

describe('clean-db.mjs — safe clean', () => {
  it('-y takes the SAFE default and keeps credentials (it used to wipe them)', () => {
    run(['-y']);

    // Mail and caches go…
    expect(present('sarvinbox-abc123.db')).toBe(false);
    expect(present('attachment-cache')).toBe(false);
    // …credentials stay. This is the whole point of the flag change.
    expect(present('sarvinbox-core.db')).toBe(true);
    expect(present('db-key.bin')).toBe(true);
    expect(present('oauth-accounts.json')).toBe(true);
  });

  it('--yes behaves the same as -y', () => {
    run(['--yes']);
    expect(present('db-key.bin')).toBe(true);
    expect(present('sarvinbox-abc123.db')).toBe(false);
  });

  it('a non-interactive run with no flags also keeps credentials', () => {
    // stdin is not a TTY under vitest, which is the CI/piped case.
    run([]);
    expect(present('db-key.bin')).toBe(true);
    expect(present('sarvinbox-abc123.db')).toBe(false);
  });

  it('deletes the rotated log as well as the live one', () => {
    run(['-y']);
    expect(present('app.log')).toBe(false);
    expect(present('app.log.1')).toBe(false);
  });

  it('deletes the SQLite sidecars and the .bak beside the mailbox DB', () => {
    run(['-y']);
    expect(present('sarvinbox-abc123.db-wal')).toBe(false);
    expect(present('sarvinbox-abc123.db.bak')).toBe(false);
  });
});

describe('clean-db.mjs — full reset', () => {
  it('--full deletes credentials, keys and the core DB', () => {
    run(['--full']);

    expect(present('sarvinbox-core.db')).toBe(false);
    expect(present('db-key.bin')).toBe(false);
    expect(present('oauth-accounts.json')).toBe(false);
    expect(present('sarvinbox-abc123.db')).toBe(false);
    expect(present('app.log.1')).toBe(false);
  });

  it('says plainly that onboarding has to be redone', () => {
    expect(run(['--full'])).toMatch(/redo onboarding/i);
  });
});

describe('clean-db.mjs — usage', () => {
  it('--help explains the flags and touches nothing', () => {
    const out = run(['--help']);

    expect(out).toMatch(/--full/);
    expect(out).toMatch(/-y, --yes/);
    expect(present('sarvinbox-abc123.db')).toBe(true);
    expect(present('db-key.bin')).toBe(true);
  });

  it('reports which app data directory it cleaned', () => {
    expect(run(['-y'])).toContain('Sarv Inbox Dev');
  });
});
