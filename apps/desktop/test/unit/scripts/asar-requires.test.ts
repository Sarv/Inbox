import { describe, expect, it } from 'vitest';

import {
  OPTIONAL_PEERS_LEFT_OUT,
  analyseRequires,
  isRuntimeProvided,
  owningPackageOf,
  packageNameOf,
  requiredPackagesOf,
  unresolvedPeersOf,
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

  it('does not confuse a macOS JXA framework import with a JavaScript package import', () => {
    const source = `const script="ObjC.import('CoreServices'); ObjC.unwrap(ObjC.castRefToObject(value))";await import("imapflow");module.require("bindings");`;
    expect(requiredPackagesOf(source)).toEqual(['bindings', 'imapflow']);
    expect(requiredPackagesOf('bridge.import("not-a-node-package");bridge?.import("also-not-a-package")')).toEqual([]);
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

  it('passes embedded JXA scripts while still rejecting a genuine missing lazy import beside them', () => {
    const { files, read } = archive({
      'dist-electron/main.js': `const query="ObjC.import('CoreServices'); ObjC.unwrap(value)";require("better-sqlite3");`,
      'node_modules/better-sqlite3/lib/database.js': '',
    });
    expect(analyseRequires(files, read)).toMatchObject({ missing: [], reached: ['better-sqlite3'] });
    const withMissing = archive({
      'dist-electron/main.js': read('dist-electron/main.js'),
      'dist-electron/lazy.js': 'await import("missing-calendar-provider")',
      'node_modules/better-sqlite3/lib/database.js': '',
    });
    expect(analyseRequires(withMissing.files, withMissing.read).missing).toEqual([{ name: 'missing-calendar-provider', requiredBy: 'dist-electron' }]);
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

/**
 * Vite's stand-in for an optional peer dependency that was not installed when
 * the app was bundled, byte for byte as the production main bundle carried it
 * from 2026-09-21: a chunk that throws on load, with no require() of the peer
 * left anywhere for the walk above to find.
 */
const stub = (peer: string, importer = '@sarv-in/mailguard') =>
  `const e=require("./rolldown-runtime-CPUxUITh.js");var t;e.n((()=>{throw t={},Error(\`Could not resolve "${peer}" imported by "${importer}". Is it installed?\`)}))(),exports.default=t;`;

describe('unresolvedPeersOf', () => {
  // THE regression it exists for: BIMI's certificate library bundled as a
  // stub, so no sender got the verified tick and the release check passed.
  it('reads the stub vite bundles for a missing optional peer', () => {
    expect(unresolvedPeersOf(stub('@peculiar/x509'))).toEqual([{ name: '@peculiar/x509', importer: '@sarv-in/mailguard' }]);
  });

  // A peer left out on purpose must not fail every release, but only for the
  // package it was left out of: the same name elsewhere is still a miss.
  it('skips a peer left out on purpose, and only for its own importer', () => {
    expect(OPTIONAL_PEERS_LEFT_OUT['@sarv-in/mailguard']).toEqual(['mailauth']);
    expect(unresolvedPeersOf(stub('mailauth'))).toEqual([]);
    expect(unresolvedPeersOf(stub('mailauth', 'some-other-lib'))).toEqual([{ name: 'mailauth', importer: 'some-other-lib' }]);
  });

  // Two stubs for one peer (a subpath and the package) are one problem; the
  // order is stable so the release log reads the same on every platform.
  it('reports each peer once per importer, by package, sorted', () => {
    const source = [stub('reflect-metadata'), stub('@peculiar/x509/sub'), stub('@peculiar/x509'), stub('zod', 'a-lib')].join('\n');
    expect(unresolvedPeersOf(source)).toEqual([
      { name: '@peculiar/x509', importer: '@sarv-in/mailguard' },
      { name: 'reflect-metadata', importer: '@sarv-in/mailguard' },
      { name: 'zod', importer: 'a-lib' },
    ]);
  });

  // An inherited Object key as an importer must not crash the check.
  it('treats an importer named like an Object property as not allowlisted', () => {
    expect(unresolvedPeersOf(stub('x', 'constructor'))).toEqual([{ name: 'x', importer: 'constructor' }]);
  });

  it('finds nothing in a bundle without stubs', () => {
    expect(unresolvedPeersOf('require("better-sqlite3")')).toEqual([]);
  });
});

describe('analyseRequires and unresolved optional peers', () => {
  // The shipped shape: main.js requires the stub chunks lazily; the release
  // must fail naming the peer and the chunk that throws in its place.
  it('fails a bundle that stands in for an optional peer, naming the chunk', () => {
    const { files, read } = archive({
      'dist-electron/main.js': 'require("./mailguard-BvvgJteH.js");require("./mailguard-BfPAS2mb.js")',
      'dist-electron/mailguard-BvvgJteH.js': stub('@peculiar/x509'),
      'dist-electron/mailguard-CNAaa7wz.js': stub('reflect-metadata'),
      'dist-electron/mailguard-BfPAS2mb.js': stub('mailauth'),
    });

    const result = analyseRequires(files, read);

    expect(result.missing).toEqual([]);
    expect(result.unresolved).toEqual([
      { name: '@peculiar/x509', importer: '@sarv-in/mailguard', file: 'dist-electron/mailguard-BvvgJteH.js' },
      { name: 'reflect-metadata', importer: '@sarv-in/mailguard', file: 'dist-electron/mailguard-CNAaa7wz.js' },
    ]);
  });

  // The fixed build: the peer is a real chunk, only the deliberate stub is left.
  it('passes once the peer is bundled for real', () => {
    const { files, read } = archive({
      'dist-electron/main.js': 'require("./x509.es-D-eZWtV1.js");require("./mailguard-BfPAS2mb.js")',
      'dist-electron/x509.es-D-eZWtV1.js': 'module.exports={X509Certificate:class{}}',
      'dist-electron/mailguard-BfPAS2mb.js': stub('mailauth'),
    });

    expect(analyseRequires(files, read)).toMatchObject({ missing: [], unresolved: [] });
  });

  // One peer stubbed in two chunks is reported once, at the first.
  it('reports a peer stubbed in several chunks once', () => {
    const { files, read } = archive({
      'dist-electron/a.js': stub('@peculiar/x509'),
      'dist-electron/b.js': stub('@peculiar/x509'),
    });

    expect(analyseRequires(files, read).unresolved).toEqual([
      { name: '@peculiar/x509', importer: '@sarv-in/mailguard', file: 'dist-electron/a.js' },
    ]);
  });

  // Only the app's own bundles are vite output; a packed package's source
  // mentioning the message is not a stub vite made.
  it('looks for stubs only in the app bundles', () => {
    const { files, read } = archive({
      'dist-electron/main.js': 'require("better-sqlite3")',
      'node_modules/better-sqlite3/lib/database.js': stub('@peculiar/x509'),
    });

    expect(analyseRequires(files, read).unresolved).toEqual([]);
  });
});
