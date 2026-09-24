#!/usr/bin/env node
/*
 * Make electron-builder's pnpm workspace-root probe answer with a Windows path.
 *
 * Why this exists. electron-builder locates the workspace root by running
 * `pnpm --workspace-root exec pwd` and using its stdout VERBATIM
 * (app-builder-lib/out/node-module-collector/index.js, findWorkspaceRoot).
 * That is written for POSIX. It survives on Windows only because the probe is
 * expected to THROW there -- and then a fallback walks up from apps/desktop
 * looking for a package.json with a `workspaces` field.
 *
 * On the GitHub Windows runners it does not throw: Git for Windows ships a
 * coreutils `pwd.exe` in C:\Program Files\Git\usr\bin, which is on PATH. So the
 * probe SUCCEEDS and answers `/d/a/Inbox/Inbox` -- an MSYS path. There is no
 * package.json at that path, so detectPackageManager finds nothing, the
 * workspace root falls back to apps/desktop, PnpmNodeModulesCollector reports
 * no dependencies, and the installer ships with NO node_modules at all.
 *
 * That is not a crash. With no better_sqlite3.node the database never opens,
 * and every core-DB read is wrapped in a try/catch returning an empty result
 * (see CLAUDE.md) -- so the user gets an app with no accounts and no mail
 * rather than an error. Same shape as the 2026-09-09 data loss.
 *
 * The fix: drop a `pwd` shim into the WORKSPACE ROOT's node_modules/.bin, which
 * `pnpm exec` puts at the front of PATH, so it shadows Git's pwd.exe and prints
 * a real Windows path. Then prove it worked, because a probe that silently goes
 * back to answering an MSYS path would take this protection with it.
 *
 * The runnable entry point is scripts/win-pwd-shim.mjs; this half is the
 * logic, kept separate so it can be unit tested without writing to the repo.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Shadowing works by filename: cmd.exe resolves `pwd` to `pwd.cmd` here. */
export const SHIM_FILENAME = 'pwd.cmd';

/**
 * The batch file that stands in for coreutils `pwd`.
 *
 * `@echo off` is load-bearing, not tidiness: without it cmd.exe echoes each
 * line to stdout, and electron-builder takes the whole of stdout as the path.
 * Nothing is printed but the directory -- `process.stdout.write`, not
 * `console.log`, so there is no trailing newline to be mistaken for one.
 *
 * @returns {string} File contents, CRLF-terminated as a .cmd must be.
 */
export function pwdShimScript() {
  return ['@echo off', 'node -e "process.stdout.write(process.cwd())"', ''].join('\r\n');
}

/**
 * Where the shim has to live: the workspace root's own `node_modules/.bin`.
 * Anywhere else and `pnpm exec` never puts it on PATH.
 *
 * @param {string} repoRoot
 * @returns {string}
 */
export function shimPath(repoRoot) {
  return join(repoRoot, 'node_modules', '.bin', SHIM_FILENAME);
}

/**
 * @param {string} repoRoot
 * @returns {string} The path written.
 */
export function writePwdShim(repoRoot) {
  const target = shimPath(repoRoot);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, pwdShimScript());
  return target;
}

/**
 * A workspace root is only usable to electron-builder if `package.json` is
 * readable at it -- that file is what detectPackageManager reads the
 * `packageManager` field out of.
 *
 * @param {string} candidate Raw stdout of the probe.
 * @returns {boolean}
 */
export function isUsableWorkspaceRoot(candidate) {
  return candidate.length > 0 && existsSync(join(candidate, 'package.json'));
}
