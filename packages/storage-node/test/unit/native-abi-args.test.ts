/*
 * Guards scripts/lib/native-abi-args.mjs — how scripts/native-abi.mjs reads its
 * command line — and that the script acts on that reading before it goes near
 * the addon.
 *
 * The regression, exactly as it happened on 2026-09-24: the script knew one
 * flag, skipped every other one and defaulted the runtime to `node`, so
 * `node scripts/native-abi.mjs --help | head -3` REBUILT better-sqlite3 for
 * Node, and the closed pipe then killed node-gyp after it had deleted build/,
 * leaving no addon at all. Neither a Node-ABI addon nor a missing one crashes
 * the desktop app: every core-DB read swallows the failure, so it boots with no
 * accounts, the reading that made the 2026-09-09 startup sweep delete two live
 * mailbox DBs.
 */

import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseNativeAbiArgs, USAGE } from '../../../../scripts/lib/native-abi-args.mjs';

const SCRIPTS = join(import.meta.dirname, '..', '..', '..', '..', 'scripts');

describe('parseNativeAbiArgs', () => {
  // Breaks: the flip every package script starts with — `node` before the
  // tests, `electron` before the app — and so every SQLite test or app start.
  it.each(['node', 'electron'] as const)('reads %s as the runtime', (runtime) => {
    expect(parseNativeAbiArgs([runtime])).toEqual({ kind: 'run', runtime, force: false });
  });

  // Breaks: --force counting in only one position, so `--force electron`
  // quietly skips the rebuild it asked for.
  it.each([
    [['electron', '--force']],
    [['--force', 'electron']],
    [['--force', 'electron', '--force']],
  ])('reads --force wherever it appears in %j', (argv) => {
    expect(parseNativeAbiArgs(argv)).toEqual({ kind: 'run', runtime: 'electron', force: true });
  });

  // Breaks: `Electron` refused, though the old parser accepted it and it names
  // exactly one runtime — reading it is not a guess.
  it('accepts the runtime in any case', () => {
    expect(parseNativeAbiArgs(['Electron'])).toEqual({ kind: 'run', runtime: 'electron', force: false });
  });

  // THE REGRESSION: --help was skipped as an unknown flag and the runtime
  // defaulted to node, so asking what the script does rebuilt the addon.
  it.each([[['--help']], [['-h']]])('answers %j with help', (argv) => {
    expect(parseNativeAbiArgs(argv)).toEqual({ kind: 'help' });
  });

  // Breaks: help asked for next to a real command — how people check what a
  // command does before they run it — running that command instead.
  it.each([
    [['electron', '--help']],
    [['node', '--force', '-h']],
    [['--bogus', '--help']],
    [['deno', '-h']],
  ])('lets help win over the rest of %j', (argv) => {
    expect(parseNativeAbiArgs(argv)).toEqual({ kind: 'help' });
  });

  // Breaks: a bare invocation defaulting to node, the one ABI the desktop app
  // cannot load, and so the dangerous direction to guess in.
  it('refuses to pick a runtime when none is named', () => {
    expect(parseNativeAbiArgs([])).toEqual({
      kind: 'error',
      message: expect.stringContaining('missing runtime'),
    });
  });

  // Breaks: a flag the script does not know skipped while it rebuilds anyway —
  // `--dry-run` compiling for real, a typo'd `--frce` silently dropping the
  // force it meant.
  it.each([
    ['a flag it has never had', ['node', '--dry-run'], '--dry-run'],
    ['a typo of --force', ['electron', '--frce'], '--frce'],
    ['--force given a value', ['node', '--force=false'], '--force=false'],
    ['a short flag it does not define', ['node', '-f'], '-f'],
    ['help in the wrong case', ['--HELP'], '--HELP'],
    ['an end-of-options marker', ['--', 'node'], '--'],
    ['a lone dash', ['node', '-'], '-'],
    ['a flag with no runtime at all', ['--bogus'], '--bogus'],
  ])('refuses %s', (_case, argv, flag) => {
    expect(parseNativeAbiArgs(argv)).toEqual({ kind: 'error', message: `unknown option "${flag}"` });
  });

  // Breaks: a typo'd runtime building for whatever the parser falls back to.
  it.each([
    ['another runtime', 'deno'],
    ['an empty argument', ''],
    ['a padded name', ' node'],
  ])('refuses %s as the runtime', (_case, runtime) => {
    expect(parseNativeAbiArgs([runtime])).toEqual({
      kind: 'error',
      message: expect.stringContaining(`unknown runtime "${runtime}"`),
    });
  });

  // Breaks: `node electron` building for whichever comes first — a guess at
  // which of two contradictory requests was meant.
  it('refuses two runtimes rather than picking one', () => {
    expect(parseNativeAbiArgs(['node', 'electron'])).toEqual({
      kind: 'error',
      message: 'expected one runtime, got 2: "node", "electron"',
    });
  });
});

