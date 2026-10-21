/*
 * What a packed app.asar loads at runtime, and whether each module is inside it.
 *
 * In a production build vite bundles every dependency into dist-electron/ and
 * leaves only electron and the native modules external (vite.config.ts,
 * `mainExternals`). So package.json `build.files` ships just those externals
 * from node_modules -- the rest was a second, unused copy of what the bundles
 * already contain: 200 MB of app.asar, re-downloaded by every update.
 *
 * The cost of that allowlist is one way to break the app: a module made
 * external in vite.config.ts, but not added to `build.files`. It is not a
 * failure the smoke launch reliably sees -- a module required only from a lazy
 * chunk throws when that feature is first used, on a user's machine. So the
 * release build reads every require() out of the packed bundles, follows each
 * package it reaches through its own requires, and fails if one is missing.
 *
 * Specifiers are matched with a regular expression, not a parser, on purpose:
 * the bundles are minified CommonJS whose externals rolldown always emits as
 * `require("name")`, and a false match fails the build loudly rather than
 * passing it quietly.
 */

import { builtinModules } from 'node:module';

/** require("x") / require('x') / require(`x`) and bare import("x") with a literal, non-relative x.
 * A property call such as ObjC.import('CoreServices') is not JavaScript's
 * dynamic import. JXA scripts passed to macOS can contain these in strings.
 * Keep member require calls (module.require) covered: those do load packages.
 */
const REQUIRE_PATTERN = /\b(?:require|(?<!\.)import)\(\s*["'`](@?[a-z0-9][\w.-]*(?:\/[\w.@-]+)*)["'`]\s*\)/gi;

const BUILTINS = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));

/** Electron's own modules, provided by the runtime rather than node_modules. */
const RUNTIME_MODULES = new Set(['electron', 'original-fs']);

/**
 * The installable package a specifier names: `@scope/name` or `name`, without
 * any subpath.
 * @param {string} specifier
 * @returns {string}
 */
export function packageNameOf(specifier) {
  const segments = specifier.split('/');
  return specifier.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0];
}

/**
 * Whether the runtime supplies `specifier` (a Node builtin or an Electron
 * module), so it never has to be packed.
 * @param {string} specifier
 * @returns {boolean}
 */
export function isRuntimeProvided(specifier) {
  return BUILTINS.has(specifier) || BUILTINS.has(specifier.split('/')[0]) || RUNTIME_MODULES.has(packageNameOf(specifier));
}

/**
 * Every package `source` requires by a literal name, other than the ones the
 * runtime provides.
 * @param {string} source JavaScript source.
 * @returns {string[]} Sorted package names.
 */
export function requiredPackagesOf(source) {
  const names = [...source.matchAll(REQUIRE_PATTERN)]
    .map((match) => match[1])
    .filter((specifier) => !isRuntimeProvided(specifier))
    .map(packageNameOf);
  return [...new Set(names)].sort();
}

/** @param {string} file */
const isScript = (file) => /\.(c|m)?js$/.test(file);

/**
 * The package a node_modules file belongs to, or null for app code.
 * @param {string} file Archive-relative path with `/` separators.
 * @returns {string | null}
 */
export function owningPackageOf(file) {
  const segments = file.split('/');
  const index = segments.lastIndexOf('node_modules');
  if (index === -1 || index + 1 >= segments.length) return null;
  const scoped = segments[index + 1].startsWith('@');
  // A bare `@scope` directory is not a package; only `@scope/name` is.
  if (scoped && index + 2 >= segments.length) return null;
  return segments.slice(index + 1, index + (scoped ? 3 : 2)).join('/');
}

/**
 * Walk from the app's own bundles through every package they reach.
 *
 * Lenient about nesting: a package found anywhere under node_modules counts as
 * available. The check exists to catch a package that was not packed at all,
 * which is the one thing the `build.files` allowlist can get wrong.
 *
 * @param {string[]} files Every file in the archive, `/`-separated, no leading slash.
 * @param {(file: string) => string} read Contents of one of those files.
 * @param {string[]} [entryDirs] Where the app's own code lives.
 * @returns {{ missing: Array<{ name: string, requiredBy: string }>, reached: string[], packed: string[] }}
 */
export function analyseRequires(files, read, entryDirs = ['dist-electron']) {
  const packed = [...new Set(files.filter((file) => file.startsWith('node_modules/')).map(owningPackageOf))]
    .filter(Boolean)
    .sort();
  const available = new Set(packed);
  const scriptsOf = (name) => files.filter((file) => file.startsWith(`node_modules/${name}/`) && isScript(file));
  const entryScripts = files.filter((file) => entryDirs.some((dir) => file.startsWith(`${dir}/`)) && isScript(file));

  /** @type {Array<{ name: string, requiredBy: string }>} */
  const missing = [];
  const reached = new Set();
  /** @type {Array<{ scripts: string[], owner: string }>} */
  const queue = [{ scripts: entryScripts, owner: entryDirs.join(', ') }];

  while (queue.length > 0) {
    const { scripts, owner } = queue.shift();
    const wanted = new Set(scripts.flatMap((file) => requiredPackagesOf(read(file))));
    for (const name of [...wanted].sort()) {
      if (name === owner || reached.has(name)) continue;
      if (!available.has(name)) {
        if (!missing.some((entry) => entry.name === name)) missing.push({ name, requiredBy: owner });
        continue;
      }
      reached.add(name);
      queue.push({ scripts: scriptsOf(name), owner: name });
    }
  }

  return { missing, reached: [...reached].sort(), packed };
}
