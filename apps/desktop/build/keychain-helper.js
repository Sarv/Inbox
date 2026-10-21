// Shared BUILD-TIME compilation for packaged apps and the local Electron bundle.
// Installed apps execute this binary; they never need Xcode or a compiler.
const { execFile } = require('node:child_process')
const { randomUUID } = require('node:crypto')
const { chmod, rename, rm, stat } = require('node:fs/promises')
const { join } = require('node:path')
const { promisify } = require('node:util')

const KEYCHAIN_HELPER_FILENAME = 'Sarv Inbox Keychain'
const runCompiler = promisify(execFile)

function compilerArchitectures(arch) {
  // electron-builder passes builder-util's Arch enum (x64=1, arm64=3,
  // universal=4); the dev build passes process.arch instead.
  if (arch === 'x64' || arch === 1) return ['x86_64']
  if (arch === 'arm64' || arch === 3) return ['arm64']
  if (arch === 'universal' || arch === 4) return ['x86_64', 'arm64']
  throw new Error('Unsupported macOS architecture for the Keychain helper.')
}

async function buildKeychainHelper({ directory, arch, run = runCompiler }) {
  const architectures = compilerArchitectures(arch)
  if (!(await stat(directory)).isDirectory()) throw new Error('The Mac executable directory is missing.')
  const destination = join(directory, KEYCHAIN_HELPER_FILENAME)
  const temporary = join(directory, `.keychain-helper-${randomUUID()}`)
  try {
    await run('/usr/bin/xcrun', [
      '--sdk', 'macosx', 'clang',
      ...architectures.flatMap(value => ['-arch', value]),
      '-mmacosx-version-min=11.0', '-Os', '-fobjc-arc',
      '-framework', 'Security', '-framework', 'CoreFoundation',
      join(__dirname, '..', 'native', 'keychain-access.m'),
      '-o', temporary,
    ], { encoding: 'utf8', timeout: 120_000, maxBuffer: 512 * 1024 })
    const output = await stat(temporary)
    if (!output.isFile() || output.size === 0) throw new Error('The macOS Keychain helper was not built.')
    await chmod(temporary, 0o755)
    await rename(temporary, destination)
    return destination
  } finally {
    await rm(temporary, { force: true })
  }
}

module.exports = { KEYCHAIN_HELPER_FILENAME, buildKeychainHelper }
