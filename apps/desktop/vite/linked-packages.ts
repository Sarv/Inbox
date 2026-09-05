/**
 * Packages installed by `file:` path and developed alongside this app.
 *
 * Vite treats everything under `node_modules` as immutable: it pre-bundles a
 * dependency once into `node_modules/.vite` and its file watcher skips the
 * directory outright. That is right for a published package and wrong for one
 * being written in the next terminal — rebuild it and the dev server keeps
 * serving the previous copy with no error, no warning and no reload. The last
 * round of chat-view CSS fixes was invisible in the running app for exactly
 * this reason, while the app-side stylesheet next to it hot-reloaded fine.
 *
 * pnpm cannot rescue this either: with `node-linker=hoisted` a `file:` dep is
 * HARDLINKED into `node_modules` rather than symlinked, so Vite's own
 * linked-dependency detection — which keys off symlinks — never fires.
 *
 * Hence these two helpers. They are a pair: excluding a package from
 * pre-bundling without watching it still serves stale files, and watching it
 * without excluding it still serves a stale pre-bundle. Both read the same
 * list, so they cannot disagree.
 */

/**
 * Packages linked by `file:` path. Add one here and both helpers pick it up.
 *
 * Empty in the normal case, and that is the correct state: `email-chat-view`
 * now installs from the registry, where Vite's default handling — pre-bundle
 * once, never watch — is exactly right for an immutable published tarball.
 * Excluding it would only cost dev-server startup time.
 *
 * The machinery stays because the moment anyone points that dependency back at
 * `file:../../../email-chat-view` to work on the library, adding its name here
 * is the difference between seeing their rebuild and silently being served the
 * previous one.
 */
export const LINKED_PACKAGES: readonly string[] = [];

/**
 * `optimizeDeps.exclude` — keep these out of the esbuild pre-bundle.
 *
 * A pre-bundled dependency is copied into `node_modules/.vite` and served from
 * there until its cache key changes, which a rebuild of the source package
 * does not reliably do.
 */
export function linkedDepsToExclude(packages: readonly string[] = LINKED_PACKAGES): string[] {
  return [...packages];
}

/**
 * `server.watch.ignored` — re-include these under the blanket node_modules skip.
 *
 * A leading `!` is anymatch's negation, which is how chokidar reads this
 * option: the broad `**\/node_modules/**` rule stays in force for every other
 * package, and only these paths are carved back out.
 */
export function linkedDepsToWatch(packages: readonly string[] = LINKED_PACKAGES): string[] {
  return packages.map((name) => `!**/node_modules/${name}/**`);
}
