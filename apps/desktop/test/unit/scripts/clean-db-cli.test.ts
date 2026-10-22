import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseCleanupArgs, runCleanupCli } from '../../../../../scripts/clean-db.mjs';

let work: string; let baseDir: string; let output: string[];
const script = fileURLToPath(new URL('../../../../../scripts/clean-db.mjs', import.meta.url));
const profileDir = (production = false) => join(baseDir, production ? 'Sarv Inbox' : 'Sarv Inbox Dev');
const present = (name: string, production = false) => existsSync(join(profileDir(production), name));
function seed(production = false) {
  const dir = profileDir(production); mkdirSync(dir, { recursive: true });
  for (const name of ['sarvinbox-account.db', 'sarvinbox-account.db-wal', 'sarvinbox-orphan.db.bak', 'sarvinbox-core.db',
    'db-key.bin', 'oauth-accounts.json', 'secure-credentials.json.premigrated', 'ai-secrets.json', 'app.log', 'app.log.1']) writeFileSync(join(dir, name), 'fixture');
  for (const name of ['Cache', 'attachment-store', 'attachment-cache', 'Local Storage', 'extensions-data']) {
    mkdirSync(join(dir, name)); writeFileSync(join(dir, name, 'keep'), 'fixture');
  }
}
const run = (args: string[]) => runCleanupCli(args, { baseDir, readProcesses: () => [], isPidAlive: () => false, log: line => output.push(line) });
beforeEach(() => {
  work = realpathSync(mkdtempSync(join(tmpdir(), 'inbox-clean-cli-'))); baseDir = join(work, 'app-data'); mkdirSync(baseDir); output = [];
  seed(); seed(true);
});
afterEach(() => { rmSync(work, { recursive: true, force: true }); });

describe('strict cleanup CLI with explicit profile scope', () => {
  it.each([[], ['-y'], ['--yes']].map(args => ({ args })))('defaults $args to development caches/logs while preserving databases and production', ({ args }) => {
    run(args);
    expect(present('Cache')).toBe(false); expect(present('app.log.1')).toBe(false);
    for (const name of ['sarvinbox-account.db', 'sarvinbox-core.db', 'db-key.bin', 'attachment-store', 'attachment-cache', 'extensions-data', 'Local Storage']) expect(present(name), name).toBe(true);
    expect(present('Cache', true)).toBe(true); expect(present('app.log.1', true)).toBe(true);
    expect(output.join('\n')).toContain('drafts, outbox');
    expect(output.join('\n')).not.toContain('Mailbox DB + caches deleted');
  });

  it('requires explicit production selection and removes its entire profile only on --full', () => {
    run(['--profile', 'production', '--full']);
    expect(existsSync(profileDir(true))).toBe(false); expect(present('sarvinbox-core.db')).toBe(true);
    expect(output.join('\n')).toContain('absence verified'); expect(output.join('\n')).toContain('Redo onboarding');
  });

  it('--full alone removes only development, not the installed production profile', () => {
    run(['--full']); expect(existsSync(profileDir())).toBe(false); expect(present('sarvinbox-core.db', true)).toBe(true);
  });

  it('only --profile all explicitly resets both profiles', () => {
    run(['--profile', 'all', '--full']); expect(existsSync(profileDir())).toBe(false); expect(existsSync(profileDir(true))).toBe(false);
  });

  it.each([['--dry-run'], ['--profile', 'production', '--full', '--dry-run'], ['--profile', 'all', '--full', '--dry-run']].map(args => ({ args })))('dry run $args changes no profile/cache/lock or source files', ({ args }) => {
    const before = readdirSync(baseDir); const contents = readFileSync(join(profileDir(), 'sarvinbox-core.db'));
    run(args);
    expect(readdirSync(baseDir)).toEqual(before); expect(readFileSync(join(profileDir(), 'sarvinbox-core.db'))).toEqual(contents);
    expect(present('Cache')).toBe(true); expect(present('Cache', true)).toBe(true);
    expect(output.join('\n')).toContain('No files or locks were changed');
  });

  it.each([['--prod'], ['--profile'], ['--profile', 'unknown'], ['--profile', '../production'],
    ['--profile', 'production', '--profile', 'development'], ['--path', '/tmp'], ['--full', '--help', '--unknown']].map(args => ({ args })))('rejects invalid args $args before touching any profile', ({ args }) => {
    expect(() => run(args)).toThrow(); expect(present('Cache')).toBe(true); expect(present('sarvinbox-core.db', true)).toBe(true);
  });

  it('blocks all-profile cleanup before either profile changes if one main is running', () => {
    expect(() => runCleanupCli(['--profile', 'all', '--full'], { baseDir, readProcesses: () => [{ pid: 314, command: 'sarvinbox-main' }], log: () => undefined })).toThrow('Quit Sarv Inbox');
    expect(present('sarvinbox-core.db')).toBe(true); expect(present('sarvinbox-core.db', true)).toBe(true);
  });

  it('help explains preservation, exact scope, dry-run and external browser sign-ins', () => {
    run(['--help']); const text = output.join('\n');
    for (const phrase of ['--profile', '--full', '--dry-run', 'development profile', 'drafts, outbox', 'external browser']) expect(text).toContain(phrase);
    expect(present('Cache')).toBe(true);
  });

  it('real child CLI rejects unknown args and displays help without changing worker HOME or any profile', () => {
    // OS profile roots are isolated ONLY in the child. Worker environment is untouched.
    const env = { ...process.env, HOME: work, USERPROFILE: work, APPDATA: join(work, 'roaming'), XDG_CONFIG_HOME: join(work, 'config'), ELECTRON_RUN_AS_NODE: '1' };
    const help = spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8', env });
    expect(help.status, help.stderr).toBe(0); expect(help.stdout).toContain('--dry-run');
    const invalid = spawnSync(process.execPath, [script, '--profile', 'bogus'], { encoding: 'utf8', env });
    expect(invalid.status).toBe(1); expect(invalid.stderr).toContain('Invalid profile');
    expect(present('sarvinbox-core.db')).toBe(true); expect(present('sarvinbox-core.db', true)).toBe(true);
  });
});

describe('cleanup argument intent', () => {
  it('-y never escalates to full reset and the profile default is explicit in the parsed plan', () => {
    expect(parseCleanupArgs(['-y'])).toEqual({ profiles: ['development'], full: false, dryRun: false, help: false });
  });
});
