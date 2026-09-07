import type { Plugin } from 'vite';

/**
 * Build-time guard: keep Node-only modules OUT of the renderer bundle.
 *
 * The renderer runs in a browser-like context. A handful of our dependencies are
 * Node-only — they do `require('stream')` / `require('module')` etc. at load
 * time — and if any of them is pulled into the renderer bundle the packaged app
 * dies on first paint with the (very hard to diagnose in the field) error:
 *
 *     Uncaught Error: Dynamic require of "stream" is not supported
 *
 * That is exactly the "app won't start" crash a shipped build hit. The usual way
 * it sneaks in is an `import { SomeType } from '@sarvinbox/core'` written WITHOUT
 * the `type` keyword: TypeScript erases it, but esbuild/rollup do not, so the
 * whole core barrel (which re-exports imapflow / mailparser / nodemailer) lands
 * in the renderer. The two safe deep-import aliases in vite.config.ts and the
 * `import type` discipline prevent it by convention — this plugin makes it a HARD
 * failure so a regression can never be shipped again.
 *
 * Scope: this plugin is registered in the TOP-LEVEL vite `plugins` array, which
 * applies only to the renderer build. The Electron main/preload builds run under
 * `vite-plugin-electron` with their own nested configs, where these modules are
 * legitimate and untouched by this guard.
 */

// Packages that must never appear in the renderer graph. Each is Node-only (does
// a runtime `require` of a Node builtin) and/or is the transport/parse layer that
// only the main process may touch. Extend this list as new Node-only deps land.
export const DEFAULT_FORBIDDEN_RENDERER_PACKAGES: readonly string[] = [
  'mailparser',
  '@zone-eu/mailsplit', // mailparser's splitter — the module that does the dynamic require
  'imapflow',
  'nodemailer',
  'better-sqlite3',
  'email-reply-parser',
  'imap', // legacy node-imap; removed, but guard so it can never return to the renderer
  'node-imap',
];

/**
 * Given a rollup module id (an absolute file path, possibly with a `?v=` query or
 * a `\0` virtual prefix) and a set of forbidden package names, return the
 * forbidden package the id belongs to, or null.
 *
 * Pure and side-effect free so it can be unit tested directly. Handles both the
 * flat `node_modules/<pkg>` and pnpm's `node_modules/.pnpm/<pkg>@x/node_modules/<pkg>`
 * layouts (the LAST `node_modules/` segment always precedes the real package
 * name), plus `@scope/name` packages.
 */
export function forbiddenPackageForId(
  moduleId: string,
  forbidden: ReadonlySet<string>,
): string | null {
  // Virtual/generated modules (rollup helpers, plugin-emitted code) never map to
  // an installed package — ignore them.
  if (moduleId.startsWith('\0')) return null;

  // Strip any query suffix (e.g. dev's `?v=<hash>`, `?worker`, `?url`).
  const withoutQuery = moduleId.split('?')[0];

  const marker = 'node_modules/';
  const lastIndex = withoutQuery.lastIndexOf(marker);
  if (lastIndex === -1) return null;

  const afterNodeModules = withoutQuery.slice(lastIndex + marker.length);
  const segments = afterNodeModules.split('/');
  if (segments.length === 0 || segments[0] === '') return null;

  const packageName = segments[0].startsWith('@')
    ? `${segments[0]}/${segments[1] ?? ''}`
    : segments[0];

  return forbidden.has(packageName) ? packageName : null;
}

/**
 * Walk up the importer graph from a banned module to the first module that is NOT
 * inside node_modules — i.e. the application source file that ultimately dragged
 * the Node-only package in. Returns a readable chain for the error message.
 */
function traceToAppImporter(
  bannedId: string,
  getModuleInfo: (id: string) => { importers: readonly string[] } | null,
): string {
  const visited = new Set<string>([bannedId]);
  let frontier: string[] = [bannedId];

  // Breadth-first up the importers; the first non-node_modules importer we reach
  // is the app file responsible. Cap the walk so a cyclic graph can't loop.
  for (let depth = 0; depth < 100 && frontier.length > 0; depth += 1) {
    const next: string[] = [];
    for (const id of frontier) {
      const importers = getModuleInfo(id)?.importers ?? [];
      for (const importer of importers) {
        if (visited.has(importer)) continue;
        visited.add(importer);
        if (!importer.includes('node_modules/')) return importer;
        next.push(importer);
      }
    }
    frontier = next;
  }
  return '(could not resolve the importing app file)';
}

/**
 * The renderer-build guard plugin. Fails the build (non-zero exit) if any
 * forbidden Node-only package is present in the final module graph.
 */
export function forbidNodeOnlyInRenderer(
  forbiddenPackages: readonly string[] = DEFAULT_FORBIDDEN_RENDERER_PACKAGES,
): Plugin {
  const forbidden = new Set(forbiddenPackages);

  return {
    name: 'forbid-node-only-in-renderer',
    // Only meaningful for the rollup build; the dev server uses a different graph.
    apply: 'build',
    buildEnd() {
      // One entry per forbidden PACKAGE (a package spans many module files;
      // reporting each file would bury the signal). Keep the first import chain
      // we see for each — one is enough to point at the offending app file.
      const offendersByPackage = new Map<string, string>();
      for (const moduleId of this.getModuleIds()) {
        const packageName = forbiddenPackageForId(moduleId, forbidden);
        if (!packageName || offendersByPackage.has(packageName)) continue;
        const via = traceToAppImporter(moduleId, (id) => this.getModuleInfo(id));
        offendersByPackage.set(packageName, via);
      }

      const offenders = [...offendersByPackage].map(
        ([packageName, via]) => `  - "${packageName}" (pulled in via ${via})`,
      );

      if (offenders.length > 0) {
        this.error(
          'Node-only module(s) leaked into the RENDERER bundle:\n' +
            `${offenders.join('\n')}\n\n` +
            'These do a runtime require() of Node builtins and crash the packaged ' +
            'app with "Dynamic require of \\"stream\\" is not supported".\n' +
            "Most likely an `import { X } from '@sarvinbox/core'` missing the " +
            '`type` keyword, which drags the whole barrel (imapflow/mailparser/' +
            'nodemailer) into the renderer. Use `import type`, or deep-import a ' +
            'renderer-safe subpath. See apps/desktop/vite/forbid-node-only-renderer.ts.',
        );
      }
    },
  };
}
