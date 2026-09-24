import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  SHIM_FILENAME,
  isUsableWorkspaceRoot,
  pwdShimScript,
  shimPath,
  writePwdShim,
} from '../../../../../scripts/lib/win-pwd-shim.mjs';

/**
 * Guards the shim that keeps the Windows installer from shipping with no
 * node_modules.
 *
 * electron-builder locates the pnpm workspace root by running
 * `pnpm --workspace-root exec pwd` and using its stdout verbatim. On the GitHub
 * Windows runners Git's coreutils pwd.exe is on PATH, so that probe answers an
 * MSYS path (/d/a/Inbox/Inbox); no package.json exists there, the workspace
 * root collapses to apps/desktop, and the pnpm module collector reports no
 * dependencies at all. The installer is still produced and CI still goes green
 * -- it just has no better_sqlite3.node, so the database never opens, and every
 * core-DB read returns an empty result rather than an error. The user sees an
 * app with no accounts and no mail. That shipped twice on the v1.2.0 tag.
 *
 * The shim shadows `pwd` from the workspace root's node_modules/.bin, which
 * `pnpm exec` puts first on PATH. These tests pin the two properties that make
 * it work at all -- the exact bytes of the batch file, and where it is written.
 */

describe('pwdShimScript', () => {
  // The regression: a .cmd echoes every line it runs unless echo is turned off
  // on the FIRST line. electron-builder reads the whole of stdout as the path,
  // so a single echoed command line makes the probe answer garbage -- which
  // fails exactly the same silent way the MSYS path does.
  it('silences cmd echo before printing anything', () => {
    expect(pwdShimScript().split('\r\n')[0]).toBe('@echo off');
  });

  // CRLF, because a .cmd with bare LF line endings is not reliably parsed by
  // cmd.exe.
  it('uses CRLF line endings', () => {
    expect(pwdShimScript()).not.toMatch(/[^\r]\n/);
  });

  // The regression: `console.log` appends a newline. electron-builder does
  // .trim() today, but the contract we depend on is "stdout IS the path" -- so
  // the shim prints the directory and nothing else.
  it('prints the working directory and nothing else', () => {
    const workDir = mkdtempSync(join(tmpdir(), 'pwd-shim-payload-'));
    try {
      // The payload line, run the way cmd.exe would run it.
      const payload = pwdShimScript().split('\r\n')[1];
      const expression = payload.replace(/^node -e "(.*)"$/, '$1');
      expect(expression, 'the shim must invoke node -e').not.toBe(payload);

      const printed = execFileSync(process.execPath, ['-e', expression], {
        cwd: workDir,
        encoding: 'utf8',
      });
      // realpath: macOS hands out /var/... for /private/var/...
      expect(printed).toBe(execFileSync(process.execPath, ['-p', 'process.cwd()'], {
        cwd: workDir,
        encoding: 'utf8',
      }).trim());
      expect(printed).not.toContain('\n');
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});

describe('shimPath', () => {
  // The regression: `pnpm exec` only prepends the WORKSPACE ROOT's
  // node_modules/.bin. A shim written next to the script, or into
  // apps/desktop's own .bin, is never on PATH and Git's pwd.exe wins again --
  // silently, because the build still succeeds.
  it('writes into the workspace root .bin that pnpm exec puts on PATH', () => {
    expect(shimPath(join('any', 'root'))).toBe(join('any', 'root', 'node_modules', '.bin', SHIM_FILENAME));
  });

  // Windows resolves `pwd` to `pwd.cmd` via PATHEXT. Any other extension is
  // not found and the shadowing does not happen.
  it('is named so that Windows resolves a bare `pwd` to it', () => {
    expect(SHIM_FILENAME).toBe('pwd.cmd');
  });
});

describe('writePwdShim', () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'pwd-shim-'));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  // node_modules/.bin does not necessarily exist yet in CI ordering terms;
  // failing to create it would abort the release job instead of fixing it.
  it('creates the .bin directory if it is missing', () => {
    const written = writePwdShim(workDir);
    expect(written).toBe(shimPath(workDir));
    expect(readFileSync(written, 'utf8')).toBe(pwdShimScript());
  });

  // Reruns happen: a re-run of the release job writes over an existing shim.
  it('is idempotent', () => {
    writePwdShim(workDir);
    const written = writePwdShim(workDir);
    expect(readFileSync(written, 'utf8')).toBe(pwdShimScript());
  });
});

describe('isUsableWorkspaceRoot', () => {
  // This is the assertion that turns the silent failure loud. It must reject
  // exactly the value the Windows runners produced on the v1.2.0 tag.
  it('rejects the MSYS path Git pwd.exe answers on Windows', () => {
    expect(isUsableWorkspaceRoot('/d/a/Inbox/Inbox')).toBe(false);
  });

  it('rejects an empty probe result', () => {
    expect(isUsableWorkspaceRoot('')).toBe(false);
  });

  // The repo root is the only answer that lets electron-builder read the
  // `packageManager` field and collect the workspace's dependencies.
  it('accepts a directory that has a package.json', () => {
    const repoRoot = join(__dirname, '..', '..', '..', '..', '..');
    expect(existsSync(join(repoRoot, `package.json`))).toBe(true);
    expect(isUsableWorkspaceRoot(repoRoot + sep)).toBe(true);
  });
});
