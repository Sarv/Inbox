/**
 * Where, and what, prefetch-default-extensions.mjs may write when it seeds a
 * default extension into build/default-extensions/. Plain ESM with no imports
 * beyond Node, so the build script runs straight from `node` with no build
 * step; extension-seed.d.mts carries its types for the desktop tests.
 */

import { isAbsolute, join, relative } from 'node:path';

/** The archive rule the app installs with; a seed is unpacked by the same one. */
export { isAllowedArchiveEntry } from '../electron/services/extension-archive-rules.mjs';

/**
 * The extension id rule: lower-case letters, digits and dashes, starting with
 * a letter or digit, at most 63 characters. Ids become folder names, so this is
 * also what keeps a seed inside its folder. The SAME rule as core's
 * `parseExtensionsConfig` (packages/core/src/extensions/extensions-config.ts);
 * extension-seed.test.ts fails if the two disagree.
 */
const EXTENSION_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

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
