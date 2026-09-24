import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Guards the SHIPPED electron-builder config against the schema of the
 * electron-builder actually installed.
 *
 * The regression: electron-builder validates its whole configuration up front,
 * before it touches any platform. So one stale key fails EVERY platform at once
 * -- and it fails inside the release workflow, minutes after the test suite has
 * already gone green, on four runners in parallel. That is exactly what
 * happened on the v1.2.0 tag: electron-builder 26 moved the Linux desktop-entry
 * keys under `desktop.entry`, and the flat `desktop` map from v24 took down the
 * macOS, Windows and both Linux builds with "configuration.linux.desktop should
 * be one of these: null".
 *
 * Validating here means a builder upgrade that renames or removes an option is
 * caught by `pnpm test`, where it costs seconds, instead of by a tag push.
 */

const require = createRequire(import.meta.url);

// The same two inputs electron-builder itself uses: its bundled JSON schema and
// its own ajv wrapper. Resolved from the installed copy on purpose -- pinning a
// snapshot of the schema here would defeat the point, since the whole risk is
// the installed version moving out from under the config.
const schema = require('app-builder-lib/scheme.json');
const { validateSchema } = require('app-builder-lib/out/util/config/schemaValidator.js') as {
  validateSchema: (schema: unknown, data: unknown, config?: { name?: string }) => void;
};
const packageJson = require('../../package.json') as Record<string, unknown>;
const buildConfig = packageJson['build'] as Record<string, unknown>;

