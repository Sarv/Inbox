/**
 * Where, and what, prefetch-default-extensions.mjs may write when it seeds a
 * default extension into build/default-extensions/. Plain ESM with no imports
 * beyond Node, so the build script runs straight from `node` with no build
 * step; extension-seed.d.mts carries its types for the desktop tests.
 */

import { isAbsolute, join, relative } from 'node:path';

/**
 * The extension id rule: lower-case letters, digits and dashes, starting with
 * a letter or digit, at most 63 characters. Ids become folder names, so this is
 * also what keeps a seed inside its folder. The SAME rule as core's
 * `parseExtensionsConfig` (packages/core/src/extensions/extensions-config.ts);
 * extension-seed.test.ts fails if the two disagree.
 */
const EXTENSION_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * The only paths an extension archive may contribute: the manifest, its
 * compiled scripts, icon, readme and licence. The same allowlist the app
 * installs with (extension-marketplace.ts).
 */
const ALLOWED_ENTRY = /^(?:\.\/)?(?:sarvinbox-extension\.json|dist\/[\w.-]+\.js|icon\.svg|README\.md|LICENSE)$/;

/** Entry types that are plain files or folders, never links or devices. */
const FILE_TYPES = new Set(['File', 'OldFile', 'ContiguousFile']);

/** Whether `id` may name a seed folder. */
export function isSeedableId(id) {
  return typeof id === 'string' && EXTENSION_ID.test(id);
}

/**
 * The folder an extension unpacks into and the temporary archive beside it,
 * both directly inside `outputDir`. Throws for an id that could name anything
 * else (`..`, a separator, an absolute path), whatever the registry said.
 */
export function seedPaths(outputDir, id) {
  if (!isSeedableId(id)) throw new Error(`"${String(id)}" is not a valid extension id`);
  const target = join(outputDir, id);
  const archivePath = join(outputDir, `${id}.tgz`);
  for (const path of [target, archivePath]) {
    const rel = relative(outputDir, path);
    if (!rel || rel.startsWith('..') || isAbsolute(rel) || rel.includes('/') || rel.includes('\\')) {
      throw new Error(`"${id}" would be written outside ${outputDir}`);
    }
  }
  return { target, archivePath };
}

/**
 * The tar `filter` for a seed: an allowlisted path that is a plain file, or
 * the archive's root folder. A symbolic or hard link is refused even under an
 * allowed name: it would put a pointer to some other file on the build machine
 * into the folder electron-builder copies into the app.
 */
export function isAllowedArchiveEntry(path, entry) {
  const normalized = String(path).replace(/\\/g, '/');
  const type = entry?.type;
  if (normalized === '.' || normalized === './') return type === 'Directory';
  return ALLOWED_ENTRY.test(normalized) && FILE_TYPES.has(type);
}
