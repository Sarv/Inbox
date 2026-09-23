// electron-builder afterPack hook.
//
// NOTE: the original hook was never committed — `.gitignore` ignores everything
// under apps/desktop/build/ except icon.icns — so this is a reconstruction.
// It deliberately does only work that is provably safe: deleting node-gyp
// build intermediates that are left inside the unpacked better-sqlite3 native
// module. Those directories (obj.target, .deps, and the intermediate .o/.a
// files) are compiler leftovers, never opened at runtime, and add tens of MB
// to the DMG.
//
// Anything that prunes locales, prebuilds, or bundle contents was NOT restored:
// guessing there risks shipping a broken app, and the cost is only file size.

const { rm, readdir, stat } = require('node:fs/promises')
const { join } = require('node:path')

// Directory names that node-gyp leaves behind and nothing loads at runtime.
const DEAD_BUILD_DIRS = new Set(['obj.target', 'obj', '.deps'])

/** Depth-limited walk that yields every directory under `root`. */
const collectDirs = async (root, depth = 0) => {
  if (depth > 8) return []
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return [] // root does not exist on this platform/arch — nothing to prune
  }
  const dirs = entries.filter((entry) => entry.isDirectory()).map((entry) => join(root, entry.name))
  const nested = await Promise.all(dirs.map((dir) => collectDirs(dir, depth + 1)))
  return [...dirs, ...nested.flat()]
}

/** Total bytes freed by removing `paths`, best-effort. */
const removeAll = async (paths) => {
  const sizes = await Promise.all(
    paths.map(async (path) => {
      try {
        const { size } = await stat(path)
        await rm(path, { recursive: true, force: true })
        return size
      } catch {
        return 0
      }
    })
  )
  return sizes.reduce((total, size) => total + size, 0)
}

exports.default = async (context) => {
  const { appOutDir, packager, electronPlatformName } = context
  const appName = packager.appInfo.productFilename

  // Where the asarUnpack'd native modules land, per platform.
  const unpacked =
    electronPlatformName === 'darwin'
      ? join(appOutDir, `${appName}.app`, 'Contents', 'Resources', 'app.asar.unpacked')
      : join(appOutDir, 'resources', 'app.asar.unpacked')

  const allDirs = await collectDirs(unpacked)
  const dead = allDirs.filter((dir) => DEAD_BUILD_DIRS.has(dir.split('/').pop()))

  if (dead.length === 0) return

  const freed = await removeAll(dead)
  // eslint-disable-next-line no-console -- build-time hook, runs outside the app
  console.log(
    `  • afterPack: pruned ${dead.length} node-gyp build dir(s), ~${Math.round(freed / 1024)} KB`
  )
}
