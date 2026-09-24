import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  REQUIRED_ADDONS,
  findNativeAddons,
  findPackagedApps,
  missingRequiredAddons,
} from '../../../../../scripts/lib/native-addons.mjs';

/**
 * Guards the check that stops an EMPTY app being published.
 *
 * The regression this protects against shipped on the v1.2.0 tag and looked
 * like a complete success: `build/beforeBuild.js` returned false,
 * electron-builder 26 read that as "node_modules are handled externally" and
 * packed no node_modules at all, on every platform. Four artifacts built,
 * uploaded and installed; each app.asar contained only dist/, dist-electron/
 * and package.json.
 *
 * It got that far because only the Windows job ever opened an artifact. The
 * script these helpers back is what makes macOS and Linux look too -- so if the
 * helpers themselves are wrong, the verification passes and the protection is
 * gone. Hence testing them, not just the script.
 */

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'native-addons-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Write a file, creating its parents. */
const touch = (...segments: string[]): string => {
  const file = join(root, ...segments);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, '');
  return file;
};

describe('findNativeAddons', () => {
  // The addon lives several levels down inside app.asar.unpacked, so a
  // non-recursive search would report every app as broken -- or, worse, a
  // shallow one that found nothing would be indistinguishable from the real bug.
  it('finds addons nested anywhere under the tree', () => {
    touch('resources', 'app.asar.unpacked', 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node');
    touch('resources', 'app.asar');
    expect(findNativeAddons(root).map((addon) => relative(root, addon))).toEqual([
      join('resources', 'app.asar.unpacked', 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node'),
    ]);
  });

  // A tree with no addon must come back empty rather than throw: "empty" is the
  // signal the caller turns into a failure, with a message that names the app.
  it('returns nothing for a tree with no addons', () => {
    touch('resources', 'app.asar');
    expect(findNativeAddons(root)).toEqual([]);
  });
});

describe('findPackagedApps', () => {
  // One entry per packed app. A two-arch build where only one arch got its
  // node_modules must still fail, so the search cannot stop at the first hit.
  it('finds every packed app below the release directory', () => {
    touch('mac', 'Sarv Inbox.app', 'Contents', 'Resources', 'app.asar');
    touch('mac-arm64', 'Sarv Inbox.app', 'Contents', 'Resources', 'app.asar');
    touch('linux-unpacked', 'resources', 'app.asar');

    expect(findPackagedApps(root).map((dir) => relative(root, dir))).toEqual([
      join('linux-unpacked', 'resources'),
      // Sorted bytewise: '-' precedes '/', so mac-arm64 lands before mac/.
      join('mac-arm64', 'Sarv Inbox.app', 'Contents', 'Resources'),
      join('mac', 'Sarv Inbox.app', 'Contents', 'Resources'),
    ]);
  });

  // The addon sits in a SIBLING of app.asar, so the walk must stop at the
  // resources dir. Descending further would report app.asar.unpacked as a
  // second, always-broken "app".
  it('stops at the resources directory rather than descending into the payload', () => {
    touch('linux-unpacked', 'resources', 'app.asar');
    touch('linux-unpacked', 'resources', 'app.asar.unpacked', 'node_modules', 'x', 'app.asar');
    expect(findPackagedApps(root)).toEqual([join(root, 'linux-unpacked', 'resources')]);
  });

  // An output directory with no app.asar anywhere is the shape of a build that
  // produced nothing. Returning empty lets the caller fail loudly; silently
  // "passing" a directory with no apps in it is how the empty artifacts shipped.
  it('returns nothing when no app was packed', () => {
    touch('release-notes.txt');
    expect(findPackagedApps(root)).toEqual([]);
  });
});

describe('missingRequiredAddons', () => {
  // The exact v1.2.0 failure: a packed app with zero addons.
  it('reports better-sqlite3 missing when nothing was packed', () => {
    expect(missingRequiredAddons([])).toEqual(['better_sqlite3.node']);
  });

  // Matching is on the basename, so it survives electron-builder moving the
  // addon between app.asar.unpacked and a flat resources directory.
  it('accepts the addon wherever in the tree it landed', () => {
    const packed = join('a', 'app.asar.unpacked', 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node');
    expect(missingRequiredAddons([packed])).toEqual([]);
    expect(missingRequiredAddons([join('b', 'better_sqlite3.node')])).toEqual([]);
  });

  // Other addons in the tree must not be mistaken for the one that matters --
  // better-sqlite3 ships a test_extension.node right beside it.
  it('does not accept a different addon as a substitute', () => {
    expect(missingRequiredAddons([join('a', 'test_extension.node')])).toEqual(['better_sqlite3.node']);
  });

  // The default list is what the release workflow enforces; an empty one would
  // make every check pass.
  it('requires at least better-sqlite3 by default', () => {
    expect(REQUIRED_ADDONS).toContain('better_sqlite3.node');
  });
});
