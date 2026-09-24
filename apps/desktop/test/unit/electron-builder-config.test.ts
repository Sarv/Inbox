import { createRequire } from 'module';

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