describe('USAGE', () => {
  // Breaks: the text every refused command prints stops naming what would have
  // worked, and whoever typed it is left to guess again.
  it('names both runtimes and every flag the parser accepts', () => {
    for (const part of ['<node|electron>', '--force', '-h, --help']) {
      expect(USAGE).toContain(part);
    }
  });
});

describe('scripts/native-abi.mjs', () => {
  // The script and its lib, copied to a directory with no node_modules. It
  // finds better-sqlite3 relative to itself, so a regression that did reach the
  // rebuild would find nothing there to rebuild. A test of the refusal must not
  // be able to fire at the real addon — least of all when this file is run
  // straight from vitest while the dev app holds the Electron ABI.
  let sandbox: string;

  beforeAll(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'native-abi-cli-'));
    mkdirSync(join(sandbox, 'scripts'));
    cpSync(join(SCRIPTS, 'native-abi.mjs'), join(sandbox, 'scripts', 'native-abi.mjs'));
    cpSync(join(SCRIPTS, 'lib'), join(sandbox, 'scripts', 'lib'), { recursive: true });
  });

  afterAll(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  const runScript = (...args: string[]) =>
    spawnSync(process.execPath, [join(sandbox, 'scripts', 'native-abi.mjs'), ...args], {
      encoding: 'utf8',
    });

  // THE REGRESSION: `--help` rebuilt the addon for Node. It must print the
  // usage and nothing else, not even the probe line every real run opens with.
  it.each(['--help', '-h'])('prints the usage for %s and exits 0', (flag) => {
    const run = runScript(flag);

    expect(run.status).toBe(0);
    expect(run.stdout).toBe(`${USAGE}\n`);
    expect(run.stderr).not.toContain('[native-abi]');
  });

  // Breaks: an unknown flag skipped and the run carried on. stdout stays empty
  // because the "current better-sqlite3: …" probe is never reached.
  it('refuses an unknown flag with the usage and exit 1, before probing', () => {
    const run = runScript('node', '--dry-run');

    expect(run.status).toBe(1);
    expect(run.stderr).toContain('[native-abi] unknown option "--dry-run"');
    expect(run.stderr).toContain(USAGE);
    expect(run.stdout).toBe('');
  });

  // Breaks: a bare invocation defaulting to node and rebuilding.
  it('refuses to run with no runtime named, before probing', () => {
    const run = runScript();

    expect(run.status).toBe(1);
    expect(run.stderr).toContain('[native-abi] missing runtime');
    expect(run.stderr).toContain(USAGE);
    expect(run.stdout).toBe('');
  });

  // Breaks: the sandbox itself. If the copy could not start, the refusals above
  // would pass on a crash; if it could see the real node_modules, they would be
  // one regression away from rebuilding the real addon. A valid command must
  // run, reach the probe, and find no addon and no Electron to build against.
  it('runs a valid command in the sandbox against no addon at all', () => {
    const run = runScript('electron');

    expect(run.status).toBe(0);
    expect(run.stdout).toContain('[native-abi] current better-sqlite3: not loadable');
    expect(run.stderr).toContain('[native-abi] electron is not installed');
  });
});