describe('electron-builder configuration', () => {
  // If this fails, every platform in .github/workflows/release.yml fails.
  it('validates against the installed electron-builder schema', () => {
    expect(() => validateSchema(schema, buildConfig, { name: 'electron-builder' })).not.toThrow();
  });

  // The keys that carry the mailto: handler registration on Linux. Losing them
  // is silent: the app still packages, it just stops being offerable as the
  // system mail client, which nobody notices until a user reports it.
  it('keeps the Linux desktop entry under the v26 `entry` key', () => {
    const linux = buildConfig['linux'] as { desktop?: { entry?: Record<string, string> } };
    expect(linux.desktop?.entry).toMatchObject({
      StartupWMClass: 'Sarv Inbox',
      MimeType: 'x-scheme-handler/mailto;',
    });
  });

  // The regression: with no explicit executableName, electron-builder derives
  // one from the package name -- and `@sarvinbox/desktop` sanitizes to
  // `@sarvinboxdesktop`, which v26 rejects outright ("contains characters that
  // cannot be safely used in file paths"). That killed both Linux jobs on the
  // v1.2.0 tag while macOS and Windows, which never use it, built fine.
  it('sets an executableName that is safe in a file path', () => {
    const executableName = buildConfig['executableName'];
    expect(executableName).toBeTypeOf('string');
    expect(executableName).toMatch(/^[A-Za-z0-9][A-Za-z0-9 ._-]*$/);
  });

  // The regression: fpm -- which electron-builder shells out to for .deb and
  // .rpm -- refuses to run without a homepage and a maintainer, because both
  // are mandatory fields in those package formats. electron-builder looks for
  // the homepage in THIS package.json, not the workspace root, so the root
  // having one is no help; see FpmTarget.computeFpmMetaInfoOptions. Missing
  // either one fails the two Linux jobs only, which is how it survived a
  // release attempt where macOS and Windows both went green.
  it('carries the package metadata fpm requires for .deb and .rpm', () => {
    expect(packageJson['homepage']).toMatch(/^https?:\/\//);
    const linux = buildConfig['linux'] as { maintainer?: string };
    // fpm wants "Name <email>" -- electron-builder falls back to author.email
    // when linux.maintainer is absent, and a bare "Sarv" string has no email.
    expect(linux.maintainer).toMatch(/^.+ <[^@\s]+@[^@\s]+\.[^@\s]+>$/);
  });

  // The regression: the fpm and archive targets default their filename to
  // `${name}-${version}...`, and `${name}` expands to the RAW package name --
  // `@sarvinbox/desktop`, slash included. That wrote the .deb, .rpm and
  // .tar.gz into `release/@sarvinbox/`, where release.yml's `release/*.deb`
  // glob could never find them: the release would have shipped with the Linux
  // packages silently missing while still reporting success.
  it('names Linux artifacts without the scoped package name', () => {
    const linux = buildConfig['linux'] as { artifactName?: string };
    expect(linux.artifactName).toBeTypeOf('string');
    // ${name} is the broken macro -- it is the scope slash that breaks the glob.
    expect(linux.artifactName).not.toContain('${name}');
    expect(linux.artifactName).not.toContain('/');
  });

  // The regression: for an @scoped package, electron-builder falls back to the
  // sanitized PRODUCT name for the package identifier -- and sanitize-filename
  // keeps spaces, so rpm got `Name: Sarv Inbox` and rpmbuild refused to build
  // it. deb and rpm therefore need an explicit, policy-legal package name.
  it('gives deb and rpm a package name those formats accept', () => {
    for (const format of ['deb', 'rpm'] as const) {
      const options = buildConfig[format] as { packageName?: string } | undefined;
      // Lowercase, no spaces: what both dpkg and rpm require of a package name.
      expect(options?.packageName, format).toMatch(/^[a-z][a-z0-9+._-]*$/);
    }
  });

  // Every Windows target must list BOTH arches. That is what makes NSIS emit
  // ONE installer carrying both payloads rather than two separate downloads:
  // buildInstaller() is handed the whole arch map and only splits per arch when
  // the effective artifactName contains ${arch}, so the second assertion is
  // part of the same guarantee, not a separate nicety. Dropping arm64 here
  // silently puts Windows-on-ARM users back on x64 emulation.
  it('builds both Windows arches into a single installer', () => {
    const win = buildConfig['win'] as { target?: Array<{ target: string; arch?: string[] }>; artifactName?: string };
    for (const entry of win.target ?? []) {
      expect(entry.arch, `win target ${entry.target}`).toEqual(['x64', 'arm64']);
    }
    const effectivePattern = win.artifactName ?? (buildConfig['artifactName'] as string | undefined) ?? '';
    expect(effectivePattern).not.toContain('${arch}');
  });

  // The regression: electron-builder's computeArchToTargetNamesMap takes the
  // arch list from the CONFIG when a target names one, and ignores the --x64 /
  // --arm64 the CLI was given. Pinning both arches here therefore made EVERY
  // Linux runner try to build BOTH: the arm64 runner shelled out to an aarch64
  // gcc with `-m64` and died ("unrecognized command-line option"). Unlike
  // macOS and Windows, each Linux arch has its own runner, so the arch must
  // come from the command line.
  it('lets the command line choose the Linux arch', () => {
    const linux = buildConfig['linux'] as { target?: Array<{ target: string; arch?: string[] }> };
    for (const entry of linux.target ?? []) {
      expect(entry.arch, `linux target ${entry.target}`).toBeUndefined();
    }
  });

  // The regression: @electron/rebuild cannot find this pnpm workspace's root on
  // Windows, so it rebuilds nothing and each packaged arch keeps whatever
  // binary was already on disk. The beforeBuild hook does the per-arch rebuild
  // itself and returns false to take electron-builder's own attempt out of the
  // picture. It must also be TRACKED: .gitignore excludes apps/desktop/build/*,
  // and the afterPack hook was already lost to that rule once.
  it('keeps the per-arch native rebuild hook wired up and committed', () => {
    const hook = buildConfig['beforeBuild'];
    expect(hook).toBeTypeOf('string');
    // The hook path is relative to apps/desktop, where electron-builder runs.
    const resolved = fileURLToPath(new URL(`../../${hook as string}`, import.meta.url));
    expect(existsSync(resolved), `${hook as string} must exist on disk`).toBe(true);
  });

  // The regression: electron-builder finds the workspace root by shelling out
  // to `pnpm --workspace-root exec pwd` -- and there is no `pwd` on Windows, so
  // that throws and it falls back to walking UP from apps/desktop looking for a
  // package.json with a `workspaces` field. This repo declares its workspace in
  // pnpm-workspace.yaml, which that walk cannot see, so on Windows the root
  // collapsed to apps/desktop: the pnpm module collector then found no
  // dependencies and the installer shipped with NO node_modules at all -- no
  // better_sqlite3.node, so an app whose database never opens and which
  // therefore looks like an empty mailbox rather than an error.
  //
  // The `workspaces` field in the root package.json exists purely to make that
  // fallback land in the right place; pnpm itself ignores it. This test walks
  // the same path electron-builder does.
  it('lets electron-builder find the workspace root by walking up from apps/desktop', () => {
    const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));

    let current = fileURLToPath(new URL('../../', import.meta.url));
    let found: string | undefined;
    for (;;) {
      const candidate = join(current, 'package.json');
      if (existsSync(candidate)) {
        const manifest = JSON.parse(readFileSync(candidate, 'utf8')) as { workspaces?: unknown };
        if (manifest.workspaces) {
          found = current;
          break;
        }
      }
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }

    expect(found, 'no package.json with a `workspaces` field above apps/desktop').toBeDefined();
    // The root that owns pnpm-workspace.yaml is the only correct answer.
    expect(resolve(found as string)).toBe(resolve(repoRoot));
    expect(existsSync(join(found as string, 'pnpm-workspace.yaml'))).toBe(true);
  });

  // Every release artifact the publish job globs must have a target that
  // actually produces it. A target quietly dropped here means a platform
  // silently vanishes from the release page.
  it('still targets every platform the release workflow publishes', () => {
    const targetsOf = (platform: string): string[] => {
      const config = buildConfig[platform] as { target?: Array<{ target: string }> };
      return (config.target ?? []).map((entry) => entry.target);
    };
    expect(targetsOf('mac')).toEqual(expect.arrayContaining(['dmg', 'zip']));
    expect(targetsOf('win')).toEqual(expect.arrayContaining(['nsis']));
    expect(targetsOf('linux')).toEqual(expect.arrayContaining(['AppImage', 'deb', 'rpm']));
  });
});
