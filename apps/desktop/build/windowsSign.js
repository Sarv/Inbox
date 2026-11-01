// electron-builder custom Windows sign hook (win.signtoolOptions.sign).
//
// electron-builder calls this once per file it wants signed: both app .exe
// files, every .dll and .node (win.signExts), elevate.exe, the uninstaller and
// the installer. It signs IN PLACE with jsign against the HSM key in Google
// Cloud KMS. Signing has to happen here, inside the build: latest.yml's
// checksum, the signed update manifest and SHA256SUMS are all computed over
// the bytes this leaves behind.
//
// Dormant until the certificate chain (build/windows-signing-chain.pem) is
// committed: until then every call is a no-op, logged once, and the build is
// exactly the unsigned build it always was. Once the chain exists it is
// FAIL-CLOSED: a missing token or jar, a publisherName that is not the
// committed publisherNames list, a chain that does not match the KMS key or
// whose CN is not the pinned publisher, or a file jsign could not sign all
// throw, and a throw here fails the Windows build. (While disabled it checks
// nothing: an unsigned build that pins a publisher is caught afterwards, by
// scripts/verify-win-signatures.mjs.) Why the asymmetry matters (it is about
// not bricking auto-update) is in scripts/lib/windows-signing.mjs and
// docs/WINDOWS_SIGNING.md.
//
// The logic lives in scripts/lib/windows-signing.mjs, shared with the CI
// self-test so that what CI exercises is what the release runs. This file
// stays a shim. It MUST be tracked: .gitignore excludes apps/desktop/build/*,
// and a clone without it fails every Windows build on the missing hook.

const { join } = require('node:path')
const { pathToFileURL } = require('node:url')

const LIB = join(__dirname, '..', '..', '..', 'scripts', 'lib', 'windows-signing.mjs')
const CONFIG = join(__dirname, 'windows-signing.json')

// Per build: the config is validated, the jar hashed and the "disabled"
// notice printed once, not once per file.
const state = {}

exports.default = async (configuration) => {
  const { electronBuilderSign } = await import(pathToFileURL(LIB).href)
  await electronBuilderSign(configuration, { configPath: CONFIG, state })
}
