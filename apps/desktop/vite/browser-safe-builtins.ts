import { resolve } from 'path';

import type { Plugin } from 'vite';

import { packageForModuleId } from './module-package';

/**
 * Give a browser-safe dependency the EMPTY `fs` / `path` / `url` its own
 * package.json asks for.
 *
 * This renderer is a plain browser — `nodeIntegration: false`,
 * `contextIsolation: true`, `sandbox: true` (electron/main.ts) — so it has no
 * `require` at all. `vite-plugin-electron-renderer` nevertheless rewrites EVERY
 * import of a Node builtin, in app code and in dependencies alike, to a
 * generated shim that calls `require()`. In this window that shim can only ever
 * throw, at module-evaluation time:
 *
 *     Uncaught ReferenceError: require is not defined
 *         at node_modules/.vite-electron-renderer/path.mjs:3
 *
 * which is a white window on first paint, with nothing in app.log: the renderer
 * dies before React mounts, and an uncaught module error never reaches the
 * console forwarder.
 *
 * `postcss` — the CSS parser behind the opt-in dark-mode body rewrite — is
 * written to run in a browser. Its package.json declares
 * `"browser": { "path": false, "url": false, "fs": false }` and every use is
 * guarded (`pathAvailable = Boolean(resolve && isAbsolute)`). Every other bundler
 * honours that and substitutes an empty module. Here the Electron plugin's
 * resolution got there first and substituted the throwing shim, so a parser that
 * works everywhere else took the whole app down on launch.
 *
 * This is a `resolveId` HOOK, not a `resolve.alias` entry, and that distinction
 * is the entire reason the guard works. Through vite-plugin-electron-renderer
 * 0.14 the plugin appended its builtin substitutions to `resolve.alias`, so
 * coming FIRST in the alias array won the race. Since 1.0 it resolves builtins
 * in a `resolveId` hook declared `order: 'pre'` — and a `'pre'` hook sorts ahead
 * of Vite's alias plugin ENTIRELY, so no alias entry, in any position, is
 * consulted for `path` any more. Beating it means matching its rank: our own
 * `'pre'` hook, registered BEFORE `renderer()` in the plugins array, because
 * hooks of equal order fall back to plugin order.
 */

/**
 * Packages whose package.json marks these builtins browser-optional and which
 * check before using them. Add one only after confirming BOTH: the `browser`
 * field maps the builtin to `false`, and the code guards every call site.
 */
export const BROWSER_SAFE_BUILTIN_PACKAGES: readonly string[] = ['postcss'];

/**
 * The builtins those packages declare optional. Deliberately narrow: a builtin
 * that is not listed here keeps the Electron plugin's loud shim.
 */
export const BROWSER_SAFE_BUILTINS = /^(?:node:)?(?:fs|path|url)$/;

/**
 * Does this importer get the empty module? Pure, so the decision is unit tested
 * rather than inferred from a build that did or didn't blank the screen.
 */
export function wantsEmptyBuiltin(
  importer: string | undefined,
  packages: readonly string[] = BROWSER_SAFE_BUILTIN_PACKAGES,
): boolean {
  if (!importer) return false;
  return packageForModuleId(importer, new Set(packages)) !== null;
}

/** Absolute path to the empty module listed importers are given. */
export function emptyBuiltinModule(desktopDir: string): string {
  return resolve(desktopDir, 'vite/empty-node-builtin.mjs');
}

/**
 * The resolution itself, split out from the plugin so it is directly unit
 * testable: the empty module for a listed importer, `null` for everyone else.
 *
 * `null` means "not mine" — resolution continues to the Electron plugin, which
 * hands an unlisted importer the shim that fails loudly. That half matters as
 * much as the first: a Node-only dependency reaching the renderer must keep
 * crashing rather than silently receive an empty object.
 */
export function resolveBrowserSafeBuiltin(
  source: string,
  importer: string | undefined,
  desktopDir: string,
): string | null {
  if (!BROWSER_SAFE_BUILTINS.test(source)) return null;
  return wantsEmptyBuiltin(importer) ? emptyBuiltinModule(desktopDir) : null;
}


/** A rolldown `external` array entry: an exact specifier or a pattern. */
type ExternalMatcher = string | RegExp;

/**
 * Reproduce rolldown's own array-form `external` test, so that deferring to the
 * list the Electron plugin declared means exactly what it meant before.
 */
export function matchesExternalList(source: string, list: readonly ExternalMatcher[]): boolean {
  return list.some((entry) => (typeof entry === 'string' ? entry === source : entry.test(source)));
}

/**
 * @param desktopDir absolute path to apps/desktop.
 */
export function browserSafeBuiltinsPlugin(desktopDir: string): Plugin {
  return {
    name: 'sarvinbox:browser-safe-builtins',
    // `enforce` puts us in the pre group; `order` matches the Electron plugin's
    // own hook rank. Both are needed, and so is being listed before it.
    enforce: 'pre',
    /**
     * The `resolveId` hook below is enough in dev, but NOT in a build. There the
     * Electron plugin ALSO declares every builtin in
     * `build.rolldownOptions.external`, and rolldown tests `external` BEFORE it
     * consults any `resolveId` hook — so for a build the hook never runs at all
     * and postcss's `path` is emitted as `__require("path")`, which throws the
     * moment the module is evaluated. Swap the array for a function that answers
     * "not external" for the importers we route, and defers to the declared list
     * for everyone else, so nothing but postcss changes.
     */
    configResolved(config) {
      const declared = config.build.rolldownOptions?.external;
      if (!Array.isArray(declared)) return;
      const list = declared as ExternalMatcher[];
      config.build.rolldownOptions.external = (source: string, importer: string | undefined) =>
        resolveBrowserSafeBuiltin(source, importer, desktopDir) === null &&
        matchesExternalList(source, list);
    },
    resolveId: {
      order: 'pre',
      handler(source, importer) {
        return resolveBrowserSafeBuiltin(source, importer, desktopDir);
      },
    },
  };
}
