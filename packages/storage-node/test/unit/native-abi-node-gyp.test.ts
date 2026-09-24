/*
 * Guards how scripts/lib/native-abi.mjs invokes node-gyp, and how it carries
 * the TARGET architecture rather than the host's.
 *
 * The regression, exactly as it happened on the v1.2.0 Windows release job: the
 * rebuild spawned `node_modules/.bin/node-gyp` directly. On Windows pnpm writes
 * an extensionless POSIX sh script under that name (next to .cmd and .ps1),
 * existsSync finds it, and Windows cannot start it — so both rebuild attempts
 * "failed" 1.6ms apart, where a real compile takes about a minute. Each attempt
 * clears build/ first, so the runner was left with NO better_sqlite3.node at
 * all and the installer shipped without a database addon.
 *
 * That does not crash anything. Every core-DB read is wrapped in a try/catch
 * returning an empty result (see CLAUDE.md), so a Windows user would have found
 * an app with no accounts and no mail — the same shape as the 2026-09-09 data
 * loss. Nothing in the build reported a problem.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { manualRebuildCommand, nodeGypCommand } from '../../../../scripts/lib/native-abi.mjs';

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'node-gyp-cmd-'));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

/** A node_modules tree holding nothing but node-gyp's JS entry point. */
const fakeNodeModules = (): string => {
  const binDir = join(workDir, 'node_modules', 'node-gyp', 'bin');
  mkdirSync(binDir, { recursive: true });
  const entry = join(binDir, 'node-gyp.js');
  writeFileSync(entry, '');
  return join(workDir, 'node_modules');
};

describe('nodeGypCommand', () => {
  // Breaks: the rebuild goes back to spawning a .bin shim and silently produces
  // nothing on Windows. Running the .js entry under THIS node binary is the
  // whole fix — no shell, no shim, same behaviour on all three platforms.
  it('runs node-gyp through the current node binary, never a .bin shim', () => {
    const command = nodeGypCommand({ nodeModules: fakeNodeModules() });
    expect(command?.command).toBe(process.execPath);
    expect(command?.args).toHaveLength(1);
    expect(command?.args[0]).toMatch(/node-gyp\.js$/);
    expect(command?.args[0]).not.toContain(`${join('node_modules', '.bin')}`);
  });

  // Breaks: a pnpm layout that does not hoist node-gyp to the root loses the
  // rebuild entirely, even though an ordinary import would have found it.
  it('falls back to module resolution when node-gyp is not hoisted', () => {
    const resolved = join(workDir, 'elsewhere', 'node-gyp.js');
    const command = nodeGypCommand({ nodeModules: join(workDir, 'empty'), resolve: () => resolved });
    expect(command).toEqual({ command: process.execPath, args: [resolved] });
  });

  // Breaks: with node-gyp genuinely absent the caller must be able to print an
  // actionable message instead of throwing an opaque spawn error.
  it('reports node-gyp missing rather than throwing', () => {
    const command = nodeGypCommand({
      nodeModules: join(workDir, 'empty'),
      resolve: () => {
        throw new Error('Cannot find module');
      },
    });
    expect(command).toBeNull();
  });
});

describe('manualRebuildCommand', () => {
  // Breaks: the printed fallback rebuilds for the HOST cpu, so pasting it after
  // a failed arm64 cross-compile quietly produces an x64 binary and "fixes"
  // nothing. The arch is the one part of a cross-compile you cannot infer.
  it('names the architecture that was being built, not the host', () => {
    const command = manualRebuildCommand({ runtime: 'electron', target: '43.2.0', arch: 'arm64' });
    expect(command).toContain('--arch=arm64');
    expect(command).toContain('--runtime=electron');
    expect(command).toContain('--target=43.2.0');
  });

  // Breaks: a Node-ABI rebuild is printed with Electron flags (or the reverse),
  // and following the instruction leaves the addon on the ABI it already had.
  it('omits the Electron flags for a plain Node rebuild', () => {
    const command = manualRebuildCommand({ runtime: 'node', target: null, arch: 'x64' });
    expect(command).not.toContain('--runtime=electron');
    expect(command).toContain('--arch=x64');
  });
});
