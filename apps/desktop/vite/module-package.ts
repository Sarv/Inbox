/**
 * Which installed package does a rollup/vite module id belong to?
 *
 * Shared by the two renderer-resolution rules that both have to answer exactly
 * that question about a path in `node_modules`: the Node-only bundle guard
 * (`forbid-node-only-renderer.ts`) and the browser-safe builtin aliases
 * (`browser-safe-builtins.ts`). One implementation so the two can never disagree
 * about what package a module came from.
 */

/**
 * Given a rollup module id (an absolute file path, possibly with a `?v=` query or
 * a `\0` virtual prefix) and a set of package names, return the one the id
 * belongs to, or null.
 *
 * Pure and side-effect free so it can be unit tested directly. Handles both the
 * flat `node_modules/<pkg>` and pnpm's `node_modules/.pnpm/<pkg>@x/node_modules/<pkg>`
 * layouts (the LAST `node_modules/` segment always precedes the real package
 * name), plus `@scope/name` packages.
 */
export function packageForModuleId(
  moduleId: string,
  packageNames: ReadonlySet<string>,
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

  return packageNames.has(packageName) ? packageName : null;
}
