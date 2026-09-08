#!/usr/bin/env node
/*
 * CLI wrapper around scripts/lib/stale-js.mjs — deletes compiled `.js` files
 * that still have a `.ts`/`.tsx` sibling.
 *
 * Used by the desktop package's `clean` script in place of a bare
 * `find … -name '*.js' -delete`, which could not tell build output from a
 * hand-written JS file. Node-only, so it behaves identically on Windows.
 *
 * Run: node scripts/clean-stale-js.mjs <dir> [dir…]   (paths relative to cwd)
 */

import path from 'node:path';

import { cleanStaleJs } from './lib/stale-js.mjs';

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('usage: node scripts/clean-stale-js.mjs <dir> [dir…]');
  process.exit(1);
}

const { removed } = cleanStaleJs(args.map((dir) => path.resolve(dir)));
if (removed.length > 0) {
  console.log(`[clean] removed ${removed.length} stale .js file(s) with a .ts source`);
}
