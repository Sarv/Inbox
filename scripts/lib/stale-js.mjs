/*
 * Remove stale compiled output: a `.js` file sitting next to the `.ts` it was
 * built from.
 *
 * Why the sibling check matters. The obvious one-liner —
 *
 *     find src electron -name '*.js' -type f -delete
 *
 * — deletes EVERY .js under those trees, including hand-written ones that were
 * never build output. Today nothing in src/ or electron/ is authored as .js, so
 * that command is harmless; the day someone adds a config shim or a worker
 * written in plain JS, `pnpm clean` silently eats it and the loss only surfaces
 * as a mysterious build failure later. Requiring a sibling .ts makes the rule
 * say what it means: delete what tsc produced, nothing else.
 *
 * Shared so clean-db.mjs and the desktop package's `clean` script cannot drift
 * apart on what "stale" means.
 */

import fs from 'node:fs';
import path from 'node:path';

// Never descend into these: node_modules is not ours to touch, and dist/
// dist-electron are build output that the caller removes wholesale — walking
// them would be slow and would delete files that have no .ts sibling anyway.
const SKIP_DIRS = new Set(['node_modules', 'dist', 'dist-electron', '.vite', '.turbo']);

/**
 * Delete `.js` files that have a matching `.ts` source, recursively.
 *
 * @param {string[]} roots directories to walk; missing ones are skipped
 * @returns {{ removed: string[] }} the paths deleted, for logging by the caller
 */
export function cleanStaleJs(roots) {
  const removed = [];

  const walk = (currentDir) => {
    let dirents = [];
    try {
      dirents = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const dirent of dirents) {
      if (SKIP_DIRS.has(dirent.name)) continue;
      const full = path.join(currentDir, dirent.name);
      if (dirent.isDirectory()) {
        walk(full);
        continue;
      }
      if (!dirent.isFile() || !full.endsWith('.js')) continue;
      // `foo.js` is stale only if `foo.ts` still exists beside it. Also cover
      // .tsx, which compiles to .js just the same.
      const base = full.slice(0, -3);
      if (fs.existsSync(`${base}.ts`) || fs.existsSync(`${base}.tsx`)) {
        try {
          fs.rmSync(full, { force: true });
          removed.push(full);
        } catch {
          // Locked or read-only — leave it; a stale .js is a nuisance, not a
          // reason to abort the rest of the clean.
        }
      }
    }
  };

  for (const root of roots) {
    if (fs.existsSync(root)) walk(root);
  }
  return { removed };
}
