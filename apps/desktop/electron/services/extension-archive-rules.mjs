/**
 * What may come out of an extension archive: the one rule the app installs with
 * (extension-marketplace.ts) and the build seeds default extensions with
 * (scripts/extension-seed.mjs). Plain ESM with no imports, so the build script
 * can load it straight from `node`; extension-archive-rules.d.mts carries its types.
 */

/** The paths an archive may contribute: the manifest, its compiled scripts, icon, readme and licence. */
const ALLOWED_FILE = /^(?:\.\/)?(?:sarvinbox-extension\.json|dist\/[\w.-]+\.js|icon\.svg|README\.md|LICENSE)$/;

/**
 * The folder entries a well-formed archive carries. The publisher packs from a
 * staging folder (`tar -czf … -C … .`), so tar records `./` and `./dist/` as entries
 * of their own beside the files. They can create nothing the file allowlist does not
 * already permit, and counting them as unexpected made every ordinary install warn.
 */
const ALLOWED_FOLDER = /^(?:\.|\.\/|(?:\.\/)?dist\/)$/;

/**
 * Entry types that are plain files. A path allowlist says nothing about type: a
 * symbolic or hard link named `dist/index.js` would be unpacked as that link,
 * pointing wherever its author chose on the computer doing the unpacking. A device
 * or a FIFO is nothing an extension ships either.
 */
const FILE_TYPES = new Set(['File', 'OldFile', 'ContiguousFile']);

/**
 * The tar `filter`: an allowlisted path of the right kind, a plain file or one of
 * the expected folders. `entry` is tar's ReadEntry; only its `type` is read.
 */
export function isAllowedArchiveEntry(path, entry) {
  const normalized = String(path).replace(/\\/g, '/');
  const type = entry?.type;
  if (ALLOWED_FOLDER.test(normalized)) return type === 'Directory';
  return ALLOWED_FILE.test(normalized) && FILE_TYPES.has(type);
}
