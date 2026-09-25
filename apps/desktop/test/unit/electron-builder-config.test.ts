import { existsSync, readFileSync, readdirSync } from 'node:fs';
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
// Resolved from apps/desktop, which is where electron-builder runs the hook.
const hookPath = fileURLToPath(new URL('../../build/beforeBuild.js', import.meta.url));

describe('electron-builder configuration', () => {
  const targetsOf = (platform: string): string[] => {
    const config = buildConfig[platform] as { target?: Array<{ target: string }> };
    return (config.target ?? []).map((entry) => entry.target);
  };

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
  // v1.2.0 tag.
  //
  // It must stay scoped to linux. A second regression came from fixing the first
  // at the TOP level: appInfo.js derives productFilename from executableName when
  // one is set, and macPackager names the bundle `${productFilename}.app`, so the
  // shipped app installed as "sarv-inbox.app" and Launchpad, the Dock and Finder
  // all called it "sarv-inbox". It also made the Windows exe "sarv-inbox.exe",
  // which quietly broke the product-name half of the prod identity check in
  // single-child.ts. Only Linux -- where the binary lands in /usr/bin and the
  // .desktop Exec line points at it -- needs a filesystem-safe name.
  it('sets a file-path-safe executableName, and only for Linux', () => {
    expect(buildConfig['executableName']).toBeUndefined();

    const executableName = (buildConfig['linux'] as { executableName?: unknown }).executableName;
    expect(executableName).toBeTypeOf('string');
    expect(executableName).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);

    // What macOS and Windows fall back to instead, and what the bundle is named.
    expect(buildConfig['productName']).toBe('Sarv Inbox');
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

  // Both macOS targets must say "universal", not "arm64"/"x64". That single
  // word is what turns two dmgs and two zips into one of each: electron-builder
  // packs both arches and merges them with lipo into one fat binary that macOS
  // picks a slice from at launch. Listing the arches separately instead builds
  // fine and produces four downloads, putting a "which Mac do I have?" question
  // back in front of every user.
  //
  // The filename spells both arches out because "universal" means nothing to
  // someone deciding whether a download will run on their Mac. That makes the
  // name a CLAIM, and the two assertions here have to stay together: a name
  // promising arm64 and amd64 on top of a build that quietly went back to a
  // single arch would send half of all Mac users to a file that cannot run.
  it('merges both macOS arches into one universal download and says so in the filename', () => {
    const mac = buildConfig['mac'] as { target?: Array<{ target: string; arch?: string[] }>; artifactName?: string };
    for (const entry of mac.target ?? []) {
      expect(entry.arch, `mac target ${entry.target}`).toEqual(['universal']);
    }
    expect(mac.artifactName).toContain('arm64');
    expect(mac.artifactName).toContain('amd64');
  });

  // The regression: @electron/universal refuses to merge two packs whose files
  // disagree, and node-gyp's intermediates (obj/, obj.target/, .deps/) are
  // arch-specific build droppings. Worse, build/afterPack.js deletes them from
  // app.asar.unpacked AFTER the asar header has already listed them, so the
  // merge walked the header and died on a file that was no longer on disk:
  //   ENOENT ... app.asar.unpacked/.../build/Release/obj/gen/sqlite3/sqlite3.c
  // Excluding them at the files level means they never enter the package, so
  // there is nothing inconsistent left to reconcile. A normal single-arch build
  // never notices any of this, so nothing but this test guards it.
  it('keeps the node-gyp intermediates out of the package entirely', () => {
    const files = buildConfig['files'] as string[];
    for (const intermediate of ['obj', 'obj.target', '.deps']) {
      expect(files, `node-gyp ${intermediate}`).toContain(`!**/build/Release/${intermediate}/**`);
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
  // itself. It must also be TRACKED: .gitignore excludes apps/desktop/build/*,
  // and the afterPack hook was already lost to that rule once.
  it('keeps the per-arch native rebuild hook wired up and committed', () => {
    const hook = buildConfig['beforeBuild'];
    expect(hook).toBeTypeOf('string');
    // The hook path is relative to apps/desktop, where electron-builder runs.
    expect(hook).toBe('./build/beforeBuild.js');
    expect(existsSync(hookPath), `${hook as string} must exist on disk`).toBe(true);
  });

  // The regression that shipped four EMPTY artifacts on the v1.2.0 tag. In
  // electron-builder 26 a falsy beforeBuild result does far more than skip the
  // rebuild: Packager.installAppDependencies reads it as "node_modules are
  // handled externally" and PlatformPackager then skips computeNodeModuleFileSets
  // altogether, so the app is packed with NO node_modules on ANY platform. Every
  // job stays green -- the installers are produced and uploaded -- and the
  // app.asar holds only dist/, dist-electron/ and package.json. With no
  // better_sqlite3.node the database never opens, and because every core-DB read
  // is wrapped in a try/catch returning an empty result (see CLAUDE.md) the user
  // sees an app with no accounts and no mail rather than an error.
  it('returns true from beforeBuild so node_modules are still packaged', () => {
    const hook = readFileSync(hookPath, 'utf8');
    // `return false` IS the bug. It must never come back to this hook.
    expect(hook).not.toMatch(/^\s*return false\b/m);
    expect(hook).toMatch(/^\s*return true\b/m);
  });

  // The tripwire for the test above. `return true` is only required because of
  // the coupling below; if an electron-builder upgrade renames or removes it,
  // the reasoning has to be re-derived from the new source rather than assumed
  // to still hold. Failing here means "go re-read installAppDependencies", not
  // "the hook is wrong".
  it('still couples the beforeBuild result to whether node_modules are packed', () => {
    const packager = readFileSync(require.resolve('app-builder-lib/out/packager.js'), 'utf8');
    const platformPackager = readFileSync(require.resolve('app-builder-lib/out/platformPackager.js'), 'utf8');
    expect(packager).toContain('_nodeModulesHandledExternally');
    expect(platformPackager).toContain('areNodeModulesHandledExternally');
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

  // The regression this exists for, verbatim from a packaged 1.2.x build:
  //
  //   [extension-runtime] Starting extension sandbox:
  //     .../app.asar.unpacked/dist-electron/extension-sandbox.worker.js
  //   Error [ERR_MODULE_NOT_FOUND]: Cannot find module ...
  //   [extension-runtime] Extension sandbox exited with code 1
  //
  // and every extension in Settings reading "Extension sandbox is not running".
  //
  // Anything spawned BY PATH -- `new Worker()`, `utilityProcess.fork()` -- needs
  // a real file: Electron's asar-patched `fs` covers reads, not spawns. So each
  // such entry calls `resolveUnpacked()` to address `app.asar.unpacked/`, and
  // that directory only holds what `asarUnpack` put there. The two halves are
  // written in different files (a .ts service and this package.json) with
  // nothing connecting them, and the mismatch is invisible everywhere except a
  // packaged build: in dev there is no archive and `resolveUnpacked` is a no-op.
  // db-compact.worker.js was listed; extension-sandbox.worker.js, added later,
  // was not.
  //
  // So derive the expectation from the code instead of restating it: every
  // `resolveUnpacked(join(__dirname, 'x.js'))` in the main process must be
  // covered by an asarUnpack pattern.
  it('unpacks every worker the main process spawns by path', () => {
    const require_ = createRequire(require.resolve('app-builder-lib/package.json'));
    const { minimatch } = require_('minimatch') as {
      minimatch: (target: string, pattern: string) => boolean;
    };

    const electronDir = fileURLToPath(new URL('../../electron', import.meta.url));
    const sources = readdirSync(electronDir, { recursive: true, encoding: 'utf8' })
      .filter((entry) => entry.endsWith('.ts'))
      .map((entry) => join(electronDir, entry));

    const spawned = new Map<string, string>();
    for (const source of sources) {
      const text = readFileSync(source, 'utf8');
      for (const match of text.matchAll(/resolveUnpacked\(\s*join\(__dirname,\s*'([^']+)'/g)) {
        spawned.set(`dist-electron/${match[1]}`, source);
      }
    }

    // If this is 0 the scan stopped finding anything (renamed helper, moved
    // directory) and the rest of the test would pass vacuously.
    expect(spawned.size).toBeGreaterThan(0);

    const patterns = buildConfig['asarUnpack'] as string[];
    for (const [packagedPath, source] of spawned) {
      const covered = patterns.some((pattern) => minimatch(packagedPath, pattern));
      expect(covered, `${packagedPath} (spawned by ${source}) is not in asarUnpack`).toBe(true);
    }
  });

  // Every release artifact the publish job globs must have a target that
  // actually produces it. A target quietly dropped here means a platform
  // silently vanishes from the release page.
  //
  // The list is exact, not a subset, because the release page is a product
  // surface: a target added by accident puts a download in front of users that
  // nobody decided to support, and one removed by accident takes a platform
  // away. Both are deliberate decisions, so both must edit this test.
  it('still targets every platform the release workflow publishes', () => {
    expect(targetsOf('mac')).toEqual(['dmg', 'zip']);
    expect(targetsOf('win')).toEqual(['nsis']);
    expect(targetsOf('linux')).toEqual(['AppImage', 'deb', 'rpm']);
  });

  // macOS auto-update runs off the .zip, NOT the .dmg -- electron-updater's
  // MacUpdater has no dmg code path at all. Dropping the zip to tidy the
  // release page therefore does not remove a duplicate download, it silently
  // ends updates for every existing Mac user: they are never offered a new
  // version again and have to find one by hand. Nothing else in the build
  // fails if it goes, which is exactly why it needs a test saying so.
  it('keeps the macOS zip that electron-updater installs from', () => {
    expect(targetsOf('mac')).toContain('zip');
  });

  // Deliberately NOT shipped, so a future "let's offer more formats" does not
  // quietly undo the decision:
  //   - win `portable`: a second ~259 MB exe carrying the same payload as the
  //     NSIS installer, which already handles both arches.
  //   - linux `tar.gz`: a generic archive that overlaps AppImage, which serves
  //     the no-package-manager case better.
  // Neither was removed for being broken -- both worked. They were removed
  // because every extra row on the release page is a choice a user has to make.
  it('leaves out the formats that only duplicate another download', () => {
    expect(targetsOf('win')).not.toContain('portable');
    expect(targetsOf('linux')).not.toContain('tar.gz');
  });
});
