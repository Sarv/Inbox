import { resolve } from 'path';

import type { Alias } from 'vite';

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
 *     Uncaught Error: Dynamic require of "path" is not supported
 *
 * which is a white window on first paint, with nothing in app.log: the renderer
 * dies before React mounts, and an uncaught module error never reaches the
 * console forwarder.
 *
 * `postcss` — the CSS parser behind the opt-in dark-mode body rewrite — is
 * written to run in a browser. Its package.json declares
 * `"browser": { "path": false, "url": false, "fs": false }` and every use is
 * guarded (`pathAvailable = Boolean(resolve && isAbsolute)`). Every other bundler
 * honours that and substitutes an empty module. Here the Electron plugin's alias
 * got there first and substituted the throwing shim, so a parser that works
 * everywhere else took the whole app down on launch.
 *
 * These aliases restore the standard behaviour for the packages listed below,
 * and ONLY for them. An importer that is not on the list falls through (`null`),
 * which leaves Vite's own "externalized for browser compatibility" handling to
 * report an app file that reached for a Node builtin — a Node-only dependency
 * must still fail loudly rather than silently receive an empty object.
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

/**
 * The alias entries, which MUST come before `vite-plugin-electron-renderer`'s
 * own (it appends its builtin aliases in its `config` hook, and the first
 * matching entry wins).
 *
 * @param desktopDir absolute path to apps/desktop.
 */
export function browserSafeBuiltinAliases(desktopDir: string): Alias[] {
  const emptyModule = resolve(desktopDir, 'vite/empty-node-builtin.mjs');
  return [
    {
      find: BROWSER_SAFE_BUILTINS,
      // Unused — customResolver decides — but @rollup/plugin-alias computes the
      // replacement before calling it, so it has to be a real id.
      replacement: emptyModule,
      customResolver: (_source: string, importer?: string) =>
        wantsEmptyBuiltin(importer) ? emptyModule : null,
    },
  ];
}
