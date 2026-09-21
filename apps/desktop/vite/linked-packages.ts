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
 *
 * WHAT THEY DO NOT COVER: a new SUBPATH in the linked package's `exports` map.
 * Watching re-serves a changed file; it does not re-read the package.json Vite
 * resolved when the server started, so an import of an entry added since then
 * fails with `Missing "./<entry>" specifier in "<package>"` however many times
 * the library is rebuilt. Restart the dev server — that is the whole fix, and
 * `rm -rf node_modules/.vite` first if it somehow survives one.
 */

/**
 * Packages linked by `file:` path. Add one here and both helpers pick it up.
 *
 * This list must match the dependencies whose version range starts with
 * `file:` — a test asserts exactly that, because the failure it prevents is
 * silent: the dev server keeps serving the previous build of the library with
 * no error, no warning and no reload.
 *
 * Empty today, and that is the healthy state: `@sarv-in/mailguard` was
 * published to the registry in Sept 2026 and `@sarv-in/email-chat-view`
 * before it, so both now install as immutable tarballs where Vite's default
 * handling — pre-bundle once, never watch — is exactly right. Point either
 * back at `file:` to work on it in the sibling checkout and it belongs here
 * again; the test below will say so if you forget.
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
 * CommonJS packages the renderer reaches THROUGH a linked package.
 *
 * Excluding a package from pre-bundling excludes its dependencies too, and Vite
 * then serves them exactly as they sit on disk. An ESM dependency is fine; a
 * CommonJS one is not — the browser is handed `module.exports = ...` and the
 * importing module's `import x from 'pkg'` fails with "does not provide an
 * export named 'default'". The window is blank, and only in dev: the production
 * build runs the same file through @rollup/plugin-commonjs and converts it, so
 * `check:renderer-bundle` stays green while `pnpm dev:desktop` is unusable.
 * That is exactly how `free-email-domains` broke the renderer on 2026-09-19.
 *
 * Naming one here puts it back in the pre-bundle on its own, which is where
 * esbuild converts it to ESM — the fix Vite documents for this case. The list
 * is short by construction: it holds only what a renderer import actually
 * reaches, not everything the library depends on.
 *
 * `ipaddr.js` arrives with the blocklist catalogue that Security > Blocklists
 * renders (`@sarv-in/mailguard/reputation`), and is CommonJS with a
 * default import.
 */
export const LINKED_CJS_DEPS: readonly string[] = ['ipaddr.js'];

/**
 * `optimizeDeps.include` — the counterpart to the exclude above.
 */
export function linkedCjsDepsToPrebundle(packages: readonly string[] = LINKED_CJS_DEPS): string[] {
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
