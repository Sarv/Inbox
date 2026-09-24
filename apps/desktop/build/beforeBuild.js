// electron-builder beforeBuild hook: compile better-sqlite3 for the arch that
// is about to be packaged, then tell electron-builder node_modules is handled.
//
// Why we take this over from electron-builder. Its own rebuild is
// @electron/rebuild, which walks node_modules from the workspace root it
// detected — and on Windows that detection fails for a pnpm workspace. It
// shells out to `pnpm --workspace-root exec pwd`; there is no `pwd` on Windows,
// so it falls back to hunting for a package.json with a `workspaces` field,
// which this repo does not have (the workspace lives in pnpm-workspace.yaml).
// The root then resolves to apps/desktop, the walk finds no native modules, and
// the step logs "completed installing native dependencies" in ~130ms having
// rebuilt nothing.
//
// The consequence is not a failed build. Every packaged arch gets whatever
// binary happened to be on disk, and an addon compiled for the wrong CPU does
// not crash the app: every core-DB read is wrapped in a try/catch, so it looks
// like an account with no mail (see CLAUDE.md). Doing the rebuild here, once
// per arch, is the only way it is deterministic on all three platforms.
//
// This hook MUST return true. `false` is electron-builder's "node_modules are
// handled externally" signal, and in v26 that does far more than skip the
// rebuild: Packager.installAppDependencies sets _nodeModulesHandledExternally,
// and platformPackager then skips computeNodeModuleFileSets outright -- the app
// ships with NO node_modules at all, on every platform. The v1.2.0 tag built
// four green artifacts whose app.asar contained only dist/, dist-electron/ and
// package.json. Returning true costs a second pass of electron-builder's own
// @electron/rebuild over an addon this hook has already built for the same
// arch; that is idempotent, and on Windows it is the no-op it always was.

const { join } = require('node:path')
const { pathToFileURL } = require('node:url')

// The same rebuild scripts/postinstall.mjs uses, so the two cannot drift.
const NATIVE_ABI = join(__dirname, '..', '..', '..', 'scripts', 'lib', 'native-abi.mjs')

exports.default = async ({ electronVersion, arch }) => {
  const { rebuildBetterSqlite3 } = await import(pathToFileURL(NATIVE_ABI).href)
  // eslint-disable-next-line no-console -- build-time hook, runs outside the app
  const report = (message) => console.log(`  • beforeBuild: ${message}`)

  const built = rebuildBetterSqlite3({
    runtime: 'electron',
    target: electronVersion,
    arch,
    log: report,
    warn: report,
  })

  if (!built) {
    throw new Error(
      `beforeBuild: could not build better-sqlite3 for ${arch}. Packaging now would ` +
        'produce an app whose database never opens, which reads as an empty mailbox.'
    )
  }
  // MUST be true -- see the header. false makes electron-builder drop every
  // node_module from the package, better_sqlite3.node included.
  return true
}
