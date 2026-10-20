import { describe, expect, it } from 'vitest';

import {
  analyseRequires,
  isRuntimeProvided,
  owningPackageOf,
  packageNameOf,
  requiredPackagesOf,
} from '../../../../../scripts/lib/asar-requires.mjs';

/**
 * Guards the check that makes the `build.files` node_modules allowlist safe.
 *
 * The allowlist ships only what the production bundles still load (better-
 * sqlite3 and its loader), which took ~180 MB out of app.asar and so out of
 * every update. Its one failure mode is a module made external in
 * vite.config.ts but never added to the allowlist: the app then throws when
 * that module is first required, which for a lazy chunk is on a user's
 * machine, not in the smoke launch. If these helpers stop seeing a require,
 * that build passes and ships.
 */

/** An in-memory archive: path -> contents. */
const archive = (entries: Record<string, string>) => ({
  files: Object.keys(entries),
  read: (file: string) => entries[file] ?? '',
});

describe('requiredPackagesOf', () => {
  // rolldown emits externals as require("name"); this is the shape every
  // missing-module case arrives in.
  it('reads double-quoted, single-quoted and template requires', () => {
    const source = `var a=require("better-sqlite3"),b=require('bindings'),c=require(\`zod\`);`;
    expect(requiredPackagesOf(source)).toEqual(['better-sqlite3', 'bindings', 'zod']);
  });

  // A dynamic import of an external package is a lazy require by another name.
  it('reads dynamic import() of a package', () => {
    expect(requiredPackagesOf('await import("imapflow")')).toEqual(['imapflow']);
  });

  // A deep import still needs the whole package packed; reporting the subpath
  // would never match a packed package name and fail every build.
  it('reduces subpaths to their package, scoped or not', () => {
    const source = 'require("@sentry/node/cjs/index.js");require("lodash/fp")';
    expect(requiredPackagesOf(source)).toEqual(['@sentry/node', 'lodash']);
  });

  // Builtins and Electron are provided by the runtime; flagging them would
  // fail every build and teach people to ignore the check.
  it('ignores Node builtins, node: specifiers and Electron', () => {
    const source = 'require("fs");require("node:path");require("stream/promises");require("electron");require("original-fs")';
    expect(requiredPackagesOf(source)).toEqual([]);
  });

  // Relative requires are the bundle's own chunks, not packages.
  it('ignores relative and absolute paths and computed names', () => {
    const source = 'require("./chunk.js");require("../preload/default.js");require("/abs");require(`+e+`);require(name)';
    expect(requiredPackagesOf(source)).toEqual([]);
  });

  it('reports each package once, sorted', () => {
    expect(requiredPackagesOf('require("b");require("a");require("b")')).toEqual(['a', 'b']);
  });
});

describe('packageNameOf / isRuntimeProvided / owningPackageOf', () => {
  it('names the package of a specifier', () => {
    expect(packageNameOf('@scope/name/deep/file.js')).toBe('@scope/name');
    expect(packageNameOf('name/deep')).toBe('name');
  });

  it('knows what the runtime provides', () => {
    expect(isRuntimeProvided('worker_threads')).toBe(true);
    expect(isRuntimeProvided('fs/promises')).toBe(true);
    expect(isRuntimeProvided('electron/main')).toBe(true);
    expect(isRuntimeProvided('better-sqlite3')).toBe(false);
  });

  // A bare scope directory counted as a package showed up as dead weight
  // ("@sentry") next to every real scoped package.
  it('maps a node_modules file to its package, and a bare scope dir to none', () => {
    expect(owningPackageOf('node_modules/bindings/bindings.js')).toBe('bindings');
    expect(owningPackageOf('node_modules/@sentry/node/index.js')).toBe('@sentry/node');
    expect(owningPackageOf('node_modules/a/node_modules/b/index.js')).toBe('b');
    expect(owningPackageOf('node_modules/@sentry')).toBeNull();
    expect(owningPackageOf('dist-electron/main.js')).toBeNull();
    expect(owningPackageOf('node_modules')).toBeNull();
  });
});

describe('analyseRequires', () => {
  // The shape the allowlist ships today: the bundle needs better-sqlite3,
  // which needs bindings, which needs file-uri-to-path.
  it('passes when every package reached is packed, following them transitively', () => {
    const { files, read } = archive({
      'dist-electron/main.js': 'require("better-sqlite3");require("fs")',
      'node_modules/better-sqlite3/package.json': '{}',
      'node_modules/better-sqlite3/lib/database.js': 'require("bindings")("better_sqlite3.node")',
      'node_modules/bindings/bindings.js': 'require("file-uri-to-path")',
      'node_modules/file-uri-to-path/index.js': 'module.exports=1',
    });

    const result = analyseRequires(files, read);

    expect(result.missing).toEqual([]);
    expect(result.reached).toEqual(['better-sqlite3', 'bindings', 'file-uri-to-path']);
  });

  // THE regression: an external added in vite.config.ts and not to build.files.
  it('fails when the bundle requires a package that was not packed', () => {
    const { files, read } = archive({
      'dist-electron/main.js': 'require("better-sqlite3")',
      'dist-electron/lazy-chunk.js': 'require("imapflow")',
      'node_modules/better-sqlite3/lib/database.js': '',
    });

    expect(analyseRequires(files, read).missing).toEqual([{ name: 'imapflow', requiredBy: 'dist-electron' }]);
  });

  // A kept package whose own dependency was cut by the allowlist throws on
  // load just the same - bindings without file-uri-to-path.
  it('fails when a packed package requires one that was not packed', () => {
    const { files, read } = archive({
      'dist-electron/main.js': 'require("better-sqlite3")',
      'node_modules/better-sqlite3/lib/database.js': 'require("bindings")',
      'node_modules/bindings/bindings.js': 'require("file-uri-to-path")',
    });

    expect(analyseRequires(files, read).missing).toEqual([{ name: 'file-uri-to-path', requiredBy: 'bindings' }]);
  });

  // The warning that keeps the asar from silently growing back.
  it('reports packed packages nothing reaches', () => {
    const { files, read } = archive({
      'dist-electron/main.js': '',
      'node_modules/lucide-react/index.js': '',
    });

    const result = analyseRequires(files, read);
    expect(result.packed).toEqual(['lucide-react']);
    expect(result.reached).toEqual([]);
  });

  // A require cycle (or a package requiring itself) must terminate.
  it('terminates on cycles and self-requires', () => {
    const { files, read } = archive({
      'dist-electron/main.js': 'require("a")',
      'node_modules/a/index.js': 'require("a");require("b")',
      'node_modules/b/index.js': 'require("a")',
    });

    expect(analyseRequires(files, read)).toMatchObject({ missing: [], reached: ['a', 'b'] });
  });

  // Only scripts are scanned: a README or .d.ts mentioning require("x") is
  // not code that runs.
  it('ignores non-script files', () => {
    const { files, read } = archive({
      'dist-electron/main.js': '',
      'dist-electron/notes.md': 'require("not-a-dep")',
      'dist-electron/types.d.ts': 'require("not-a-dep")',
    });

    expect(analyseRequires(files, read).missing).toEqual([]);
  });
});
