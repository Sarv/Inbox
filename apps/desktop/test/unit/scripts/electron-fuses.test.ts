import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FuseV1Options } from '@electron/fuses';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  BUILDER_KEYS,
  EXPECTED_FUSES,
  FUSE_SENTINEL,
  fuseFilePath,
  fuseProblems,
  readFuseWires,
} from '../../../../../scripts/lib/electron-fuses.mjs';

/**
 * Guards the Electron fuses (CASA M-2). Left at Electron's defaults, any local
 * process can run code AS the signed app — ELECTRON_RUN_AS_NODE, NODE_OPTIONS,
 * --inspect — and read the Keychain/DPAPI secrets it trusts (the mail DB key,
 * sign-in tokens, passwords) without a prompt; a tampered app.asar goes
 * unnoticed. What breaks if this fails: the config stops asking electron-builder
 * to flip a fuse, or the release check that reads them back passes a binary
 * that wasn't flipped — and the protection is silently gone.
 */

const require = createRequire(import.meta.url);
const packageJson = require('../../../package.json') as { build: { electronFuses?: Record<string, boolean> } };
const verifyScript = fileURLToPath(new URL('../../../../../scripts/verify-fuses.mjs', import.meta.url));

const ids = Object.fromEntries(Object.entries(FuseV1Options).filter(([name]) => Number.isNaN(Number(name)))) as Record<string, number>;

/** Electron's own default for each V1 fuse (what an unconfigured build ships). */
const ELECTRON_DEFAULTS: Record<string, boolean> = {
  RunAsNode: true,
  EnableCookieEncryption: false,
  EnableNodeOptionsEnvironmentVariable: true,
  EnableNodeCliInspectArguments: true,
  EnableEmbeddedAsarIntegrityValidation: false,
  OnlyLoadAppFromAsar: false,
  LoadBrowserProcessSpecificV8Snapshot: false,
  GrantFileProtocolExtraPrivileges: true,
};

/** A fake binary: junk, then a V1 fuse wire per entry of `wires`. */
const fakeBinary = (...wires: Array<Record<string, boolean>>): Buffer => {
  const parts: Buffer[] = [Buffer.from('\u0000junk-before\u0000')];
  for (const wire of wires) {
    const length = Math.max(...Object.values(ids)) + 1;
    const states = Array.from({ length }, (_, id) => {
      const name = Object.keys(ids).find((key) => ids[key] === id)!;
      return (wire[name] ?? ELECTRON_DEFAULTS[name]) ? 0x31 : 0x30;
    });
    parts.push(Buffer.from(FUSE_SENTINEL, 'ascii'), Buffer.from([1, length, ...states]), Buffer.from('\u0000between\u0000'));
  }
  return Buffer.concat(parts);
};
const stateArray = (wire: Record<string, boolean>) => readFuseWires(fakeBinary(wire))[0].states;

describe('the fuses the build asks for', () => {
  // Breaks: a fuse is dropped from (or wrongly set in) package.json, so
  // electron-builder ships Electron's default for it.
  it('package.json electronFuses yields exactly the expected state for every fuse', () => {
    const config = packageJson.build.electronFuses ?? {};
    for (const [name, expected] of Object.entries(EXPECTED_FUSES)) {
      const key = BUILDER_KEYS[name as keyof typeof BUILDER_KEYS];
      const effective = key in config ? config[key] : ELECTRON_DEFAULTS[name];
      expect([name, effective]).toEqual([name, expected]);
    }
    // No stray keys the list doesn't know about (beyond the signing option below).
    expect(Object.keys(config).filter((key) => key !== 'resetAdHocDarwinSignature')
      .every((key) => Object.values(BUILDER_KEYS).includes(key as never))).toBe(true);
  });

  // Flipping a fuse rewrites bytes inside Electron Framework, which breaks its
  // ad-hoc signature. A release built without a Developer ID (documented in
  // release.yml and docs/RELEASING.md: warn, ship unsigned) is never re-signed
  // after the flip, and Apple Silicon kills an app with a broken signature at
  // launch. Breaks: that unsigned arm64 app no longer starts, the release's
  // smoke launch fails, and publishing is blocked. Harmless when signed:
  // electron-builder re-signs with --force straight after.
  it('re-signs ad hoc after flipping, so an unsigned macOS build still launches', () => {
    expect((packageJson.build.electronFuses ?? {}).resetAdHocDarwinSignature).toBe(true);
  });

  it('turns off every way to run code as the app, and turns on asar integrity', () => {
    expect(EXPECTED_FUSES).toMatchObject({
      RunAsNode: false,
      EnableNodeOptionsEnvironmentVariable: false,
      EnableNodeCliInspectArguments: false,
      EnableEmbeddedAsarIntegrityValidation: true,
      OnlyLoadAppFromAsar: true,
    });
  });

  // Breaks: the list falls behind the installed library (a new fuse goes unchecked).
  it('covers every fuse the installed @electron/fuses knows, and its sentinel', () => {
    expect(Object.keys(EXPECTED_FUSES).sort()).toEqual(Object.keys(ids).sort());
    expect(Object.keys(BUILDER_KEYS).sort()).toEqual(Object.keys(ids).sort());
    expect(FUSE_SENTINEL).toBe(require('@electron/fuses/dist/constants.js').SENTINEL);
  });
});

