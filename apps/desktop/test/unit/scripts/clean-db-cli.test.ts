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

const SCRIPT = resolve(__dirname, '../../../../../scripts/clean-db.mjs');

let home: string;
let userData: string;

/** The macOS layout; the script derives it from HOME via os.homedir(). */
const seedUserData = () => {
  userData = join(home, 'Library', 'Application Support', 'Sarv Inbox Dev');
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
    env: { ...process.env, HOME: home },
  });

const present = (name: string) => existsSync(join(userData, name));

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'clean-db-cli-'));
  seedUserData();
});

afterEach(() => {
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
