#!/usr/bin/env node
/*
 * Make electron-builder's pnpm workspace-root probe answer with a Windows path,
 * and fail the build if it still does not.
 *
 * Run by .github/workflows/release.yml on the Windows runner, right after
 * `pnpm install`. See scripts/lib/win-pwd-shim.mjs for what goes wrong without
 * it: an installer with no node_modules, no better_sqlite3.node, and therefore
 * an app that opens to no accounts and no mail rather than to an error.
 *
 * Usage (a no-op off Windows):
 *   node scripts/win-pwd-shim.mjs
 */

import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isUsableWorkspaceRoot, writePwdShim } from './lib/win-pwd-shim.mjs';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));

function main() {
  if (process.platform !== 'win32') {
    console.log('OK: not Windows -- `pnpm --workspace-root exec pwd` already answers a usable path');
    return 0;
  }

  console.log(`wrote ${writePwdShim(REPO_ROOT)}`);

  // Exactly the command electron-builder runs, from the directory it runs it in.
  const probe = execFileSync('pnpm', ['--workspace-root', 'exec', 'pwd'], {
    cwd: join(REPO_ROOT, 'apps', 'desktop'),
    encoding: 'utf8',
    shell: true,
  }).trim();
  console.log(`pnpm --workspace-root exec pwd -> ${probe}`);

  if (!isUsableWorkspaceRoot(probe)) {
    console.error(`FAIL: the workspace-root probe answered "${probe}", which has no package.json.`);
    console.error('electron-builder would collapse the workspace root to apps/desktop and package');
    console.error('NO node_modules -- an installer whose database never opens. Do not build this.');
    return 1;
  }

  console.log('OK: electron-builder will resolve the workspace root to a real directory');
  return 0;
}

process.exit(main());