describe('fuseProblems', () => {
  it('is empty for a correctly flipped wire', () => {
    expect(fuseProblems(stateArray(EXPECTED_FUSES), ids)).toEqual([]);
  });

  // THE regression: an unflipped (default) Electron.
  it('names every fuse left at a wrong default', () => {
    expect(fuseProblems(stateArray({}), ids)).toEqual([
      'RunAsNode: is ON, must be OFF',
      'EnableCookieEncryption: is OFF, must be ON',
      'EnableNodeOptionsEnvironmentVariable: is ON, must be OFF',
      'EnableNodeCliInspectArguments: is ON, must be OFF',
      'EnableEmbeddedAsarIntegrityValidation: is OFF, must be ON',
      'OnlyLoadAppFromAsar: is OFF, must be ON',
    ]);
  });

  // Breaks: a removed, truncated or garbled wire reads as "fine".
  it('reports removed, missing, unreadable and unknown fuses', () => {
    const states = stateArray(EXPECTED_FUSES);
    states[ids.RunAsNode] = 0x72; // 'r'
    states[ids.OnlyLoadAppFromAsar] = 0x00;
    expect(fuseProblems(states.slice(0, ids.GrantFileProtocolExtraPrivileges), ids)).toEqual([
      'RunAsNode: removed from this binary',
      'OnlyLoadAppFromAsar: unreadable state 0',
      'GrantFileProtocolExtraPrivileges: not present in this binary',
    ]);
    const { RunAsNode: _removed, ...withoutRunAsNode } = ids;
    expect(fuseProblems(stateArray(EXPECTED_FUSES), withoutRunAsNode)).toEqual(['RunAsNode: unknown to the installed @electron/fuses']);
  });
});

describe('readFuseWires', () => {
  // A universal macOS binary has one wire per CPU slice; @electron/fuses'
  // getCurrentFuseWire reads only the first. Breaks: an unflipped slice passes.
  it('reads every wire in a file', () => {
    const wires = readFuseWires(fakeBinary(EXPECTED_FUSES, {}));
    expect(wires).toHaveLength(2);
    expect(fuseProblems(wires[0].states, ids)).toEqual([]);
    expect(fuseProblems(wires[1].states, ids)).not.toEqual([]);
    expect(wires.every((wire) => wire.version === 1)).toBe(true);
  });

  it('finds none in a file that is not an Electron binary', () => {
    expect(readFuseWires(Buffer.from('just some bytes'))).toEqual([]);
  });
});

describe('fuseFilePath', () => {
  // On macOS the wire is in the Electron Framework, not the MacOS/ launcher.
  it('resolves a .app (or a path inside one) to its Electron Framework, and leaves executables alone', () => {
    const framework = 'r/Sarv Inbox.app/Contents/Frameworks/Electron Framework.framework/Electron Framework';
    expect(fuseFilePath('r/Sarv Inbox.app')).toBe(framework);
    expect(fuseFilePath('r/Sarv Inbox.app/Contents/MacOS/Sarv Inbox')).toBe(framework);
    expect(fuseFilePath('r/win-unpacked/Sarv Inbox.exe')).toBe('r/win-unpacked/Sarv Inbox.exe');
    expect(fuseFilePath('r/linux-unpacked/sarv-inbox')).toBe('r/linux-unpacked/sarv-inbox');
  });
});

describe('scripts/verify-fuses.mjs (as the release workflow runs it)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'sarvinbox-fuses-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
  const run = (...targets: string[]) => spawnSync(process.execPath, [verifyScript, ...targets], { encoding: 'utf8' });

  it('passes correctly flipped binaries, both universal slices included', () => {
    const exe = join(dir, 'sarv-inbox');
    writeFileSync(exe, fakeBinary(EXPECTED_FUSES));
    const framework = join(dir, 'Sarv Inbox.app/Contents/Frameworks/Electron Framework.framework');
    mkdirSync(framework, { recursive: true });
    writeFileSync(join(framework, 'Electron Framework'), fakeBinary(EXPECTED_FUSES, EXPECTED_FUSES));
    const result = run(exe, join(dir, 'Sarv Inbox.app'));
    expect(result.stdout).toContain('slice 2 of 2');
    expect(result.status).toBe(0);
  });

  // Breaks: the release ships an app whose fuses were never flipped.
  it('fails on an unflipped binary, or one unflipped universal slice', () => {
    const exe = join(dir, 'sarv-inbox');
    writeFileSync(exe, fakeBinary({}));
    expect(run(exe)).toMatchObject({ status: 1, stderr: expect.stringContaining('RunAsNode: is ON, must be OFF') });
    writeFileSync(exe, fakeBinary(EXPECTED_FUSES, {}));
    expect(run(exe)).toMatchObject({ status: 1, stderr: expect.stringContaining('slice 2 of 2') });
  });

  // Verifying nothing must never pass.
  it('fails with no targets, a missing file, a non-Electron file, or an unknown wire version', () => {
    expect(run().status).toBe(2);
    expect(run(join(dir, 'nope')).status).toBe(1);
    const junk = join(dir, 'junk');
    writeFileSync(junk, 'not electron');
    expect(run(junk)).toMatchObject({ status: 1, stderr: expect.stringContaining('no fuse wire found') });
    const v2 = fakeBinary(EXPECTED_FUSES);
    v2[v2.indexOf(FUSE_SENTINEL) + FUSE_SENTINEL.length] = 2;
    writeFileSync(junk, v2);
    expect(run(junk)).toMatchObject({ status: 1, stderr: expect.stringContaining('fuse wire version 2') });
  });
});
